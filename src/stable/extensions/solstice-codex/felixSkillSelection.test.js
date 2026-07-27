"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills } = require("./felixSkills");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-skill-selection-"));
	const store = path.join(root, "felix-skills");
	const partial = path.join(store, "skills", "scroll-world-gpt-image");
	fs.mkdirSync(partial, { recursive: true });
	fs.writeFileSync(path.join(partial, "stale-install.txt"), "04097 partial install");
	const logs = [];
	try {
		const skills = new FelixSkills({ dir: store, log: (message) => logs.push(message) });
		const seeded = skills.seedFrom(__dirname);
		ok(seeded.scrollWorld.status === "repaired", "partial ScrollWorld install self-heals at startup");
		ok(fs.existsSync(path.join(partial, "SKILL.md")), "self-heal restores portable SKILL.md");
		ok(logs.some((line) => /self-healed directory seed scroll-world-gpt-image/.test(line)), "self-heal emits a visible diagnostic log");
		fs.rmSync(path.join(partial, "references", "pipeline.md"));
		const resourceRepair = skills.seedFrom(__dirname);
		ok(resourceRepair.scrollWorld.status === "repaired" && resourceRepair.scrollWorld.copied === 1, "valid SKILL.md also self-heals a missing referenced resource");
		ok(fs.existsSync(path.join(partial, "references", "pipeline.md")), "resource self-heal restores the missing file without replacing the skill");

		const animated = skills.list().find((item) => item.meta.name === "animated-website-kit");
		const scrollWorld = skills.list().find((item) => item.meta.name === "scroll-world-gpt-image");
		ok(animated && scrollWorld, "both motion skills are present after seeding");
		ok(!animated.meta.tags.includes("scrollytelling") && animated.meta.tags.includes("general-motion"), "animated kit tags no longer claim ScrollWorld territory");

		animated.meta.uses = "250";
		skills._writeFile(animated.file, animated.meta, animated.body);
		let hits = await skills.retrieve("בנה אתר ScrollWorld למועדון כושר", 4);
		ok(hits[0].meta.name === "scroll-world-gpt-image", "explicit ScrollWorld name pins the skill above a heavily-used older skill");
		ok(hits[0].retrieval.pinned && hits[0].retrieval.reason === "explicit skill name", "pinned selection carries a human-readable reason");

		hits = await skills.retrieve("בנה אתר סקול וורלד למועדון כושר", 4);
		ok(hits[0].meta.name === "scroll-world-gpt-image" && hits[0].retrieval.pinned, "Hebrew ScrollWorld alias pins the same skill");

		hits = await skills.retrieve("cinematic scroll-scrub gpt image world", 4);
		ok(hits[0].meta.name === "scroll-world-gpt-image", "semantic relevance beats the capped use-count bonus");
		ok(/relevant term/.test(hits[0].retrieval.reason) && /capped/.test(hits[0].retrieval.reason), "ranked selection explains relevance and capped history bonus");

		console.log(`felixSkillSelection.test.js: ${checks}/${checks} checks passed`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
