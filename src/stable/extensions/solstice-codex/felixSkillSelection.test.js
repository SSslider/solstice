"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills, composeSkillsPrompt, explicitScrollWorldRequest, hasExclusiveScrollWorldRoute } = require("./felixSkills");

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
		ok(hits[0].retrieval.pinned && !hits[0].retrieval.exclusive, "explicit ScrollWorld mention pins ranking without creating an exclusive route");
		ok(hits[0].retrieval.reason === "explicit skill name", "explicit selection carries a human-readable ranking reason");
		const composed = composeSkillsPrompt(hits);
		ok(!composed.exclusive && !hasExclusiveScrollWorldRoute(composed.text), "ranked ScrollWorld mention does not emit an exclusive route marker");
		ok(composed.injectedBytes > 0, "ranked ScrollWorld selection still injects relevant skill context");
		ok(!hasExclusiveScrollWorldRoute("בנה אתר ScrollWorld מונפש"), "raw ScrollWorld mention is ranking-only — never exclusive without the FELIX_ROUTE marker");
		const bundledContract = fs.readFileSync(path.join(__dirname, "prompts", "scroll-world", "SKILL.md"), "utf8");
		skills.recordUse(explicitHits);
		ok(fs.readFileSync(path.join(partial, "SKILL.md"), "utf8") === bundledContract, "recording runtime use does not rewrite or dilute the portable SKILL.md contract");
		ok(skills.list().find((item) => item.meta.name === "scroll-world-gpt-image").meta.uses === "1", "portable usage metadata persists in a sidecar and remains visible to ranking");
		ok(skills.runtimeDiagnostics(__dirname).status === "healthy", "managed usage metadata does not create a false bundled/runtime drift alarm");

		// Name detection is deliberately broad and ranking-only. Natural Hebrew and
		// English phrasing must not be lost to build-verb ordering heuristics.
		const naturalScrollWorldMentions = [
			"בנה לי אתר עם ScrollWorld",
			"build a ScrollWorld site for a fitness coach",
			"בנה אתר ScrollWorld למועדון כושר",
			"בנה אתר סקול וורלד למועדון כושר",
			"תעשה לי אתר עם ScrollWorld",
			"אני רוצה אתר ScrollWorld",
			"I want a site built with ScrollWorld",
			"ScrollWorld please, build it",
			"צריך ScrollWorld לפרויקט",
		];
		for (const request of naturalScrollWorldMentions) {
			ok(explicitScrollWorldRequest(request), `ScrollWorld mention is detected for ranking: ${request}`);
			ok(!hasExclusiveScrollWorldRoute(request), `raw ScrollWorld mention stays non-exclusive: ${request}`);
		}
		ok(!explicitScrollWorldRequest("בנה לי אתר אנימציה יפה"), "text without a ScrollWorld mention stays outside named-skill ranking");
		ok(!explicitScrollWorldRequest(""), "empty text stays outside named-skill ranking");

		// The marker remains an output-only contract for downstream suppression.
		// Expanded negation pack (Orion 2026-08-05): בלי / במקום / חוץ מ- / rather than / skip
		// — locks the invariant at the real user-text decision point.
		const exclusiveMarker = '[FELIX_ROUTE name="scroll-world-gpt-image" exclusive="true"]';
		// Split by what each phrasing must DO, not by whether it mentions the name.
		// A single mixed list asserting one direction is how the negation bug got
		// locked in as required behaviour twice on 05/08.
		const nonExclusiveMentions = [
			"בנה לי אתר עם ScrollWorld",
			"למה ScrollWorld נכשל אתמול?",
			"מה ההבדל בין ScrollWorld ל-GSAP?",
			"ראיתי אתר עם scroll world, אבל תבנה לי לנדינג פשוט",
			"ScrollWorld היה רעיון גרוע",
		];
		// Negation is the one veto: "do not use X" must never pin or route to X.
		const negatedMentions = [
			"אל תשתמש ב-ScrollWorld, רוצה פשוט",
			"do NOT use ScrollWorld for this",
			"בנה אתר בלי ScrollWorld",
			"בלי ScrollWorld, רק לנדינג נקי",
			"במקום ScrollWorld תבנה לי לנדינג רגיל",
			"תבנה GSAP במקום ScrollWorld",
			"חוץ מ-ScrollWorld, כל דבר אחר בסדר",
			"הכל חוץ מ-ScrollWorld",
			"use simple animation rather than ScrollWorld",
			"rather than ScrollWorld, keep it a plain landing",
			"skip ScrollWorld, just a simple landing",
			"please skip ScrollWorld for this task",
		];
		ok(hasExclusiveScrollWorldRoute(exclusiveMarker), "case 1: explicit FELIX_ROUTE marker remains exclusive");
		for (const request of nonExclusiveMentions) {
			ok(explicitScrollWorldRequest(request), `mention is detected before ordinary ranking: ${request}`);
			ok(!hasExclusiveScrollWorldRoute(request), `mention cannot suppress alternatives without a route marker: ${request}`);
		}
		for (const request of negatedMentions) {
			ok(!explicitScrollWorldRequest(request), `negation must not pin or route to ScrollWorld: ${request}`);
			ok(!hasExclusiveScrollWorldRoute(request), `negation cannot suppress alternatives either: ${request}`);
		}
		ok(!hasExclusiveScrollWorldRoute("בנה לי אתר אנימציה יפה"), "plain animation request stays non-exclusive");
		ok(explicitScrollWorldRequest("בנה לי אתר עם ScrollWorld") && !hasExclusiveScrollWorldRoute("בנה לי אתר עם ScrollWorld"), "direct build request selects ScrollWorld while raw user text remains marker-free");

		hits = await skills.retrieve("אל תשתמש ב-ScrollWorld, רוצה משהו פשוט", 4);
		const negatedPrompt = composeSkillsPrompt(hits);
		ok(!hits.some((hit) => hit.retrieval && hit.retrieval.exclusive), "negated request does not create an exclusive retrieval hit");
		ok(!negatedPrompt.exclusive && !hasExclusiveScrollWorldRoute(negatedPrompt.text), "negated request stays non-exclusive through retrieve and compose");

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
