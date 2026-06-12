"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
};

// Static file server over the workspace so Simple Browser can render the
// site the agent is building (iframe can't load file:// URLs).
class PreviewServer {
	constructor(root) {
		this.root = root;
		this.server = null;
		this.port = 0;
	}

	async ensure() {
		if (this.server) return this.port;
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		this.port = this.server.address().port;
		return this.port;
	}

	handle(req, res) {
		try {
			let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
			if (urlPath.endsWith("/")) urlPath += "index.html";
			const filePath = path.normalize(path.join(this.root, urlPath));
			if (!filePath.startsWith(path.normalize(this.root + path.sep)) && filePath !== path.normalize(this.root)) {
				res.writeHead(403); res.end("forbidden"); return;
			}
			let stat;
			try { stat = fs.statSync(filePath); } catch { res.writeHead(404); res.end("not found"); return; }
			if (stat.isDirectory()) {
				res.writeHead(302, { Location: urlPath.replace(/\/?$/, "/") }); res.end(); return;
			}
			res.writeHead(200, {
				"Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
				"Cache-Control": "no-store",
			});
			fs.createReadStream(filePath).pipe(res);
		} catch (e) {
			res.writeHead(500); res.end(String(e && e.message || e));
		}
	}

	dispose() {
		if (this.server) { this.server.close(); this.server = null; }
	}
}

module.exports = { PreviewServer };
