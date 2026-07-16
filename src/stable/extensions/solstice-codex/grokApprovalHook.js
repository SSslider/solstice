"use strict";

const http = require("http");
const {
	APPROVAL_TOKEN_ENV,
	APPROVAL_URL_ENV,
} = require("./grokApprovalBridge");

function readStdin(stream = process.stdin, limit = 128 * 1024) {
	return new Promise((resolve, reject) => {
		let body = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			body += chunk;
			if (body.length > limit) reject(new Error("hook_input_too_large"));
		});
		stream.on("end", () => resolve(body));
		stream.on("error", reject);
	});
}

function requestGrokApproval(input, env = process.env) {
	return new Promise((resolve, reject) => {
		const base = env[APPROVAL_URL_ENV];
		const token = env[APPROVAL_TOKEN_ENV];
		if (!base || !token) return resolve({ decision: "allow" });
		const url = new URL("/approval", base);
		const body = JSON.stringify(input || {});
		const req = http.request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				"x-solstice-approval-token": token,
			},
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				let parsed;
				try { parsed = JSON.parse(text || "{}"); }
				catch { return reject(new Error("invalid_approval_response")); }
				if (res.statusCode !== 200) return reject(new Error(parsed.reason || `approval_http_${res.statusCode}`));
				resolve(parsed);
			});
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function cliMain() {
	try {
		const input = JSON.parse(await readStdin() || "{}");
		const result = await requestGrokApproval(input);
		if (result && result.decision === "allow") {
			process.stdout.write('{"decision":"allow"}\n');
			return;
		}
		process.stdout.write(JSON.stringify({ decision: "deny", reason: result && result.reason || "Denied by Felix." }) + "\n");
		process.exitCode = 2;
	} catch (error) {
		process.stdout.write(JSON.stringify({ decision: "deny", reason: `Felix approval bridge unavailable: ${error && error.message || error}` }) + "\n");
		process.exitCode = 2;
	}
}

if (require.main === module) cliMain();

module.exports = { cliMain, readStdin, requestGrokApproval };
