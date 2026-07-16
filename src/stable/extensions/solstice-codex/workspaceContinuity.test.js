"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	captureBuild,
	captureWorkspaceState,
	compactFileMap,
	workspaceContext,
	workspaceStateFile,
} = require("./projectBrain");
const { writeDevServerRegistration } = require("./preview");

let passed = 0;
function ok(value, name) { assert.ok(value, name); passed++; console.log("ok - " + name); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-workspace-state-"));
try {
	fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
		name: "continuity-fixture",
		scripts: { dev: "vite" },
		dependencies: { react: "latest", vite: "latest" },
	}, null, 2));
	fs.writeFileSync(path.join(root, "src", "main.jsx"), "export default 'site';\n");
	fs.writeFileSync(path.join(root, "src", "components", "Hero.jsx"), "export const Hero = () => null;\n");
	fs.writeFileSync(path.join(root, "node_modules", "ignored", "index.js"), "throw new Error('do not map');\n");
	fs.mkdirSync(path.join(root, ".solstice"), { recursive: true });
	fs.writeFileSync(path.join(root, ".solstice", "PLAN.md"), "- [x] Build shell\n- [~] Polish hero\n");
	writeDevServerRegistration(root, { port: 12654, pid: process.pid });

	const files = compactFileMap(root);
	ok(files.includes("package.json") && files.includes("src/main.jsx"), "compact map includes project source and config");
	ok(files.includes("src/components/Hero.jsx"), "compact map keeps nested source files");
	ok(!files.some((file) => file.includes("node_modules") || file.includes("WORKSPACE_STATE")), "compact map excludes dependencies and generated state");

	const first = captureWorkspaceState(root, { previewUrl: "http://127.0.0.1:41001/" });
	ok(fs.existsSync(first.file), "workspace state is written on disk");
	let state = fs.readFileSync(workspaceStateFile(root), "utf8");
	ok(state.includes("Live preview: http://127.0.0.1:41001/"), "state records the visible preview URL");
	ok(state.includes("workspace-owned process alive · port 12654"), "state records registered server ownership and port");
	ok(state.includes("Stack: vite, react") && state.includes("Dev command: npm run dev"), "state records stack and launch command");
	ok(state.includes("1 completed · active: Polish hero"), "state records current plan progress");

	const context = workspaceContext(root);
	ok(context.startsWith("[FELIX_WORKSPACE_STATE]"), "continuity context has an explicit opening boundary");
	ok(context.includes("Do not rescan the whole workspace"), "continuity contract forbids redundant inventory");
	ok(context.includes("[/FELIX_WORKSPACE_STATE]"), "continuity context has an explicit closing boundary");

	fs.writeFileSync(path.join(root, "src", "new-section.js"), "export const ready = true;\n");
	const build = captureBuild(root, { prompt: "Add a new section", provider: "Grok", previewUrl: "http://127.0.0.1:41002/" });
	state = fs.readFileSync(workspaceStateFile(root), "utf8");
	ok(build.workspaceStateFile === workspaceStateFile(root), "every build capture refreshes the workspace state");
	ok(state.includes("src/new-section.js"), "refreshed state sees newly built files");
	ok(state.includes("41002") && !state.includes("41001"), "refreshed state replaces stale preview metadata");

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const runtimeIndex = extension.indexOf("await this.handleRuntimeIntent(rawText)");
	const stateIndex = extension.indexOf("workspaceContext(workspaceCwd())");
	ok(runtimeIndex >= 0 && stateIndex > runtimeIndex, "runtime fast-path executes before workspace context or model dispatch");
	ok(/const \{ captureBuild, projectContext, workspaceContext,/.test(extension), "extension imports the workspace continuity provider");

	console.log(`${passed}/${passed} checks passed`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
