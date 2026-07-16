"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	CANONICAL_BRAND_PACK,
	brandPackContext,
	installBrandPack,
	loadBrandPack,
	parseBrandPack,
} = require("./brandPack");

let passed = 0;
function ok(condition, message) { assert.ok(condition, message); passed += 1; }

const fixture = {
	schema_version: "1.0",
	domain: "client.example",
	name: { value: "Fallback name", effective: "מותג לדוגמה", source: "brand-dna" },
	logo: {
		primary: { value: "/logo.svg", effective: "/logo.svg" },
		icon: { value: null, effective: "/icon.png", is_fallback: true },
		variants: ["/logo-dark.svg"],
	},
	palette: {
		primary: { value: "#111111", effective: "#111111" },
		accent: { value: null, effective: "#D4A846", is_fallback: true },
		background: "#FAFAF5",
	},
	typography: {
		primary: { value: "Heebo", effective: "Heebo" },
		heading: { value: "Frank Ruhl Libre", effective: "Frank Ruhl Libre" },
		body: { value: "Heebo", effective: "Heebo" },
		families: ["Heebo", "Frank Ruhl Libre"],
	},
	color_scheme: { value: "light", effective: "light" },
	voice: {
		language: "עברית ישראלית",
		direction: "rtl",
		summary: "ישיר, חם וסמכותי",
		tone_adjectives: ["חם", "בטוח"],
		audience: ["לקוחות בישראל"],
		message_pillars: ["אמון", "שירות"],
		writing_style: "כותרות קצרות וקריאה ברורה לפעולה",
		sample_phrases: ["מתחילים כאן"],
	},
	visual: {
		mood: ["יוקרתי", "רגוע"],
		imagery_style: "צילום מסחרי ריאליסטי",
		do: ["שמור על RTL"],
		dont: ["אל תמציא טענות"],
	},
	imagery: { hero: { effective: "/hero.webp" }, local_images: ["images/one.webp"] },
};

(function run() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-brand-pack-"));
	const source = path.join(root, "incoming.json");
	fs.writeFileSync(source, JSON.stringify(fixture));

	const parsed = parseBrandPack(fs.readFileSync(source), "incoming.json");
	ok(parsed.schema_version === "1.0", "BrandDNA schema version is accepted without translation");
	ok(parsed.voice.direction === "rtl", "Hebrew voice and direction survive parsing");

	const installed = installBrandPack(root, source);
	ok(installed.relative === CANONICAL_BRAND_PACK, "import installs the canonical project-local BrandDNA path");
	ok(fs.existsSync(path.join(root, CANONICAL_BRAND_PACK)), "canonical brand pack exists on disk");
	ok(installed.document.name.effective === "מותג לדוגמה", "the original BrandDNA document remains semantically intact");
	ok(installed.compact.name === "מותג לדוגמה", "effective identity wins over raw value");
	ok(installed.compact.palette.accent === "#D4A846", "effective fallback colors remain usable");
	ok(installed.compact.fallback_fields.includes("palette.accent") && installed.compact.fallback_fields.includes("logo.icon"), "fallback provenance stays visible to the generation contract");
	ok(installed.compact.typography.heading === "Frank Ruhl Libre", "heading typography is normalized");
	ok(installed.compact.voice.tone_adjectives.includes("חם"), "tone is present in compact generation context");
	ok(installed.compact.visual.dont.includes("אל תמציא טענות"), "visual guardrails are present");
	ok(installed.compact.imagery.hero === "/hero.webp", "hero imagery is present");
	ok(/^[a-f0-9]{64}$/.test(installed.sha256), "loaded pack has a stable SHA-256 identity");

	const context = brandPackContext(root);
	ok(context.startsWith("[FELIX_BRAND_PACK]"), "prompt context has an explicit boundary");
	ok(context.includes("READ-ONLY") && context.includes("Never edit, delete, regenerate"), "Felix receives the read-only contract");
	ok(context.includes("untrusted brand content") && context.includes("prompt-injection"), "captured brand data cannot become model instructions");
	ok(context.includes("מותג לדוגמה") && context.includes("#111111") && context.includes("Heebo"), "identity, palette and typography reach generation context");
	ok(context.includes("ישיר, חם וסמכותי") && context.includes("שמור על RTL"), "voice and RTL design rules reach generation context");
	ok(context.includes("do not call or depend on an external Brand-DNA service"), "runtime stays independent from Jasper's service");
	ok(context.endsWith("[/FELIX_BRAND_PACK]\n"), "prompt context closes cleanly");

	fs.writeFileSync(path.join(root, "brand-dna.json"), JSON.stringify({ ...fixture, name: { effective: "root fallback" } }));
	ok(loadBrandPack(root).document.name.effective === "מותג לדוגמה", "canonical .solstice pack wins over a root fallback");

	const invalidHeading = { ...fixture, typography: { ...fixture.typography, heading: { effective: "inherit!important" } } };
	ok(require("./brandPack").compactBrandDna(invalidHeading).typography.heading === "Heebo", "invalid captured CSS cannot become a font-family instruction");

	let invalid = "";
	try { parseBrandPack(Buffer.from("{}"), "empty.json"); } catch (error) { invalid = error.message; }
	ok(invalid.includes("identity fields"), "unrelated JSON is rejected instead of silently becoming a brand pack");

	fs.writeFileSync(path.join(root, CANONICAL_BRAND_PACK), "{broken");
	const errorContext = brandPackContext(root);
	ok(errorContext.includes("[FELIX_BRAND_PACK_ERROR]") && errorContext.includes("Do not overwrite or repair"), "invalid project packs fail visibly and stay untouched");

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	ok(/sendClaude\(text\)[\s\S]*?withBrandPack\(text, cwd\)/.test(extension), "Claude turns receive project BrandDNA context");
	ok(/sendGrok\(text, rawText = text\)[\s\S]*?withBrandPack\(text, cwd\)/.test(extension), "Grok and Composer turns receive project BrandDNA context");
	ok(/startTurn\(threadId, text\)[\s\S]*?brandPackRootForThread\(threadId\)[\s\S]*?withBrandPack\(text, root\)/.test(extension), "Codex and Manager worktree turns receive their own project BrandDNA context");
	ok(/developerInstructions\(text = "", cwd = workspaceCwd\(\)\)[\s\S]*?this\.brandContext\(cwd\)/.test(extension), "new Codex threads receive BrandDNA at developer-instruction level");
	ok(/steer\(threadId, text\)[\s\S]*?withBrandPack\(text, this\.brandPackRootForThread\(threadId\)\)/.test(extension), "in-flight generation corrections retain BrandDNA context");

	fs.rmSync(root, { recursive: true, force: true });
	console.log(`brandPack.test.js: ${passed}/${passed} checks passed`);
})();
