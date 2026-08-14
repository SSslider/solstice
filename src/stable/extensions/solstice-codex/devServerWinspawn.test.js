"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { resolveNpmSpawn } = require("./preview");

const args = ["run", "dev"];

assert.equal(typeof resolveNpmSpawn, "function", "preview exports the npm spawn resolver for focused regression testing");

let resolverCalls = 0;
const linux = resolveNpmSpawn(args, {
	platform: "linux",
	resolve: () => { resolverCalls++; throw new Error("Linux must not use winspawn"); },
	find: () => { throw new Error("Linux must not probe Windows npm paths"); },
});
assert.deepEqual(linux, { command: "npm", args, env: null, shell: false }, "Linux/macOS keep the existing direct npm spawn behavior");
assert.equal(resolverCalls, 0, "non-Windows spawn is a strict winspawn no-op");

const augmentedEnv = { PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32" };
const windows = resolveNpmSpawn(args, {
	platform: "win32",
	find: (bin) => bin === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : null,
	resolve: (bin, incomingArgs) => {
		resolverCalls++;
		assert.equal(bin, "npm", "Windows resolves the npm command through winspawn");
		assert.deepEqual(incomingArgs, args, "winspawn receives the original npm arguments");
		return { cmd: "C:\\Program Files\\nodejs\\node.exe", args: ["npm-cli.js", ...incomingArgs], env: augmentedEnv };
	},
});
assert.deepEqual(windows, {
	command: "C:\\Program Files\\nodejs\\node.exe",
	args: ["npm-cli.js", ...args],
	env: augmentedEnv,
	shell: false,
}, "Windows uses winspawn's resolved command, arguments, and augmented PATH");
assert.equal(resolverCalls, 1, "Windows calls winspawn exactly once");

assert.throws(
	() => resolveNpmSpawn(args, { platform: "win32", find: () => null, resolve: () => { throw new Error("must not resolve missing npm"); } }),
	/npm was not found.*Windows PATH.*registry PATH.*npm prefix/i,
	"missing npm fails loudly with actionable Windows path diagnostics",
);

const previewSource = fs.readFileSync(path.join(__dirname, "preview.js"), "utf8");
assert.equal((previewSource.match(/resolveNpmSpawn\(args\)/g) || []).length, 2, "npm install and npm run dev both use the shared resolver");
assert.doesNotMatch(previewSource, /const npm = process\.platform === "win32" \? "npm\.cmd" : "npm"/, "no DevServer path spawns npm.cmd from the inherited GUI PATH");

const extensionSource = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const externalStart = extensionSource.indexOf('else if (m.type === "openExternal"');
const externalHandler = externalStart >= 0 ? extensionSource.slice(externalStart, externalStart + 900) : "";
assert.match(externalHandler, /vscode\.env\.openExternal/, "preview opens the external browser through VS Code's URI API");
assert.doesNotMatch(externalHandler, /spawn\(/, "external-browser opening does not depend on the GUI process PATH");
assert.match(externalHandler, /showErrorMessage/, "external-browser failures are visible instead of swallowed");

console.log("devServerWinspawn.test.js: 13/13 checks passed");
