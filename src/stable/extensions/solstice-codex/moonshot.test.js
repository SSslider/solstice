"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MoonshotProvider, MOONSHOT_TOOLS, workspacePath } = require("./moonshot");

function sseResponse(payloads) {
	return {
		ok: true,
		status: 200,
		body: {
			async *[Symbol.asyncIterator]() {
				for (const payload of payloads) yield Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
				yield Buffer.from("data: [DONE]\n\n");
			},
		},
	};
}

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-moonshot-test-"));
	try {
		fs.writeFileSync(path.join(root, "sample.txt"), "MOONSHOT_FILE_OK\n", "utf8");
		assert.equal(MOONSHOT_TOOLS.length, 6);
		assert.throws(() => workspacePath(root, "../escape"), /outside the workspace/);
		const outside = `${root}-outside`;
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(root, "linked-outside"), "dir");
		assert.throws(() => workspacePath(root, "linked-outside/escape.txt"), /resolves outside the workspace/);
		fs.rmSync(outside, { recursive: true, force: true });

		const requests = [];
		let call = 0;
		const fetchImpl = async (url, init) => {
			requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
			call++;
			if (call === 1) {
				return sseResponse([
					{ choices: [{ delta: { reasoning_content: "Need file." } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"sample.txt\"}" } }] } }] },
				]);
			}
			return sseResponse([
				{ choices: [{ delta: { content: "MOONSHOT_TURN_OK" } }] },
				{ usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [] },
			]);
		};
		const events = [];
		const provider = new MoonshotProvider({
			cwd: root,
			apiKey: "secret-test-key",
			fetchImpl,
			notify: (method, params) => events.push({ method, params }),
			authorizeTool: async () => ({ decision: "deny" }),
		});
		await provider.send("Read sample.txt", "You are a test agent.");
		assert.equal(requests.length, 2);
		assert.equal(requests[0].url, "https://api.moonshot.ai/v1/chat/completions");
		assert.equal(requests[0].auth, "Bearer secret-test-key");
		assert.equal(requests[0].body.model, "kimi-k3");
		assert.equal(requests[0].body.reasoning_effort, "high");
		assert.equal(requests[1].body.messages.at(-1).role, "tool");
		assert.match(requests[1].body.messages.at(-1).content, /MOONSHOT_FILE_OK/);
		assert.ok(events.some((event) => event.method === "item/reasoning/textDelta"));
		assert.ok(events.some((event) => event.method === "item/agentMessage/delta" && event.params.delta === "MOONSHOT_TURN_OK"));
		assert.ok(events.some((event) => event.method === "turn/completed"));
		console.log("moonshot.test.js: 14/14 checks passed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
