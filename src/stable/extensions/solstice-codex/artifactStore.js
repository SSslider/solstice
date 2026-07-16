"use strict";

const fs = require("fs");
const path = require("path");

function safeTaskId(value) {
	return String(value || "build")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 96) || "build";
}

function atomicJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temp, file);
}

function artifactIndexFile(root) {
	return path.join(path.resolve(root), ".solstice", "artifacts", "index.json");
}

function readIndex(root) {
	try {
		const parsed = JSON.parse(fs.readFileSync(artifactIndexFile(root), "utf8"));
		return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
	} catch { return []; }
}

function relativeInside(root, target) {
	const base = path.resolve(root);
	const resolved = path.resolve(target);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("artifact path escapes workspace");
	return path.relative(base, resolved).split(path.sep).join("/");
}

function registerArtifact(root, record) {
	if (!record || !record.taskId || !record.path) throw new Error("artifact requires taskId and path");
	const taskId = safeTaskId(record.taskId);
	const normalized = {
		...record,
		taskId,
		path: relativeInside(root, record.path),
		createdAt: String(record.createdAt || new Date().toISOString()),
	};
	const existing = readIndex(root).filter((item) => !(item.taskId === taskId && item.path === normalized.path));
	const artifacts = [normalized, ...existing].slice(0, 80);
	atomicJson(artifactIndexFile(root), { version: 1, updatedAt: new Date().toISOString(), artifacts });
	return normalized;
}

function listArtifacts(root, taskId) {
	const wanted = taskId ? safeTaskId(taskId) : "";
	return readIndex(root).filter((item) => !wanted || item.taskId === wanted);
}

function latestGreenSelfCheck(root, taskId) {
	const base = path.join(path.resolve(root), ".solstice", "self-check", safeTaskId(taskId));
	let rounds = [];
	try {
		rounds = fs.readdirSync(base, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^round-\d+$/.test(entry.name))
			.map((entry) => ({ name: entry.name, round: Number(entry.name.slice(6)) }))
			.sort((a, b) => b.round - a.round);
	} catch { return null; }
	for (const item of rounds) {
		const dir = path.join(base, item.name);
		try {
			const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
			const desktop = path.join(dir, "desktop.png");
			const mobile = path.join(dir, "mobile.png");
			if (report.ok === true && fs.statSync(desktop).size > 0 && fs.statSync(mobile).size > 0) {
				return { taskId: safeTaskId(taskId), round: item.round, dir, report, desktop, mobile };
			}
		} catch { }
	}
	return null;
}

module.exports = {
	safeTaskId,
	artifactIndexFile,
	registerArtifact,
	listArtifacts,
	latestGreenSelfCheck,
};
