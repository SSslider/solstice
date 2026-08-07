#!/usr/bin/env node
"use strict";

// One fail-closed image-generation path for every Solstice model. The model
// invokes this helper; the helper resolves the IDE-owned Codex binary, asks its
// native GPT-Image-2 capability for exactly one raster, then copies the asset
// itself. Codex is never trusted to deliver/copy the file into the workspace.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveCodexBinary } = require("../codexClient");
const { resolveWinSpawn, whichFull } = require("../winspawn");

const RASTER_EXT = /\.(png|jpe?g|webp)$/i;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

function bridgeError(message, code = "IMAGE_BRIDGE_FAILED") {
	const error = new Error(message);
	error.code = code;
	return error;
}

function existingRealpath(file) {
	try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function assertWorkspaceDestination(workspace, requested) {
	const root = existingRealpath(workspace);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw bridgeError(`workspace does not exist: ${root}`, "BAD_WORKSPACE");
	const destination = path.resolve(root, requested || "");
	const rel = path.relative(root, destination);
	if (!requested || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw bridgeError("output must be a file inside the workspace", "PATH_ESCAPE");
	}
	let cursor = root;
	for (const part of rel.split(path.sep).slice(0, -1)) {
		cursor = path.join(cursor, part);
		if (!fs.existsSync(cursor)) continue;
		if (fs.lstatSync(cursor).isSymbolicLink()) throw bridgeError(`output parent is a symlink: ${cursor}`, "PATH_ESCAPE");
	}
	if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
		throw bridgeError(`output is a symlink: ${destination}`, "PATH_ESCAPE");
	}
	return { root, destination, rel };
}

function pngDimensions(buffer) {
	if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
	return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) { offset++; continue; }
		const marker = buffer[offset + 1];
		if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
		if (offset + 4 > buffer.length) break;
		const length = buffer.readUInt16BE(offset + 2);
		if (length < 2 || offset + 2 + length > buffer.length) break;
		if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			return { format: "jpeg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
		}
		offset += 2 + length;
	}
	return null;
}

function webpDimensions(buffer) {
	if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
	const kind = buffer.toString("ascii", 12, 16);
	if (kind === "VP8X") {
		return {
			format: "webp",
			width: 1 + buffer.readUIntLE(24, 3),
			height: 1 + buffer.readUIntLE(27, 3),
		};
	}
	if (kind === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
		return { format: "webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
	}
	if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
		const bits = buffer.readUInt32LE(21);
		return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

function validateRaster(file) {
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size < 32) throw bridgeError("generated asset is empty or not a file", "INVALID_ASSET");
	const buffer = fs.readFileSync(file);
	const dimensions = pngDimensions(buffer) || jpegDimensions(buffer) || webpDimensions(buffer);
	if (!dimensions || !dimensions.width || !dimensions.height) throw bridgeError("generated asset has invalid raster magic or dimensions", "INVALID_ASSET");
	return { ...dimensions, bytes: stat.size };
}

function parseSessionId(stdout) {
	for (const line of String(stdout || "").split(/\r?\n/)) {
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const queue = [event];
		while (queue.length) {
			const value = queue.shift();
			if (!value || typeof value !== "object") continue;
			for (const [key, nested] of Object.entries(value)) {
				if (/^(thread|session)[_-]?id$/i.test(key) && typeof nested === "string" && /^[a-z0-9-]{8,}$/i.test(nested)) return nested;
				if (nested && typeof nested === "object") queue.push(nested);
			}
		}
	}
	return "";
}

function listRasterFiles(dir) {
	let entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const files = [];
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listRasterFiles(file));
		else if (entry.isFile() && RASTER_EXT.test(entry.name)) files.push(file);
	}
	return files.sort();
}

function atomicCopy(source, destination, overwrite = false) {
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	if (fs.existsSync(destination) && !overwrite) throw bridgeError(`output already exists: ${destination}`, "OUTPUT_EXISTS");
	const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	try {
		fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
		if (overwrite) fs.renameSync(temp, destination);
		else { fs.linkSync(temp, destination); fs.unlinkSync(temp); }
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { }
		throw error;
	}
}

function defaultCodexRun(bin, args, options) {
	const plan = resolveWinSpawn(bin, args);
	const env = { ...process.env, ...(options.env || {}), ...(plan.env || {}) };
	const result = spawnSync(plan.cmd, plan.args, {
		cwd: options.cwd,
		env,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		input: options.input || "",
		windowsHide: true,
		timeout: options.timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
	});
	return { code: typeof result.status === "number" ? result.status : -1, signal: result.signal, error: result.error, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function resolveBridgeCodex(extensionPath, configuredPath, env = process.env) {
	const explicit = configuredPath || env.SOLSTICE_CODEX_BIN || env.CODEX_BIN || "";
	return resolveCodexBinary(extensionPath, explicit);
}

function imageBridgeStatus({ extensionPath, configuredPath, env = process.env } = {}) {
	if (configuredPath && !fs.existsSync(configuredPath)) {
		return {
			ok: false,
			code: "SCROLLWORLD_ENGINE_UNAVAILABLE",
			message: `ScrollWorld image engine unavailable: the configured Codex path does not exist (${configuredPath}).`,
		};
	}
	const requested = resolveBridgeCodex(extensionPath || path.resolve(__dirname, ".."), configuredPath, env);
	const bin = whichFull(requested);
	if (!bin) {
		return {
			ok: false,
			code: "SCROLLWORLD_ENGINE_UNAVAILABLE",
			message: "ScrollWorld image engine unavailable: Solstice cannot find the Codex/GPT-Image-2 bridge executable. Install or configure Codex, then run the request again.",
		};
	}
	return { ok: true, bin };
}

function generateImage(options) {
	const { root, destination, rel } = assertWorkspaceDestination(options.workspace, options.output);
	const prompt = String(options.prompt || "").trim();
	if (!prompt) throw bridgeError("prompt is required", "BAD_PROMPT");
	const extensionPath = options.extensionPath || path.resolve(__dirname, "..");
	const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
	const generatedRoot = options.generatedRoot || path.join(codexHome, "generated_images");
	const readiness = options.runCodex ? null : imageBridgeStatus({ extensionPath, configuredPath: options.codexBin, env: options.env || process.env });
	if (readiness && !readiness.ok) throw bridgeError(readiness.message, readiness.code);
	const bin = readiness ? readiness.bin : resolveBridgeCodex(extensionPath, options.codexBin, options.env || process.env);
	const contract = [
		"Use the built-in image generation tool backed by GPT-Image-2.",
		"Generate exactly ONE raster image for the specification below.",
		"Do not run shell commands, do not copy or move files, and do not create any second image.",
		"Once the image-generation tool succeeds, finish immediately with a one-line confirmation.",
		"\nIMAGE SPECIFICATION:\n" + prompt,
	].join("\n");
	// Prompt travels on stdin: image briefs can be large and must not cross the
	// Windows CreateProcess/cmd-shim argument limit.
	const args = ["exec", "--skip-git-repo-check", "--full-auto", "--json", "-C", root, "-"];
	const run = options.runCodex || defaultCodexRun;
	const startedAt = Date.now();
	const result = run(bin, args, { cwd: root, env: { ...(options.env || {}), CODEX_HOME: codexHome }, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, input: contract });
	if (result.error) throw bridgeError(`ScrollWorld image engine unavailable: Codex/GPT-Image-2 failed to start (${result.error.message || result.error}).`, "SCROLLWORLD_ENGINE_UNAVAILABLE");
	if (result.signal || result.code !== 0) throw bridgeError(`ScrollWorld image engine/model unavailable: Codex/GPT-Image-2 exited ${result.signal || result.code}: ${String(result.stderr || result.stdout || "").slice(-800)}`, "SCROLLWORLD_ENGINE_UNAVAILABLE");
	const sessionId = parseSessionId(result.stdout);
	if (!sessionId) throw bridgeError("Codex exited without a parseable session id", "MISSING_SESSION");
	const sessionDir = path.join(generatedRoot, sessionId);
	const sessionRel = path.relative(generatedRoot, sessionDir);
	if (sessionRel.startsWith("..") || path.isAbsolute(sessionRel)) throw bridgeError("invalid Codex session path", "MISSING_SESSION");
	let realGeneratedRoot, realSessionDir;
	try { realGeneratedRoot = fs.realpathSync(generatedRoot); realSessionDir = fs.realpathSync(sessionDir); }
	catch { throw bridgeError(`Codex session output directory is missing: ${sessionId}`, "MISSING_SESSION"); }
	const realRel = path.relative(realGeneratedRoot, realSessionDir);
	if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw bridgeError("Codex session output escaped generated_images", "MISSING_SESSION");
	const assets = listRasterFiles(sessionDir);
	if (assets.length !== 1) throw bridgeError(`expected exactly one raster in Codex session ${sessionId}, found ${assets.length}`, "ASSET_COUNT");
	if (fs.statSync(assets[0]).mtimeMs < startedAt - 2000) throw bridgeError("Codex session raster predates this bridge invocation", "STALE_ASSET");
	const info = validateRaster(assets[0]);
	const outputExt = path.extname(destination).toLowerCase();
	const expected = info.format === "jpeg" ? new Set([".jpg", ".jpeg"]) : new Set([`.${info.format}`]);
	if (!expected.has(outputExt)) throw bridgeError(`output extension ${outputExt || "(none)"} does not match generated ${info.format}`, "FORMAT_MISMATCH");
	atomicCopy(assets[0], destination, Boolean(options.overwrite));
	const delivered = validateRaster(destination);
	return { ok: true, provider: "agent+gpt-image-2", sessionId, output: destination, relativeOutput: rel.replace(/\\/g, "/"), source: assets[0], ...delivered, sourceBytes: info.bytes };
}

function shellQuote(value, platform = process.platform) {
	const text = String(value);
	if (platform === "win32") return `"${text.replace(/"/g, '""')}"`;
	return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function capabilityInstructions({ extensionPath, nodePath = process.execPath, platform = process.platform } = {}) {
	const script = path.join(extensionPath || path.resolve(__dirname, ".."), "webtools", "image-bridge.js");
	const command = platform === "win32"
		? `cmd /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ""${String(nodePath).replace(/"/g, '""')}"" ""${String(script).replace(/"/g, '""')}"" generate --workspace ""<workspace>"" --output public/images/<descriptive-name>.png --prompt-file ""<workspace>/.solstice/image-prompts/<name>.txt"""`
		: `ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodePath, platform)} ${shellQuote(script, platform)} generate --workspace <workspace> --output public/images/<descriptive-name>.png --prompt-file <workspace>/.solstice/image-prompts/<name>.txt`;
	return [
		"- IMAGE GENERATION (available to this model through agent + GPT-Image-2):",
		`  Write one detailed image brief to a workspace prompt file, then run the Solstice-owned bridge: ${command}`,
		"  The bridge uses the IDE-bundled Codex image capability, isolates the Codex session, validates raster magic + dimensions, and atomically delivers the exact asset. Success means the JSON says ok:true AND the output exists; an exit code alone is never success.",
		"  GPT-Image-2 is the only still-image generation route. X-Field/Higgsfield/Seedance/Kling are video-only and always require Thomas's approval card, even in Autonomous.",
	].join("\n");
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i];
		if (!value.startsWith("--")) { out._.push(value); continue; }
		const key = value.slice(2);
		if (key === "force") { out.force = true; continue; }
		out[key] = argv[++i];
	}
	return out;
}

function cli(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const command = args._[0];
	if (!command || command === "help" || command === "--help") {
		console.log("Usage: image-bridge.js generate --workspace <dir> --output <relative-file> (--prompt <text> | --prompt-file <file>) [--codex-bin <file>] [--force]");
		return 0;
	}
	if (command !== "generate") throw bridgeError(`unknown command: ${command}`, "BAD_COMMAND");
	let prompt = args.prompt || "";
	if (args["prompt-file"]) prompt = fs.readFileSync(path.resolve(args["prompt-file"]), "utf8");
	const result = generateImage({ workspace: args.workspace, output: args.output, prompt, codexBin: args["codex-bin"], overwrite: args.force });
	console.log(JSON.stringify(result));
	return 0;
}

if (require.main === module) {
	try { process.exitCode = cli(); }
	catch (error) {
		console.error(JSON.stringify({ ok: false, code: error.code || "IMAGE_BRIDGE_FAILED", error: error.message }));
		process.exitCode = 1;
	}
}

module.exports = {
	assertWorkspaceDestination,
	capabilityInstructions,
	generateImage,
	imageBridgeStatus,
	listRasterFiles,
	parseSessionId,
	resolveBridgeCodex,
	validateRaster,
};
