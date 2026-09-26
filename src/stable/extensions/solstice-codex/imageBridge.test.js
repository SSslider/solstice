"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	assertWorkspaceDestination,
	capabilityInstructions,
	generateImage,
	imageBridgeStatus,
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
		assert.ok(!args.includes("--full-auto"), "removed CLI flag must not return");
		assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
		assert.ok(args.includes('approval_policy="never"'));
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
assert.equal(imageBridgeStatus({ extensionPath: path.join(root, "extension") }).ok, true);
const missingStatus = imageBridgeStatus({ extensionPath: path.join(root, "missing-extension"), configuredPath: path.join(root, "missing-codex"), env: { PATH: "" } });
assert.equal(missingStatus.ok, false);
assert.match(missingStatus.message, /ScrollWorld image engine unavailable/);

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
console.log("imageBridge.test.js: 42/42 checks passed");

// Sandbox preflight: a nested codex started from a network-disabled Codex shell
// must fail in seconds with an actionable code, not after the 12-minute timeout.
(function sandboxPreflightGuards() {
	const { sandboxPreflight, defaultNetworkProbe } = require("./webtools/image-bridge");
	assert.throws(() => sandboxPreflight({ env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" }, probe: () => ({ ok: true }) }), (e) => e.code === "SANDBOX_BLOCKED" && /network_access=true/.test(e.message));
	assert.throws(() => sandboxPreflight({ env: {}, probe: () => ({ ok: false, error: "ENETUNREACH" }) }), (e) => e.code === "NETWORK_UNREACHABLE" && /ENETUNREACH/.test(e.message));
	assert.strictEqual(sandboxPreflight({ env: {}, probe: () => ({ ok: true }) }), true);
	// generateImage runs the preflight for real runs and passes the env through.
	const blockedWs = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-blocked-"));
	assert.throws(() => generateImage({ workspace: blockedWs, output: "blocked.png", prompt: "x", generatedRoot: blockedWs, runCodex: () => { throw new Error("must not spawn"); }, preflight: true, env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } }), (e) => e.code === "SANDBOX_BLOCKED");
	// The real probe against a closed local port fails fast, not after the timeout.
	const t0 = Date.now(); const closed = defaultNetworkProbe("127.0.0.1", 9, 3000);
	assert.strictEqual(closed.ok, false); assert.ok(Date.now() - t0 < 3000, "closed port must fail fast");
	console.log("sandbox preflight guards: ok");
})();

// Read-only CODEX_HOME (what the nested codex sees from inside the workspace
// sandbox, 18/09: "failed to initialize in-process app-server client:
// Read-only file system") must fall back to a private writable home in tmp,
// carrying the credentials only — never a directory inside the workspace.
(function writableHomeFallback() {
	const { ensureWritableCodexHome } = require("./webtools/image-bridge");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
	const writable = path.join(tmp, "writable"); fs.mkdirSync(writable);
	assert.deepStrictEqual(ensureWritableCodexHome(writable, { tmpdir: tmp }), { home: writable, fallback: false });
	const ro = path.join(tmp, "ro"); fs.mkdirSync(ro); fs.writeFileSync(path.join(ro, "auth.json"), "{\"t\":1}"); fs.writeFileSync(path.join(ro, "config.toml"), "x=1\n"); fs.chmodSync(ro, 0o500);
	try {
		const r = ensureWritableCodexHome(ro, { tmpdir: tmp });
		assert.strictEqual(r.fallback, true);
		assert.strictEqual(r.home, path.join(tmp, "solstice-image-bridge", "codex-home"));
		assert.strictEqual(fs.readFileSync(path.join(r.home, "auth.json"), "utf8"), "{\"t\":1}");
		assert.strictEqual(fs.statSync(path.join(r.home, "auth.json")).mode & 0o777, 0o600);
		assert.ok(!r.home.startsWith(ro), "fallback home must not live in the read-only tree");
	} finally { fs.chmodSync(ro, 0o700); }
	console.log("writable codex home fallback: ok");
})();

// Bundled codex without its code-mode host must be reported before any model
// turn, and only for the extension's own bin/ layout.
(function codeModeHostCheck() {
	const { missingCodeModeHost, imageBridgeStatus } = require("./webtools/image-bridge");
	const ext = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ext-"));
	fs.mkdirSync(path.join(ext, "webtools")); fs.writeFileSync(path.join(ext, "webtools", "image-bridge.js"), "");
	fs.mkdirSync(path.join(ext, "bin")); fs.writeFileSync(path.join(ext, "bin", "codex"), "#!/bin/sh\n"); fs.chmodSync(path.join(ext, "bin", "codex"), 0o755);
	assert.ok(missingCodeModeHost(path.join(ext, "bin", "codex")), "bundled codex without host is flagged");
	const st = imageBridgeStatus({ extensionPath: ext, configuredPath: path.join(ext, "bin", "codex") });
	assert.strictEqual(st.ok, false); assert.strictEqual(st.code, "SCROLLWORLD_ENGINE_INCOMPLETE");
	fs.writeFileSync(path.join(ext, "bin", process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host"), "");
	assert.strictEqual(missingCodeModeHost(path.join(ext, "bin", "codex")), "", "host present → ok");
	assert.strictEqual(imageBridgeStatus({ extensionPath: ext, configuredPath: path.join(ext, "bin", "codex") }).ok, true);
	const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "npm-codex-")); fs.writeFileSync(path.join(elsewhere, "codex"), "");
	assert.strictEqual(missingCodeModeHost(path.join(elsewhere, "codex")), "", "non-bundled codex is not checked");
	console.log("code-mode host check: ok");
})();
