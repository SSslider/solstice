"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function solsticeDir(root) { return path.join(path.resolve(root), ".solstice"); }
function brainDir(root) { return path.join(solsticeDir(root), "brain"); }
function workspaceStateFile(root) { return path.join(brainDir(root), "WORKSPACE_STATE.md"); }
function read(file, limit = 16000) { try { return fs.readFileSync(file, "utf8").slice(0, limit); } catch { return ""; } }
function safeJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
function projectId(root) {
	const name = path.basename(path.resolve(root)).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "project";
	return name + "-" + crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);
}

function signalsFrom(text) {
	const groups = { brand: [], design: [], technical: [], lessons: [] };
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
		if (line.length < 12 || line.length > 360 || /^https?:\/\//i.test(line)) continue;
		if (/brand|voice|tone|audience|position|מותג|קהל|טון/i.test(line)) groups.brand.push(line);
		if (/design|visual|color|palette|typograph|layout|motion|rtl|עיצוב|צבע|טיפוגרפ|תנועה/i.test(line)) groups.design.push(line);
		if (/api|database|schema|auth|stack|framework|deploy|performance|technical|ארכיטקט|סכימה|אימות/i.test(line)) groups.technical.push(line);
		if (/lesson|learn|avoid|must|fixed|risk|לקח|אסור|חובה|תוקן|סיכון/i.test(line)) groups.lessons.push(line);
	}
	for (const key of Object.keys(groups)) groups[key] = [...new Set(groups[key])].slice(0, 12);
	return groups;
}

const FILE_MAP_LIMIT = 80;
const FILE_MAP_DEPTH = 5;
const SKIP_DIRS = new Set([".git", ".hg", ".next", ".nuxt", ".svelte-kit", ".turbo", "build", "coverage", "dist", "node_modules", "out", "vendor"]);
const SKIP_FILE_RE = /(?:^|\/)(?:\.env(?:\..*)?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(?:7z|avi|br|eot|gif|gz|ico|jpe?g|mov|mp3|mp4|pdf|png|tar|tgz|ttf|webm|webp|woff2?|zip)$/i;

function canonicalRoot(root) {
	let resolved = path.resolve(String(root || ""));
	try { resolved = fs.realpathSync.native(resolved); } catch { }
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// A bounded source-oriented map gives a fresh model enough orientation to act
// without repeating a recursive workspace inventory on every follow-up turn.
function compactFileMap(root, limit = FILE_MAP_LIMIT) {
	const base = path.resolve(root);
	const files = [];
	const walk = (dir, relDir, depth) => {
		if (depth > FILE_MAP_DEPTH || files.length >= limit * 4) return;
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
		catch { return; }
		for (const entry of entries) {
			const rel = relDir ? path.join(relDir, entry.name) : entry.name;
			const normalized = rel.split(path.sep).join("/");
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || (entry.name === ".solstice" && relDir === "")) continue;
				walk(path.join(dir, entry.name), rel, depth + 1);
			} else if (entry.isFile() && !SKIP_FILE_RE.test(normalized)) {
				files.push(normalized);
			}
			if (files.length >= limit * 4) break;
		}
	};
	walk(base, "", 0);
	return files.slice(0, Math.max(1, Number(limit) || FILE_MAP_LIMIT));
}

function processIsAlive(pid) {
	if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch (error) { return !!(error && error.code === "EPERM"); }
}

function registeredServerState(root) {
	const record = safeJson(path.join(solsticeDir(root), "dev-server.json"), null);
	if (!record || canonicalRoot(record.root) !== canonicalRoot(root)) return { status: "not registered", url: "", port: null };
	const port = Number(record.port), pid = Number(record.pid);
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return { status: "invalid registration", url: "", port: null };
	const live = processIsAlive(pid);
	return {
		status: live ? "workspace-owned process alive" : "stale registration",
		url: live ? `http://127.0.0.1:${port}/` : "",
		port,
	};
}

function packageSummary(root) {
	const pkg = safeJson(path.join(root, "package.json"), null);
	if (!pkg) return { stack: "unknown", command: "unknown" };
	const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
	const stack = ["next", "vite", "react", "astro", "nuxt", "@sveltejs/kit", "vue", "three"]
		.filter((name) => deps[name])
		.join(", ") || "Node project";
	const script = pkg.scripts && (pkg.scripts.dev ? "dev" : pkg.scripts.start ? "start" : "");
	return { stack, command: script ? `npm run ${script}` : "no dev/start script" };
}

function captureWorkspaceState(root, info = {}) {
	if (!root) return null;
	const dir = ensureDir(brainDir(root));
	const server = registeredServerState(root);
	const previewUrl = String(info.previewUrl || server.url || "").trim();
	const files = compactFileMap(root);
	const pkg = packageSummary(root);
	const plan = read(path.join(solsticeDir(root), "PLAN.md"), 12000);
	const completed = (plan.match(/^\s*-?\s*\[x\]/gim) || []).length;
	const active = (plan.match(/^\s*-?\s*\[~\]\s*(.+)$/im) || [])[1] || "none recorded";
	const body = [
		"# Felix Workspace State",
		"",
		`Updated: ${new Date().toISOString()}`,
		`Workspace: ${path.basename(path.resolve(root))}`,
		`Stack: ${pkg.stack}`,
		`Dev command: ${pkg.command}`,
		`Live preview: ${previewUrl || "not available"}`,
		`Dev server: ${server.status}${server.port ? ` · port ${server.port}` : ""}`,
		`Plan: ${completed} completed · active: ${String(active).trim().slice(0, 180)}`,
		"",
		`## File map (${files.length}${files.length >= FILE_MAP_LIMIT ? "+" : ""})`,
		"",
		...(files.length ? files.map((file) => `- ${file}`) : ["- Empty workspace"]),
		"",
	].join("\n");
	const file = workspaceStateFile(root);
	const tmp = path.join(dir, `.workspace-state.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, body, "utf8");
	try { fs.renameSync(tmp, file); }
	catch {
		try { fs.unlinkSync(file); } catch { }
		fs.renameSync(tmp, file);
	}
	return { file, previewUrl, server, files };
}

function workspaceContext(root) {
	if (!root) return "";
	const state = read(workspaceStateFile(root), 12000).trim();
	if (!state) return "";
	return [
		"[FELIX_WORKSPACE_STATE]",
		"Authoritative compact state captured after the latest completed turn in this workspace.",
		"Continue from it. Do not rescan the whole workspace unless a requested file is missing or this state proves stale.",
		state,
		"[/FELIX_WORKSPACE_STATE]",
		"",
	].join("\n");
}

function captureBuild(root, info = {}) {
	if (!root) return null;
	const dir = ensureDir(brainDir(root));
	const sources = ["DECISIONS.md", "RESEARCH.md", "DECONSTRUCT.md", path.join(".solstice", "FIDELITY.md"), path.join(".solstice", "PLAN.md")];
	const sourceText = sources.map((rel) => read(path.join(root, rel), 8000)).filter(Boolean).join("\n");
	const workspaceState = captureWorkspaceState(root, info);
	const record = {
		id: crypto.randomUUID(), projectId: projectId(root), capturedAt: new Date().toISOString(),
		prompt: String(info.prompt || "").slice(0, 1200), provider: info.provider || null,
		previewUrl: info.previewUrl || null, workspaceStateFile: workspaceState && workspaceState.file,
		signals: signalsFrom(sourceText + "\n" + String(info.prompt || "")), sources: sources.filter((rel) => fs.existsSync(path.join(root, rel))),
	};
	fs.appendFileSync(path.join(dir, "builds.jsonl"), JSON.stringify(record) + "\n");
	const records = read(path.join(dir, "builds.jsonl"), 256000).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).slice(-20);
	const merged = { brand: [], design: [], technical: [], lessons: [] };
	for (const item of records) for (const key of Object.keys(merged)) merged[key].push(...((item.signals && item.signals[key]) || []));
	for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key])].slice(-30);
	const labels = { brand: "Brand & audience", design: "Design preferences", technical: "Technical decisions", lessons: "Lessons & constraints" };
	const memory = ["# Project Brain", "", `Project: ${record.projectId}`, `Updated: ${record.capturedAt}`, "", ...Object.keys(merged).flatMap((key) => [`## ${labels[key]}`, "", ...(merged[key].length ? merged[key].map((x) => "- " + x) : ["- No durable signal captured yet."]), ""]), "## Recent builds", "", ...records.slice(-5).reverse().map((x) => `- ${x.capturedAt} · ${String(x.prompt || "build").replace(/\s+/g, " ").slice(0, 140)}`), ""].join("\n");
	fs.writeFileSync(path.join(dir, "MEMORY.md"), memory);
	return { dir, record, memoryFile: path.join(dir, "MEMORY.md"), workspaceStateFile: workspaceState && workspaceState.file };
}

function projectContext(root) {
	if (!root) return "";
	const memory = read(path.join(brainDir(root), "MEMORY.md"), 10000).trim();
	const annotations = read(path.join(solsticeDir(root), "ANNOTATIONS.md"), 5000).trim();
	if (!memory && !annotations) return "";
	return ["[FELIX_PROJECT_BRAIN]", "Durable context from earlier builds of this exact project. Respect it unless Thomas explicitly overrides it.", memory, annotations && "\nOpen artifact feedback:\n" + annotations, "[/FELIX_PROJECT_BRAIN]", ""].filter(Boolean).join("\n");
}

function captureAnnotation(root, artifact, note) {
	if (!root || !String(note || "").trim()) throw new Error("annotation requires workspace and note");
	const file = path.join(ensureDir(solsticeDir(root)), "ANNOTATIONS.md");
	if (!fs.existsSync(file)) fs.writeFileSync(file, "# Artifact annotations\n\n");
	const id = crypto.randomUUID();
	fs.appendFileSync(file, `## ${new Date().toISOString()} · ${String(artifact || "artifact")}\n\n- id: \`${id}\`\n- status: open\n- note: ${String(note).trim().replace(/\r?\n/g, " ")}\n\n`);
	return { id, file, prompt: `[FELIX_ARTIFACT_ANNOTATION]\nThomas commented on ${artifact || "the current artifact"}: ${String(note).trim()}\nCapture this in the active work queue, update the evolving PLAN.md, and address it without restarting the project.` };
}

function checksFile(root) { return path.join(solsticeDir(root), "SCHEDULED_CHECKS.json"); }
function ensureScheduledCheck(root, url) {
	if (!root || !url) return null;
	const file = checksFile(root); ensureDir(path.dirname(file));
	const cfg = safeJson(file, { version: 1, sites: [] });
	const normalized = String(url).replace(/\/$/, "");
	let site = cfg.sites.find((x) => x.url === normalized);
	if (!site) { site = { id: "production", url: normalized, enabled: true, intervalHours: 24, lastRunAt: null, lastResult: null }; cfg.sites.push(site); }
	writeJson(file, cfg); return { file, site };
}

function dueScheduledChecks(root, now = Date.now()) {
	const cfg = safeJson(checksFile(root), { sites: [] });
	return (cfg.sites || []).filter((site) => site.enabled !== false && (!site.lastRunAt || now - Date.parse(site.lastRunAt) >= Math.max(1, Number(site.intervalHours) || 24) * 3600000));
}

module.exports = {
	captureBuild,
	captureWorkspaceState,
	compactFileMap,
	workspaceContext,
	workspaceStateFile,
	projectContext,
	captureAnnotation,
	ensureScheduledCheck,
	dueScheduledChecks,
	checksFile,
	projectId,
	signalsFrom,
};
