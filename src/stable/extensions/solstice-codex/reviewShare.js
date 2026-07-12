"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { captureAnnotation } = require("./projectBrain");

const MAX_BODY = 16 * 1024;
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function solsticeDir(root) { return path.join(path.resolve(root), ".solstice"); }
function registryFile(root) { return path.join(solsticeDir(root), "review-shares.json"); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + "." + process.pid + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
	fs.renameSync(tmp, file);
}
function escapeHtml(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function safeArtifact(root, artifact) {
	const resolved = fs.realpathSync(path.resolve(artifact));
	const base = fs.realpathSync(path.join(solsticeDir(root), "walkthrough"));
	if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("review artifact must be an existing walkthrough directory");
	return resolved;
}
function newShareId() { return crypto.randomBytes(18).toString("base64url"); }

function reviewHtml({ shareId, manifest, quality, security }) {
	const live = manifest.liveUrl || manifest.previewUrl || "";
	const shots = [...(manifest.desktopScrollshots || []), manifest.mobileScreenshot].filter(Boolean);
	const findings = (quality.findings || []).slice(0, 12), securityFindings = (security && security.findings || []).slice(0, 12);
	return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solstice · ביקורת לקוח</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b0d12;color:#f5f3ed;font:15px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 20px 64px}header,.card{background:#121722;border:1px solid #252c3b;border-radius:18px;padding:22px;margin-bottom:18px}h1{margin:0 0 8px;font-size:clamp(26px,5vw,48px)}h2{margin-top:0}.meta{color:#aeb7c7}.score{display:inline-grid;place-items:center;width:92px;height:92px;border-radius:50%;border:6px solid #7be0b7;font-size:22px;font-weight:800}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}a,button{background:#f0c674;color:#17130b;border:0;border-radius:10px;padding:10px 15px;font-weight:750;text-decoration:none;cursor:pointer}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.gallery img{width:100%;border-radius:12px;border:1px solid #2b3344;background:#080a0e}ul{padding-inline-start:22px}textarea{width:100%;min-height:120px;background:#090c12;color:#fff;border:1px solid #39445a;border-radius:12px;padding:12px;font:inherit}#status{min-height:24px;color:#7be0b7;margin-top:8px}@media(max-width:600px){main{padding:16px 12px 44px}header,.card{padding:16px}.score{width:72px;height:72px}}
</style></head><body><main><header><div class="meta">עמוד ביקורת משותף · צפייה בלבד</div><h1>Solstice Build Walkthrough</h1><div class="actions">${live ? `<a href="${escapeHtml(live)}" target="_blank" rel="noopener noreferrer">פתיחת האתר החי</a>` : ""}<a href="./WALKTHROUGH.md" target="_blank">דוח מלא</a></div></header>
<section class="card"><h2>ציוני מסירה</h2><div class="actions"><div><div class="score">${escapeHtml(quality.score)}/100</div><p class="meta">Quality · Grade ${escapeHtml(quality.grade)} · LCP ${quality.lcpMs ? escapeHtml(quality.lcpMs) + "ms" : "לא נמדד"}</p></div>${security ? `<div><div class="score">${escapeHtml(security.score)}/100</div><p class="meta">Security · Grade ${escapeHtml(security.grade)}</p></div>` : ""}</div>${findings.length ? `<ul>${findings.map((x) => `<li><strong>${escapeHtml(x.check)}</strong> — ${escapeHtml(x.message)}</li>`).join("")}</ul>` : "<p>לא נמצאו ממצאי איכות פתוחים.</p>"}${securityFindings.length ? `<h3>ממצאי אבטחה</h3><ul>${securityFindings.map((x) => `<li><strong>${escapeHtml(x.check)}</strong> — ${escapeHtml(x.message)}</li>`).join("")}</ul>` : "<p>לא נמצאו ממצאי אבטחה פתוחים.</p>"}</section>
<section class="card"><h2>צילומי המסירה</h2><div class="gallery">${shots.map((shot, i) => `<a href="./${encodeURIComponent(shot)}" target="_blank"><img loading="lazy" src="./${encodeURIComponent(shot)}" alt="צילום מסירה ${i + 1}"></a>`).join("")}</div></section>
<section class="card"><h2>הערה לפליקס</h2><p class="meta">ההערה תיכנס ישירות לתור ה־artifact annotations של הפרויקט.</p><form id="comment"><textarea name="note" maxlength="2000" required placeholder="מה לשנות, איפה, ומה התוצאה הרצויה?"></textarea><div class="actions"><button type="submit">שליחת הערה</button></div><div id="status" role="status" aria-live="polite"></div></form></section>
</main><script>document.getElementById("comment").addEventListener("submit",async function(e){e.preventDefault();const s=document.getElementById("status"),n=this.note.value.trim();if(!n)return;s.textContent="שולח…";try{const r=await fetch("/review/${encodeURIComponent(shareId)}/comments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({note:n,artifact:"walkthrough:${encodeURIComponent(shareId)}"})});const j=await r.json();if(!r.ok)throw new Error(j.error||"שליחה נכשלה");this.reset();s.textContent="ההערה נקלטה בתור העבודה."}catch(x){s.textContent="לא הצלחתי לשלוח: "+x.message}});</script></body></html>`;
}

function registerReview(root, artifact, manifest, quality, security) {
	root = path.resolve(root); artifact = safeArtifact(root, artifact);
	const file = registryFile(root), registry = readJson(file, { version: 1, shares: {} });
	const shareId = newShareId();
	registry.shares[shareId] = { artifact, createdAt: new Date().toISOString(), revoked: false };
	writeJsonAtomic(file, registry);
	fs.writeFileSync(path.join(artifact, "index.html"), reviewHtml({ shareId, manifest, quality, security }));
	return { shareId, path: `/review/${shareId}/`, registry: file };
}

function sendJson(res, status, value) { res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_BODY) { reject(new Error("comment too large")); req.destroy(); } }); req.on("end", () => resolve(body)); req.on("error", reject); }); }
function createReviewHandler(root, onAnnotation = (workspace, artifact, note) => captureAnnotation(workspace, artifact, note)) {
	root = path.resolve(root);
	return async function reviewHandler(req, res) {
		const url = new URL(req.url || "/", "http://127.0.0.1"), match = url.pathname.match(/^\/review\/([A-Za-z0-9_-]{20,32})(?:\/(.*))?$/);
		if (!match) return false;
		const registry = readJson(registryFile(root), { shares: {} }), share = registry.shares && registry.shares[match[1]];
		if (!share || share.revoked) { sendJson(res, 404, { ok: false, error: "review_not_found" }); return true; }
		let artifact;
		try { artifact = safeArtifact(root, share.artifact); } catch { sendJson(res, 404, { ok: false, error: "review_not_found" }); return true; }
		const rest = match[2] || "index.html";
		if (req.method === "POST" && rest === "comments") {
			try {
				const payload = JSON.parse(await readBody(req));
				const note = String(payload.note || "").trim();
				if (!note || note.length > 2000) throw new Error("comment must contain 1-2000 characters");
				const saved = await onAnnotation(root, payload.artifact || `walkthrough:${match[1]}`, note);
				sendJson(res, 201, { ok: true, annotationId: saved.id });
			} catch (error) { sendJson(res, 400, { ok: false, error: error.message }); }
			return true;
		}
		if (req.method !== "GET" && req.method !== "HEAD") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return true; }
		let file;
		try {
			const decoded = decodeURIComponent(rest), candidate = path.resolve(artifact, decoded);
			if (candidate !== artifact && !candidate.startsWith(artifact + path.sep)) throw new Error("path escaped artifact");
			file = fs.realpathSync(candidate);
			if (file !== artifact && !file.startsWith(artifact + path.sep)) throw new Error("symlink escaped artifact");
		} catch { sendJson(res, 404, { ok: false, error: "asset_not_found" }); return true; }
		try {
			const stat = fs.statSync(file); if (!stat.isFile()) throw new Error("not file");
			res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length": stat.size, "x-content-type-options": "nosniff", "cache-control": path.basename(file) === "index.html" ? "no-store" : "public, max-age=3600" });
			if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
		} catch { sendJson(res, 404, { ok: false, error: "asset_not_found" }); }
		return true;
	};
}

function startReviewServer(root, port = 4179, host = "127.0.0.1", onAnnotation) {
	const handler = createReviewHandler(root, onAnnotation);
	const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) sendJson(res, 404, { ok: false, error: "not_found" }); });
	return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server)); });
}

if (require.main === module) {
	const root = process.argv[2], port = Number(process.argv[3] || 4179);
	if (!root) { console.error("usage: reviewShare.js <workspace> [port]"); process.exit(1); }
	startReviewServer(root, port, "0.0.0.0").then(() => console.log(`review server listening on http://0.0.0.0:${port}`)).catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { registerReview, createReviewHandler, startReviewServer, reviewHtml, registryFile };
