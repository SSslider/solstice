"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills, composeSkillsPrompt } = require("./felixSkills");
const { generateImage } = require("./webtools/image-bridge");

function png(width = 512, height = 512) {
	const buffer = Buffer.alloc(32);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
	buffer.writeUInt32BE(13, 8);
	Buffer.from("IHDR").copy(buffer, 12);
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrollworld-route-e2e-"));
	try {
		const workspace = path.join(root, "workspace");
		const generatedRoot = path.join(root, "codex", "generated_images");
		fs.mkdirSync(workspace, { recursive: true });
		const skills = new FelixSkills({ dir: path.join(root, "skills") });
		skills.seedFrom(__dirname);
		const hits = await skills.retrieve("build a ScrollWorld site for a fitness coach", 4);
		const routed = composeSkillsPrompt(hits);
		assert.equal(routed.exclusive, true);
		assert.match(routed.text, /FELIX_ROUTE name="scroll-world-gpt-image" exclusive="true"/);

		const sessionId = "019f7c06-a93f-7551-8475-95b5b878e2e1";
		const delivered = generateImage({
			workspace,
			output: "public/scroll-world/stills/chapter-01.png",
			prompt: "Cinematic fitness world, cobalt and warm ivory, no text",
			generatedRoot,
			codexHome: path.join(root, "codex"),
			runCodex: () => {
				const dir = path.join(generatedRoot, sessionId);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "chapter.png"), png());
				return { code: 0, signal: null, error: null, stdout: JSON.stringify({ type: "thread.started", thread_id: sessionId }) + "\n", stderr: "" };
			},
		});
		assert.equal(delivered.ok, true);
		assert.equal(delivered.provider, "agent+gpt-image-2");
		assert.ok(fs.existsSync(delivered.output));

		assert.throws(() => generateImage({
			workspace,
			output: "public/scroll-world/stills/chapter-02.png",
			prompt: "Same world, next chapter",
			generatedRoot,
			runCodex: () => ({ code: 7, signal: null, error: null, stdout: "", stderr: "model gpt-image-2 is unavailable" }),
		}), (error) => error.code === "SCROLLWORLD_ENGINE_UNAVAILABLE" && /engine\/model unavailable/.test(error.message));

		console.log("scrollWorldRouteE2E.test.js: 8/8 checks passed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exit(1); });
