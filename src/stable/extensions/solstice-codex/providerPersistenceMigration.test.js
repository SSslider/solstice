"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

function providerKeyImplementation() {
	const source = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const start = source.indexOf("\n\tproviderKey() {");
	const end = source.indexOf("\n\t// The CLI binary", start);
	assert.notEqual(start, -1, "providerKey() exists");
	assert.notEqual(end, -1, "providerKey() boundary exists");
	const method = source.slice(start + 2, end).replace(/^providerKey\(\)/, "function providerKey()");
	const runnerFor = (key) => String(key).startsWith("claude-") ? "claude" : "codex";
	return Function("runnerFor", `return (${method});`)(runnerFor);
}

test("persisted Grok providers migrate to the discovered Codex default", () => {
	const providerKey = providerKeyImplementation();
	for (const persistedProvider of ["composer-2.5", "grok-4.5"]) {
		const updates = [];
		const config = {
			get(key) {
				if (key === "provider") return persistedProvider;
				if (key === "allowClaude") return true;
				return undefined;
			},
			update(...args) {
				updates.push(args);
				return Promise.resolve();
			},
		};
		const controller = {
			_codexDefaultKey: "gpt-5.6-sol",
			_manualGrokSelected: false,
			_legacyDefaultProviderMigrated: false,
			cfg: () => config,
			cfgTarget: () => "workspace",
			claudeAllowed: () => true,
		};

		assert.equal(providerKey.call(controller), "gpt-5.6-sol", persistedProvider);
		assert.deepEqual(updates, [["provider", "codex-auto", "workspace"]], persistedProvider);
		assert.equal(controller._legacyDefaultProviderMigrated, true, persistedProvider);
	}
});
