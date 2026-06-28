#!/usr/bin/env node
"use strict";
// Solstice Deploy — minimal MCP stdio server exposing a real deploy_site tool.
// Copies a static site to /home/thomas/solstice-deploys/<name> and serves it on :8930.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEPLOY_ROOT = process.env.SOLSTICE_DEPLOY_ROOT || path.join(process.env.HOME || "/tmp", "solstice-deploys");
const PORT = Number(process.env.SOLSTICE_DEPLOY_PORT || 8930);
const SKIP = new Set(["node_modules", ".git", ".next", ".solstice", "dist"]);

function copyDir(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
		if (SKIP.has(ent.name)) continue;
		const s = path.join(src, ent.name);
		const d = path.join(dst, ent.name);
		if (ent.isDirectory()) copyDir(s, d);
		else if (ent.isFile()) fs.copyFileSync(s, d);
	}
}

function ensureServer() {
	const pidFile = path.join(DEPLOY_ROOT, ".server.pid");
	try {
		const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
		if (pid > 0) { process.kill(pid, 0); return; } // alive
	} catch { /* not running */ }
	const child = spawn(process.execPath, [path.join(__dirname, "static-server.js")], {
		detached: true, // intentional: deploy server must outlive the IDE (child.unref below)
		stdio: "ignore",
		windowsHide: true, // no console window on Windows
		env: { ...process.env, SOLSTICE_DEPLOY_ROOT: DEPLOY_ROOT, SOLSTICE_DEPLOY_PORT: String(PORT) },
	});
	child.unref();
	fs.mkdirSync(DEPLOY_ROOT, { recursive: true });
	fs.writeFileSync(pidFile, String(child.pid));
}

function deploySite(args) {
	const sourceDir = path.resolve(String(args.source_dir || "."));
	if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
		throw new Error("source_dir does not exist: " + sourceDir);
	}
	const name = String(args.name || path.basename(sourceDir))
		.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
	const target = path.join(DEPLOY_ROOT, name);
	fs.rmSync(target, { recursive: true, force: true });
	copyDir(sourceDir, target);
	ensureServer();
	const url = `http://localhost:${PORT}/${name}/`;
	const count = fs.readdirSync(target).length;
	return `Deployed ${count} top-level entries from ${sourceDir} to ${target}\nLive URL: ${url}`;
}

const TOOLS = [{
	name: "deploy_site",
	description: "Deploy a static site directory to the local Solstice deploy host and get a live URL. Use after building HTML/CSS/JS output (for Next.js, deploy the exported 'out' directory or the project root for plain HTML sites).",
	inputSchema: {
		type: "object",
		properties: {
			source_dir: { type: "string", description: "Absolute path of the directory to deploy" },
			name: { type: "string", description: "Site slug used in the URL (lowercase, dashes)" },
		},
		required: ["source_dir"],
	},
}];

// ---- MCP stdio loop (newline-delimited JSON-RPC) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		handle(msg);
	}
});

function handle(msg) {
	const { id, method, params } = msg;
	if (method === "initialize") {
		send({ jsonrpc: "2.0", id, result: {
			protocolVersion: (params && params.protocolVersion) || "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "solstice-deploy", version: "0.1.0" },
		}});
	} else if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
	} else if (method === "tools/call") {
		try {
			if (params.name !== "deploy_site") throw new Error("unknown tool: " + params.name);
			const text = deploySite(params.arguments || {});
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
		} catch (e) {
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
		}
	} else if (method === "ping") {
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (id !== undefined && method) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
	}
}

process.stdin.on("end", () => process.exit(0));
