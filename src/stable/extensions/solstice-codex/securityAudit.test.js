"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { auditSecurity, sourceScan } = require("./securityAudit");

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-security-"));
	try {
		fs.writeFileSync(path.join(root, "safe.js"), "const token = process.env.API_TOKEN;\n");
		let scan = sourceScan(root);
		assert.equal(scan.secrets.length, 0); assert.equal(scan.riskyInputs.length, 0);
		// Secret fixtures are assembled at runtime so the literal patterns never sit
		// in committed source (GitHub push protection would block the whole build).
		const fakeOpenai = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
		const fakeStripe = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
		fs.writeFileSync(path.join(root, "bad.js"), `const api_key = '${fakeOpenai}'; el.innerHTML = input;\n`);
		fs.writeFileSync(path.join(root, ".env.local"), `STRIPE_SECRET=${fakeStripe}\n`);
		scan = sourceScan(root);
		assert.equal(scan.secrets.length, 2); assert.equal(scan.riskyInputs.length, 1);
		const result = await auditSecurity(root, "http://fixture.test", { skipNpm: true, headers: { status: "complete", statusCode: 200, headers: {}, missing: ["content-security-policy", "x-content-type-options"] } });
		assert.equal(result.score, 45); assert.equal(result.grade, "F");
		assert.equal(result.findings.length, 5); assert.equal(result.headers.missing.length, 2);
		console.log("securityAudit.test.js: 8/8 checks passed");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exit(1); });
