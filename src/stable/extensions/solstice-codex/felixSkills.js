"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const SKILL_STORE_MIGRATION = ".storage-migration-v1.json";

// Felix's PRIVATE self-improvement store (Phase 6). Skills are reusable
// playbooks distilled from VERIFIED-good builds; memory holds lessons. Both
// are plain markdown with frontmatter — inspectable, versioned, never
// overwritten. Retrieval ranks by the central fleet embedder when its URL is
// configured (no in-process model → avoids the mem0 bloat), else by keyword
// overlap. Write-back is GATED by the caller behind the self-verify pass so
// Felix never learns from an unverified build.

function slug(s) {
	return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
}

// tokens include latin + hebrew so retrieval works on bilingual task prompts.
function tokenize(s) {
	return (String(s || "").toLowerCase().match(/[a-z0-9\u0590-\u05ff]+/g)) || [];
}

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function portableInventory(root) {
	const files = [];
	const walk = (dir, prefix = "") => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (rel === ".felix-runtime.json") continue;
			const file = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) files.push({ path: rel, status: "invalid-symlink" });
			else if (entry.isDirectory()) walk(file, rel);
			else if (entry.isFile()) files.push({ path: rel, bytes: fs.statSync(file).size, sha256: sha256(file) });
		}
	};
	if (fs.existsSync(root)) walk(root);
	return files;
}

function inventoryFingerprint(files) {
	return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

// "Do not use X" must never route to X. A closed list of build verbs was tried
// on 05/08 and rejected 8 of 12 legitimate requests — "תשתמש ב-ScrollWorld
// בבקשה" and "use ScrollWorld for this project" both missed, which is the
// two-week generic-site bug in a new form. So mention is the trigger and
// negation the only veto: a missed request fails silently, while an unwanted
// route is visible and recovers on retry.
function negatedScrollWorldRequest(text) {
	const raw = String(text || "");
	const named = "(?:scroll[\\s_-]*world|סקול\\s*וורלד)";
	const hebrewNegation = new RegExp("(?:אל\\s+תשתמש(?:ו)?|בלי|לא\\s+רוצה|במקום|חוץ\\s*מ[-־]?)\\s*(?:ב[-־]?)?" + named, "i");
	const englishNegation = new RegExp("(?:\\b(?:do\\s+not|don't|dont|not)\\b[^.!?\\n]{0,40}|\\b(?:no|without|instead\\s+of|rather\\s+than|skip|avoid)\\s+(?:using\\s+)?)" + named, "i");
	const hebrewQuestion = new RegExp("(?:\\b(?:למה|מדוע|מה|איך|האם|מתי|איפה)\\b[^.!?\\n]{0,80}" + named + "|" + named + "[^.!?\\n]{0,80}\\?)", "i");
	const englishQuestion = new RegExp("(?:\\b(?:why|what|how|whether|when|where|does|did|is|can|should)\\b[^.!?\\n]{0,80}" + named + "|" + named + "[^.!?\\n]{0,80}\\?)", "i");
	return hebrewNegation.test(raw) || englishNegation.test(raw) || hebrewQuestion.test(raw) || englishQuestion.test(raw);
}

function explicitScrollWorldRequest(text) {
	const raw = String(text || "");
	const mention = /scroll[\s_-]*world/i.test(raw) || /סקול\s*וורלד/i.test(raw);
	if (!mention) return false;
	return !negatedScrollWorldRequest(raw);
}

// Exclusive suppression (Animated Kit silence + fail-closed) requires the
// unambiguous route marker only. A bare mention of "ScrollWorld" may still
// pin/rank via explicitScrollWorldRequest — never suppress alternatives.
function hasExclusiveScrollWorldRoute(text) {
	return /\[FELIX_ROUTE\s+name="scroll-world-gpt-image"\s+exclusive="true"\]/.test(String(text || ""));
}

function composeSkillsPrompt(hits) {
	const selected = Array.isArray(hits) ? hits : [];
	const exclusive = selected.length === 1 && selected[0].retrieval && selected[0].retrieval.exclusive === true;
	const bodies = selected.map((hit) => exclusive
		? String(hit.body || "").trim()
		: String(hit.body || "").slice(0, 500).trim());
	const blocks = selected.map((hit, index) =>
		"• " + (hit.meta.kind === "lesson" ? "⚠️ לקח: " : "") + (hit.meta.name || "skill") +
		(hit.meta.tags && hit.meta.tags.length ? " [" + hit.meta.tags.join(", ") + "]" : "") +
		(hit.skillDir ? "\nResources: " + hit.skillDir + " (read SKILL.md and open its referenced files before acting)" : "") +
		"\n" + bodies[index]);
	const route = exclusive ? "[FELIX_ROUTE name=\"scroll-world-gpt-image\" exclusive=\"true\"]\n" : "";
	return {
		exclusive,
		injectedBytes: bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
		text: selected.length ? route + "[FELIX_SKILLS]\n🧠 ידע נצבר רלוונטי (skills מבניות מאומתות + לקחים מטעויות עבר — השתמש, ואל תחזור על לקח שסומן ⚠️):\n" + blocks.join("\n\n") + "\n[/FELIX_SKILLS]\n\n---\n\n" : "",
	};
}

// One-time import into VS Code globalStorage. Older/dev builds could leave the
// mutable store beside the extension bundle or in workspaceStorage; both are
// replaced during an update. Existing global files always win, so migration is
// idempotent and never rolls XP/version metadata backwards.
function migrateLegacyStores(targetDir, legacyDirs, log = () => { }) {
	fs.mkdirSync(targetDir, { recursive: true });
	const marker = path.join(targetDir, SKILL_STORE_MIGRATION);
	try {
		if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, "utf8"));
	} catch { }
	let copied = 0;
	const sources = [];
	for (const legacy of [...new Set((legacyDirs || []).filter(Boolean).map((p) => path.resolve(p)))]) {
		if (legacy === path.resolve(targetDir) || !fs.existsSync(legacy)) continue;
		let sourceCopied = 0;
		for (const bucket of ["skills", "memory"]) {
			const from = path.join(legacy, bucket);
			const to = path.join(targetDir, bucket);
			let files = [];
			try { files = fs.readdirSync(from, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")); } catch { }
			if (!files.length) continue;
			fs.mkdirSync(to, { recursive: true });
			for (const entry of files) {
				const dest = path.join(to, entry.name);
				if (fs.existsSync(dest)) continue;
				try { fs.copyFileSync(path.join(from, entry.name), dest); copied++; sourceCopied++; } catch { }
			}
		}
		if (sourceCopied) sources.push({ path: legacy, copied: sourceCopied });
	}
	const result = { version: 1, migratedAt: new Date().toISOString(), copied, sources };
	try { fs.writeFileSync(marker, JSON.stringify(result, null, 2) + "\n"); } catch { }
	if (copied) log(`[skills] migrated ${copied} durable file(s) into globalStorage`);
	return result;
}

const SKILL_LEVELS = [
	{ level: 1, minXp: 0, title: "Foundation" },
	{ level: 2, minXp: 300, title: "Proven" },
	{ level: 3, minXp: 800, title: "Mastered" },
];

// XP is derived from durable metadata instead of stored separately, so it can
// never drift from the real use/version counters. A use is the primary signal;
// verified revisions add a smaller maturity bonus.
function skillProgress(meta = {}) {
	const uses = Math.max(0, parseInt(meta.uses, 10) || 0);
	const version = Math.max(1, parseInt(meta.version, 10) || 1);
	const xp = uses * 100 + (version - 1) * 250;
	let tier = SKILL_LEVELS[0];
	for (const candidate of SKILL_LEVELS) if (xp >= candidate.minXp) tier = candidate;
	const next = SKILL_LEVELS.find((candidate) => candidate.level === tier.level + 1);
	const progress = next
		? Math.max(0, Math.min(100, Math.round(((xp - tier.minXp) / (next.minXp - tier.minXp)) * 100)))
		: 100;
	return { xp, level: tier.level, title: tier.title, progress, nextXp: next ? next.minXp : null };
}

class FelixSkills {
	constructor(opts) {
		this.dir = opts.dir;
		this.migration = migrateLegacyStores(this.dir, opts.legacyDirs, opts.log);
		this.skillsDir = path.join(this.dir, "skills");
		this.memoryDir = path.join(this.dir, "memory");
		this.log = opts.log || (() => { });
		this.embedderUrl = (opts.embedderUrl || "").trim();
		try { fs.mkdirSync(this.skillsDir, { recursive: true }); fs.mkdirSync(this.memoryDir, { recursive: true }); } catch { }
	}

	// import static prompt playbooks as seed skills, once.
	seedFrom(extensionPath) {
		this._seedPrompt(extensionPath, "design-playbook", "design-playbook.md", ["design", "premium", "landing", "ui"]);
		this._seedPrompt(extensionPath, "animated-website-kit", "animated-website-kit.md", ["animation", "gsap", "r3f", "three", "webgl", "general-motion"]);
		this._seedPrompt(extensionPath, "felix-toolbox-router", "felix-toolbox-router.md", ["toolbox", "router", "workflow", "research", "build"]);
		this._seedPrompt(extensionPath, "gap-analysis-playbook", "gap-analysis-playbook.md", ["gap", "antigravity", "cursor", "analysis"]);
		const scrollWorld = this._seedDirectory(extensionPath, "scroll-world-gpt-image", path.join("prompts", "scroll-world"));
		const verticalDir = path.join(extensionPath, "prompts", "verticals");
		let files = [];
		try { files = fs.readdirSync(verticalDir).filter((f) => f.endsWith(".md")).sort(); } catch { }
		for (const f of files) {
			const name = "vertical-" + slug(f.replace(/\.md$/, ""));
			const sector = slug(f.replace(/\.md$/, ""));
			const tags = ["vertical", "template", sector].concat(sector.split("-").filter(Boolean));
			this._seedPrompt(extensionPath, name, path.join("verticals", f), tags, sector);
		}
		return { scrollWorld };
	}

	runtimeDiagnostics(extensionPath) {
		const name = "scroll-world-gpt-image";
		const bundledDir = path.join(extensionPath, "prompts", "scroll-world");
		const runtimeDir = path.join(this.skillsDir, name);
		const bundledSkill = path.join(bundledDir, "SKILL.md");
		const runtimeSkill = path.join(runtimeDir, "SKILL.md");
		let bundled = [], runtime = [], error = "";
		try { bundled = portableInventory(bundledDir); } catch (e) { error = `bundled inventory failed: ${e.message}`; }
		try { runtime = portableInventory(runtimeDir); } catch (e) { error = error || `runtime inventory failed: ${e.message}`; }
		const bundledByPath = new Map(bundled.map((item) => [item.path, item]));
		const runtimeByPath = new Map(runtime.map((item) => [item.path, item]));
		const resources = bundled.map((source) => {
			const target = runtimeByPath.get(source.path);
			return {
				path: source.path,
				status: !target ? "missing" : source.sha256 === target.sha256 ? "match" : "mismatch",
				bundledSha256: source.sha256 || "",
				runtimeSha256: target && target.sha256 || "",
			};
		});
		for (const target of runtime) {
			if (!bundledByPath.has(target.path)) resources.push({ path: target.path, status: "runtime-only", runtimeSha256: target.sha256 || "" });
		}
		const bundledProblem = this._portableSeedProblem(bundledSkill, name, "bundle");
		const runtimeProblem = this._portableSeedProblem(runtimeSkill, name, "runtime");
		const bundledValid = !bundledProblem;
		const runtimeValid = !runtimeProblem;
		if (bundledProblem) error = error || bundledProblem;
		const missing = resources.filter((item) => item.status === "missing");
		const mismatched = resources.filter((item) => item.status === "mismatch");
		let status = "healthy";
		if (error || !bundledValid) status = "bundled-error";
		else if (!runtimeValid) status = fs.existsSync(runtimeDir) ? "runtime-invalid" : "runtime-missing";
		else if (missing.length) status = "runtime-incomplete";
		else if (mismatched.length) status = "runtime-modified";
		return {
			name, status, error,
			bundled: { path: bundledDir, valid: bundledValid, files: bundled.length, fingerprint: inventoryFingerprint(bundled), error: bundledProblem },
			runtime: { path: runtimeDir, valid: runtimeValid, files: runtime.length, fingerprint: inventoryFingerprint(runtime), error: runtimeProblem },
			resources,
		};
	}

	repairScrollWorld(extensionPath) {
		const name = "scroll-world-gpt-image";
		const source = path.join(extensionPath, "prompts", "scroll-world");
		const target = path.join(this.skillsDir, name);
		const sourceSkill = path.join(source, "SKILL.md");
		const sourceProblem = this._portableSeedProblem(sourceSkill, name, "bundle");
		if (sourceProblem) throw new Error(sourceProblem);
		const nonce = `${process.pid}-${Date.now().toString(36)}`;
		const temp = `${target}.repairing-${nonce}`;
		const backup = path.join(this.dir, "backups", `${name}-${nonce}`);
		let runtimeMeta = null;
		try { runtimeMeta = JSON.parse(fs.readFileSync(path.join(target, ".felix-runtime.json"), "utf8")); } catch { }
		const copy = (from, to) => {
			fs.mkdirSync(to, { recursive: true });
			for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
				const src = path.join(from, entry.name);
				const dest = path.join(to, entry.name);
				if (entry.isSymbolicLink()) throw new Error("bundled skill contains a symlink");
				if (entry.isDirectory()) copy(src, dest);
				else if (entry.isFile()) fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
			}
		};
		try {
			copy(source, temp);
			if (runtimeMeta) fs.writeFileSync(path.join(temp, ".felix-runtime.json"), JSON.stringify(runtimeMeta, null, 2) + "\n");
			if (!this._validPortableSeed(path.join(temp, "SKILL.md"), name)) throw new Error("repaired contract failed validation");
			if (fs.existsSync(target)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(target, backup); }
			fs.renameSync(temp, target);
			this.log(`[skills] repaired ${name}; previous runtime saved at ${backup}`);
			return { name, status: "repaired", target, backup: fs.existsSync(backup) ? backup : "" };
		} catch (error) {
			try { fs.rmSync(temp, { recursive: true, force: true }); } catch { }
			if (!fs.existsSync(target) && fs.existsSync(backup)) {
				try { fs.renameSync(backup, target); } catch { }
			}
			throw error;
		}
	}

	_validPortableSeed(file, name) {
		return !this._portableSeedProblem(file, name);
	}

	_portableSeedProblem(file, name, location = "skill") {
		try {
			if (!fs.existsSync(file)) return `SKILL.md missing from ${location} at ${file}`;
			const parsed = this._parse(file);
			if (parsed.body.trim().length <= 100) return `SKILL.md in ${location} is empty or truncated at ${file}`;
			if (slug(parsed.meta.name) !== slug(name)) return `SKILL.md in ${location} has unexpected name at ${file}`;
			return "";
		} catch (error) {
			return `SKILL.md in ${location} is unreadable at ${file}: ${error.message}`;
		}
	}

	_seedDirectory(extensionPath, name, rel) {
		const source = path.join(extensionPath, rel);
		const target = path.join(this.skillsDir, slug(name));
		const sourceSkill = path.join(source, "SKILL.md");
		const targetSkill = path.join(target, "SKILL.md");
		const sourceProblem = this._portableSeedProblem(sourceSkill, name, "bundle");
		if (sourceProblem) {
			const result = { name, status: "failed", error: sourceProblem };
			this.log(`[skills] directory seed failed for ${name}: ${result.error}`);
			return result;
		}
		const temp = target + `.installing-${process.pid}-${Date.now().toString(36)}`;
		const copy = (from, to, exclusive = true) => {
			let copied = 0;
			fs.mkdirSync(to, { recursive: true });
			for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
				const sourceFile = path.join(from, entry.name);
				const targetFile = path.join(to, entry.name);
				if (entry.isSymbolicLink()) throw new Error("seed skill contains a symlink");
				if (entry.isDirectory()) copied += copy(sourceFile, targetFile, exclusive);
				else if (entry.isFile() && (!exclusive || !fs.existsSync(targetFile))) {
					fs.copyFileSync(sourceFile, targetFile, exclusive ? fs.constants.COPYFILE_EXCL : 0);
					copied++;
				}
			}
			return copied;
		};
		if (this._validPortableSeed(targetSkill, name)) {
			try {
				const copied = copy(source, target, true);
				if (copied) {
					this.log(`[skills] self-healed ${copied} missing resource(s) for ${name}`);
					return { name, status: "repaired", target, copied };
				}
				this.log("[skills] verified directory seed " + name);
				return { name, status: "verified", target };
			} catch (error) {
				this.log("[skills] directory seed verification failed for " + name + ": " + error.message);
				return { name, status: "failed", error: error.message, target };
			}
		}
		try {
			if (fs.existsSync(target)) {
				if (fs.existsSync(targetSkill)) {
					const backup = path.join(target, `SKILL.invalid-${Date.now().toString(36)}.md`);
					fs.renameSync(targetSkill, backup);
				}
				copy(source, target, true);
				if (!this._validPortableSeed(targetSkill, name)) throw new Error("self-heal did not produce a valid SKILL.md");
				this.log("[skills] self-healed directory seed " + name);
				return { name, status: "repaired", target };
			}
			copy(source, temp, true);
			fs.renameSync(temp, target);
			this.log("[skills] seeded directory " + name);
			return { name, status: "seeded", target };
		} catch (error) {
			try { fs.rmSync(temp, { recursive: true, force: true }); } catch { }
			this.log("[skills] directory seed failed for " + name + ": " + error.message);
			return { name, status: "failed", error: error.message, target };
		}
	}

	_seedPrompt(extensionPath, name, rel, tags, sector) {
		const seedFile = path.join(this.skillsDir, slug(name) + ".md");
		if (fs.existsSync(seedFile)) {
			try {
				const current = this._parse(seedFile);
				const expectedTags = [...new Set(tags || [])];
				const currentTags = current.meta.tags || [];
				if (String(current.meta.provenance || "").startsWith("seed:")
					&& JSON.stringify(currentTags) !== JSON.stringify(expectedTags)) {
					this._writeFile(seedFile, { ...current.meta, tags: expectedTags, updatedAt: new Date().toISOString() }, current.body);
					this.log("[skills] reconciled seed tags for " + name);
				}
			} catch (error) { this.log("[skills] seed tag reconcile failed for " + name + ": " + error.message); }
			return;
		}
		let src = "";
		try { src = fs.readFileSync(path.join(extensionPath, "prompts", rel), "utf8"); } catch { return; }
		this._writeFile(seedFile, {
			name, tags: tags || [], sector: sector || "", version: 1,
			provenance: "seed:prompts/" + rel.replace(/\\/g, "/"), verified: true,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), change_note: "seeded",
		}, src);
		this.log("[skills] seeded " + name);
	}

	_writeFile(file, meta, body) {
		const fm = ["---"];
		for (const k of ["name", "tags", "sector", "version", "provenance", "verified", "uses", "createdAt", "updatedAt", "change_note"]) {
			if (meta[k] === undefined) continue;
			fm.push(k + ": " + (Array.isArray(meta[k]) ? meta[k].join(", ") : meta[k]));
		}
		fm.push("---", "");
		fs.writeFileSync(file, fm.join("\n") + body);
	}

	_parse(file) {
		const raw = fs.readFileSync(file, "utf8");
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		const meta = {};
		let body = raw;
		if (m) {
			body = m[2];
			for (const line of m[1].split("\n")) {
				const i = line.indexOf(":");
				if (i < 0) continue;
				const k = line.slice(0, i).trim();
				const v = line.slice(i + 1).trim();
				meta[k] = k === "tags" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
			}
		}
		if (path.basename(file).toLowerCase() === "skill.md") {
			try {
				const runtimeMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), ".felix-runtime.json"), "utf8"));
				if (runtimeMeta && Number.isFinite(Number(runtimeMeta.uses))) meta.uses = String(Math.max(0, parseInt(runtimeMeta.uses, 10) || 0));
				if (runtimeMeta && runtimeMeta.updatedAt) meta.updatedAt = String(runtimeMeta.updatedAt);
			} catch { }
		}
		return { meta, body, file, skillDir: path.basename(file).toLowerCase() === "skill.md" ? path.dirname(file) : "" };
	}

	_writePortableRuntimeMeta(skill, meta) {
		const file = path.join(skill.skillDir, ".felix-runtime.json");
		const temp = file + `.tmp-${process.pid}-${Date.now().toString(36)}`;
		fs.writeFileSync(temp, JSON.stringify({ uses: Number(meta.uses || 0), updatedAt: meta.updatedAt || new Date().toISOString() }, null, 2) + "\n");
		fs.renameSync(temp, file);
	}

	// active skills only — versioned archives (*.vN.md) are excluded.
	list() {
		let entries = [];
		try { entries = fs.readdirSync(this.skillsDir, { withFileTypes: true }); } catch { }
		const files = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".md") && !/\.v\d+\.md$/.test(entry.name)) files.push(path.join(this.skillsDir, entry.name));
			else if (entry.isDirectory()) {
				const portable = path.join(this.skillsDir, entry.name, "SKILL.md");
				if (fs.existsSync(portable)) files.push(portable);
			}
		}
		return files.map((file) => { try { return this._parse(file); } catch { return null; } }).filter(Boolean);
	}

	// lessons learned from fidelity gaps / failures — the "never repeat a
	// mistake" half of self-improvement (mirrors the fleet's memory/ pattern).
	listLessons() {
		let files = [];
		try { files = fs.readdirSync(this.memoryDir).filter((f) => f.endsWith(".md")); } catch { }
		return files.map((f) => { try { const p = this._parse(path.join(this.memoryDir, f)); p.meta.kind = "lesson"; return p; } catch { return null; } }).filter(Boolean);
	}

	// top-k skills+lessons relevant to a task. Embedder rank when configured,
	// else keyword/tag overlap boosted by a use-count signal (skills that keep
	// getting used and re-verified float up). Never throws.
	async retrieve(queryText, k = 3) {
		const skills = [...this.list(), ...this.listLessons()];
		if (!skills.length) return [];
		const explicit = this._explicitMatches(queryText, skills);
		if (explicit.length) {
			// Asking for ScrollWorld by name is a ROUTE, not just a ranking boost.
			// Without this branch composeSkillsPrompt truncates it to 500 chars and
			// never emits the marker, so the generic Animated Website Kit is injected
			// whole beside it — the exact behaviour that made every "ScrollWorld"
			// build come out looking like an ordinary animated site for two weeks.
			// The assignment existed, was dropped in e076d28, and nothing replaced it.
			const scrollWorld = explicit.filter((skill) => String(skill.meta.name || "") === "scroll-world-gpt-image");
			if (scrollWorld.length && explicitScrollWorldRequest(queryText)) {
				return scrollWorld.map((skill) => this._withRetrieval(skill, {
					score: Number.MAX_SAFE_INTEGER,
					reason: "explicit ScrollWorld route",
					pinned: true,
					exclusive: true,
				}));
			}
			const rest = this._keywordRank(queryText, skills.filter((skill) => !explicit.includes(skill)));
			return [...explicit.map((skill) => this._withRetrieval(skill, {
				score: Number.MAX_SAFE_INTEGER,
				reason: "explicit skill name",
				pinned: true,
			})), ...rest].slice(0, k);
		}
		if (this.embedderUrl) {
			try {
				const ranked = await this._embedRank(queryText, skills, k);
				return ranked.map((skill, index) => this._withRetrieval(skill, { score: null, reason: `semantic match #${index + 1}`, pinned: false }));
			}
			catch (e) { this.log("[skills] embed rank failed, keyword fallback: " + (e && e.message || e)); }
		}
		return this._keywordRank(queryText, skills).slice(0, k);
	}

	_withRetrieval(skill, retrieval) {
		skill.retrieval = retrieval;
		return skill;
	}

	_explicitMatches(queryText, skills) {
		const compact = String(queryText || "").toLowerCase().replace(/[\s_-]+/g, "");
		return skills.filter((skill) => {
			const name = String(skill.meta.name || "");
			const compactName = name.toLowerCase().replace(/[\s_-]+/g, "");
			if (compactName.length >= 4 && compact.includes(compactName)) return true;
			return name === "scroll-world-gpt-image" && explicitScrollWorldRequest(queryText);
		});
	}

	_keywordRank(queryText, skills) {
		const q = new Set(tokenize(queryText));
		return skills.map((s) => {
			const hay = tokenize((s.meta.name || "") + " " + ((s.meta.tags || []).join(" ")) + " " + (s.meta.sector || "") + " " + s.body.slice(0, 400));
			let overlap = 0;
			for (const t of new Set(hay)) if (q.has(t)) overlap++;
			const useBonus = Math.min(0.75, Math.log1p(parseInt(s.meta.uses, 10) || 0) / 4);
			const score = overlap * 4 + useBonus;
			return { s, score, overlap, useBonus };
		}).filter((x) => x.overlap > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => this._withRetrieval(x.s, {
				score: Math.round(x.score * 100) / 100,
				reason: `${x.overlap} relevant term${x.overlap === 1 ? "" : "s"}; use bonus ${x.useBonus.toFixed(2)} (capped)`,
				pinned: false,
			}));
	}

	// bump the use-counter of retrieved skills (called at dispatch, best-effort).
	recordUse(items) {
		const events = [];
		for (const s of items || []) {
			try {
				if (!s.file || s.meta.kind === "lesson") continue;
				const before = skillProgress(s.meta);
				const uses = (parseInt(s.meta.uses, 10) || 0) + 1;
				const meta = { ...s.meta, uses, updatedAt: new Date().toISOString() };
				if (s.skillDir) this._writePortableRuntimeMeta(s, meta);
				else this._writeFile(s.file, meta, s.body);
				s.meta = meta;
				const after = skillProgress(meta);
				events.push({ item: s, before, after, leveledUp: after.level > before.level });
			} catch { }
		}
		return events;
	}

	// write a LESSON (post-incident learning): fidelity gaps, failures, user
	// corrections. Overwrite-by-name with version bump, like learn().
	rememberLesson(rec) {
		const name = rec.name || "lesson";
		const file = path.join(this.memoryDir, slug(name) + ".md");
		const now = new Date().toISOString();
		let version = 1, createdAt = now;
		if (fs.existsSync(file)) {
			const prev = this._parse(file);
			version = (parseInt(prev.meta.version, 10) || 1) + 1;
			createdAt = prev.meta.createdAt || now;
		}
		this._writeFile(file, {
			name, tags: rec.tags || [], sector: rec.sector || "", version,
			provenance: rec.provenance || "", verified: true, createdAt, updatedAt: now,
			change_note: rec.change_note || "lesson recorded",
		}, rec.body || "");
		this.log("[skills] lesson '" + name + "' v" + version);
		return { file, version };
	}

	async _embedRank(queryText, skills, k) {
		const summaries = skills.map((s) => (s.meta.name || "") + ": " + ((s.meta.tags || []).join(" ")) + " " + s.body.slice(0, 300));
		const vecs = await this._embed([queryText, ...summaries]);
		if (!vecs.length || vecs.length !== summaries.length + 1) throw new Error("bad embed shape");
		const qv = vecs[0];
		const cos = (a, b) => {
			let d = 0, na = 0, nb = 0;
			for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
			return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
		};
		return skills.map((s, i) => ({ s, score: cos(qv, vecs[i + 1]) })).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.s);
	}

	_embed(inputs) {
		return new Promise((resolve, reject) => {
			let u;
			try { u = new URL(this.embedderUrl.replace(/\/$/, "") + "/embed"); } catch (e) { return reject(e); }
			const data = JSON.stringify({ input: inputs });
			const lib = u.protocol === "https:" ? https : http;
			const req = lib.request(u, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: 8000 }, (res) => {
				let b = "";
				res.on("data", (d) => b += d);
				res.on("end", () => { try { resolve((JSON.parse(b).embeddings) || []); } catch (e) { reject(e); } });
			});
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("embed timeout")));
			req.write(data);
			req.end();
		});
	}

	// GATED write-back — the caller MUST only invoke this after a verified-good
	// build. Never overwrites: archives the prior file as *.vN.md and bumps the
	// version with a change_note (provenance + versioning, like the TemplateStore).
	learn(rec) {
		const name = rec.name || "build";
		const file = path.join(this.skillsDir, slug(name) + ".md");
		const now = new Date().toISOString();
		let version = 1, createdAt = now, uses = 0, change_note = "created from verified build " + (rec.provenance || "");
		let before = skillProgress({ version, uses });
		if (fs.existsSync(file)) {
			const prev = this._parse(file);
			before = skillProgress(prev.meta);
			version = (parseInt(prev.meta.version, 10) || 1) + 1;
			createdAt = prev.meta.createdAt || now;
			uses = parseInt(prev.meta.uses, 10) || 0;
			change_note = "updated after verified build " + (rec.provenance || "");
			try { fs.copyFileSync(file, path.join(this.skillsDir, slug(name) + ".v" + (version - 1) + ".md")); } catch { }
		}
		this._writeFile(file, {
			name, tags: rec.tags || [], sector: rec.sector || "", version,
			provenance: rec.provenance || "", verified: true, uses, createdAt, updatedAt: now, change_note,
		}, rec.body || "");
		this.log("[skills] learned '" + name + "' v" + version);
		const after = skillProgress({ version, uses });
		return { file, version, uses, before, after, leveledUp: after.level > before.level };
	}
}

module.exports = { FelixSkills, slug, tokenize, skillProgress, SKILL_LEVELS, migrateLegacyStores, SKILL_STORE_MIGRATION, explicitScrollWorldRequest, hasExclusiveScrollWorldRoute, composeSkillsPrompt };
