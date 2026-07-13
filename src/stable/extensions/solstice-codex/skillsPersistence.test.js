"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills, skillProgress, SKILL_STORE_MIGRATION } = require("./felixSkills");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-skills-upgrade-"));
const oldBundle = path.join(root, "04093", "felix-skills");
const globalStorage = path.join(root, "userData", "globalStorage", "solstice.solstice-codex", "felix-skills");
fs.mkdirSync(path.join(oldBundle, "skills"), { recursive: true });
fs.writeFileSync(path.join(oldBundle, "skills", "dynamic-layout.md"), [
	"---",
	"name: dynamic-layout",
	"tags: layout, dynamic",
	"version: 2",
	"verified: true",
	"uses: 8",
	"createdAt: 2026-07-01T00:00:00.000Z",
	"updatedAt: 2026-07-12T00:00:00.000Z",
	"---",
	"# Dynamic layout skill",
].join("\n"));

// Upgrade 04093 -> 04094: import the old mutable bundle store once.
const v2 = new FelixSkills({ dir: globalStorage, legacyDirs: [oldBundle] });
const migrated = v2.list().find((item) => item.meta.name === "dynamic-layout");
assert.ok(migrated);
assert.equal(migrated.meta.uses, "8");
assert.equal(skillProgress(migrated.meta).xp, 1050);
assert.equal(skillProgress(migrated.meta).level, 3);
assert.ok(fs.existsSync(path.join(globalStorage, SKILL_STORE_MIGRATION)));
assert.ok(migrated.file.startsWith(globalStorage));

// Felix keeps growing after the update and writes the new skill to globalStorage.
const learned = v2.learn({ name: "dynamic-checkout", tags: ["checkout"], body: "# Dynamic checkout", provenance: "post-upgrade" });
assert.ok(fs.existsSync(learned.file));
assert.ok(learned.file.startsWith(globalStorage));

// Install the next version over it: same userData/globalStorage, exact state.
const v3 = new FelixSkills({ dir: globalStorage, legacyDirs: [path.join(root, "04094", "felix-skills")] });
const names = v3.list().map((item) => item.meta.name).sort();
assert.deepEqual(names, ["dynamic-checkout", "dynamic-layout"]);
const afterUpgrade = v3.list().find((item) => item.meta.name === "dynamic-layout");
assert.equal(afterUpgrade.meta.uses, "8");
assert.equal(skillProgress(afterUpgrade.meta).level, 3);
assert.equal(v3.list().find((item) => item.meta.name === "dynamic-checkout").meta.version, "1");

fs.rmSync(root, { recursive: true, force: true });
console.log("skillsPersistence.test.js: 12/12 checks passed");
