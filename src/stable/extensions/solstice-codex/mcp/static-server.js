#!/usr/bin/env node
"use strict";
// Tiny static file host for Solstice deploys (spawned detached by deploy-server.js).

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = process.env.SOLSTICE_DEPLOY_ROOT || path.join(process.env.HOME || "/tmp", "solstice-deploys");
const PORT = Number(process.env.SOLSTICE_DEPLOY_PORT || 8930);

const MIME = {
	".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp",
	".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

http.createServer((req, res) => {
	try {
		const urlPath = decodeURIComponent(req.url.split("?")[0]);
		let file = path.normalize(path.join(ROOT, urlPath));
		if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
		if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
		res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	} catch {
		res.writeHead(500); res.end();
	}
}).listen(PORT, "127.0.0.1");
