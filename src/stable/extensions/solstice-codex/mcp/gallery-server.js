#!/usr/bin/env node
"use strict";
// Solstice Gallery server — read-only HTTP API + live host for projects agents
// built on this server. Lets the Solstice IDE (running on Thomas's PC over
// Tailscale) show the server's ~/solstice-deploys gallery and open each site.
//
//   GET /api/projects        -> JSON [{ name, description, tags, updatedAt, hasPreview }]
//   GET /preview/<name>      -> representative preview image (best-effort)
//   GET /p/<name>/<path...>  -> serve the deployed site files (live preview)
//
// Bound to the Tailscale interface only (not the public IP) so the listing and
// sites are reachable from the tailnet PC without exposing them to the internet.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = process.env.SOLSTICE_DEPLOY_ROOT || path.join(process.env.HOME || "/tmp", "solstice-deploys");
const PORT = Number(process.env.SOLSTICE_GALLERY_PORT || 8931);
const HOST = process.env.SOLSTICE_GALLERY_HOST || "100.88.154.26"; // tailscale IP of srv1404664
const SKIP = new Set(["node_modules", ".git", ".next", "dist"]);

const MIME = {
	".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
	".mjs": "text/javascript", ".json": "application/json", ".png": "image/png",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif",
	".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
	".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

const PREVIEW_CANDIDATES = [
	".solstice/preview.png", "public/og.png", "public/og.jpg", "public/images/hero.png",
	"public/images/hero.jpg", "public/preview.png", "preview.png", "screenshot.png",
];

function safeName(name) {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes("..");
}

function projectDir(name) {
	if (!safeName(name)) return null;
	const dir = path.join(ROOT, name);
	try { if (fs.statSync(dir).isDirectory()) return dir; } catch { }
	return null;
}

function previewPath(dir) {
	for (const rel of PREVIEW_CANDIDATES) {
		const abs = path.join(dir, rel);
		try { if (fs.statSync(abs).isFile()) return abs; } catch { }
	}
	const imgDir = path.join(dir, "public", "images");
	try {
		const f = fs.readdirSync(imgDir).find((n) => /\.(png|jpe?g|webp)$/i.test(n));
		if (f) return path.join(imgDir, f);
	} catch { }
	return null;
}

function detectTags(dir) {
	let pkg = null;
	try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { }
	const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
	const tags = [];
	if (deps.next) tags.push("Next.js");
	else if (deps.vite) tags.push("Vite");
	if (deps.react) tags.push("React");
	if (deps.three || deps["@react-three/fiber"]) tags.push("three.js");
	if (deps.gsap || deps["framer-motion"]) tags.push("Motion");
	if (deps.tailwindcss) tags.push("Tailwind");
	if (!tags.length) {
		try { if (fs.statSync(path.join(dir, "index.html")).isFile()) tags.push("Static"); } catch { }
	}
	return { pkg, tags };
}

function listProjects() {
	const out = [];
	let names;
	try { names = fs.readdirSync(ROOT); } catch { return out; }
	for (const name of names) {
		if (name.startsWith(".")) continue;
		if (!safeName(name)) continue;
		const dir = path.join(ROOT, name);
		let st;
		try { st = fs.statSync(dir); } catch { continue; }
		if (!st.isDirectory()) continue;
		const isProject = ["package.json", "index.html", ".git", ".solstice"]
			.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });
		if (!isProject) continue;
		const { pkg, tags } = detectTags(dir);
		out.push({
			name: (pkg && pkg.name) || name,
			slug: name,
			description: (pkg && pkg.description) || "",
			tags,
			updatedAt: st.mtimeMs,
			hasPreview: !!previewPath(dir),
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

function sendFile(res, file) {
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
	res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
	fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
	try {
		res.setHeader("Access-Control-Allow-Origin", "*");
		const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

		if (urlPath === "/api/projects") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(listProjects()));
			return;
		}

		if (urlPath.startsWith("/preview/")) {
			const dir = projectDir(urlPath.slice("/preview/".length).replace(/\/.*$/, ""));
			const pv = dir && previewPath(dir);
			if (!pv) { res.writeHead(404); res.end(); return; }
			sendFile(res, pv);
			return;
		}

		if (urlPath.startsWith("/p/")) {
			const rest = urlPath.slice("/p/".length);
			const slug = rest.split("/")[0];
			const dir = projectDir(slug);
			if (!dir) { res.writeHead(404); res.end("unknown project"); return; }
			let sub = rest.slice(slug.length).replace(/^\//, "") || "index.html";
			let file = path.normalize(path.join(dir, sub));
			if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
			sendFile(res, file);
			return;
		}

		res.writeHead(404); res.end("not found");
	} catch {
		res.writeHead(500); res.end();
	}
});

server.on("error", (e) => { console.error("gallery-server error:", e.message); process.exit(1); });
server.listen(PORT, HOST, () => console.log(`solstice gallery server on http://${HOST}:${PORT} (root=${ROOT})`));
