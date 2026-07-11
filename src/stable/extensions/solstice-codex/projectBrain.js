"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function solsticeDir(root) { return path.join(path.resolve(root), ".solstice"); }
function brainDir(root) { return path.join(solsticeDir(root), "brain"); }
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

function captureBuild(root, info = {}) {
	if (!root) return null;
	const dir = ensureDir(brainDir(root));
	const sources = ["DECISIONS.md", "RESEARCH.md", "DECONSTRUCT.md", path.join(".solstice", "FIDELITY.md"), path.join(".solstice", "PLAN.md")];
	const sourceText = sources.map((rel) => read(path.join(root, rel), 8000)).filter(Boolean).join("\n");
	const record = {
		id: crypto.randomUUID(), projectId: projectId(root), capturedAt: new Date().toISOString(),
		prompt: String(info.prompt || "").slice(0, 1200), provider: info.provider || null,
		previewUrl: info.previewUrl || null, signals: signalsFrom(sourceText + "\n" + String(info.prompt || "")), sources: sources.filter((rel) => fs.existsSync(path.join(root, rel))),
	};
	fs.appendFileSync(path.join(dir, "builds.jsonl"), JSON.stringify(record) + "\n");
	const records = read(path.join(dir, "builds.jsonl"), 256000).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).slice(-20);
	const merged = { brand: [], design: [], technical: [], lessons: [] };
	for (const item of records) for (const key of Object.keys(merged)) merged[key].push(...((item.signals && item.signals[key]) || []));
	for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key])].slice(-30);
	const labels = { brand: "Brand & audience", design: "Design preferences", technical: "Technical decisions", lessons: "Lessons & constraints" };
	const memory = ["# Project Brain", "", `Project: ${record.projectId}`, `Updated: ${record.capturedAt}`, "", ...Object.keys(merged).flatMap((key) => [`## ${labels[key]}`, "", ...(merged[key].length ? merged[key].map((x) => "- " + x) : ["- No durable signal captured yet."]), ""]), "## Recent builds", "", ...records.slice(-5).reverse().map((x) => `- ${x.capturedAt} · ${String(x.prompt || "build").replace(/\s+/g, " ").slice(0, 140)}`), ""].join("\n");
	fs.writeFileSync(path.join(dir, "MEMORY.md"), memory);
	return { dir, record, memoryFile: path.join(dir, "MEMORY.md") };
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

module.exports = { captureBuild, projectContext, captureAnnotation, ensureScheduledCheck, dueScheduledChecks, checksFile, projectId, signalsFrom };
