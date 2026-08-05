"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const panel = fs.readFileSync(path.join(__dirname, "media", "brand-dna.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "brandDnaClient.js"), "utf8");

assert.ok(manifest.contributes.commands.some((item) => item.command === "solstice.agent.openBrandDna"));
assert.ok(manifest.contributes.menus["view/title"].some((item) => item.command === "solstice.agent.openBrandDna"));
assert.match(extension, /registerCommand\("solstice\.agent\.openBrandDna"/);
assert.match(extension, /new BrandDnaClient\(\)/);
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
assert.match(client, /http:\/\/127\.0\.0\.1:8794/);
assert.match(client, /Brand-DNA is unavailable/);

console.log("brandDnaIntegration.test.js: 19/19 checks passed");
