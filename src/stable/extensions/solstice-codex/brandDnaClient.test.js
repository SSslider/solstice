"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
	BrandDnaClient,
	attachApprovedBrandDna,
	normalizeBrandInput,
} = require("./brandDnaClient");

const profile = {
	schema_version: "1.0",
	domain: "example.com",
	source_url: "https://example.com/",
	name: { effective: "Example" },
	logo: { primary: { effective: "https://example.com/logo.svg" }, icon: { effective: "" }, variants: [] },
	palette: { primary: { effective: "#112233" }, accent: { effective: "#ff8844" } },
	typography: { primary: { effective: "Inter" }, heading: { effective: "Inter" }, body: { effective: "Inter" }, families: ["Inter"] },
	imagery: { images: [], hero: { effective: "https://example.com/hero.jpg" } },
	color_scheme: { effective: "light" },
};

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

(async () => {
	const calls = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
			res.setHeader("content-type", req.url.includes("format=png") ? "image/png" : "application/json");
			if (req.url === "/health") res.end(JSON.stringify({ status: "ok", service: "brand-dna", version: "0.4.0" }));
			else if (req.url === "/extract") res.end(JSON.stringify(profile));
			else if (req.url === "/dna/example.com") res.end(JSON.stringify(profile));
			else if (req.url === "/recrawl/example.com") res.end(JSON.stringify({ status: "refreshed", profile }));
			else if (req.url === "/moodboard/example.com") res.end(JSON.stringify({ domain: "example.com", score: 91, passed: true, artifacts: {} }));
			else if (req.url === "/moodboard/example.com?format=png") res.end(Buffer.from("png"));
			else if (req.url === "/visual-brief/moshiko") res.end(JSON.stringify({ client_slug: "moshiko", critic: { score: 90, passed: true } }));
			else { res.statusCode = 404; res.end(JSON.stringify({ detail: "missing" })); }
		});
	});
	await listen(server);
	const client = new BrandDnaClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeout: 2000 });
	assert.equal((await client.health()).version, "0.4.0");
	assert.equal((await client.extract("example.com")).domain, "example.com");
	assert.equal((await client.profile("https://www.example.com/path")).name.effective, "Example");
	assert.equal((await client.recrawl("example.com")).status, "refreshed");
	assert.equal((await client.moodboard("example.com")).score, 91);
	assert.match(await client.moodboardPng("example.com"), /^data:image\/png;base64,/);
	assert.equal((await client.visualBrief("moshiko")).critic.passed, true);
	const extractCall = calls.find((call) => call.url === "/extract");
	assert.deepEqual(JSON.parse(extractCall.body), { url: "https://example.com/", refresh: false });
	assert.equal(normalizeBrandInput("HTTPS://WWW.Example.COM/a").domain, "example.com");
	assert.throws(() => normalizeBrandInput("file:///etc/passwd"), /public HTTP/);
	assert.throws(() => client.visualBrief("../../etc/passwd"), /invalid/);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-brand-dna-client-"));
	const attached = attachApprovedBrandDna(root, profile, { serviceVersion: "0.4.0", sourceUrl: profile.source_url });
	assert.equal(attached.file, path.join(root, ".solstice", "brand-dna.json"));
	assert.ok(fs.existsSync(attached.file));
	const approval = JSON.parse(fs.readFileSync(path.join(root, ".solstice", "brand-dna.approval.json"), "utf8"));
	assert.equal(approval.sha256, attached.sha256);
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(attached.file)).digest("hex"), attached.sha256);
	assert.equal(JSON.parse(fs.readFileSync(attached.file, "utf8")).domain, "example.com");
	fs.rmSync(root, { recursive: true, force: true });
	await close(server);
	console.log("brandDnaClient.test.js: 16/16 checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
