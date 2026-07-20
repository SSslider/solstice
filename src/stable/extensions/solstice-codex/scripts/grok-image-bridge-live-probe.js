#!/usr/bin/env node
"use strict";

// Real acceptance probe for Part B. It launches the same GrokProvider used by
// Solstice, injects the shared capability block, and passes only when Grok calls
// the bridge and a validated workspace asset plus proof landing page exist.

const fs = require("fs");
const path = require("path");
const { GrokProvider } = require("../grok");
const { capabilityInstructions, validateRaster } = require("../webtools/image-bridge");

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		out[argv[i].slice(2)] = argv[++i];
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const workspace = path.resolve(args.workspace || "");
	if (!args.workspace || !fs.existsSync(workspace)) throw new Error("--workspace must point to an existing directory");
	const extensionPath = path.resolve(__dirname, "..");
	const relativeImageOutput = String(args.output || "public/images/grok-bridge-proof.png").replace(/\\/g, "/");
	const imageOutput = path.resolve(workspace, relativeImageOutput);
	const imageRel = path.relative(workspace, imageOutput);
	if (imageRel.startsWith("..") || path.isAbsolute(imageRel)) throw new Error("--output must stay inside --workspace");
	const skill = path.join(extensionPath, "prompts", "scroll-world", "SKILL.md");
	const engine = path.join(extensionPath, "prompts", "scroll-world", "references", "scrub-engine.js");
	const events = [];
	const errors = [];
	const provider = new GrokProvider({
		cwd: workspace,
		bin: args["grok-bin"] || "grok",
		extensionPath,
		env: { SOLSTICE_CODEX_BIN: args["codex-bin"] || process.env.SOLSTICE_CODEX_BIN || "" },
		log: (message) => process.stderr.write(String(message)),
		notify: (method, params) => {
			if (method === "error" || method === "turn/engineFailed") errors.push({ method, params });
			if (method === "item/completed" && params && params.item) {
				const item = params.item;
				if (item.type === "commandExecution" || item.type === "agentMessage" || item.type === "fileChange") {
					events.push({ type: item.type, command: item.command || "", exitCode: item.exitCode, text: String(item.text || "").slice(-1200), paths: (item.changes || []).map((change) => change.path) });
				}
			}
		},
	});
	const preamble = [
		"You are running inside the real Solstice Grok 4.5 provider acceptance probe.",
		capabilityInstructions({ extensionPath, nodePath: process.execPath, platform: process.platform }),
		`The adapted ScrollWorld skill is ${skill}; its portable engine is ${engine}. Read both before acting.`,
	].join("\n\n");
	const task = [
		"Prove you can use Solstice image generation end-to-end.",
		"1. Create .solstice/image-prompts/proof.txt with a detailed brief for one wide cinematic isometric desert observatory world: amber stone, cobalt night sky, brass instruments, three connected narrative zones, no text or logos.",
		`2. Use the exact Solstice image bridge from your capability instructions to generate exactly one image at ${relativeImageOutput}. Do not call bare codex. Do not use X-Field, Higgsfield, Seedance, Kling, or any paid provider.`,
		"3. Verify the bridge JSON says ok:true and the exact output exists with non-zero size.",
		`4. Build one dependency-free proof landing page in this workspace: index.html, styles.css, and scroll-world.js. Copy the adapted portable scrub engine into scroll-world.js and mount three chapters using ${relativeImageOutput} as the local still. The page must visibly change chapter copy as scroll advances, support reduced motion, and contain no placeholders or remote media.`,
		"5. Finish only after checking all four files exist. Do not start a server and do not generate another image.",
	].join("\n");
	await provider.send("grok-4.5", task, preamble, { userText: task });
	if (errors.length) throw new Error("Grok provider reported errors: " + JSON.stringify(errors).slice(-1600));
	const image = validateRaster(imageOutput);
	for (const file of ["index.html", "styles.css", "scroll-world.js"]) {
		if (!fs.existsSync(path.join(workspace, file))) throw new Error(`Grok did not create ${file}`);
	}
	const bridgeCommands = events.filter((event) => event.type === "commandExecution" && /image-bridge\.js/.test(event.command));
	if (!bridgeCommands.length) throw new Error("No image-bridge.js command was observed in the Grok provider event stream");
	if (bridgeCommands.some((event) => event.exitCode !== 0)) throw new Error("The observed image bridge command did not exit cleanly");
	const report = {
		ok: true,
		provider: "grok-4.5-via-solstice-grok-provider",
		capability: "agent+gpt-image-2",
		workspace,
		image: { path: imageOutput, ...image },
		bridgeCommands: bridgeCommands.map((event) => ({ command: event.command, exitCode: event.exitCode })),
		eventCount: events.length,
		files: ["index.html", "styles.css", "scroll-world.js", relativeImageOutput],
		completedAt: new Date().toISOString(),
	};
	fs.mkdirSync(path.join(workspace, ".solstice"), { recursive: true });
	fs.writeFileSync(path.join(workspace, ".solstice", "grok-image-probe.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
