"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

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

class FelixSkills {
	constructor(opts) {
		this.dir = opts.dir;
		this.skillsDir = path.join(this.dir, "skills");
		this.memoryDir = path.join(this.dir, "memory");
		this.log = opts.log || (() => { });
		this.embedderUrl = (opts.embedderUrl || "").trim();
		try { fs.mkdirSync(this.skillsDir, { recursive: true }); fs.mkdirSync(this.memoryDir, { recursive: true }); } catch { }
	}

	// import the static design playbook as the seed skill, once.
	seedFrom(extensionPath) {
		const seedFile = path.join(this.skillsDir, "design-playbook.md");
		if (fs.existsSync(seedFile)) return;
		let src = "";
		try { src = fs.readFileSync(path.join(extensionPath, "prompts", "design-playbook.md"), "utf8"); } catch { return; }
		this._writeFile(seedFile, {
			name: "design-playbook", tags: ["design", "premium", "landing", "ui"], version: 1,
			provenance: "seed:prompts/design-playbook.md", verified: true,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), change_note: "seeded",
		}, src);
		this.log("[skills] seeded design-playbook");
	}

	_writeFile(file, meta, body) {
		const fm = ["---"];
		for (const k of ["name", "tags", "sector", "version", "provenance", "verified", "createdAt", "updatedAt", "change_note"]) {
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
		return { meta, body, file };
	}

	// active skills only — versioned archives (*.vN.md) are excluded.
	list() {
		let files = [];
		try { files = fs.readdirSync(this.skillsDir).filter((f) => f.endsWith(".md") && !/\.v\d+\.md$/.test(f)); } catch { }
		return files.map((f) => { try { return this._parse(path.join(this.skillsDir, f)); } catch { return null; } }).filter(Boolean);
	}

	// top-k skills relevant to a task. Embedder rank when configured, else
	// keyword/tag overlap. Never throws — retrieval must not block a build.
	async retrieve(queryText, k = 3) {
		const skills = this.list();
		if (!skills.length) return [];
		if (this.embedderUrl) {
			try { return await this._embedRank(queryText, skills, k); }
			catch (e) { this.log("[skills] embed rank failed, keyword fallback: " + (e && e.message || e)); }
		}
		const q = new Set(tokenize(queryText));
		return skills.map((s) => {
			const hay = tokenize((s.meta.name || "") + " " + ((s.meta.tags || []).join(" ")) + " " + (s.meta.sector || "") + " " + s.body.slice(0, 400));
			let score = 0;
			for (const t of hay) if (q.has(t)) score++;
			return { s, score };
		}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.s);
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
		let version = 1, createdAt = now, change_note = "created from verified build " + (rec.provenance || "");
		if (fs.existsSync(file)) {
			const prev = this._parse(file);
			version = (parseInt(prev.meta.version, 10) || 1) + 1;
			createdAt = prev.meta.createdAt || now;
			change_note = "updated after verified build " + (rec.provenance || "");
			try { fs.copyFileSync(file, path.join(this.skillsDir, slug(name) + ".v" + (version - 1) + ".md")); } catch { }
		}
		this._writeFile(file, {
			name, tags: rec.tags || [], sector: rec.sector || "", version,
			provenance: rec.provenance || "", verified: true, createdAt, updatedAt: now, change_note,
		}, rec.body || "");
		this.log("[skills] learned '" + name + "' v" + version);
		return { file, version };
	}
}

module.exports = { FelixSkills, slug, tokenize };
