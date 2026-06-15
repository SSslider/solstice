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
const zlib = require("zlib");

const HOME = process.env.HOME || "/tmp";
// Scan every place agents actually build — not just solstice-deploys. Jasper &
// the fleet bridge build into solstice-bridge-work, so in-progress agent builds
// (e.g. the reform clone) must surface here too. First root that owns a slug wins.
const ROOTS = (process.env.SOLSTICE_DEPLOY_ROOTS
	? process.env.SOLSTICE_DEPLOY_ROOTS.split(":")
	: [
		process.env.SOLSTICE_DEPLOY_ROOT || path.join(HOME, "solstice-deploys"),
		path.join(HOME, "solstice-bridge-work"),
		path.join(HOME, "solstice-bridge-keep"),
		path.join(HOME, "Projects"),
	]
).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
const PORT = Number(process.env.SOLSTICE_GALLERY_PORT || 8931);
const HOST = process.env.SOLSTICE_GALLERY_HOST || "100.88.154.26"; // tailscale IP of srv1404664
const SKIP = new Set([
	"node_modules", ".git", ".next", "dist", "out",
	"userdata", "exthost-logs", "VSCode-linux-x64", "VSCode-darwin-arm64", "VSCode-win32-x64",
]);

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

// Build a slug -> { dir, st } index across all roots, cached briefly so the
// /preview and /p live-serving paths resolve to the right root cheaply.
let _idx = { at: 0, map: new Map() };
function indexMap() {
	const now = Date.now();
	if (now - _idx.at < 3000 && _idx.map.size) return _idx.map;
	const map = new Map();
	for (const root of ROOTS) {
		let names;
		try { names = fs.readdirSync(root); } catch { continue; }
		for (const name of names) {
			if (name.startsWith(".") || SKIP.has(name) || !safeName(name)) continue;
			if (map.has(name)) continue; // first root wins
			const dir = path.join(root, name);
			let st;
			try { st = fs.statSync(dir); } catch { continue; }
			if (!st.isDirectory()) continue;
			const isProject = ["package.json", "index.html", ".git", ".solstice"]
				.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });
			if (!isProject) continue;
			map.set(name, { dir, st });
		}
	}
	_idx = { at: now, map };
	return map;
}

function projectDir(name) {
	if (!safeName(name)) return null;
	const e = indexMap().get(name);
	return e ? e.dir : null;
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
	for (const [name, { dir, st }] of indexMap()) {
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

// ---- zip download (pure core: zlib only, no deps) --------------------------
// Walk a project dir (skipping heavy/regenerable dirs) and stream a real .zip
// so the IDE on Thomas's PC can pull a server-built project down to disk. A
// proper ZIP (deflate + central directory) opens natively in Windows Explorer.
const _CRC = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ _CRC[(c ^ buf[i]) & 0xff];
	return (~c) >>> 0;
}
function collectFiles(dir, base, out) {
	let names;
	try { names = fs.readdirSync(dir); } catch { return; }
	for (const name of names) {
		if (SKIP.has(name) || name === ".git") continue;
		const abs = path.join(dir, name);
		const rel = base ? base + "/" + name : name;
		let st; try { st = fs.statSync(abs); } catch { continue; }
		if (st.isDirectory()) collectFiles(abs, rel, out);
		else if (st.isFile() && st.size <= 25 * 1024 * 1024) out.push({ abs, rel });
	}
}
function buildZip(dir) {
	const files = [];
	collectFiles(dir, "", files);
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const f of files) {
		let data; try { data = fs.readFileSync(f.abs); } catch { continue; }
		const nameBuf = Buffer.from(f.rel, "utf8");
		const crc = crc32(data);
		const comp = zlib.deflateRawSync(data);
		const useStore = comp.length >= data.length;
		const body = useStore ? data : comp;
		const method = useStore ? 0 : 8;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, nameBuf, body);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(body.length, 20);
		cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([cd, nameBuf]));
		offset += local.length + nameBuf.length + body.length;
	}
	const cdBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length, 8);
	end.writeUInt16LE(central.length, 10);
	end.writeUInt32LE(cdBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cdBuf, end]);
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

		if (urlPath.startsWith("/zip/")) {
			const slug = urlPath.slice("/zip/".length).replace(/\/.*$/, "");
			const dir = projectDir(slug);
			if (!dir) { res.writeHead(404); res.end("unknown project"); return; }
			let buf;
			try { buf = buildZip(dir); } catch (e) { res.writeHead(500); res.end(String(e && e.message || e)); return; }
			res.writeHead(200, {
				"content-type": "application/zip",
				"content-length": buf.length,
				"content-disposition": `attachment; filename="${slug}.zip"`,
			});
			res.end(buf);
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
server.listen(PORT, HOST, () => console.log(`solstice gallery server on http://${HOST}:${PORT} (roots=${ROOTS.join(", ")})`));
