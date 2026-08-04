"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills, composeSkillsPrompt, hasExclusiveScrollWorldRoute } = require("./felixSkills");

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
		const explicitHits = hits;
		ok(hits[0].meta.name === "scroll-world-gpt-image", "explicit ScrollWorld name pins the skill above a heavily-used older skill");
		ok(hits.length === 1 && hits[0].retrieval.pinned && hits[0].retrieval.exclusive, "explicit ScrollWorld is an exclusive route, not one ranked skill among competitors");
		ok(hits[0].retrieval.reason === "explicit ScrollWorld route", "exclusive selection carries a human-readable reason");
		const composed = composeSkillsPrompt(hits);
		ok(composed.exclusive && composed.text.startsWith("[FELIX_ROUTE name=\"scroll-world-gpt-image\" exclusive=\"true\"]"), "exclusive prompt carries an unambiguous route marker for downstream contract suppression");
		ok(composed.injectedBytes === Buffer.byteLength(hits[0].body.trim()) && composed.text.includes("No copied website source when visual references are used."), "explicit route injects the complete SKILL.md contract, including its final boundary");
		ok(hasExclusiveScrollWorldRoute(composed.text) && hasExclusiveScrollWorldRoute("בנה אתר ScrollWorld מונפש"), "animated contract routing recognizes both the raw explicit request and composed route marker");
		const bundledContract = fs.readFileSync(path.join(__dirname, "prompts", "scroll-world", "SKILL.md"), "utf8");
		skills.recordUse(explicitHits);
		ok(fs.readFileSync(path.join(partial, "SKILL.md"), "utf8") === bundledContract, "recording runtime use does not rewrite or dilute the portable SKILL.md contract");
		ok(skills.list().find((item) => item.meta.name === "scroll-world-gpt-image").meta.uses === "1", "portable usage metadata persists in a sidecar and remains visible to ranking");
		ok(skills.runtimeDiagnostics(__dirname).status === "healthy", "managed usage metadata does not create a false bundled/runtime drift alarm");

		hits = await skills.retrieve("בנה אתר סקול וורלד למועדון כושר", 4);
		ok(hits[0].meta.name === "scroll-world-gpt-image" && hits[0].retrieval.pinned, "Hebrew ScrollWorld alias pins the same skill");

		hits = await skills.retrieve("cinematic scroll-scrub gpt image world", 4);
		ok(hits[0].meta.name === "scroll-world-gpt-image", "semantic relevance beats the capped use-count bonus");
		ok(/relevant term/.test(hits[0].retrieval.reason) && /capped/.test(hits[0].retrieval.reason), "ranked selection explains relevance and capped history bonus");

		fs.rmSync(path.join(partial, "references", "pipeline.md"));
		let diagnostics = skills.runtimeDiagnostics(__dirname);
		ok(diagnostics.status === "runtime-incomplete", "diagnostics expose a missing runtime resource instead of returning a silent partial list");
		ok(diagnostics.bundled.valid && diagnostics.runtime.valid && diagnostics.resources.some((item) => item.path === "references/pipeline.md" && item.status === "missing"), "diagnostics include validity, fingerprints and per-resource mismatch state");
		const repair = skills.repairScrollWorld(__dirname);
		ok(repair.status === "repaired" && fs.existsSync(repair.backup), "repair is recoverable and preserves the previous runtime directory");
		diagnostics = skills.runtimeDiagnostics(__dirname);
		ok(diagnostics.status === "healthy" && diagnostics.bundled.fingerprint === diagnostics.runtime.fingerprint, "repair restores a byte-identical healthy runtime contract");
		ok(skills.list().filter((item) => item.meta.name === "scroll-world-gpt-image").length === 1, "repair backup is kept outside the active skills list and cannot create duplicate routes");

		const extensionSource = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
		const skillsUiSource = fs.readFileSync(path.join(__dirname, "media", "skills.js"), "utf8");
		ok(extensionSource.includes("needsAnimatedWebsiteKit(out) && !hasExclusiveScrollWorldRoute(out)"), "final prompt composition suppresses the generic Animated Website Kit on the exclusive route");
		ok(extensionSource.includes("if (this._skillsDispatchBlocked) return;") && extensionSource.includes("ScrollWorld route blocked: runtime status is"), "explicit ScrollWorld fails closed before model dispatch when runtime truth is missing or unhealthy");
		ok(extensionSource.includes('recordSkillPrompt("codex"') && extensionSource.includes('recordSkillPrompt("grok"') && extensionSource.includes('recordSkillPrompt("claude"'), "Codex, Grok and Claude all record final prompt byte and fingerprint proof");
		ok(skillsUiSource.includes("FELIX RUNTIME DIAGNOSTICS") && skillsUiSource.includes("repairScrollWorld") && skillsUiSource.includes("exportDiagnostics"), "Skills UI exposes runtime truth, repair and one-click diagnostics export");

		console.log(`felixSkillSelection.test.js: ${checks}/${checks} checks passed`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
