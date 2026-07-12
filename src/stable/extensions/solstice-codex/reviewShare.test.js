"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { registerReview, startReviewServer } = require("./reviewShare");
const { captureAnnotation } = require("./projectBrain");

function request(port, pathname, options = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: pathname, method: options.method || "GET", headers: options.headers || {} }, (res) => { let body = ""; res.on("data", (chunk) => body += chunk); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers })); });
		req.on("error", reject); if (options.body) req.write(options.body); req.end();
	});
}

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-review-"));
	const artifact = path.join(root, ".solstice", "walkthrough", "fixture"); fs.mkdirSync(artifact, { recursive: true });
	fs.writeFileSync(path.join(artifact, "mobile.png"), Buffer.from([137, 80, 78, 71]));
	fs.writeFileSync(path.join(artifact, "WALKTHROUGH.md"), "# Fixture\n");
	const review = registerReview(root, artifact, { previewUrl: "https://preview.example", liveUrl: "https://live.example", desktopScrollshots: [], mobileScreenshot: "mobile.png" }, { score: 96, grade: "A", lcpMs: 800, findings: [] });
	assert.match(review.shareId, /^[A-Za-z0-9_-]{20,32}$/);
	assert.match(fs.readFileSync(path.join(artifact, "index.html"), "utf8"), /פתיחת האתר החי/);
	const routed = [];
	const server = await startReviewServer(root, 0, "127.0.0.1", async (workspace, artifactName, note) => {
		routed.push({ workspace, artifactName, note });
		return captureAnnotation(workspace, artifactName, note);
	}); const port = server.address().port;
	try {
		const page = await request(port, review.path); assert.equal(page.status, 200); assert.match(page.body, /(ציון|ציוני) מסירה/);
		const asset = await request(port, review.path + "mobile.png"); assert.equal(asset.status, 200); assert.equal(asset.headers["content-type"], "image/png");
		const traversal = await request(port, review.path + "%2e%2e%2f%2e%2e%2fetc%2fpasswd"); assert.equal(traversal.status, 404);
		const malformed = await request(port, review.path + "%E0%A4%A"); assert.equal(malformed.status, 404);
		const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "private\n"); fs.symlinkSync(outside, path.join(artifact, "escape.txt"));
		const symlink = await request(port, review.path + "escape.txt"); assert.equal(symlink.status, 404);
		const comment = await request(port, review.path + "comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Please tighten the mobile spacing." }) });
		assert.equal(comment.status, 201); assert.equal(JSON.parse(comment.body).ok, true);
		assert.match(fs.readFileSync(path.join(root, ".solstice", "ANNOTATIONS.md"), "utf8"), /tighten the mobile spacing/);
		assert.equal(routed.length, 1); assert.equal(routed[0].note, "Please tighten the mobile spacing.");
		const invalid = await request(port, review.path + "comments", { method: "POST", body: "{}" }); assert.equal(invalid.status, 400);
		const missing = await request(port, "/review/not-a-real-id-1234567890/"); assert.equal(missing.status, 404);
		console.log("reviewShare: 12/12 checks passed");
	} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exit(1); });
