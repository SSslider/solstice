"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const panel = fs.readFileSync(path.join(__dirname, "media", "brand-dna.js"), "utf8");
const foundationPanel = fs.readFileSync(path.join(__dirname, "media", "foundation.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "brandDnaClient.js"), "utf8");

assert.ok(manifest.contributes.commands.some((item) => item.command === "solstice.agent.openBrandDna"));
assert.ok(manifest.contributes.menus["view/title"].some((item) => item.command === "solstice.agent.openBrandDna"));
assert.ok(manifest.contributes.commands.some((item) => item.command === "solstice.agent.openFoundation"));
assert.ok(manifest.contributes.menus["view/title"].some((item) => item.command === "solstice.agent.openFoundation"));
assert.match(extension, /registerCommand\("solstice\.agent\.openBrandDna"/);
assert.match(extension, /new BrandDnaClient\(\{/);
assert.match(extension, /registerCommand\("solstice\.agent\.openFoundation"/);
assert.match(extension, /createWebviewPanel\("solstice\.foundation"/);
assert.match(extension, /brandDnaClient\.health\(\)/);
assert.match(extension, /brandDnaClient\.extract\(message\.url, false\)/);
assert.match(extension, /brandDnaClient\.moodboardPng\(message\.domain\)/);
assert.match(extension, /brandDnaClient\.visualBrief\(message\.clientSlug\)/);
assert.match(extension, /"Attach approved DNA"[\s\S]*?installBrandDnaDocument/);
assert.match(extension, /const ports = \[8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809\]/);
assert.doesNotMatch(extension, /const ports = \[[^\]]*8794/);
assert.match(panel, /profileCard\(\)/);
assert.match(panel, /moodboardCard\(\)/);
assert.match(panel, /briefCard\(\)/);
assert.match(panel, /צרף DNA מאושר לפרויקט/);
assert.match(panel, /Brand‑DNA לא זמין/);
assert.match(panel, /הטאב לא עובד על mock/);
assert.match(client, /http:\/\/100\.88\.154\.26:8794/);
assert.match(client, /x-brand-dna-key/);
assert.match(client, /Brand-DNA is unavailable/);
assert.match(foundationPanel, /\/api\/foundation\/businesses/);
assert.match(foundationPanel, /אין fallback לנתוני mock/);
assert.equal(manifest.contributes.configuration.properties["solstice.codex.brandDnaUrl"].default, "http://100.88.154.26:8794");
assert.match(manifest.contributes.configuration.properties["solstice.codex.foundationApiUrl"].default, /^https:\/\/srv1404664\.tailf3ebe4\.ts\.net:10000/);

console.log("brandDnaIntegration.test.js: 29/29 checks passed");
