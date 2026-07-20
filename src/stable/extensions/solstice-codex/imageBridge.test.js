"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	assertWorkspaceDestination,
	capabilityInstructions,
	generateImage,
	parseSessionId,
	resolveBridgeCodex,
	validateRaster,
} = require("./webtools/image-bridge");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-image-bridge-test-"));
const workspace = path.join(root, "workspace");
const generatedRoot = path.join(root, "codex", "generated_images");
fs.mkdirSync(workspace, { recursive: true });

function png(width = 640, height = 360) {
	const buffer = Buffer.alloc(32);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
	buffer.writeUInt32BE(13, 8); Buffer.from("IHDR").copy(buffer, 12);
	buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
	return buffer;
}

function fakeRun(session, files, result = {}) {
	return (_bin, args, options) => {
		const dir = path.join(generatedRoot, session);
		fs.mkdirSync(dir, { recursive: true });
		for (const [name, body] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), body);
		assert.equal(args[0], "exec");
		assert.ok(args.includes("--json"));
		assert.equal(args[args.length - 1], "-");
		assert.match(options.input, /Do not run shell commands, do not copy or move files/);
		return { code: 0, stdout: JSON.stringify({ type: "thread.started", thread_id: session }) + "\n", stderr: "", ...result };
	};
}

const session = "019f7c06-a93f-7551-8475-95b5b878cdf1";
const delivered = generateImage({
	workspace,
	output: "public/images/hero.png",
	prompt: "A cobalt sphere on warm ivory, no text",
	generatedRoot,
	codexHome: path.join(root, "codex"),
	runCodex: fakeRun(session, { "image.png": png() }),
});
assert.equal(delivered.ok, true);
assert.equal(delivered.provider, "agent+gpt-image-2");
assert.equal(delivered.width, 640);
assert.equal(delivered.height, 360);
assert.equal(validateRaster(path.join(workspace, "public/images/hero.png")).format, "png");
assert.equal(parseSessionId('{"params":{"threadId":"thread-12345678"}}'), "thread-12345678");

assert.throws(() => assertWorkspaceDestination(workspace, "../escape.png"), /inside the workspace/);
const linked = path.join(workspace, "linked");
fs.symlinkSync(root, linked);
assert.throws(() => assertWorkspaceDestination(workspace, "linked/escape.png"), /symlink/);

const noSession = () => ({ code: 0, stdout: "{}\n", stderr: "" });
assert.throws(() => generateImage({ workspace, output: "no-session.png", prompt: "x", generatedRoot, runCodex: noSession }), /session id/);

const multiSession = "019f7c06-a93f-7551-8475-95b5b878cdf2";
assert.throws(() => generateImage({ workspace, output: "multi.png", prompt: "x", generatedRoot, runCodex: fakeRun(multiSession, { "one.png": png(), "two.png": png() }) }), /found 2/);

const invalidSession = "019f7c06-a93f-7551-8475-95b5b878cdf3";
assert.throws(() => generateImage({ workspace, output: "invalid.png", prompt: "x", generatedRoot, runCodex: fakeRun(invalidSession, { "bad.png": Buffer.from("not an image") }) }), /invalid raster|empty/);

const mismatchSession = "019f7c06-a93f-7551-8475-95b5b878cdf9";
assert.throws(() => generateImage({ workspace, output: "wrong.jpg", prompt: "x", generatedRoot, runCodex: fakeRun(mismatchSession, { "image.png": png() }) }), /does not match generated png/);

const staleSession = "019f7c06-a93f-7551-8475-95b5b878cdf8";
const staleRun = fakeRun(staleSession, { "image.png": png() });
assert.throws(() => generateImage({ workspace, output: "stale.png", prompt: "x", generatedRoot, runCodex: (bin, args, options) => { const result = staleRun(bin, args, options); fs.utimesSync(path.join(generatedRoot, staleSession, "image.png"), new Date(0), new Date(0)); return result; } }), /predates this bridge invocation/);

const nonzeroSession = "019f7c06-a93f-7551-8475-95b5b878cdf4";
assert.throws(() => generateImage({ workspace, output: "failed.png", prompt: "x", generatedRoot, runCodex: fakeRun(nonzeroSession, { "image.png": png() }, { code: 7 }) }), /exited 7/);

const explicit = path.join(root, "codex-custom"); fs.writeFileSync(explicit, "");
assert.equal(resolveBridgeCodex(path.join(root, "extension"), explicit), explicit);
const bundledDir = path.join(root, "extension", "bin"); fs.mkdirSync(bundledDir, { recursive: true });
const bundled = path.join(bundledDir, process.platform === "win32" ? "codex.exe" : "codex"); fs.writeFileSync(bundled, "");
assert.equal(resolveBridgeCodex(path.join(root, "extension"), ""), bundled);

const capability = capabilityInstructions({ extensionPath: "/opt/solstice/extension", nodePath: "/opt/solstice/node", platform: "linux" });
assert.match(capability, /agent \+ GPT-Image-2/);
assert.match(capability, /image-bridge\.js['"]? generate/);
assert.match(capability, /exit code alone is never success/);
assert.match(capability, /X-Field\/Higgsfield\/Seedance\/Kling are video-only/);
assert.doesNotMatch(capability, /\bcodex exec\b/);
const windowsCapability = capabilityInstructions({ extensionPath: "C:\\Solstice\\extension", nodePath: "C:\\Solstice\\node.exe", platform: "win32" });
assert.match(windowsCapability, /cmd \/d \/s \/c/);
assert.match(windowsCapability, /set ELECTRON_RUN_AS_NODE=1&&/);
assert.match(windowsCapability, /""C:\\Solstice\\node\.exe""/);

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
assert.equal((extension.match(/this\.imageCapabilityInstructions\(\)/g) || []).length, 3);
const animated = fs.readFileSync(path.join(__dirname, "webtools", "animated-assets.js"), "utf8");
assert.match(animated, /generateImage\(\{ workspace: root/);
assert.doesNotMatch(animated, /function codexBinary|run\(codexBinary/);

fs.rmSync(root, { recursive: true, force: true });
console.log("imageBridge.test.js: 36/36 checks passed");
