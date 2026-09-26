"use strict";

// Anthropic models in Felix have no native image generation. They must reach
// OpenAI GPT-Image-2 through the Solstice bridge, and headless Claude denies
// every Bash call that is not allow-listed — so the bridge command head must be
// both what the preamble teaches and what --allowedTools permits.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { bridgeCommandPrefix, capabilityInstructions } = require("./webtools/image-bridge");
const { MODEL_REGISTRY } = require("./grok");

let checks = 0;
const ok = (fn) => { fn(); checks++; };

for (const platform of ["linux", "darwin", "win32"]) {
	const opts = { extensionPath: "/ext dir", nodePath: "/opt/Sol stice/node", platform };
	const prefix = bridgeCommandPrefix(opts);
	ok(() => assert.match(prefix, / generate$/));
	ok(() => assert.ok(capabilityInstructions(opts).includes(prefix + " --workspace"), `${platform}: taught command must start with the allow-listed head`));
}

const ext = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const method = (name) => {
	const m = ext.match(new RegExp(`\\n\\t${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\t\\}\\n`));
	assert.ok(m, `method ${name} not found`);
	return m[1];
};

ok(() => assert.match(method("claudeDevServerAllowedTools"), /\.\.\.this\.solsticeToolCommandPrefixes\(\)\.map\(\(prefix\) => `\$\{prefix\}:\*`\)/));
ok(() => assert.match(method("solsticeToolCommandPrefixes"), /imageBridgeCommandPrefix\(/));
ok(() => assert.match(ext, /permissionMode: this\.claudePermissionMode\(\),/));

// claudePermissionMode: explicit setting wins, else autonomy decides.
const permission = new Function(method("claudePermissionMode"));
const fake = (autonomy, inspected) => ({
	autonomyLevel: () => autonomy,
	cfg: () => ({ inspect: () => inspected }),
});
ok(() => assert.equal(permission.call(fake("autonomous", {})), "bypassPermissions"));
ok(() => assert.equal(permission.call(fake("supervised", {})), "acceptEdits"));
ok(() => assert.equal(permission.call(fake("auto-edit", undefined)), "acceptEdits"));
ok(() => assert.equal(permission.call(fake("autonomous", { globalValue: "acceptEdits" })), "acceptEdits"));
ok(() => assert.equal(permission.call(fake("supervised", { workspaceValue: "bypassPermissions" })), "bypassPermissions"));

// The Claude preamble tells the model where its images come from.
const pre = ext.match(/\n\tclaudePreamble\(text = ""\) \{([\s\S]*?)\n\t\}\n/)[1];
ok(() => assert.match(pre, /no native image generation[\s\S]{0,200}GPT-Image-2[\s\S]{0,120}pre-approved/));
ok(() => assert.match(pre, /this\.imageCapabilityInstructions\(\)/));

// Opus 5.5 is selectable, manual-only, and listed first among Claude models.
const opus = MODEL_REGISTRY["claude-opus-5-5"];
ok(() => assert.equal(opus && opus.claudeId, "claude-opus-5-5"));
ok(() => assert.ok(opus.manualOnly && opus.gated && opus.runner === "claude"));
ok(() => assert.match(ext, /for \(const key of \["claude-opus-5-5", "claude-opus-5",/));

console.log(`claudeImageAccess.test.js: ${checks}/${checks} checks passed`);
