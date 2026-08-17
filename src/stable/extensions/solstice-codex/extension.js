"use strict";
const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { CodexClient, resolveCodexBinary } = require("./codexClient");
const { checkCodexModelCompatibility } = require("./codexCompatibility");
const { isPureLaunchIntent, isExternalLaunchIntent, runtimeStopIntent } = require("./intent");
const { PreviewServer, DevServer, detectDevServerUrl, hasFramework } = require("./preview");
const { GrokProvider, GROK_MODELS, MODEL_REGISTRY, runnerFor, resolveGrokBinary, grokBundlePresent, killTree } = require("./grok");
const { ClaudeProvider } = require("./claude");
const { MoonshotProvider } = require("./moonshot");
const { ensureProviderConnection, providerCredential } = require("./providerOnboarding");
const { FleetBridge } = require("./fleetBridge");
const { FelixSkills, skillProgress, hasExclusiveScrollWorldRoute, composeSkillsPrompt } = require("./felixSkills");
const { selectVerticalTemplates, buildVerticalTemplatePack } = require("./verticalTemplates");
const { SkillInstaller } = require("./skillInstaller");
const { BrandDnaClient } = require("./brandDnaClient");
const { FoundationClient, foundationBusinessesUrl } = require("./foundationClient");
const { FelixLearning, LEARNING_MODE } = require("./felixLearning");
const { captureBuild, projectContext, workspaceContext, captureAnnotation, ensureScheduledCheck, dueScheduledChecks } = require("./projectBrain");
const { ManagerWorktrees } = require("./managerWorktrees");
const { createReviewHandler } = require("./reviewShare");
const { runBugbot } = require("./bugbot");
const { listenOnFirstAvailable } = require("./companionPort");
const { discoverCodexModels, discoverGrokModels, groupModels } = require("./modelDiscovery");
const { grokApprovalDescriptor, isSafeGrokTool } = require("./grokApprovalBridge");
const { listArtifacts } = require("./artifactStore");
const { BRAND_PACK_APPROVAL, CANONICAL_BRAND_PACK, brandPackContext, installBrandDnaDocument, installBrandPack, loadBrandPack } = require("./brandPack");
const {
	normalizeBrowserReport,
	selfCheckRoundDir,
	writeBrowserSelfCheckReport,
	buildBrowserFixPrompt,
} = require("./browserSelfCheck");
const {
	DevServerToolBridge,
	agentToolCommand,
	codexMcpConfigArgs,
	isSafeDevServerToolApproval,
	listOwnedDevServers,
	stopAllOwnedDevServers,
	stopOwnedDevServer,
} = require("./devServerTools");
const { capabilityInstructions: imageCapabilityInstructions, imageBridgeStatus } = require("./webtools/image-bridge");

// Resolve a bare CLI name against PATH the same way child_process.spawn would,
// so we can tell BEFORE spawning whether the model binary actually exists on
// this machine. On a packaged Windows/Mac desktop install the grok/claude/codex
// CLIs are usually NOT present (unlike the dev server, where they are installed
// and signed in), and a blind spawn just ENOENTs — see effectiveProvider().
function binOnPath(bin) {
	if (!bin) return false;
	// An explicit path was configured/bundled — trust existsSync.
	if (bin.includes("/") || bin.includes("\\")) {
		try { return fs.existsSync(bin); } catch { return false; }
	}
	const isWin = process.platform === "win32";
	const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
	const dirs = (process.env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			try { if (fs.existsSync(path.join(dir, bin + ext))) return true; } catch { /* ignore */ }
		}
	}
	return false;
}

// Subdirs that live alongside agent build workspaces but are not projects.
const GALLERY_SKIP_DIRS = new Set([
	"node_modules", "userdata", "exthost-logs",
	"VSCode-linux-x64", "VSCode-darwin-arm64", "VSCode-win32-x64",
]);

const SIDEBAR_FORWARDED = new Set([
	"thread/started",
	"turn/started",
	"turn/completed",
	"turn/plan/updated",
	"item/started",
	"item/completed",
	"item/agentMessage/delta",
	"item/reasoning/textDelta",
	"item/reasoning/summaryTextDelta",
	"item/commandExecution/outputDelta",
	"item/fileChange/patchUpdated",
	"item/mcpToolCall/progress",
	"account/rateLimits/updated",
	"turn/diff/updated",
	"error",
]);

const MANAGER_FORWARDED = new Set([
	...SIDEBAR_FORWARDED,
	"thread/status/changed",
	"thread/name/updated",
]);

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);
const PLAN_FILE_RE = /[\\/]\.solstice[\\/]PLAN\.md$/i;

function workspaceCwd() {
	const f = vscode.workspace.workspaceFolders;
	return f && f[0] ? f[0].uri.fsPath : undefined;
}

function digestText(value) {
	return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function digestFile(file) {
	try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return ""; }
}

function sourceCommit(extensionPath) {
	let dir = path.resolve(extensionPath || ".");
	for (let depth = 0; depth < 10; depth++) {
		const git = path.join(dir, ".git");
		try {
			if (fs.statSync(git).isDirectory()) {
				const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
				if (!head.startsWith("ref:")) return /^[a-f0-9]{40}$/i.test(head) ? head : "";
				const ref = head.slice(5).trim();
				const direct = path.join(git, ref);
				if (fs.existsSync(direct)) return fs.readFileSync(direct, "utf8").trim();
				const packed = fs.readFileSync(path.join(git, "packed-refs"), "utf8");
				const line = packed.split("\n").find((value) => value.endsWith(` ${ref}`));
				return line ? line.split(" ")[0] : "";
			}
		} catch { }
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "";
}

// roots a webview may load files from: bundled media + the workspace + the
// codex image output dir, so generated images render inline in the agent panel
function webviewResourceRoots(extensionUri) {
	const roots = [vscode.Uri.joinPath(extensionUri, "media")];
	const ws = vscode.workspace.workspaceFolders;
	if (ws) for (const f of ws) roots.push(f.uri);
	try { roots.push(vscode.Uri.file(path.join(os.homedir(), ".codex", "generated_images"))); } catch { }
	return roots;
}

const CREDIT_PROVIDERS = [
	{ re: /\bx[-\s]?field\b|אקס[-\s]?פילד/i, name: "X-Field" },
	{ re: /\bseedance\b|סידאנס/i, name: "Seedance" },
	{ re: /\bhiggsfield\b|היגספילד/i, name: "Higgsfield" },
	{ re: /\brunway\b|(?:ראנוויי|רנוויי)/i, name: "Runway" },
	{ re: /\bkling\b|קלינג/i, name: "Kling" },
	{ re: /\bsora\b|סורה/i, name: "Sora" },
	{ re: /\bveo\b|ואו/i, name: "Veo" },
	{ re: /\bpika\b|פיקה/i, name: "Pika" },
	{ re: /\bluma\b|לומה/i, name: "Luma" },
];
const CREDIT_VIDEO_PATTERNS = [
	{ re: /\b(generate|create|make|produce|render|gen)\b[\s\S]{0,120}\b(video|mp4|webm|movie|film)\b/i, label: "video generation" },
	{ re: /\b(video|mp4|webm|movie|film)\b[\s\S]{0,120}\b(generate|create|make|produce|render|gen)\b/i, label: "video generation" },
	{ re: /(?:וידאו|סרטון)[\s\S]{0,120}(?:צור|ליצור|ג'נרוט|ג׳נרוט|רנדר|הפק|הפיק|תפיק|יפיק|מפיק|נפיק|להפיק)/i, label: "video generation" },
	{ re: /(?:צור|ליצור|ג'נרוט|ג׳נרוט|רנדר|הפק|הפיק|תפיק|יפיק|מפיק|נפיק|להפיק)[\s\S]{0,120}(?:וידאו|סרטון)/i, label: "video generation" },
];
const CREDIT_3D_ASSET_PATTERNS = [
	{ re: /\b(generate|create|make|produce|render|gen)\b[\s\S]{0,120}\b(animation|3d|three[-\s]?d|3d[-\s]?model|model)\b/i, label: "3D/animation generation" },
	{ re: /\b(animation|3d|three[-\s]?d|3d[-\s]?model|model)\b[\s\S]{0,120}\b(generate|create|make|produce|render|gen)\b/i, label: "3D/animation generation" },
	{ re: /(?:אנימציה|תלת[-\s]?ממד|תלת\s?מימד|מודל\s?3d|מודל\s?תלת)[\s\S]{0,120}(?:צור|ליצור|ג'נרוט|ג׳נרוט|רנדר|הפק|הפיק|תפיק|יפיק|מפיק|נפיק|להפיק)/i, label: "3D/animation generation" },
	{ re: /(?:צור|ליצור|ג'נרוט|ג׳נרוט|רנדר|הפק|הפיק|תפיק|יפיק|מפיק|נפיק|להפיק)[\s\S]{0,120}(?:אנימציה|תלת[-\s]?ממד|תלת\s?מימד|מודל\s?3d|מודל\s?תלת)/i, label: "3D/animation generation" },
];
const LOCAL_FRONTEND_3D_PATTERN = /\b(three\.?js|three[-\s]?js|@react-three\/fiber|react[-\s]?three[-\s]?fiber|r3f|gsap|scrolltrigger|framer[-\s]?motion|css|webgl|canvas)\b/i;
const LOCAL_FRONTEND_BUILD_PATTERN = /\b(page|site|website|app|component|viewer|hero|frontend|front[-\s]?end|ui|layout|smooth(?:er)?|scroll|animate|animation)\b/i;

function creditRiskText(value, depth = 0) {
	if (value == null || depth > 4) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map((x) => creditRiskText(x, depth + 1)).join("\n");
	if (typeof value === "object") {
		return Object.entries(value)
			.map(([k, v]) => `${k}: ${creditRiskText(v, depth + 1)}`)
			.join("\n");
	}
	return "";
}

function creditRequestSummary(text) {
	if (/(?:וידאו|סרטון)|\b(video|mp4|webm|movie|film|clip)\b/i.test(text)) return "וידאו / קליפ";
	if (/(?:אנימציה|תלת[-\s]?ממד|תלת\s?מימד|מודל\s?3d|מודל\s?תלת)|\b(animation|3d|three[-\s]?d|3d[-\s]?model)\b/i.test(text)) return "נכס אנימציה / 3D";
	return "נכס מדיה בתשלום";
}

function creditEstimate(params) {
	if (params && typeof params === "object") {
		for (const key of ["creditEstimate", "estimatedCredits", "credits", "creditCost"]) {
			const value = params[key];
			if (value != null && String(value).trim()) return String(value).trim();
		}
	}
	return "חיוב קרדיטים חיצוני; הכמות המדויקת תלויה במודל, במשך וברזולוציה ותוצג אצל הספק לפני ההרצה";
}

function makeCreditRisk(label, text, params, provider = "ספק חיצוני") {
	return {
		label,
		detail: text.replace(/\s+/g, " ").trim().slice(0, 500),
		provider,
		creation: creditRequestSummary(text),
		creditEstimate: creditEstimate(params),
	};
}

function creditRiskSignal(method, params) {
	const text = `${method || ""}\n${creditRiskText(params)}`.slice(0, 12000);
	const provider = CREDIT_PROVIDERS.find((item) => item.re.test(text));
	if (provider) {
		return makeCreditRisk("paid video/3D provider", text, params, provider.name);
	}
	for (const p of CREDIT_VIDEO_PATTERNS) {
		if (p.re.test(text)) {
			return makeCreditRisk(p.label, text, params);
		}
	}
	if (LOCAL_FRONTEND_3D_PATTERN.test(text) && LOCAL_FRONTEND_BUILD_PATTERN.test(text)) {
		return null;
	}
	for (const p of CREDIT_3D_ASSET_PATTERNS) {
		if (p.re.test(text)) {
			return makeCreditRisk(p.label, text, params);
		}
	}
	return null;
}

function needsResearchContract(text) {
	const t = String(text || "");
	if (!t || /SOLSTICE_RESEARCH_CONTRACT/.test(t)) return false;
	const asksAnalysis = /\b(analy[sz]e|inspect|deconstruct|research|reference|references|inspiration|imitat(?:e|ion)|clone|recreate|study|break\s+down|style|look\s+like|based\s+on|attached)\b|(?:נתח|תנתח|לנתח|פרק|תפרק|לפרק|חקור|תחקור|רפרנס|רפרנסים|השראה|סגנון|כמו|לפי|מצורף)/i;
	const hasVisualTarget = /https?:\/\/|www\.|behance|dribbble|awwwards|\b(site|website|web\s*app|app|page|landing|screenshot|image|photo|picture|video|mp4|webm|motion|animation)\b|(?:אתר|אפליקציה|דף|עמוד|צילום|סקרינשוט|תמונה|וידאו|סרטון|אנימציה)/i;
	return asksAnalysis.test(t) && hasVisualTarget.test(t);
}

function siteReplicaSourceUrl(text) {
	const value = String(text || "");
	const asksReplica = /\b(clone|reclone|recreate|replica|replicate|mirror|rebuild\s+(?:this|the)\s+(?:site|website)|copy\s+(?:this|the)\s+(?:site|website))\b|(?:שכפל|לשכפל|שכפול|רפליקה|בנה\s+מחדש|תבנה\s+מחדש|העתק\s+את\s+האתר)/i.test(value);
	if (!asksReplica) return "";
	const match = value.match(/https?:\/\/[^\s<>'"`]+/i);
	return match ? match[0].replace(/[),.;!?\]}]+$/g, "") : "";
}

function needsSiteReplicaContract(text) {
	return !!siteReplicaSourceUrl(text) && !/SOLSTICE_SITE_REPLICA_CONTRACT/.test(String(text || ""));
}

function hasSiteReplicaAuthorization(text) {
	return /\b(my|our|ours|client(?:'s)?|customer(?:'s)?|owned|authorized|authorised|licensed|permission)\b|(?:שלי|שלנו|לקוח|הלקוח|בבעלות|מורשה|מורשית|רישיון|אישור להעתיק|אישור לשכפל)/i.test(String(text || ""));
}

function needsAnimatedWebsiteKit(text) {
	const t = String(text || "");
	if (!t || /SOLSTICE_ANIMATED_WEBSITE_KIT/.test(t)) return false;
	const asksSite = /\b(site|website|landing|homepage|page|web\s*app|microsite)\b|(?:אתר|דף|עמוד|לנדינג|נחיתה|מיניסייט)/i;
	const asksMotion = /\b(animated|animation|motion|scrollytelling|scroll[-\s]?telling|scroll[-\s]?scrub|scrolltrigger|gsap|parallax|sticky\s+scroll|apple[-\s]?style|cinematic|webgl|three\.?js|three[-\s]?js|react[-\s]?three[-\s]?fiber|r3f|shader|canvas\s+sequence|video\s+scroll)\b|(?:מונפש|אנימציה|תנועה|גלילה|פרלקס|תלת[-\s]?ממד|תלת\s?מימד|וובגל|קנבס|סינמטי|בסגנון\s+אפל)/i;
	return asksSite.test(t) && asksMotion.test(t);
}

const PROMPT_CACHE = new Map();
function promptText(rel) {
	if (PROMPT_CACHE.has(rel)) return PROMPT_CACHE.get(rel);
	let txt = "";
	try {
		txt = fs.readFileSync(path.join(__dirname, "prompts", rel), "utf8").trim();
	} catch { txt = ""; }
	PROMPT_CACHE.set(rel, txt);
	return txt;
}
function animatedWebsiteKitText() { return promptText("animated-website-kit.md"); }
function xfieldAnimatedWiringPlanText() { return promptText("xfield-animated-wiring-plan.md"); }
function toolboxRouterText() { return promptText("felix-toolbox-router.md"); }
function gapAnalysisPlaybookText() { return promptText("gap-analysis-playbook.md"); }

function selectedVerticalTemplates(text) {
	return buildVerticalTemplatePack(text, promptText).blocks;
}

function needsVerticalTemplatePack(text) {
	const t = String(text || "");
	if (!t || /SOLSTICE_VERTICAL_TEMPLATE_PACK/.test(t)) return false;
	return selectedVerticalTemplates(t).length > 0;
}

function verticalTemplatePackText(text) {
	return buildVerticalTemplatePack(text, promptText).text;
}

function needsGapAnalysis(text) {
	const t = String(text || "");
	if (!t || /SOLSTICE_GAP_ANALYSIS_PLAYBOOK/.test(t)) return false;
	return /\b(antigravity|cursor|windsurf|gap\s*(?:analysis|report)|compare|comparison|benchmark|adopt|adoption)\b|(?:פערים|השוואה|להשוות|לאמץ|אימוץ|דוח\s+פערים)/i.test(t)
		&& /\b(solstice|felix|ide|agent|coding|builder|cursor|antigravity|windsurf)\b|(?:פליקס|סולסטיס|סוכן|סוכנים|איידיאי|עורך|בונה)/i.test(t);
}

function needsExplicitToolboxRouter(text) {
	const t = String(text || "");
	if (!t || /SOLSTICE_FELIX_TOOLBOX_ROUTER/.test(t)) return false;
	return /\b(felix\s+toolbox|toolbox|tool\s*router|agent\s+toolkit|smart\s+agent|analy[sz]e\s+and\s+build)\b|(?:ארגז\s+כלים|כלים\s+של\s+פליקס|סוכן\s+חכם|נתח\s+ובנה)/i.test(t);
}

function appendResearchContract(text) {
	let out = String(text || "");
	const addResearchContract = needsResearchContract(out);
	const addAnimatedKit = needsAnimatedWebsiteKit(out) && !hasExclusiveScrollWorldRoute(out);
	const addVerticalPack = needsVerticalTemplatePack(out);
	const addGapAnalysis = needsGapAnalysis(out);
	const addToolboxRouter = needsExplicitToolboxRouter(out);
	const addSiteReplica = needsSiteReplicaContract(out);
	if (addResearchContract) {
		out += [
			"",
			"[SOLSTICE_RESEARCH_CONTRACT]",
			"This request includes site/design/media analysis. You must gather visual ground truth before building or final analysis:",
			"1. Create or update `DECONSTRUCT.md` in the workspace root immediately, then keep updating it after each finding.",
			"2. INTERACTIVE RESEARCH DEFAULT: as the first browser action, automatically run bundled `browse.js live <url> 3 8` so the user sees a real Chrome window tour and scroll through the target. Do this for every interactive site/app research request even when the user did not say `live` or ask to watch. If the prompt names a site but has no URL, run `search` only to resolve its canonical URL, then immediately run `live` on the best match before `read`, `crawl`, or headless screenshots.",
			"3. This visible-first rule applies only to this user-initiated research turn. Background engine discovery, build-time checks, and unattended `search`/`read`/`crawl` operations remain headless unless the user turn carries this contract.",
			"4. For Behance/Dribbble showcases, run `browse.js showcase <url> .solstice/showcase/<slug> 30` to force lazy-load, download the best image variants, and inventory video/player URLs. Classify every downloaded frame as desktop, tablet, mobile, presentation, or embedded-device evidence before deriving the site.",
			"5. Capture desktop scrollshots and a mobile screenshot. Inspect every relevant extracted image with vision (`view_image`, Claude Read, or `browse.js describe`) and record concrete per-device observations in `DECONSTRUCT.md`.",
			"6. For every video/player URL in showcase-manifest.json, run `browse.js videoframes` with the showcase URL as referrer. If none are detected or playback is blocked, record that explicitly; otherwise describe motion, timing, pinned sections, parallax, and transitions.",
			"7. Do not start implementation until the evidence table in `DECONSTRUCT.md` lists the URLs/files/frames examined and the build decisions derived from them.",
			"[/SOLSTICE_RESEARCH_CONTRACT]",
			].join("\n");
	}
	if (addSiteReplica) {
		const sourceUrl = siteReplicaSourceUrl(out);
		out += [
			"",
			"[SOLSTICE_SITE_REPLICA_CONTRACT]",
			`Authorized-source candidate: ${sourceUrl}`,
			"This route is only for internal work on a client-owned or licensed source. A bare URL is not authorization; Felix's confirmation modal or an explicit ownership/license statement is required before capture. Never use it to resell or impersonate a third-party brand.",
			`1. After the required visible tour, capture rendered evidence with: browse.js replica-source ${sourceUrl} .solstice/replica/source --authorized`,
			"2. Read `.solstice/replica/source/DECONSTRUCT.md` and `source-manifest.json`. Rebuild structure, sections, palette, typography, content hierarchy and responsive behavior in the project stack. Do not copy source HTML, CSS, JavaScript, trackers, authentication state or hidden assets.",
			"3. Use only client-owned/licensed assets; otherwise create or license replacements. Preserve attribution where required.",
			"4. The CP-F1 browser gate will run desktop/tablet/mobile visual comparison automatically after functional QA. A score below 80 is a concrete failure and triggers the same bounded auto-fix loop. Do not bypass or delete the evidence.",
			"5. Final walkthrough must contain source, replica and diff evidence for all three breakpoints, bound to the build taskId.",
			"[/SOLSTICE_SITE_REPLICA_CONTRACT]",
		].join("\n");
	}
	if (addAnimatedKit) {
		const kit = animatedWebsiteKitText();
		const premiumPlan = xfieldAnimatedWiringPlanText();
		out += [
			"",
			"[SOLSTICE_ANIMATED_WEBSITE_KIT]",
			kit || "Build a real animated website with GSAP ScrollTrigger or React Three Fiber, include scroll-depth verification, and keep paid video/3D providers behind the credit gate.",
			"[SOLSTICE_XFIELD_WIRING_PLAN_ONLY]",
			premiumPlan || "You may propose X-Field with a free-vs-premium cost/time trade-off, but do not implement or call a paid provider. Present the unimplemented bridge and one-time approval boundary for review first.",
			"[/SOLSTICE_XFIELD_WIRING_PLAN_ONLY]",
			"[/SOLSTICE_ANIMATED_WEBSITE_KIT]",
		].join("\n");
	}
	if (addVerticalPack) {
		const pack = verticalTemplatePackText(out);
		out += [
			"",
			"[SOLSTICE_VERTICAL_TEMPLATE_PACK]",
			pack || "Use the closest Solstice vertical template pack. Preserve local-business conversion paths and adapt copy/assets to the actual sector.",
			"[/SOLSTICE_VERTICAL_TEMPLATE_PACK]",
		].join("\n");
	}
	if (addGapAnalysis) {
		const playbook = gapAnalysisPlaybookText();
		out += [
			"",
			"[SOLSTICE_GAP_ANALYSIS_PLAYBOOK]",
			playbook || "Write GAP_REPORT.md with evidence, ROI-ranked gaps, adoption candidates, and do-not-adopt items. Do not implement unless asked.",
			"[/SOLSTICE_GAP_ANALYSIS_PLAYBOOK]",
		].join("\n");
	}
	if (addToolboxRouter) {
		const toolbox = toolboxRouterText();
		out += [
			"",
			"[SOLSTICE_FELIX_TOOLBOX_ROUTER]",
			toolbox || "Choose the right route before acting: research, plan, build, animated site, vertical template, gap analysis, approval, recovery.",
			"[/SOLSTICE_FELIX_TOOLBOX_ROUTER]",
		].join("\n");
	}
	return out;
}

class AgentController {
	constructor(context) {
		this.context = context;
		this.client = null;
		this.threadId = null;          // the sidebar's active thread
		this.activeCodexThreadId = null; // actual active app-server turn (may differ after plan gate)
		this.lastDiff = "";
		this.webview = null;           // sidebar webview
		this.manager = null;           // manager panel webview
		this.skillsSeedResult = null;
		this.skillsInitError = "";
		this._lastSkillRoute = null;
		this._lastVerticalRoute = null;
		this._lastPromptDiagnostics = null;
		this._lastDeveloperInstructions = null;
		this.threads = new Map();      // threadId -> {id, preview, status, activeTurnId, plan, diff, updatedAt}
		this.loaded = new Set();       // threadIds resumed/started in this server process
		this.pendingApprovals = new Map(); // approvalKey -> { resolve(decision), creditGate }
		this.terminal = null;          // integrated terminal spawned from the panel
		this.preview = null;
		this.devServer = null;         // auto-started dev server (npm run dev) for framework apps
		this.previewUrl = "";
		this.previewPanel = null;      // device-frame live preview webview (center column)
		this.previewKind = "site";     // "site" | "app" — drives default device frame
		this.buildMode = "site";       // "site" | "app" — user-selected build intent (composer toggle)
		this.previewBuildTimer = null;
		this.grok = null;
		this.claude = null;
		this.moonshot = null;
		this.grokWatcher = null;
		this.grokChanged = null;
		this.fallbackPrompted = false;
		this.steerQueue = [];          // grok/claude: mid-turn messages queued as next-priority follow-up
		this.fleetBridges = new Map(); // agentId -> { ws:FleetBridge, status:"connecting"|"online"|"offline" }
		this.watch = new Map();        // agentId -> { state, text, ts, alerted } — stuck-loop watchdog
		this.watchTimer = null;
		this.live = new Map();         // key -> liveness rec (progress-aware). "_builder" = local Solstice build
		this.activeFleetAgent = null;  // fleet agent the live build is attributed to
		this._pendingRecovery = null;  // unfinished build read from .solstice/BUILD.json on activation
		this._verifyTaskId = null;     // taskId already given its one auto self-verify pass
		this._browserSelfCheck = null; // active post-build browser QA + bounded auto-fix state
		this._browserSelfCheckRunning = false;
		this._walkthroughTaskId = ""; // stable build/task key shared by gate evidence + delivery artifacts
		this._bugbotTaskId = null;     // taskId already reviewed after self-verify
		this._bugbotRunning = false;
		this.output = vscode.window.createOutputChannel("Felix");
		this.skills = null;            // Felix's private self-improvement store (Phase 6)
		this.skillInstaller = null;     // reviewed GitHub -> runtime skill directory installer
		this.learning = null;          // verified-outcome learning; activates only after an external gate
		this._learningSignals = new Map(); // externally verified evidence keyed by build/task id
		this.brandDnaClient = new BrandDnaClient({
			baseUrl: process.env.SOLSTICE_BRAND_DNA_URL || this.cfg().get("brandDnaUrl") || undefined,
		});
		this.foundationClient = null;
		this._foundationReady = null;
		try {
			const root = workspaceCwd();
			if (root) {
				let foundationStudioKey = process.env.SOLSTICE_FOUNDATION_STUDIO_KEY || "";
				if (!foundationStudioKey) {
					try { foundationStudioKey = fs.readFileSync(path.join(os.homedir(), ".solstice", "foundation-studio-key"), "utf8").trim(); }
					catch { }
				}
				this.foundationClient = new FoundationClient({
					endpoint: process.env.SOLSTICE_FOUNDATION_API_URL || this.cfg().get("foundationApiUrl") || undefined,
					storageDir: path.join(context.globalStorageUri.fsPath, "foundation-sync"),
					businessFile: path.join(root, ".solstice", "foundation.json"),
					businessId: process.env.SOLSTICE_FOUNDATION_BUSINESS_ID || this.cfg().get("foundationBusinessId") || "",
					studioKey: foundationStudioKey,
					log: (message) => this.output.append(message + "\n"),
				});
				// Startup performs drain -> pull, then arms a five-second poll. A failed
				// request is deliberately non-fatal: the disk outbox remains authoritative.
				this._foundationReady = this.foundationClient.start().then((status) => {
					this.output.append(`[foundation] ready business=${status.business_id || "unconfigured"} queued=${status.queued}\n`);
					return status;
				}).catch((error) => {
					this.output.append(`[foundation] start failed: ${error && error.message || error}\n`);
					return null;
				});
			}
		} catch (error) {
			this.output.append(`[foundation] init failed: ${error && error.message || error}\n`);
		}
		this.scheduledCheckTimer = null;
		this._scheduledCheckRunning = false;
		this.activeCliChildren = new Set(); // walkthrough/deploy/helper processes stopped by global Stop
		this.managerTasks = null;       // CP-7: isolated build task/worktree registry
		this.managerPreviews = new Map(); // taskId -> PreviewServer
		this.managerDevServers = new Map(); // taskId -> DevServer
		this._companionRelayTimer = null;
		this._companionPreviewImage = "";
		this._discoveredModelChoices = null;
		this._modelDiscoveryPromise = null;
		this._manualClaudeSelected = false;
		try {
			const root = workspaceCwd();
			if (root && fs.existsSync(path.join(root, ".git"))) this.managerTasks = new ManagerWorktrees(root, { limit: 2, log: (m) => this.output.append(m) });
		} catch (e) { this.output.append("[manager] init failed: " + (e && e.message || e) + "\n"); }
		// A loopback, token-authenticated bridge lets all three engine runtimes call
		// the same IDE-owned dev-server controls. The bridge never accepts a PID or
		// root from the model; it can only list/stop DevServer objects this window owns.
		this.devServerToolBridge = new DevServerToolBridge({
			list: () => this.listDevServersForAgent(),
			stop: (id) => this.stopDevServerForAgent(id),
			stopAll: () => this.stopAllDevServers("agent-close-all"),
			log: (m) => this.output.append(m),
		});
		this._devServerToolReady = this.devServerToolBridge.start().catch((error) => {
			this.output.append(`[dev-tools] bridge unavailable: ${error && error.message || error}\n`);
			vscode.window.showErrorMessage(`Solstice dev-server controls are unavailable: ${error && error.message || error}`);
			return {};
		});
		try {
			this.learning = new FelixLearning({
				dir: path.join(context.globalStorageUri.fsPath, "felix-learning"),
				log: (m) => this.output.append(m + "\n"),
			});
			this.skills = new FelixSkills({
				dir: path.join(context.globalStorageUri.fsPath, "felix-skills"),
				legacyDirs: [
					path.join(context.extensionPath, "felix-skills"),
					...(context.storageUri ? [path.join(context.storageUri.fsPath, "felix-skills")] : []),
				],
				embedderUrl: this.cfg().get("skillEmbedderUrl") || "",
				log: (m) => this.output.append(m + "\n"),
			});
			const seeded = this.skills.seedFrom(context.extensionPath);
			this.skillsSeedResult = seeded;
			const resumedLearning = this.learning.activateAllPending(this.skills);
			if (resumedLearning.activated.length) {
				this.output.append(`[learning-active] activated ${resumedLearning.activated.length} verified record(s) during startup\n`);
			}
			if (resumedLearning.failed.length) {
				this.output.append(`[learning-active] ${resumedLearning.failed.length} verified record(s) still need activation attention\n`);
			}
			if (resumedLearning.exhausted.length) {
				this.output.append(`[learning-active] ${resumedLearning.exhausted.length} verified record(s) reached the automatic retry limit; manual review is required\n`);
			}
			if (seeded && seeded.scrollWorld && seeded.scrollWorld.status === "repaired") {
				vscode.window.showInformationMessage("Felix self-healed the ScrollWorld skill in global storage.");
			} else if (seeded && seeded.scrollWorld && seeded.scrollWorld.status === "failed") {
				vscode.window.showErrorMessage(`Felix could not install ScrollWorld: ${seeded.scrollWorld.error}`);
			}
			this.skillInstaller = new SkillInstaller({
				skillsDir: this.skills.skillsDir,
				log: (m) => this.output.append(m + "\n"),
			});
		} catch (e) {
			this.skillsInitError = String(e && e.message || e);
			this.output.append("[skills] init failed: " + this.skillsInitError + "\n");
			vscode.window.showErrorMessage("Felix Skills failed to initialize: " + this.skillsInitError);
		}
	}

	startScheduledChecks() {
		if (this.scheduledCheckTimer) return;
		const tick = () => this.runScheduledChecks().catch((e) => this.output.append("[scheduled-check] " + (e && e.message || e) + "\n"));
		this.scheduledCheckTimer = setInterval(tick, 15 * 60 * 1000);
		this.scheduledCheckTimer.unref && this.scheduledCheckTimer.unref();
		setTimeout(tick, 20000);
	}
	async runScheduledChecks() {
		const cwd = workspaceCwd();
		if (!cwd || this._scheduledCheckRunning || !dueScheduledChecks(cwd).length) return;
		this._scheduledCheckRunning = true;
		try {
			const tool = path.join(this.context.extensionPath, "webtools", "site-check.js");
			const result = await this.runCli(process.execPath, [tool, cwd], cwd, { ELECTRON_RUN_AS_NODE: "1" });
			if (result.code !== 0) throw new Error((result.stderr || result.stdout || "site check failed").slice(-800));
			const parsed = JSON.parse(result.stdout || "{}");
			const deviations = (parsed.results || []).filter((x) => x.deviation);
			this.announceAgentMessage(deviations.length ? `⚠️ בדיקה מתוזמנת מצאה ${deviations.length} סטיות — הדוחות נשמרו ב-.solstice/scheduled-checks.` : `✅ בדיקה מתוזמנת עברה על ${parsed.checked || 0} אתרים ללא סטייה.`);
		} finally { this._scheduledCheckRunning = false; }
	}

	async queueArtifactAnnotation(artifact, note) {
		const saved = captureAnnotation(workspaceCwd(), artifact, note);
		this.announceAgentMessage("📝 הערת artifact נקלטה לתור: " + String(note).slice(0, 120));
		if (this.threadId) await this.steer(this.threadId, saved.prompt);
		else { this._planApprovalBypass = true; await this.send(saved.prompt); }
		return saved;
	}

	// ---- stuck-agent watchdog ----------------------------------------------
	// Busy states that can hang (e.g. "Exploring…" looping for hours with no
	// file write). Terminal/idle states clear the watch entry.
	watchdogConfig() {
		const c = vscode.workspace.getConfiguration("solstice.watchdog");
		return {
			enabled: c.get("enabled", true),
			stuckMs: Math.max(60000, (c.get("stuckMinutes", 6) || 6) * 60000),
		};
	}
	noteWatch(agentId, state) {
		const busy = state === "working" || state === "exploring" || state === "thinking"
			|| state === "connecting" || state === "dispatch" || state === "planning";
		if (!busy) { this.watch.delete(agentId); return; }
		const prev = this.watch.get(agentId);
		// fresh busy event = real progress: reset the clock and the alert latch
		this.watch.set(agentId, { state, ts: Date.now(), alerted: false, prevState: prev ? prev.state : null });
	}
	startWatchdog() {
		if (this.watchTimer) return;
		this.watchTimer = setInterval(() => {
			try { this.tickLiveness(); } catch { }
			const cfg = this.watchdogConfig();
			if (!cfg.enabled) return;
			const now = Date.now();
			for (const [agentId, w] of this.watch) {
				if (w.alerted) continue;
				if (now - w.ts < cfg.stuckMs) continue;
				w.alerted = true;
				const mins = Math.round((now - w.ts) / 60000);
				this.emitStuck(agentId, w.state, mins);
			}
		}, 15000);
		this.watchTimer.unref && this.watchTimer.unref();
	}
	emitStuck(agentId, state, mins) {
		const label = `נתקע ב-"${state}" כבר ${mins} דק׳ ללא התקדמות`;
		try { this.output.appendLine(`[watchdog] ${agentId}: ${label}`); } catch { }
		if (this.fleetPanel) {
			this.fleetPanel.webview.postMessage({ type: "stuck", agent: agentId, state, mins, ts: Date.now() });
			this.fleetPanel.webview.postMessage({ type: "activity", agent: agentId, state: "stuck", text: label, ts: Date.now() });
		}
		const name = (this.fleetAgents().find((a) => a.id === agentId) || {}).name || agentId;
		vscode.window.showWarningMessage(`⚠️ ${name} ${label}`, "פתח Fleet", "נקה תקיעה").then((pick) => {
			if (pick === "פתח Fleet" && this.fleetPanel) { this.fleetPanel.reveal(vscode.ViewColumn.One); this.fleetPanel.webview.postMessage({ type: "focusAgent", agent: agentId }); }
			else if (pick === "נקה תקיעה") { this.watch.delete(agentId); if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "stuckCleared", agent: agentId }); }
		}, () => { });
	}

	// ---- liveness (layered, progress-aware) --------------------------------
	// The watchdog above resets on ANY busy event, so a self-refreshing
	// "working…" animation can mask a hung turn for hours. Liveness instead
	// tracks DISTINCT progress signals — only real output (tokens / stream
	// deltas / file & tool events) counts as alive. A busy state with no strong
	// signal degrades: alive → quiet → stalled. On stall we recover by RESUME
	// (drain queued steers / nudge), never a blind wall-clock restart.
	livenessConfig() {
		const c = vscode.workspace.getConfiguration("solstice.liveness");
		return {
			enabled: c.get("enabled", true),
			freshMs: Math.max(10000, (c.get("freshSeconds", 90) || 90) * 1000),
			stallMs: Math.max(60000, (c.get("stallSeconds", 300) || 300) * 1000),
		};
	}
	liveRec(key) {
		let r = this.live.get(key);
		if (!r) { r = { sig: { state: 0, stream: 0, tool: 0, token: 0 }, busySince: 0, layer: "idle", alerted: false, lastTokenTotal: 0, queued: 0 }; this.live.set(key, r); }
		return r;
	}
	// kind: "state" (weak) | "stream" | "tool" | "token" (strong = real output)
	notePulse(key, kind, meta) {
		const r = this.liveRec(key);
		r.sig[kind] = Date.now();
		if (kind === "token" && meta && meta.total != null) r.lastTokenTotal = meta.total;
		if (kind !== "state") r.alerted = false; // real progress clears the stall latch
	}
	markBusy(key, busy) {
		const r = this.liveRec(key);
		if (busy) { if (!r.busySince) r.busySince = Date.now(); }
		else { r.busySince = 0; r.layer = "idle"; r.alerted = false; }
	}
	lastStrong(r) { return Math.max(r.sig.token, r.sig.tool, r.sig.stream); }
	livenessInfo(key) {
		const r = this.live.get(key);
		if (!r || !r.busySince) return { layer: "idle", sinceMs: 0, kind: null, queued: r ? r.queued : 0 };
		const cfg = this.livenessConfig();
		const now = Date.now();
		const strong = this.lastStrong(r);
		const since = now - (strong || r.busySince);
		let layer = since < cfg.freshMs ? "alive" : since < cfg.stallMs ? "quiet" : "stalled";
		const kind = strong === r.sig.token ? "token" : strong === r.sig.tool ? "tool" : strong === r.sig.stream ? "stream" : null;
		return { layer, sinceMs: since, kind, queued: r.queued, tokens: r.lastTokenTotal };
	}
	// The fleet agent the live build is attributed to in the Fleet panel.
	builderAgent() { return this.activeFleetAgent || "jasper"; }
	tickLiveness() {
		const cfg = this.livenessConfig();
		if (!cfg.enabled) return;
		for (const [key] of this.live) {
			const info = this.livenessInfo(key);
			const agent = key === "_builder" ? this.builderAgent() : key;
			if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "liveness", agent, ...info, ts: Date.now() });
			const r = this.live.get(key);
			if (info.layer === "stalled" && r && !r.alerted) {
				r.alerted = true;
				this.emitStall(agent, info);
			}
		}
	}
	emitStall(agent, info) {
		const mins = Math.round(info.sinceMs / 60000);
		const q = info.queued || 0;
		const name = (this.fleetAgents().find((a) => a.id === agent) || {}).name || agent;
		const label = `אין פלט אמיתי ${mins} דק׳` + (q ? ` · ${q} הודעות ממתינות` : "");
		try { this.output.appendLine(`[liveness] ${agent}: stalled — ${label}`); } catch { }
		if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "activity", agent, state: "stuck", text: "🔴 " + label, ts: Date.now() });
		const actions = q ? ["המשך (resume)", "פתח Fleet"] : ["פתח Fleet"];
		vscode.window.showWarningMessage(`🔴 ${name}: ${label}`, ...actions).then((pick) => {
			if (pick === "המשך (resume)") this.resumeBuilder();
			else if (pick === "פתח Fleet" && this.fleetPanel) { this.fleetPanel.reveal(vscode.ViewColumn.One); this.fleetPanel.webview.postMessage({ type: "focusAgent", agent }); }
		}, () => { });
	}
	// Recovery-by-resume: a stalled turn never emits turn/completed, so its
	// queued steers would sit forever (the reported bug). Force-drain them and
	// nudge the agent instead of killing the process.
	resumeBuilder() {
		const r = this.live.get("_builder");
		if (r) { r.alerted = false; r.sig.state = Date.now(); }
		if (this.steerQueue.length) { this.forceDrainSteer(); return; }
		// nothing queued — interrupt the hung turn so the CLI frees up
		this.interrupt(this.threadId).catch(() => { });
	}
	forceDrainSteer() {
		if (!this.steerQueue.length) return;
		const text = this.steerQueue.join("\n\n");
		this.steerQueue = [];
		const r = this.live.get("_builder"); if (r) r.queued = 0;
		this.post({ type: "steerQueued", count: 0 });
		this.interrupt(this.threadId)
			.catch(() => { })
			.then(() => this.send(text))
			.catch((e) => this.output.append(`\n[resume drain] ${e && e.message || e}\n`));
	}

	// Detect whether the workspace is an app (device-frame defaults to phone) or
	// a marketing site (defaults to full screen). Looks for app stacks.
	detectPreviewKind() {
		const root = workspaceCwd();
		if (!root) return "site";
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
			const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
			if (deps.expo || deps["react-native"]) return "app";
			// PWA / app-shell signals
			if (deps.next && (fs.existsSync(path.join(root, "public", "manifest.json")) ||
				fs.existsSync(path.join(root, "public", "manifest.webmanifest")) ||
				fs.existsSync(path.join(root, "app", "manifest.ts")))) return "app";
		} catch { }
		return "site";
	}

	defaultDevice() { return (this.buildMode === "app" || this.previewKind === "app") ? "iphone" : "desktop"; }

	// User-selected build intent from the composer toggle. App mode also primes the
	// preview to open in a phone frame and injects app-specific build guidance.
	setBuildMode(mode) {
		this.buildMode = mode === "app" ? "app" : "site";
		this.previewKind = this.buildMode;
		if (this.previewPanel && this.previewReady && this.previewUrl) {
			this.postPreview({ type: "load", url: this.previewUrl, device: this.defaultDevice() });
		}
	}

	// ---- Phone Companion (PWA): drive Felix + watch the build live from a phone ----
	_companion() { return (this.companionState = this.companionState || { messages: [], plan: [], files: [], previewUrl: "", liveUrl: "", building: false, model: "", managerTasks: [], ts: 0 }); }
	companionInstanceId() {
		const root = workspaceCwd() || "no-workspace";
		return "solstice:" + crypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
	}
	companionBridgeId() {
		const configured = String(this.fleetCfg().get("companionBridge") || "orion").trim();
		return configured || "orion";
	}
	companionReviewLinks() {
		const root = workspaceCwd(); if (!root) return [];
		try {
			const registry = JSON.parse(fs.readFileSync(path.join(root, ".solstice", "review-shares.json"), "utf8"));
			return Object.values(registry || {}).filter((x) => x && !x.revoked).slice(-12).map((x) => ({ shareId: x.shareId, path: `/review/${x.shareId}/`, createdAt: x.createdAt || "" }));
		} catch { return []; }
	}
	companionRelayState() {
		const s = this._companion();
		const root = workspaceCwd() || "";
		return {
			...s,
			project: root ? path.basename(root) : "No workspace",
			workspace: root,
			connected: true,
			planMode: this.pendingPlanApproval ? "approval" : ((s.building || (s.plan && s.plan.length)) ? "flowing" : "idle"),
			planPending: !!this.pendingPlanApproval,
			planDraft: this.pendingPlanApproval ? {
				prompt: this.pendingPlanApproval.prompt || "",
				questions: this.pendingPlanApproval.questions || [],
				answers: this.pendingPlanApproval.answers || {},
				revision: this.pendingPlanApproval.revision || 0,
			} : null,
			reviewLinks: this.companionReviewLinks(),
			previewImage: this._companionPreviewImage || "",
		};
	}
	scheduleCompanionRelay() {
		if (this._companionRelayTimer) return;
		this._companionRelayTimer = setTimeout(() => {
			this._companionRelayTimer = null;
			this.publishCompanionState();
		}, 120);
	}
	publishCompanionState() {
		const id = this.companionBridgeId();
		const rec = this.fleetBridges.get(id);
		if (!rec || !rec.ws || !rec.ws.connected || !rec.companionReady) return false;
		try {
			rec.ws.send({ type: "companion_state", instanceId: this.companionInstanceId(), state: this.companionRelayState() });
			return true;
		} catch (e) { this.output.append("[companion relay] " + (e && e.message || e) + "\n"); return false; }
	}
	ensureCompanionRelay() {
		const id = this.companionBridgeId();
		const ws = this.ensureFleetBridge(id);
		return !!ws;
	}
	syncCompanionManagerTasks() {
		const s = this._companion();
		s.managerTasks = this.managerTaskList().map((task) => ({
			id: task.id, label: task.label, threadId: task.threadId, status: task.status,
			phase: task.phase, plan: task.plan || [], changedFiles: task.changedFiles || 0,
			previewUrl: task.previewUrl || "", updatedAt: task.updatedAt,
		}));
		s.ts = Date.now();
		this.scheduleCompanionRelay();
	}
	captureCompanionState(method, params) {
		const s = this._companion();
		try { s.model = (this.cfg().get("provider") || "composer-2.5"); } catch (e) {}
		if (this.previewUrl) s.previewUrl = this.previewUrl;
		if (this.lastDeployUrl) s.liveUrl = this.lastDeployUrl;
		if (method === "turn/started") s.building = true;
		else if (method === "turn/completed") s.building = false;
		else if (method === "item/completed" && params && params.item) {
			const it = params.item;
			if (it.type === "agentMessage" && it.text) s.messages.push({ role: "agent", text: String(it.text).slice(0, 4000) });
			else if (it.type === "fileChange" && Array.isArray(it.changes)) for (const c of it.changes) if (c && c.path) s.files.unshift({ path: c.path, t: Date.now() });
		} else if (method === "turn/plan/updated" && params && params.plan) s.plan = this.normalizePlan(params.plan);
		s.messages = s.messages.slice(-40);
		s.files = s.files.slice(0, 24);
		s.ts = Date.now();
		this.scheduleCompanionRelay();
	}
	companionUserMessage(text) { const s = this._companion(); s.messages.push({ role: "user", text: String(text).slice(0, 2000) }); s.ts = Date.now(); this.scheduleCompanionRelay(); }
	async handleCompanionAction(frame) {
		if (String(frame.instanceId || "") !== this.companionInstanceId()) return;
		const requestId = String(frame.requestId || "");
		const action = String(frame.action || "");
		const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
		let ok = false, error = "";
		try {
			if (action === "prompt") {
				const text = String(payload.text || "").trim().slice(0, 8000);
				if (!text) throw new Error("Prompt is empty");
				this.companionUserMessage(text);
				if (this._companion().building && this.threadId) await this.steer(this.threadId, text); else await this.send(text);
			} else if (action === "update_plan") {
				if (this.pendingPlanApproval) this.replanPendingBuild(payload.prompt, payload.answers);
				else {
					const note = String(payload.prompt || "").trim().slice(0, 4000);
					if (!note) throw new Error("Plan update is empty");
					await this.queueArtifactAnnotation("PLAN.md", note);
				}
			} else if (action === "approve_plan") {
				if (this.pendingPlanApproval) {
					this.replanPendingBuild(payload.prompt, payload.answers, { final: true });
					const prompt = this.approvedBuildPrompt(this.pendingPlanApproval);
					this.pendingPlanApproval = null;
					this._planApprovalBypass = true;
					this._walkthroughPending = true;
					await this.send(prompt);
				}
			} else if (action === "annotate_plan") {
				const note = String(payload.note || payload.prompt || "").trim().slice(0, 4000);
				if (!note) throw new Error("Plan note is empty");
				await this.queueArtifactAnnotation("PLAN.md", note);
			} else if (action === "stop") {
				const taskId = String(payload.taskId || "");
				const task = taskId && this.managerTasks && this.managerTasks.get(taskId);
				await this.interrupt(task && task.threadId ? task.threadId : this.threadId);
			} else if (action === "refresh_preview") {
				if (!this.previewUrl) throw new Error("No live preview yet");
				const shot = await this.capturePreviewShot(this.previewUrl, "companion", "390x844");
				if (!shot) throw new Error("Preview capture failed");
				const data = fs.readFileSync(shot);
				if (data.length > 1_400_000) throw new Error("Preview capture is too large to relay");
				this._companionPreviewImage = "data:image/png;base64," + data.toString("base64");
			}
			ok = true;
		} catch (e) { error = String(e && e.message || e); }
		this.scheduleCompanionRelay();
		const rec = this.fleetBridges.get(this.companionBridgeId());
		try { if (rec && rec.ws) rec.ws.send({ type: "companion_ack", instanceId: this.companionInstanceId(), requestId, ok, error }); } catch { }
	}
	async startCompanion() {
		this.ensureCompanionRelay();
		if (this._companionServer) { vscode.window.showInformationMessage(`📱 Companion 2.0 מחובר ל-Vega. אבחון מקומי: 127.0.0.1:${this._companionPort}`); return this._companionPort; }
		const http = require("http");
		// 8794 is the Brand-DNA Engine; 8797-8799 are reserved by other local
		// services. Companion diagnostics live in their own explicit range.
		const ports = [8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809];
		const reviewHandler = createReviewHandler(workspaceCwd(), (_root, artifact, note) => this.queueArtifactAnnotation(artifact, note));
		const srv = http.createServer(async (req, res) => {
			const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
			if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
			if (await reviewHandler(req, res)) return;
			const u = (req.url || "/").split("?")[0];
			if (u === "/" || u === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...cors }); res.end(companionHtml()); return; }
			if (u === "/state") { res.writeHead(200, { "Content-Type": "application/json", ...cors }); res.end(JSON.stringify(this.companionState || {})); return; }
			if (u === "/prompt" && req.method === "POST") {
				let body = ""; req.on("data", (d) => { body += d; if (body.length > 100000) req.destroy(); });
				req.on("end", () => {
					try {
						const t = (JSON.parse(body || "{}").text || "").trim();
						if (t) { this.companionUserMessage(t); if (this.companionState && this.companionState.building && this.threadId) this.steer(this.threadId, t).catch(() => {}); else this.send(t).catch(() => {}); }
					} catch (e) {}
					res.writeHead(200, { "Content-Type": "application/json", ...cors }); res.end('{"ok":true}');
				});
				return;
			}
			if (u === "/manager/stop" && req.method === "POST") {
				let body = ""; req.on("data", (d) => { body += d; if (body.length > 10000) req.destroy(); });
				req.on("end", async () => {
					let ok = false;
					try {
						const task = this.managerTasks && this.managerTasks.get((JSON.parse(body || "{}").taskId || "").trim());
						if (task && task.threadId) { await this.interrupt(task.threadId); ok = true; }
					} catch (e) {}
					res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json", ...cors }); res.end(JSON.stringify({ ok }));
				});
				return;
			}
			res.writeHead(404, cors); res.end("not found");
		});
		try {
			const port = await listenOnFirstAvailable(srv, ports);
			this._companionServer = srv;
			this._companionPort = port;
			srv.on("error", (e) => { try { this.output.append("companion server: " + e.message + "\n"); } catch (x) {} });
			vscode.window.showInformationMessage(`📱 Companion 2.0 מחובר ל-Vega. אבחון מקומי: 127.0.0.1:${port}`);
			return port;
		} catch (e) {
			try { srv.close(); } catch (x) {}
			const detail = String(e && e.message || e);
			try { this.output.append("companion server failed: " + detail + "\n"); } catch (x) {}
			vscode.window.showErrorMessage(`Companion 2.0 relay מחובר, אבל שרת האבחון המקומי לא נפתח: ${detail}`);
			return null;
		}
	}

	// ---- production deploy -------------------------------------------------
	// Uses the user's existing local Vercel CLI login first. A token stored in
	// the connector vault is a fallback only; it is passed through the child env
	// and never written to the workspace, model context, process argv, or logs.
	runCli(bin, args, cwd, env) {
		return new Promise((resolve) => {
			let stdout = "", stderr = "", settled = false;
			const child = spawn(bin, args, {
				cwd, env: { ...process.env, ...(env || {}) },
				shell: process.platform === "win32", windowsHide: true,
			});
			this.activeCliChildren.add(child);
			const append = (key, chunk) => {
				const text = String(chunk || "");
				if (key === "out") stdout = (stdout + text).slice(-2 * 1024 * 1024);
				else stderr = (stderr + text).slice(-2 * 1024 * 1024);
			};
			if (child.stdout) child.stdout.on("data", (d) => append("out", d));
			if (child.stderr) child.stderr.on("data", (d) => append("err", d));
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				killTree(child);
				resolve({ code: -1, stdout, stderr, error: new Error("Vercel CLI timed out") });
			}, 10 * 60 * 1000);
			child.on("error", (error) => { this.activeCliChildren.delete(child); if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr, error }); } });
			child.on("close", (code) => { this.activeCliChildren.delete(child); if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code == null ? -1 : Number(code), stdout, stderr }); } });
		});
	}

	announceAgentMessage(text) {
		const item = { id: "solstice_" + Date.now(), type: "agentMessage", text: String(text || ""), status: "completed" };
		this.onNotification("item/completed", { threadId: this.threadId || undefined, item });
	}

	async deployCurrentProject(projectDir) {
		const selectedDir = projectDir || workspaceCwd();
		if (!selectedDir) { vscode.window.showWarningMessage("Solstice: פתח תיקיית פרויקט לפני deploy."); return null; }
		const cwd = path.resolve(selectedDir);
		try { if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory"); }
		catch { vscode.window.showWarningMessage("Solstice: תיקיית הפרויקט לא קיימת."); return null; }
		const bin = process.platform === "win32" ? "vercel.cmd" : "vercel";
		const fallbackToken = await this.connectorToken("vercel");
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Solstice · Vercel", cancellable: false }, async (progress) => {
			progress.report({ message: "בודק login מקומי…" });
			let who = await this.runCli(bin, ["whoami"], cwd, {});
			let env = {};
			if (who.code !== 0 && fallbackToken) {
				env = { VERCEL_TOKEN: fallbackToken };
				who = await this.runCli(bin, ["whoami"], cwd, env);
			}
			if (who.code !== 0) {
				const missing = who.error && (who.error.code === "ENOENT" || /not found/i.test(who.error.message || ""));
				const message = missing
					? "Vercel CLI לא מותקן. התקן אותו (`npm i -g vercel`) ואז הרץ `vercel login`."
					: "אין login פעיל ל-Vercel. הרץ `vercel login` בטרמינל של המחשב ונסה שוב.";
				vscode.window.showErrorMessage(message);
				this.announceAgentMessage("▲ הפריסה נעצרה: " + message);
				return null;
			}
			progress.report({ message: "פורס production…" });
			const deployed = await this.runCli(bin, ["deploy", "--prod", "--yes"], cwd, env);
			if (deployed.code !== 0) {
				const detail = (deployed.stderr || deployed.stdout || "Vercel deploy failed").trim().split("\n").slice(-3).join(" ").slice(0, 500);
				vscode.window.showErrorMessage("Vercel deploy נכשל: " + detail);
				this.announceAgentMessage("▲ הפריסה נכשלה: " + detail);
				return null;
			}
			const cleanOutput = (deployed.stdout + "\n" + deployed.stderr).replace(/\x1b\[[0-9;]*m/g, "");
			const urls = cleanOutput.match(/https:\/\/[^\s\]\[()<>]+/g) || [];
			const liveUrl = [...urls].reverse().find((u) => /\.vercel\.app\/?$/i.test(u)) || urls[urls.length - 1];
			if (!liveUrl) {
				vscode.window.showErrorMessage("Vercel סיים בלי להחזיר URL חי.");
				return null;
			}
			this.lastDeployUrl = liveUrl.replace(/[.,;]+$/, "");
			const state = this._companion(); state.liveUrl = this.lastDeployUrl; state.previewUrl = this.lastDeployUrl; state.ts = Date.now();
			try {
				const dir = path.join(cwd, ".solstice"); fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ provider: "vercel", liveUrl: this.lastDeployUrl, deployedAt: new Date().toISOString() }, null, 2) + "\n");
			} catch (e) { this.output.append("deploy manifest: " + (e && e.message || e) + "\n"); }
			this.announceAgentMessage("▲ האתר חי: " + this.lastDeployUrl);
			this.sendBuildStatus("deployed", { deployUrl: this.lastDeployUrl, previewUrl: this.lastDeployUrl });
			if (this.galleryPanel) this.galleryPanel.webview.postMessage({ type: "projects", projects: this.scanProjects(this.galleryPanel.webview) });
			vscode.window.showInformationMessage("▲ האתר עלה ל-Vercel", "פתח אתר").then((choice) => { if (choice === "פתח אתר") vscode.env.openExternal(vscode.Uri.parse(this.lastDeployUrl)); });
			return this.lastDeployUrl;
		});
	}

	// Extra guidance appended to the build preamble when the user is in App mode,
	// so a "build an app" request yields a real mobile-first installable app
	// (screens + navigation + manifest) rather than a marketing website.
	appModeGuidance() {
		if (this.buildMode !== "app") return "";
		return [
			"",
			"## BUILD MODE: APP (not a marketing website)",
			"The user is building an APPLICATION, not a landing/marketing site. Design accordingly:",
			"- Mobile-first: target a phone viewport (~390px) first; the live preview opens in a phone frame.",
			"- App shell: persistent navigation (top app bar and/or bottom tab bar), multiple SCREENS/routes, not one long scroll page.",
			"- Real interaction & state: working navigation between screens, lists/detail views, forms, and local state (use localStorage or a store).",
			"- Touch ergonomics: ≥44px tap targets, thumb-reachable primary actions, no hover-only affordances.",
			"- Installable PWA: include a web app manifest (name, icons, theme/background color, display: standalone) and a basic service worker so it can be added to the home screen.",
			"- Prefer an SPA stack (Vite + React/Router) unless told otherwise; keep it runnable with `npm run dev`.",
			"- Treat each screen as a deliverable: build the navigation skeleton first, then fill screens so the preview is always interactive.",
			"- A runnable PWA app-shell scaffold (index.html + app.js hash-router + bottom tab bar + manifest + service worker + data.js mock store) may already exist in the workspace (Solstice's 'Scaffold App Shell'). If so, BUILD ON IT — add screens/routes and flesh out the existing tabs rather than starting a single-page site from scratch.",
			"- Data layer: read/write app data through `window.DB` (data.js) — a seeded localStorage CRUD store. Build lists/detail screens off it; swap it for a real backend later. Every write surfaces live in Solstice's State inspector.",
			"- Solstice's live preview gives you app tooling: a phone/tablet/desktop device switcher, a 'מסכים' screens-flow map (reads your hash routes / data-route screens), and a 'State' inspector (live localStorage). Use hash routes (#/screen) and localStorage so these light up.",
		].join("\n");
	}

	brandPackRootForThread(threadId) {
		const task = this.managerTasks && threadId ? this.managerTasks.forThread(threadId) : null;
		return task && task.worktree ? task.worktree : workspaceCwd();
	}

	brandContext(root = workspaceCwd()) {
		return brandPackContext(root);
	}

	withBrandPack(text, root = workspaceCwd()) {
		const prompt = String(text || "");
		if (!prompt || prompt.includes("[FELIX_BRAND_PACK]") || prompt.includes("[FELIX_BRAND_PACK_ERROR]")) return prompt;
		const context = this.brandContext(root);
		return context ? context + prompt : prompt;
	}

	async loadBrandPackIntoWorkspace() {
		const root = workspaceCwd();
		if (!root) { vscode.window.showWarningMessage("Solstice: open a project before loading a Brand Pack."); return null; }
		const selected = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: { "BrandDNA JSON": ["json"] },
			openLabel: "Load Brand Pack",
			title: "Choose a BrandDNA JSON file",
		});
		if (!selected || !selected[0]) return null;
		const target = path.join(root, CANONICAL_BRAND_PACK);
		if (fs.existsSync(target) && path.resolve(selected[0].fsPath) !== path.resolve(target)) {
			const choice = await vscode.window.showWarningMessage(
				"This project already has a Brand Pack. Replace it with the selected BrandDNA JSON?",
				{ modal: true },
				"Replace Brand Pack"
			);
			if (choice !== "Replace Brand Pack") return null;
		}
		try {
			const pack = installBrandPack(root, selected[0].fsPath);
			vscode.window.showInformationMessage(`Brand Pack loaded: ${pack.compact.name || pack.compact.domain || "BrandDNA"}`);
			return pack;
		} catch (error) {
			vscode.window.showErrorMessage("Brand Pack rejected: " + String(error && error.message || error));
			return null;
		}
	}

	// Cross-provider "act like a real agent" guidance — persistence, ground-truth
	// tool use, planning, self-verification, and knowing when to ask. Injected into
	// every preamble so Felix behaves like an agent, not a one-shot chat model.
	agentBehavior() {
		return [
			"",
			"## How to operate — you are an AGENT, not a one-shot chat model",
			"- PERSIST: keep going until the user's request is FULLY done. Don't stop and hand back after a single step — plan the steps, execute every one, verify, then finish. If you hit uncertainty mid-task, research or deduce the most reasonable path and CONTINUE rather than stopping.",
			"- GET GROUND TRUTH, don't guess: when unsure about a file, the project, or how a design/site looks, use your tools (read files, search/read/crawl the web, screenshot + describe the image). Never invent something you could verify.",
			"- DESIGN/MEDIA RESEARCH CONTRACT: when the user asks you to analyze, deconstruct, imitate, recreate, or take inspiration from a site/app/design/image/video/reference, do not answer or build from memory. First create/update `DECONSTRUCT.md`, gather visual evidence with the browser/media tools, record what you examined, then derive build decisions from that evidence.",
			"- PLAN first on any multi-step task and keep the plan updated as you go (the IDE renders it live).",
			"- SELF-VERIFY before saying done: run/preview what you built, screenshot the live result, VIEW the screenshot, compare it to the goal, and fix issues — including a mobile-width pass. Placeholders, console errors, or an unopened preview mean it is NOT done.",
			"- CONVERGE \u2014 don't loop: for a SMALL or incremental change (a tweak, a menu/style fix, one element, fixing a few links), make the edit, do AT MOST ONE quick verify, then STOP and report. Do NOT re-screenshot, re-edit and re-verify the same thing in a loop. Deep iterative self-verify is for a full from-scratch build, not a small follow-up. If the requested change is applied and reasonable you are DONE \u2014 never chase a subjective 'perfect' across dozens of steps; if you've taken many steps on one small ask, stop and hand back what you have.",
			"- ASK only when genuinely blocked: if the request is truly ambiguous or you're missing something essential you cannot reasonably infer (brand, required content/copy, a decision with real trade-offs), ask the user ONE short, specific question instead of guessing wrong. Don't ask about things you can decide sensibly yourself — proceed and note the assumption.",
			"- COMMERCE (Mercury bridge): if `lib/mercury.ts` exists, the project is connected to a live Mercury commerce store — BUILD THE STOREFRONT AGAINST IT, not mock data. Import its helpers (`getProducts`, `getProduct`, `createCheckout`, `trackEvent`) for catalog, cart, checkout, and the analytics pixel. The storefront is CUSTOMER-FACING: render products and buying flow, but NEVER show store analytics/sales/revenue to the shopper — that data belongs only to the owner's admin (MercuryShell). Prefer Next.js.",
			"- KNOW YOUR IDE WINDOWS: the CENTER window is a LIVE PREVIEW of the running site/app exactly as the user sees it (plan and research dashboards also render there); YOU are the RIGHT panel (this chat). The center preview AUTO-REFRESHES after every one of your turns, so the user sees your latest changes each prompt. If the user says \"the center/the site isn't updated\", it means the live preview isn't reflecting your work — ensure the dev server is running and your file changes are saved so the center shows them; the IDE will reload it. When the user SELECTS a component/section in the live preview, you are handed that element's identity (tag/id/class/text/path) — scope your change to THAT specific element.",
		].join("\n");
	}

	// ---- PWA app-shell scaffold --------------------------------------------
	// App mode's tangible distinctiveness: generate a REAL, runnable multi-screen
	// PWA app shell (no build step — plain HTML/CSS/JS so it runs straight in the
	// phone-frame preview) instead of a one-page marketing site. The build agent
	// then fleshes out each screen. Files are written only if absent so we never
	// clobber the user's work.
	appShellFiles() {
		const manifest = JSON.stringify({
			name: "Solstice App", short_name: "App", start_url: "./index.html",
			display: "standalone", background_color: "#0f0f12", theme_color: "#f59e0b",
			icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
		}, null, 2);
		const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f0f12"/><circle cx="256" cy="256" r="120" fill="none" stroke="#f59e0b" stroke-width="28"/><circle cx="256" cy="256" r="44" fill="#f59e0b"/></svg>\n`;
		const indexHtml = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#f59e0b" />
<link rel="manifest" href="manifest.webmanifest" />
<link rel="icon" href="icon.svg" />
<link rel="stylesheet" href="app.css" />
<title>Solstice App</title>
</head>
<body>
  <div class="appbar"><button class="appbar-back" id="back" hidden>‹</button><h1 id="title">בית</h1></div>
  <main id="screen" class="screen"></main>
  <nav class="tabbar">
    <a href="#/" class="tab" data-route="/"><span class="tab-ico">⌂</span><span>בית</span></a>
    <a href="#/explore" class="tab" data-route="/explore"><span class="tab-ico">⌕</span><span>גלה</span></a>
    <a href="#/profile" class="tab" data-route="/profile"><span class="tab-ico">◑</span><span>פרופיל</span></a>
  </nav>
  <script src="data.js"></script>
  <script src="app.js"></script>
</body>
</html>
`;
		const appCss = `:root{ --bg:#0f0f12; --surface:#1a1a1f; --line:#2a2a31; --fg:#ececf0; --muted:#9a9aa4; --accent:#f59e0b; --accent2:#fb7a3c; }
*{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
html,body{ margin:0; height:100%; background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
body{ display:flex; flex-direction:column; min-height:100vh; }
.appbar{ position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:8px; padding:max(12px,env(safe-area-inset-top)) 16px 12px; background:linear-gradient(180deg,rgba(245,158,11,.12),transparent), var(--bg); border-bottom:1px solid var(--line); }
.appbar h1{ font-size:19px; font-weight:700; margin:0; letter-spacing:-.3px; }
.appbar-back{ appearance:none; border:none; background:transparent; color:var(--accent); font-size:26px; line-height:1; padding:0 4px; cursor:pointer; }
.screen{ flex:1; padding:18px 16px 96px; overflow-y:auto; animation:screen-in .28s cubic-bezier(.2,.7,.3,1); }
@keyframes screen-in{ from{ opacity:0; transform:translateY(10px); } }
.card{ background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:14px; }
.hero{ background:linear-gradient(150deg,var(--accent2),var(--accent)); color:#1a1206; border:none; }
.hero h2{ margin:0 0 4px; font-size:22px; } .hero p{ margin:0; opacity:.85; font-size:13px; }
.btn{ appearance:none; border:none; border-radius:12px; padding:13px 16px; font-size:15px; font-weight:600; width:100%; cursor:pointer; background:linear-gradient(150deg,var(--accent2),var(--accent)); color:#1a1206; }
.btn.ghost{ background:var(--surface); color:var(--fg); border:1px solid var(--line); }
.row{ display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--line); }
.row:last-child{ border-bottom:none; }
.row .ico{ width:40px; height:40px; border-radius:11px; display:grid; place-items:center; background:rgba(245,158,11,.14); color:var(--accent); font-size:18px; flex:none; }
.row .meta{ flex:1; min-width:0; } .row .meta b{ display:block; font-size:14px; } .row .meta small{ color:var(--muted); font-size:12px; }
.muted{ color:var(--muted); font-size:13px; line-height:1.6; }
.count{ font-size:44px; font-weight:800; letter-spacing:-1px; text-align:center; margin:8px 0; }
.tabbar{ position:fixed; bottom:0; left:0; right:0; z-index:6; display:flex; background:rgba(20,20,24,.92); backdrop-filter:blur(12px); border-top:1px solid var(--line); padding-bottom:env(safe-area-inset-bottom); }
.tab{ flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; padding:9px 0 11px; text-decoration:none; color:var(--muted); font-size:10.5px; font-weight:600; }
.tab-ico{ font-size:20px; line-height:1; }
.tab.active{ color:var(--accent); }
`;
		const appJs = `"use strict";
// Tiny hash router + 3 screens. No build step, no deps — runs straight in the
// Solstice phone-frame preview. The build agent fills these screens out.
(function(){
  const screenEl = document.getElementById("screen");
  const titleEl = document.getElementById("title");
  const backEl = document.getElementById("back");
  const tabs = [...document.querySelectorAll(".tab")];
  const store = { get k(){ return Number(localStorage.getItem("count")||0); }, set k(v){ localStorage.setItem("count", v); } };

  const screens = {
    "/": { title: "בית", render(){ return \`
      <section class="card hero"><h2>ברוך הבא 👋</h2><p>שלד אפליקציה — ריבוי מסכים, ניווט תחתון, מותקנת.</p></section>
      <section class="card"><div class="muted">מונה דמו ששומר ב-localStorage:</div><div class="count" id="cnt">\${store.k}</div>
        <button class="btn" id="inc">הוסף +1</button></section>
      <section class="card"><div class="row"><div class="ico">⚡</div><div class="meta"><b>מהיר</b><small>נטען מיידית, עובד אופליין</small></div></div>
        <div class="row"><div class="ico">📲</div><div class="meta"><b>מותקנת</b><small>הוסף למסך הבית כאפליקציה</small></div></div></section>\`; },
      after(){ const c=document.getElementById("cnt"); document.getElementById("inc").onclick=()=>{ store.k=store.k+1; c.textContent=store.k; }; } },
    "/explore": { title: "גלה", render(){
      var items = (window.DB ? DB.all() : []);
      var rows = items.map(function(it){ return \`<div class="row" data-id="\${it.id}">
        <div class="ico" style="\${it.done?'background:rgba(52,211,153,.16);color:#34d399':''}">\${it.done?'✓':'○'}</div>
        <div class="meta"><b>\${it.title}</b><small>\${it.note||''}</small></div></div>\`; }).join("");
      return \`<section class="card"><div class="muted">רשימה חיה משכבת ה-data (\${items.length} פריטים, נשמרים ב-localStorage):</div></section>
      <section class="card" id="list">\${rows || '<div class="muted">אין פריטים</div>'}</section>
      <section class="card"><button class="btn" id="add">הוסף פריט +</button>
        <button class="btn ghost" id="reset" style="margin-top:10px">אפס נתונים</button></section>\`; },
      after(){
        var list = document.getElementById("list");
        list.querySelectorAll(".row").forEach(function(r){ r.onclick=function(){ DB.toggle(r.dataset.id); route(); }; });
        document.getElementById("add").onclick=function(){ DB.add({ title:"פריט חדש", note:"נוצר עכשיו", done:false }); route(); };
        document.getElementById("reset").onclick=function(){ DB.reset(); route(); };
      } },
    "/profile": { title: "פרופיל", render(){ return \`
      <section class="card"><div class="row"><div class="ico">🙂</div><div class="meta"><b>המשתמש שלך</b><small>guest@solstice.app</small></div></div></section>
      <section class="card"><button class="btn ghost" id="reset">אפס מונה</button></section>\`; },
      after(){ document.getElementById("reset").onclick=()=>{ store.k=0; location.hash="#/"; }; } },
  };

  function route(){
    const path = (location.hash.replace(/^#/, "") || "/");
    const s = screens[path] || screens["/"];
    titleEl.textContent = s.title;
    screenEl.innerHTML = s.render();
    if (s.after) s.after();
    backEl.hidden = path === "/";
    tabs.forEach(t => t.classList.toggle("active", t.dataset.route === path));
    screenEl.scrollTop = 0;
  }
  backEl.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");
  window.addEventListener("hashchange", route);
  route();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
`;
		const dataJs = `"use strict";
// Mock data layer — the app-vs-site distinction made tangible. A real app needs
// DATA and CRUD; a marketing site doesn't. Seed records + a tiny store persisted
// to localStorage, with a clean API the build agent swaps for a real backend
// (fetch/Supabase/Firebase) later. Lists/detail screens read from window.DB, and
// every write shows up live in Solstice's State inspector.
(function () {
  const KEY = "app.items";
  const SEED = [
    { id: 1, title: "להתחיל פרויקט", note: "מסך ראשון של האפליקציה", done: false },
    { id: 2, title: "לעצב מסכים", note: "ניווט תחתון + מעבר חלק", done: false },
    { id: 3, title: "לחבר נתונים", note: "שכבת data עם שמירה מקומית", done: true },
  ];
  function load() { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : SEED.slice(); } catch (e) { return SEED.slice(); } }
  function save(items) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }
  window.DB = {
    all() { return load(); },
    get(id) { return load().find((x) => String(x.id) === String(id)); },
    add(item) { const items = load(); item.id = Date.now(); items.unshift(item); save(items); return item; },
    update(id, patch) { save(load().map((x) => String(x.id) === String(id) ? Object.assign({}, x, patch) : x)); },
    toggle(id) { save(load().map((x) => String(x.id) === String(id) ? Object.assign({}, x, { done: !x.done }) : x)); },
    remove(id) { save(load().filter((x) => String(x.id) !== String(id))); },
    reset() { try { localStorage.removeItem(KEY); } catch (e) {} },
  };
})();
`;
		const swJs = `// Minimal offline-first service worker for the app shell.
const CACHE = "solstice-app-v1";
const ASSETS = ["./", "index.html", "app.css", "app.js", "data.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match("index.html"))));
});
`;
		return {
			"index.html": indexHtml,
			"app.css": appCss,
			"app.js": appJs,
			"data.js": dataJs,
			"sw.js": swJs,
			"manifest.webmanifest": manifest,
			"icon.svg": icon,
		};
	}

	// Write the app-shell scaffold into `root`, never clobbering existing files.
	// Returns { written:[...], skipped:[...] }.
	scaffoldAppShell(root) {
		const files = this.appShellFiles();
		const written = [], skipped = [];
		for (const [rel, content] of Object.entries(files)) {
			const abs = path.join(root, rel);
			if (fs.existsSync(abs)) { skipped.push(rel); continue; }
			try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content, "utf8"); written.push(rel); }
			catch { skipped.push(rel); }
		}
		return { written, skipped };
	}

	// Generate the app shell into the open workspace, switch to App mode, and open
	// the phone-frame preview so the user immediately sees a runnable app.
	async scaffoldAppIntoWorkspace() {
		const root = workspaceCwd();
		if (!root) { vscode.window.showWarningMessage("פתח תיקייה כדי ליצור שלד אפליקציה."); return; }
		const { written, skipped } = this.scaffoldAppShell(root);
		this.setBuildMode("app");
		if (written.length) {
			this.post({ type: "systemNote", text: "📱 נוצר שלד אפליקציה (PWA): " + written.join(", ") + (skipped.length ? " · דילגתי על קיימים: " + skipped.join(", ") : "") });
			vscode.window.showInformationMessage("שלד אפליקציה נוצר — " + written.length + " קבצים. פותח תצוגה…");
			setTimeout(() => this.openPreview("").catch(() => { }), 400);
		} else {
			vscode.window.showInformationMessage("כל קבצי שלד האפליקציה כבר קיימים — לא נכתב כלום.");
		}
		return { written, skipped };
	}

	async openPreview(explicitUrl) {
		let url = explicitUrl || "";
		if (!url) {
			const root = workspaceCwd();
			if (!root) { vscode.window.showWarningMessage("Open a folder to preview."); return; }
			// Prefer a live dev server (Vite/Next/CRA the agent started) — a bundled
			// app can't run as flat files. Fall back to the static server only for
			// plain-HTML projects.
			url = await detectDevServerUrl(root).catch(() => null);
			// Framework project with no live server: boot the dev server rather than
			// static-serving an un-bundled (broken) page. ensureDevServer re-enters
			// openPreview with the real URL once the port is up.
			if (!url && hasFramework(root)) { await this.ensureDevServer().catch(() => { }); return; }
			if (!url) url = await this.ensureStaticPreviewUrl(root);
			if (!url) { vscode.window.showWarningMessage("Solstice: no HTML file is available to preview."); return; }
		}
		if (this.devServer && this.devServer.hasOwnedProcess()) this.devServer.touch("preview-open");
		// Route a live dev server through the injecting proxy so click-to-select works
		// on framework apps too (not just plain HTML). Keeps the URL we actually load.
		url = await this.proxyDevServerForSelect(url).catch(() => url);
		this.previewUrl = url;
		this.previewKind = this.detectPreviewKind();
		this.openPreviewPanel(url, this.defaultDevice());
		this.fleetFlow("preview", { url });
	}

	async ensureStaticPreviewUrl(root = workspaceCwd()) {
		if (!root) return null;
		let rel = "index.html";
		if (!fs.existsSync(path.join(root, rel))) {
			const found = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**", 1);
			if (!found.length) return null;
			rel = vscode.workspace.asRelativePath(found[0]);
		}
		if (!this.preview) this.preview = new PreviewServer(root, {
			onSelect: (pick) => this.post({ type: "elementSelected", pick }),
		});
		const port = await this.preview.ensure();
		const urlPath = String(rel).split(/[\\/]/).map(encodeURIComponent).join("/");
		return `http://127.0.0.1:${port}/${urlPath}`;
	}

	// If `url` is a live local dev server (Vite/Next/CRA the agent started), wrap it
	// in the static PreviewServer running as an injecting reverse-proxy, so the
	// click-to-select picker + app bridge are present. No-op for remote URLs or when
	// the URL is already our own (already-injected) static server.
	async proxyDevServerForSelect(url) {
		let u;
		try { u = new URL(url); } catch { return url; }
		if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return url;
		if (!this.preview) this.preview = new PreviewServer(workspaceCwd(), {
			onSelect: (pick) => this.post({ type: "elementSelected", pick }),
		});
		const port = await this.preview.ensure();
		if (Number(u.port) === port) return url; // already our static server → already injected
		this.preview.setProxyTarget(`${u.protocol}//${u.host}`);
		return `http://127.0.0.1:${port}${u.pathname}${u.search || ""}`;
	}

	// First previewable file → auto-open the center preview (regression fix: this
	// used to fire only on plain .html). For framework projects we poll briefly
	// for the agent's dev server and open the moment it's reachable; for plain
	// HTML we open the static server right away.
	ensurePreviewSoon() {
		if (this.previewUrl || this._previewWatch) return;
		const root = workspaceCwd();
		if (!root) return;
		const framework = hasFramework(root);
		// Plain-HTML projects: open the static server right away.
		if (!framework) { this.openPreview("").catch(() => { }); return; }
		// Framework projects: a static serve would render a broken, un-bundled page,
		// so we need the real dev server. The agent writes the app but never started
		// it — so we boot it ourselves (npm install if needed + npm run dev) and open
		// the preview the moment the port is live.
		let elapsed = 0;
		const STEP = 2500, MAX = 30000;
		const tick = async () => {
			if (this.previewUrl) { this.stopPreviewWatch(); return; }
			const dev = await detectDevServerUrl(root).catch(() => null);
			if (dev) { this.stopPreviewWatch(); await this.openPreview(dev).catch(() => { }); return; }
			elapsed += STEP;
			// Already-running server not found quickly → start it ourselves.
			if (elapsed >= MAX) { this.stopPreviewWatch(); this.ensureDevServer().catch(() => { }); }
		};
		this._previewWatch = setInterval(tick, STEP);
		tick();
	}

	// Boot (or reuse) the project's dev server, streaming its log to the agent
	// terminal, then point the live preview at it. This is what makes the center
	// window actually render the built site instead of staying blank.
	async ensureDevServer(options = {}) {
		const root = workspaceCwd();
		const openPreview = options.openPreview !== false;
		const reportFailure = options.reportFailure !== false;
		if (!root) return null;
		if (!this.devServer) {
			this.devServer = new DevServer(root, {
				onLog: (s) => { try { this.output.append(s); } catch { } },
				onStateChange: () => {
					if (this.devServer && !this.devServer.hasOwnedProcess()) {
						this.previewUrl = "";
						this.postPreview({ type: "load", url: "", device: this.defaultDevice() });
					}
					this.pushDevServerInventory();
				},
				idleTimeoutMs: this.devServerIdleTimeoutMs(),
			});
		}
		this.post({ type: "systemNote", text: "🚀 מריץ את שרת הפיתוח (npm run dev)… התצוגה תיפתח כשהוא יעלה." });
		let launchError = null;
		const url = await this.devServer.ensure().catch((error) => { launchError = error; return null; });
		if (url) {
			this.devServer.touch("preview-open");
			if (openPreview) {
				try { await this.openPreview(url); }
				catch (error) {
					const reason = error && error.message || String(error);
					this.post({ type: "systemNote", text: `⚠️ שרת הפיתוח עלה, אבל פתיחת ה־Preview נכשלה: ${reason}` });
					this.pushDevServerInventory();
					return null;
				}
			}
			this.pushDevServerInventory();
			return url;
		}
		const reason = launchError && launchError.message
			|| this.devServer.lastError
			|| "npm run dev לא החזיר כתובת פעילה";
		if (reportFailure) this.post({ type: "systemNote", text: `⚠️ לא הצלחתי להריץ את שרת הפיתוח: ${reason}` });
		this.pushDevServerInventory();
		return null;
	}

	devServerIdleTimeoutMs() {
		const minutes = Number(this.cfg().get("devServerIdleMinutes"));
		return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60 * 1000;
	}

	listDevServersForAgent() {
		return listOwnedDevServers(this.devServer, this.managerDevServers);
	}

	pushDevServerInventory() {
		const servers = this.listDevServersForAgent();
		this.postManager({
			type: "devServers",
			servers,
			idleTimeoutMs: this.devServerIdleTimeoutMs(),
		});
		this.updateDevServerStatus(servers);
	}

	updateDevServerStatus(servers = this.listDevServersForAgent()) {
		if (!this.devServerStatus) return;
		const count = servers.length;
		this.devServerStatus.text = `$(zap) ${count} שרתי preview`;
		this.devServerStatus.tooltip = count
			? "Solstice-owned preview servers are using memory. Click to inspect or close them."
			: "No Solstice-owned preview servers are running.";
		this.devServerStatus.show();
	}

	async devServerMemoryMb(pid) {
		const safePid = Number(pid);
		if (!Number.isInteger(safePid) || safePid <= 0) return null;
		try {
			const execFile = require("util").promisify(require("child_process").execFile);
			let bytes;
			if (process.platform === "win32") {
				const script = [
					`$all=Get-CimInstance Win32_Process; $ids=@(${safePid});`,
					"do { $next=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId } | Where-Object { $ids -notcontains $_ }); $ids += $next } while ($next.Count -gt 0);",
					"($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum",
				].join(" ");
				const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 3000 });
				bytes = Number(stdout.trim());
			} else {
				const { stdout } = await execFile("ps", ["-e", "-o", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 3000 });
				const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3);
				const ids = new Set([safePid]);
				let changed = true;
				while (changed) {
					changed = false;
					for (const [child, parent] of rows) {
						if (ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true; }
					}
				}
				bytes = rows.filter(([child]) => ids.has(child)).reduce((sum, row) => sum + row[2] * 1024, 0);
			}
			return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / 1024 / 1024) : null;
		} catch { return null; }
	}

	async showDevServers() {
		const servers = this.listDevServersForAgent();
		if (!servers.length) {
			vscode.window.showInformationMessage("Solstice: no preview servers are running.");
			return;
		}
		const items = await Promise.all(servers.map(async (server) => {
			const ram = await this.devServerMemoryMb(server.pid);
			return {
				label: `$(pulse) ${path.basename(server.root || "project")} · :${server.port || "?"}`,
				description: `PID ${server.pid || "?"} · RAM ${ram == null ? "unknown" : `${ram} MB`}`,
				detail: server.root || "",
				serverId: server.id,
			};
		}));
		items.push({
			label: "$(debug-stop) Close all preview servers",
			description: `Stop ${servers.length} Solstice-owned server${servers.length === 1 ? "" : "s"}`,
			detail: "No unrelated process is touched.",
			closeAll: true,
		});
		const selected = await vscode.window.showQuickPick(items, { title: "Solstice preview servers", placeHolder: "Inspect a server or close all" });
		if (!selected || !selected.closeAll) return;
		const result = this.stopAllDevServers("statusbar-close-all");
		if (!result.ok) vscode.window.showErrorMessage(`Solstice could stop only ${result.stopped}/${result.requested} preview servers.`);
		else vscode.window.showInformationMessage(`Solstice: closed ${result.stopped} preview server${result.stopped === 1 ? "" : "s"}.`);
	}

	stopDevServerForAgent(id) {
		const result = stopOwnedDevServer(this.devServer, this.managerDevServers, id, "manual");
		if (!result.ok) {
			this.pushDevServerInventory();
			return result;
		}
		if (result.scope === "workspace") {
			this.previewUrl = "";
			this.postPreview({ type: "load", url: "", device: this.defaultDevice() });
		} else if (result.taskId) {
			this.managerDevServers.delete(result.taskId);
			const task = this.managerTasks && this.managerTasks.get(result.taskId);
			if (task) this.managerTasks.setStatus(result.taskId, task.status, { previewUrl: "" });
			this.pushManagerTasks();
			this.postManager({ type: "managerPreview", taskId: result.taskId, url: "" });
		}
		this.output.append(`[dev-tools] stopped ${result.id} PID ${result.pid}\n`);
		this.pushDevServerInventory();
		return result;
	}

	stopAllDevServers(reason = "close-all") {
		const result = stopAllOwnedDevServers(this.devServer, this.managerDevServers, reason);
		const stoppedIds = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
		for (const item of result.results) {
			if (item.ok && item.scope === "manager" && item.taskId) this.managerDevServers.delete(item.taskId);
		}
		if (stoppedIds.has("workspace")) {
			if (this.preview) this.preview.dispose();
			this.previewUrl = "";
			this.postPreview({ type: "load", url: "", device: this.defaultDevice() });
		}
		for (const [taskId, preview] of this.managerPreviews) {
			if (!stoppedIds.has(`manager:${taskId}`)) continue;
			preview.dispose();
			this.managerPreviews.delete(taskId);
		}
		for (const task of this.managerTaskList()) {
			if (!stoppedIds.has(`manager:${task.id}`)) continue;
			if (task.previewUrl) this.managerTasks.setStatus(task.id, task.status, { previewUrl: "" });
			this.postManager({ type: "managerPreview", taskId: task.id, url: "" });
		}
		this.pushManagerTasks();
		this.pushDevServerInventory();
		this.output.append(`[dev-tools] close-all reason=${reason} stopped=${result.stopped}/${result.requested}\n`);
		return result;
	}

	async devServerToolEnv() {
		await this._devServerToolReady;
		return this.devServerToolBridge ? this.devServerToolBridge.env() : {};
	}

	devServerToolCommand(operation, id) {
		return agentToolCommand(process.execPath, path.join(this.context.extensionPath, "devServerTools.js"), operation, id);
	}

	devServerToolInstructions() {
		return [
			"- solstice/dev-server-list — list only dev servers owned by this Solstice window: " + this.devServerToolCommand("list"),
			"- solstice/dev-server-stop — stop an IDE-owned server without an approval card. First list, then run: " + this.devServerToolCommand("stop", "workspace") + " (replace workspace with a returned manager:<task-id> when needed). Never kill a process by port or PID yourself.",
			"- solstice/dev-server-stop-all — close every preview server owned by this Solstice window: " + this.devServerToolCommand("close-all") + ". Use this at the end of a build session or when Thomas asks to close all servers.",
		].join("\n");
	}

	claudeDevServerAllowedTools() {
		const commands = [
			this.devServerToolCommand("list"),
			this.devServerToolCommand("stop", "workspace"),
			this.devServerToolCommand("close-all"),
			...this.listDevServersForAgent()
				.filter((item) => item.scope === "manager")
				.map((item) => this.devServerToolCommand("stop", item.id)),
		];
		return [...new Set(commands)].map((command) => `Bash(${command})`);
	}

	grokDevServerAllowedTools() {
		return [
			this.devServerToolCommand("list"),
			this.devServerToolCommand("stop", "workspace"),
			this.devServerToolCommand("close-all"),
			...this.listDevServersForAgent()
				.filter((item) => item.scope === "manager")
				.map((item) => this.devServerToolCommand("stop", item.id)),
		];
	}

	// Deterministic runtime commands should not spend a model turn rediscovering
	// the workspace. Launch/reveal is handled by the IDE; an owned dev server can
	// also be stopped directly. External servers are left to the agent because we
	// do not own their PID and must not kill an unrelated process by port alone.
	async handleRuntimeIntent(text) {
		if (isPureLaunchIntent(text)) {
			const root = workspaceCwd();
			if (!root) { vscode.window.showWarningMessage("Solstice: open a folder first."); return true; }
			const external = isExternalLaunchIntent(text);
			const framework = hasFramework(root);
			let url = await detectDevServerUrl(root).catch(() => null);
			if (!url) {
				if (!fs.existsSync(path.join(root, "package.json"))) {
					url = await this.ensureStaticPreviewUrl(root).catch(() => null);
					if (!url) {
						this.post({ type: "systemNote", text: "⚠️ לא מצאתי package.json או קובץ HTML שניתן להציג בפרויקט." });
						return true;
					}
					if (!external) await this.openPreview(url).catch(() => { });
				} else {
					url = await this.ensureDevServer({ openPreview: !external, reportFailure: framework });
					if (!url && !framework) {
						url = await this.ensureStaticPreviewUrl(root).catch(() => null);
						if (url && !external) await this.openPreview(url).catch(() => { });
						if (url) this.post({ type: "systemNote", text: "ℹ️ פקודת הפיתוח הסתיימה בלי שרת; פתחתי את גרסת ה־HTML ישירות." });
					}
					if (!url) {
						if (!framework) {
							const reason = this.devServer && this.devServer.lastError || "npm run dev לא החזיר כתובת פעילה ולא נמצא קובץ HTML להצגה";
							this.post({ type: "systemNote", text: `⚠️ לא הצלחתי לפתוח את האתר: ${reason}` });
						}
						return true; // Framework failures were already reported by ensureDevServer.
					}
				}
			} else if (!external) {
				try { await this.openPreview(url); }
				catch (error) {
					this.post({ type: "systemNote", text: `⚠️ השרת פעיל, אבל פתיחת ה־Preview נכשלה: ${error && error.message || error}` });
					return true;
				}
			}
			if (external) {
				try {
					const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
					if (opened === false) throw new Error("VS Code rejected the browser-open request");
					this.post({ type: "systemNote", text: "🌐 האתר נפתח בדפדפן החיצוני." });
				} catch (error) {
					this.post({ type: "systemNote", text: `⚠️ לא הצלחתי לפתוח את האתר בדפדפן החיצוני: ${error && error.message || error}` });
				}
				return true;
			}
			if (this.previewUrl) this.refreshPreview();
			this.post({ type: "systemNote", text: this.previewUrl ? "🚀 האתר פתוח ב־Live Preview." : "⚠️ לא נמצא שרת או קובץ שניתן להציג." });
			return true;
		}
		const stopScope = runtimeStopIntent(text);
		if (stopScope) {
			const result = stopScope === "all"
				? this.stopAllDevServers("intent-close-all")
				: this.stopDevServerForAgent("workspace");
			if (result.ok) {
				const stopped = stopScope === "all" ? result.stopped : 1;
				this.post({ type: "systemNote", text: stopped ? `🛑 סגרתי ${stopped} שרתי preview.` : "ℹ️ אין שרתי preview פתוחים לסגירה." });
			} else {
				const detail = result.error || `${result.stopped || 0}/${result.requested || 1} servers stopped`;
				const message = `Solstice could not close the requested preview server(s): ${detail}`;
				this.output.append(`[dev-tools] ${message}\n`);
				this.post({ type: "systemNote", text: `⚠️ ${message}` });
				vscode.window.showErrorMessage(message);
			}
			return true;
		}
		return false;
	}

	stopPreviewWatch() {
		if (this._previewWatch) { clearInterval(this._previewWatch); this._previewWatch = null; }
	}

	// Create/reveal the device-frame preview webview in the center column and
	// point it at the live URL.
	openPreviewPanel(url, device) {
		if (!this.previewPanel) {
			this.previewPanel = vscode.window.createWebviewPanel(
				"solstice.preview",
				"🔎 Live Preview",
				{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
				}
			);
			this.previewPanel.webview.html = previewHtml(this.previewPanel.webview, this.context.extensionUri);
			this.previewReady = false;
			this.previewPanel.webview.onDidReceiveMessage((m) => {
				if (m.type === "ready") {
					this.previewReady = true;
					if (this.previewUrl) this.postPreview({ type: "load", url: this.previewUrl, device: this.defaultDevice() });
				} else if (m.type === "device") {
					this.previewKind = (m.device === "desktop") ? "site" : "app";
				} else if (m.type === "openExternal" && m.url) {
					try {
						const target = vscode.Uri.parse(m.url);
						Promise.resolve(vscode.env.openExternal(target)).then(
							(opened) => { if (opened === false) vscode.window.showErrorMessage(`Solstice could not open ${m.url} in the external browser.`); },
							(error) => vscode.window.showErrorMessage(`Solstice could not open the external browser: ${error && error.message || error}`),
						);
					} catch (error) {
						vscode.window.showErrorMessage(`Solstice could not open the external browser: ${error && error.message || error}`);
					}
				}
			});
			this.previewPanel.onDidDispose(() => { this.previewPanel = null; this.previewReady = false; });
		} else {
			this.previewPanel.reveal(vscode.ViewColumn.Two, true);
		}
		if (this.previewReady) this.postPreview({ type: "load", url, device });
	}

	postPreview(msg) {
		if (this.previewPanel) this.previewPanel.webview.postMessage(msg);
	}

	refreshPreview() {
		// This is intentionally the only refreshPreview implementation. A duplicate
		// method used to override the reopen path, so turn 2+ silently lost Preview.
		if (!this.previewUrl) { this.openPreview("").catch(() => { }); return; }
		if (this.devServer && this.devServer.hasOwnedProcess()) this.devServer.touch("preview-refresh");
		if (!this.previewPanel) { this.openPreviewPanel(this.previewUrl, this.defaultDevice()); return; }
		this.postPreview({ type: "reload", holdMs: 900 });
	}

	normalizePlanStatus(status) {
		const s = String(status || "").toLowerCase().replace(/[_\s-]+/g, "");
		if (/^(completed|complete|done|success|finished|x)$/.test(s)) return "completed";
		if (/^(inprogress|current|running|active|doing|working|started|~)$/.test(s)) return "inProgress";
		return "pending";
	}

	normalizePlan(plan) {
		if (!Array.isArray(plan)) return [];
		return plan.map((s) => {
			if (!s) return null;
			const item = {
				step: String(s.step || s.content || s.title || s.text || "").trim(),
				status: this.normalizePlanStatus(s.status),
			};
			if (!item.step) return null;
			if (s.group) item.group = String(s.group).trim();
			if (s.detail) item.detail = String(s.detail).trim();
			const substeps = Array.isArray(s.substeps) ? this.normalizePlan(s.substeps) : [];
			if (substeps.length) item.substeps = substeps;
			return item;
		}).filter(Boolean);
	}

	serializePlanMarkdown(th) {
		const marks = { completed: "[x]", inProgress: "[~]", pending: "[ ]" };
		const lines = [];
		let group = "";
		for (const s of th.plan || []) {
			if (s.group && s.group !== group) {
				group = s.group;
				if (lines.length) lines.push("");
				lines.push("## " + group);
			}
			const mark = marks[s.status] || "[ ]";
			lines.push(`${lines.filter((l) => /^\d+\.\s/.test(l)).length + 1}. ${mark} ${s.step}${s.status === "inProgress" ? "   ← current" : ""}`);
			if (s.detail) lines.push(`   _${s.detail}_`);
			if (Array.isArray(s.substeps)) {
				for (const sub of s.substeps) {
					const sm = marks[sub.status] || "[ ]";
					lines.push(`   - ${sm} ${sub.step}${sub.status === "inProgress" ? "   ← current" : ""}`);
					if (sub.detail) lines.push(`     _${sub.detail}_`);
				}
			}
		}
		const title = (th.preview || "").split("\n")[0].slice(0, 80);
		return `# Agent Plan\n\n${title ? "_" + title + "_\n\n" : ""}${lines.join("\n")}\n`;
	}

	writePlanFile(th) {
		const root = workspaceCwd();
		if (!root || !th || !Array.isArray(th.plan) || !th.plan.length) return;
		const dir = path.join(root, ".solstice");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
		const text = this.serializePlanMarkdown(th);
		if (text === this.lastPlanFileText) return;
		this.lastPlanFileText = text;
		const file = path.join(dir, "PLAN.md");
		try { fs.writeFileSync(file, text); } catch { return; }
		// PLAN.md stays on disk as an artifact, but we no longer open it as raw
		// markdown — the visual plan webview (openPlanPanel) owns the center view.
	}

	onFilesChanged(item, threadId) {
		const root = workspaceCwd();
		const paths = (item.changes || []).map((c) => c.path || c.file).filter(Boolean);
		for (const p of paths) {
			const abs = path.isAbsolute(p) ? p : path.join(root || "", p);
			if (PLAN_FILE_RE.test(abs)) this.emitPlanFile(abs, threadId);
		}
		// research/plan docs have dedicated views — never open their raw editors over them
		const skip = /(^|[\\/])(RESEARCH|DECONSTRUCT)\.md$|[\\/]\.solstice[\\/]/;
		for (const p of paths.filter((p) => !skip.test(p)).slice(0, 3)) {
			const abs = path.isAbsolute(p) ? p : path.join(root || "", p);
			let stat;
			try { stat = fs.statSync(abs); } catch { continue; }
			if (!stat.isFile()) continue;
			// Images the agent generates/saves arrive as plain FILE WRITES (it uses a
			// shell image tool), NOT imageGeneration items — so the panel never renders
			// them. Open them in the center editor as image previews so the user
			// actually sees generated imagery. (Thomas: "I don't see the images.")
			if (/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(p)) { this.openImage(abs); this.showImageInPanel(abs); continue; }
			if (stat.size > 1500000) continue;
			vscode.window.showTextDocument(vscode.Uri.file(abs), {
				viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
			}).then(undefined, () => { });
		}
		// first previewable file the agent writes → auto-open the live preview
		// (html for static sites; jsx/tsx/vue/svelte/astro for bundled apps)
		if (!this.previewUrl && paths.some((p) => /\.(html?|jsx?|tsx?|vue|svelte|astro)$/i.test(p))) {
			this.ensurePreviewSoon();
			return;
		}
		this.refreshPreview();
	}

	// Render an agent-written image INLINE in the right agent panel. Composer/grok
	// don't emit imageGeneration items, so a generated image would otherwise never
	// show in the panel — we synthesize an imageView item from the file write.
	showImageInPanel(abs) {
		try {
			if (!this.webview) return;
			const item = this.withImageUri({ id: "img_" + Date.now(), type: "imageView", path: abs, status: "completed" }, this.webview);
			this.post({ type: "notification", method: "item/completed", params: { item } });
		} catch (e) { /* ignore */ }
	}

	// resolve an image item's saved location to an absolute path on disk
	imageAbsPath(item) {
		const p = item && (item.savedPath || item.path);
		if (!p) return null;
		if (path.isAbsolute(p)) return p;
		const root = workspaceCwd();
		return root ? path.join(root, p) : p;
	}

	// attach a webview-loadable URI to an image item so the panel can render it inline
	withImageUri(item, webview) {
		const abs = this.imageAbsPath(item);
		if (!abs || !webview) return item;
		try { if (!fs.existsSync(abs)) return item; } catch { return item; }
		return {
			...item,
			absPath: abs,
			webUri: webview.asWebviewUri(vscode.Uri.file(abs)).toString(),
		};
	}

	// open a generated image in the center editor (image preview), like PLAN.md
	openImage(p) {
		const abs = p && (path.isAbsolute(p) ? p : path.join(workspaceCwd() || "", p));
		if (!abs) return;
		try { if (!fs.statSync(abs).isFile()) return; } catch { return; }
		vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs), {
			viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
		}).then(undefined, () => { });
	}

	// Persist user-attached images (composer 📎 / paste / drag-drop) into the
	// workspace so the agent can read & analyze them, and append a reference to
	// the prompt. Lets the user hand the agent a reference image to add to the
	// site, or a screenshot of a bug to fix. Returns the (augmented) text.
	async withAttachments(text, attachments) {
		const list = Array.isArray(attachments) ? attachments : [];
		if (!list.length) return text;
		const root = workspaceCwd();
		if (!root) return text;
		const dir = path.join(root, ".solstice", "attachments");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { }
		const saved = [];
		for (let i = 0; i < list.length; i++) {
			const a = list[i] || {};
			const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(String(a.dataUrl || ""));
			if (!m) continue;
			const ext = (m[1].split("/")[1] || "png").replace("+xml", "").replace("jpeg", "jpg");
			const safe = String(a.name || "image").replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "image";
			const abs = path.join(dir, `${Date.now()}_${i}_${safe}.${ext}`);
			try { fs.writeFileSync(abs, Buffer.from(m[2], "base64")); saved.push(abs); } catch { }
		}
		if (!saved.length) return text;
		const rels = saved.map((p) => path.relative(root, p));
		const note = `\n\n[The user attached ${saved.length} image(s) for you to use: ${rels.join(", ")}. Open and analyze them directly, then act — incorporate into the site, or fix the issue shown in the screenshot.]`;
		return (text || "Please look at the attached image(s).") + note;
	}

	// Voice dictation: webview records mic audio → Groq Whisper → text back into the composer.
	// Same engine as the fleet's Telegram dictation (whisper-large-v3, Hebrew-first).
	async transcribeVoice(b64, mime) {
		try {
			const key = String(this.cfg().get("groqApiKey") || process.env.GROQ_API_KEY || "").trim();
			if (!key) {
				this.post({ type: "transcribeError", message: "Voice needs a Groq key — set solstice.codex.groqApiKey (or GROQ_API_KEY)." });
				return;
			}
			const bytes = Buffer.from(String(b64 || ""), "base64");
			if (!bytes.length) { this.post({ type: "transcribeError", message: "empty recording" }); return; }
			const ext = mime && mime.includes("ogg") ? "ogg" : "webm";
			const lang = String(this.cfg().get("dictationLanguage") || "he").trim() || "he";
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "voice." + ext);
			form.append("model", "whisper-large-v3");
			if (lang && lang !== "auto") form.append("language", lang);
			const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
				method: "POST",
				headers: { Authorization: "Bearer " + key },
				body: form,
			});
			if (!res.ok) {
				const t = await res.text().catch(() => "");
				this.post({ type: "transcribeError", message: "Groq " + res.status + " " + t.slice(0, 200) });
				return;
			}
			const data = await res.json();
			this.post({ type: "transcribed", text: String((data && data.text) || "").trim() });
		} catch (e) {
			this.post({ type: "transcribeError", message: String((e && e.message) || e) });
		}
	}

	// spawn (or reveal) an integrated terminal in the workspace root — opens in the
	// bottom panel by default; the user can drag it anywhere (editor area / sides)
	openTerminal() {
		const cwd = workspaceCwd();
		let term = this.terminal;
		if (!term || term.exitStatus !== undefined) {
			term = vscode.window.createTerminal({
				name: "Solstice", cwd, iconPath: new vscode.ThemeIcon("flame"),
				location: vscode.TerminalLocation.Panel,
			});
			this.terminal = term;
		}
		term.show(false);
		return term;
	}

	cfg() {
		return vscode.workspace.getConfiguration("solstice.codex");
	}

	// Per-window settings (model, autonomy) are stored at Workspace scope when a
	// folder is open, so each Solstice window can run a different model on its own
	// project in parallel. With no workspace open we fall back to Global.
	cfgTarget() {
		return vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	}

	claudeAllowed() {
		return this.cfg().get("allowClaude") === true;
	}

	autonomyLevel() {
		// Legacy approvalPolicy="never" means "never prompt" → full autonomy.
		if (this.cfg().get("approvalPolicy") === "never") return "autonomous";
		const lvl = this.cfg().get("autonomy") || "supervised";
		return ["supervised", "auto-edit", "autonomous"].includes(lvl) ? lvl : "supervised";
	}

	// Decide whether an approval request can be auto-accepted without prompting,
	// based on the autonomy level and the action category derived from the method.
	shouldAutoApprove(method, elicitation) {
		const level = this.autonomyLevel();
		if (level === "autonomous") return true;
		if (level === "auto-edit") {
			// auto-edit trusts file writes/reads; still asks for shell commands and
			// external/MCP tool calls (the riskier, side-effecting categories).
			const isEdit = /fileChange/.test(method) || method === "applyPatchApproval";
			return isEdit && !elicitation;
		}
		return false; // supervised: ask for everything
	}

	requestCreditApproval(method, params, risk) {
		const guarded = {
			...(params || {}),
			creditGate: {
				label: risk.label,
				reason: "Thomas approval is required before any paid video/3D generation or credit-risk provider call, even in Autonomous.",
				detail: risk.detail,
				provider: risk.provider,
				creation: risk.creation,
				creditEstimate: risk.creditEstimate,
			},
		};
		const approveLabel = "Approve once";
		return new Promise((resolve) => {
			const key = crypto.randomUUID();
			this.pendingApprovals.set(key, { resolve, creditGate: true, threadId: guarded && guarded.threadId });
			const tid = guarded && guarded.threadId;
			const task = this.managerTasks && tid ? this.managerTasks.forThread(tid) : null;
			if (task) { this.managerTasks.setStatus(task.id, "awaiting_approval"); this.pushManagerTasks(); }
			if (!tid || tid === this.threadId) this.post({ type: "approvalRequest", key, method, params: guarded });
			this.postManager({ type: "approvalRequest", key, method, params: guarded });
			if (!this.webview && !this.manager) {
				vscode.window.showWarningMessage(
					`Solstice credit gate: ${risk.label}`,
					{ modal: true, detail: risk.detail || "This action may spend credits or generate video/3D assets." },
					approveLabel,
					"Deny"
				).then((choice) => this.resolveApproval(key, choice === approveLabel ? "accept" : "decline"));
			}
		});
	}

	providerKey() {
		let k = this.cfg().get("provider") || "composer-2.5";
		const legacyClaude = { "claude-opus": "claude-opus-4-8", "claude-sonnet": "claude-sonnet-5" };
		if (legacyClaude[k]) {
			k = legacyClaude[k];
			if (!this._legacyClaudeProviderMigrated) {
				this._legacyClaudeProviderMigrated = true;
				Promise.resolve(this.cfg().update("provider", k, this.cfgTarget())).catch(() => {});
			}
		}
		// Migrate the pre-04096 persisted key without keeping the removed model id
		// in the active registry or selector defaults.
		const legacyGrokBuildKey = ["grok", "build"].join("-");
		if (k === legacyGrokBuildKey) {
			k = "grok-4.5";
			if (!this._legacyGrokProviderMigrated) {
				this._legacyGrokProviderMigrated = true;
				Promise.resolve(this.cfg().update("provider", k, this.cfgTarget())).catch(() => { });
			}
		}
		// Claude is Thomas-test-only: a persisted/stale setting must never activate
		// it on startup. It becomes live only after a manual picker selection in
		// this window, and only while the explicit allowClaude gate is open.
		if (runnerFor(k) === "claude" && (!this.claudeAllowed() || !this._manualClaudeSelected)) return "gpt-5.5";
		return k;
	}

	// The CLI binary (path or bare name) a given runner will try to spawn —
	// mirrors how each provider resolves its `bin`, including codex's bundled
	// fallback and the per-runner override settings.
	runnerBin(runner) {
		if (runner === "codex") return resolveCodexBinary(this.context.extensionPath, this.cfg().get("path"));
		if (runner === "claude") return this.cfg().get("claudePath") || "claude";
		if (runner === "moonshot") return "Moonshot direct API";
		// grok runner (grok-4.5 / composer-2.5): explicit setting → bundled engine → PATH.
		return resolveGrokBinary(this.context.extensionPath, this.cfg().get("grokPath"));
	}

	// Per-model engine health for the header chips: can this runner's binary be
	// found on THIS machine right now? Cheap (no spawns), safe to call often.
	enginesStatus() {
		const { whichFull } = require("./winspawn");
		const seen = new Set();
		const list = [];
		for (const [key, meta] of Object.entries(MODEL_REGISTRY)) {
			if (seen.has(meta.runner)) continue;
			seen.add(meta.runner);
			let bin = "";
			let found = null;
			try {
				if (meta.runner === "moonshot") {
					list.push({ key, runner: meta.runner, label: meta.label, ok: true, detail: "Direct API — connects securely when selected" });
					continue;
				}
				bin = this.runnerBin(meta.runner) || "";
				found = bin ? whichFull(bin) : null;
			} catch { /* status only — never throw */ }
			list.push({
				key, runner: meta.runner, label: meta.label,
				ok: !!found,
				detail: found ? found : (bin ? `לא נמצא: ${bin}` : "לא מוגדר"),
			});
		}
		return list;
	}
	postEngineStatus() {
		try {
			const msg = { type: "engines", list: this.enginesStatus(), current: this.providerKey() };
			this.post(msg);
			this.postManager(msg);
		} catch { /* chips are cosmetic — never break the panel */ }
	}

	// "Why won't Composer/Grok start?" — one command that answers it BEFORE a
	// failed build: for every model, the exact binary that will be spawned, how
	// it was found (or that it wasn't), and the node used to crack npm shims.
	async checkEngines() {
		const { whichFull, resolveWinSpawn } = require("./winspawn");
		const lines = [];
		for (const meta of Object.values(MODEL_REGISTRY)) {
			const runner = meta.runner;
			if (runner === "moonshot") {
				const connected = !!(await providerCredential(this.context, "moonshot"));
				lines.push(`${meta.label} [${runner}]`, "  engine: built-in direct API", `  auth  : ${connected ? "connected" : "connects when selected"}`);
				continue;
			}
			let bin = "";
			try { bin = this.runnerBin(runner) || "<none>"; } catch (e) { bin = `<resolve failed: ${e.message}>`; }
			const found = whichFull(bin);
			let spawnPlan = "";
			try {
				const sp = resolveWinSpawn(bin, ["--version"]);
				spawnPlan = sp.cmd === bin ? "direct" : `via ${sp.cmd}`;
			} catch (e) { spawnPlan = `<plan failed: ${e.message}>`; }
			lines.push(`${meta.label} [${runner}]`, `  bin   : ${bin}`, `  found : ${found || "NOT FOUND"}`, `  spawn : ${spawnPlan}`);
		}
		const node = whichFull("node");
		lines.push(`node    : ${node || "NOT FOUND (npm-shim CLIs like grok need it)"}`);
		const report = lines.join("\n");
		try { this.output.appendLine(`[engines]\n${report}`); } catch { /* output channel optional */ }
		vscode.window.showInformationMessage("Solstice — Model Engines", { modal: true, detail: report });
		return report;
	}

	runnerAvailable(runner) {
		if (runner === "moonshot") return true;
		// grok ships its engine bundled (brotli payload) — count it as available
		// WITHOUT forcing a decompression on every availability probe.
		if (runner === "grok") {
			const p = this.cfg().get("grokPath");
			if (p && fs.existsSync(p)) return true;
			if (grokBundlePresent(this.context.extensionPath)) return true;
			return binOnPath("grok");
		}
		return binOnPath(this.runnerBin(runner));
	}
	modelAvailable(key) {
		const runner = runnerFor(key);
		if (!this.runnerAvailable(runner)) return false;
		if (/^gpt-5\.6(?:-|$)/.test(key)) return checkCodexModelCompatibility(key, this.runnerBin("codex")).ok;
		return true;
	}

	// The provider we can ACTUALLY run on this machine. If the configured
	// provider's CLI isn't installed (the desktop case — codex/grok/claude are
	// not bundled), walk the failover chain to the first provider whose binary
	// exists. Returns null when nothing is installed so send() can show a clear
	// setup card instead of spawning straight into ENOENT.
	effectiveProvider() {
		const want = this.providerKey();
		if (this.modelAvailable(want)) return want;
		for (const k of this.failoverChain()) {
			if (k !== want && this.modelAvailable(k)) return k;
		}
		return null;
	}

	// Before any send, make sure the live provider has a runnable CLI. Switches
	// to an installed one (with a visible notice) or surfaces an install card.
	// Returns true when the agent can proceed, false when it cannot.
	ensureRunnableProvider() {
		const want = this.providerKey();
		if (/^gpt-5\.6(?:-|$)/.test(want)) {
			const compatibility = checkCodexModelCompatibility(want, this.runnerBin("codex"));
			if (!compatibility.ok) {
				this.output.append(`\n[codex] ${compatibility.message}\n`);
				this.onNotification("error", { threadId: this.threadId, error: { message: compatibility.message } });
				vscode.window.showErrorMessage(`Solstice: GPT-5.6 needs Codex CLI >=${compatibility.required}; installed ${compatibility.installed}. Run npm i -g @openai/codex@latest, then set solstice.codex.path to the new binary.`);
				return false;
			}
		}
		const eff = this.effectiveProvider();
		if (eff === null) {
			const runner = runnerFor(want);
			const cli = runner === "codex" ? "codex" : runner === "claude" ? "claude" : "grok";
			const install = cli === "codex"
				? "npm i -g @openai/codex  →  codex login"
				: cli === "grok"
					? "npm i -g @vercel/grok  →  grok  (sign in once)"
					: "install Claude Code  →  claude  (sign in once)";
			this.onNotification("error", {
				threadId: this.threadId,
				error: { message: `No model CLI is installed on this machine, so the Solstice agent has no engine to run. Install one and sign in once, then retry:\n\n    ${install}\n\nThe agent drives a local model CLI — without it nothing can build.` },
			});
			vscode.window.showErrorMessage(`Solstice: the ${cli} CLI isn't installed — the agent can't run. Install it and sign in once.`);
			return false;
		}
		if (eff !== want) {
			this.output.append(`\n[provider] configured "${want}" CLI (${this.runnerBin(runnerFor(want))}) not found on this machine; using "${eff}" instead.\n`);
			vscode.window.setStatusBarMessage(`Solstice: ${want} CLI missing → using ${eff}`, 6000);
			// Persist so the picker reflects reality; cfgTarget keeps it per-scope.
			this.cfg().update("provider", eff, this.cfgTarget());
			this.applyProviderToWebviews();
		}
		return true;
	}

	designElevationOn() {
		return this.cfg().get("designElevation") === true;
	}

	// Premium design playbook — only injected when Design Elevation is ON (optional layer).
	designPlaybook(text = "") {
		if (!this.designElevationOn()) return "";
		const source = String(text || "");
		const needsDesign = this.isBuildIntent(source)
			|| needsResearchContract(source)
			|| needsAnimatedWebsiteKit(source)
			|| needsVerticalTemplatePack(source);
		if (!needsDesign) return "";
		try {
			return fs.readFileSync(path.join(this.context.extensionPath, "prompts", "design-playbook.md"), "utf8");
		} catch { return ""; }
	}

	logPreambleSize(runner, preamble) {
		const bytes = Buffer.byteLength(String(preamble || ""), "utf8");
		const warning = bytes > 24 * 1024 ? " WARNING>24KB" : "";
		this.output.append(`[preamble] runner=${runner} bytes=${bytes}${warning}\n`);
		return preamble;
	}

	async toggleDesignElevation() {
		const on = !this.designElevationOn();
		await this.cfg().update("designElevation", on, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			on
				? "Solstice Design Elevation: ON — premium design playbook will guide the next build."
				: "Solstice Design Elevation: OFF — plain build (no design playbook)."
		);
	}

	providerLabel() {
		const k = this.providerKey();
		const m = MODEL_REGISTRY[k];
		return m ? m.label : k;
	}

	async refreshModelCatalog(force = false) {
		if (this._modelDiscoveryPromise && !force) return this._modelDiscoveryPromise;
		this._modelDiscoveryPromise = Promise.all([
			discoverCodexModels(this.runnerBin("codex")),
			discoverGrokModels(this.runnerBin("grok")),
		]).then(([codexModels, grokModels]) => {
			const discovered = [...codexModels, ...grokModels];
			for (const item of discovered) {
				MODEL_REGISTRY[item.key] = {
					label: item.label, desc: item.description, runner: item.runner,
					provider: item.provider,
					codexId: item.runner === "codex" ? item.modelId : undefined,
					grokId: item.runner === "grok" ? item.modelId : undefined,
				};
				if (item.runner === "grok") GROK_MODELS[item.key] = { id: item.modelId, label: item.label };
			}
			this._discoveredModelChoices = discovered;
			this.postModelChoices();
			return discovered;
		}).catch((error) => {
			this.output.append(`[models] CLI discovery failed: ${error && error.message || error}\n`);
			return [];
		});
		return this._modelDiscoveryPromise;
	}

	modelProviders() {
		return groupModels(this.modelChoices(), this.claudeAllowed());
	}

	// Single source of truth for the model list — shared by the command-palette
	// quick-pick and the inline picker rendered at the bottom of the chat panel.
	// Derived from MODEL_REGISTRY (grok.js): a new model is one entry there.
	// Gated models (claude) only appear when explicitly opted in.
	modelChoices() {
		if (this._discoveredModelChoices) {
			const list = [...this._discoveredModelChoices];
			if (this.claudeAllowed()) {
				for (const key of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]) {
					const m = MODEL_REGISTRY[key];
					list.push({ key, modelId: m.claudeId, label: m.label, description: m.desc, runner: m.runner, provider: "claude", manualOnly: true });
				}
			}
			for (const [key, m] of Object.entries(MODEL_REGISTRY)) {
				if (m.runner !== "moonshot" || list.some((item) => item.key === key)) continue;
				list.push({ key, modelId: m.moonshotId, label: m.label, description: m.desc, runner: m.runner, provider: "moonshot", manualOnly: true });
			}
			return list;
		}
		return Object.entries(MODEL_REGISTRY)
			.filter(([, m]) => !m.gated || this.claudeAllowed())
			.sort((a, b) => (a[1].order || 0) - (b[1].order || 0))
			.map(([key, m]) => ({ key, label: m.label, description: m.desc, provider: m.provider || (m.runner === "claude" ? "claude" : m.runner === "grok" ? "grok" : "gpt"), manualOnly: !!m.manualOnly }));
	}

	async selectModel() {
		const cur = this.providerKey();
		await this.refreshModelCatalog();
		const provider = await vscode.window.showQuickPick(this.modelProviders().map((group) => ({ key: group.key, label: group.label, description: `${group.models.length} available` })), { placeHolder: "1/2 — Choose provider" });
		if (!provider) return;
		const group = this.modelProviders().find((item) => item.key === provider.key);
		const items = (group ? group.models : []).map((it) => (it.key === cur ? { ...it, label: "$(check) " + it.label } : it));
		const pick = await vscode.window.showQuickPick(items, { placeHolder: `2/2 — Choose ${provider.label} tier` });
		if (!pick || pick.key === cur) return;
		if (this.agentBusy()) {
			vscode.window.showWarningMessage("Solstice: finish or stop the current build before switching the model.");
			return;
		}
		await this.setModel(pick.key);
	}

	// Tear down the running agent session so the NEXT prompt spawns the freshly
	// selected model/runner cleanly. The previous GrokProvider was bound to the
	// old model; without this, switching models between prompts didn't take.
	resetAgentSession() {
		try { if (this.grok && typeof this.grok.dispose === "function") this.grok.dispose(); } catch { }
		try { if (this.grok && typeof this.grok.stop === "function") this.grok.stop(); } catch { }
		// Also tear down the codex (GPT-5.5) and claude sessions — NOT just grok.
		// Switching FROM GPT-5.5 left this.client (the codex app-server) running;
		// its half-killed detached child was the "EPERM on switch" trigger. Stop
		// every provider so the next prompt re-spawns the selected one cleanly.
		try { if (this.client && typeof this.client.stop === "function") this.client.stop(); } catch { }
		this.client = null;
		try { if (this.claude && typeof this.claude.stop === "function") this.claude.stop(); } catch { }
		try { if (this.claude && typeof this.claude.dispose === "function") this.claude.dispose(); } catch { }
		try { if (this.moonshot && typeof this.moonshot.dispose === "function") this.moonshot.dispose(); } catch { }
		this.claude = null;
		this.moonshot = null;
		this.grok = null;
		this.threadId = null;
		this._failoverTried = null;
	}

	// True while a build/turn is actively running (don't switch model mid-build).
	agentBusy() {
		const runner = runnerFor(this.providerKey());
		const prov = runner === "claude" ? this.claude : runner === "moonshot" ? this.moonshot : this.grok;
		return !!(prov && prov.busy);
	}

	// Inline picker (bottom of chat panel) → set the model directly, no quick-pick.
	// Switching is allowed BETWEEN prompts (not mid-build): we reset the session
	// so the newly-selected model/runner takes effect on the next send.
	async setModel(key) {
		if (!key || !this.modelChoices().some((it) => it.key === key)) return;
		if (key === this.providerKey()) return;
		if (this.agentBusy()) {
			vscode.window.showWarningMessage("Solstice: finish or stop the current build before switching the model.");
			this.applyProviderToWebviews();
			return;
		}
		// Don't switch to a model whose CLI isn't installed on THIS machine — building
		// on it would spawn-EPERM (the npm shim doesn't exist). Tell the user how to
		// enable it instead of crashing. (Thomas: "spawn EPERM" switching to Grok/Composer.)
		const nextRunner = runnerFor(key);
		if (nextRunner === "moonshot") {
			try {
				const connection = await ensureProviderConnection(vscode, this.context, "moonshot");
				if (!connection.ok) { this.applyProviderToWebviews(); return; }
			} catch (error) {
				vscode.window.showErrorMessage(`Solstice: Moonshot connection failed — ${error && error.message || error}`);
				this.applyProviderToWebviews();
				return;
			}
		}
		if (!this.runnerAvailable(nextRunner)) {
			const label = (this.modelChoices().find((it) => it.key === key) || {}).label || key;
			vscode.window.showWarningMessage(`Solstice: ${label} isn't available on this machine — its CLI isn't installed, so it can't run here (that's the "spawn EPERM"). Install its CLI and sign in once, or stay on the current model.`);
			this.applyProviderToWebviews(); // snap the picker back to the real provider
			return;
		}
		this._manualClaudeSelected = nextRunner === "claude";
		await this.cfg().update("provider", key, this.cfgTarget());
		this.resetAgentSession();
		this.applyProviderToWebviews();
	}

	async selectAutonomy() {
		const cur = this.autonomyLevel();
		const items = [
			{ key: "supervised", label: "Supervised", description: "Ask before every edit, command, and tool call" },
			{ key: "auto-edit", label: "Auto-edit", description: "Apply edits automatically — ask before shell commands & tools" },
			{ key: "autonomous", label: "Autonomous", description: "I trust the agent — approve everything, never interrupt" },
		];
		items.forEach((it, i) => { if (it.key === cur) items[i] = { ...it, label: "$(check) " + it.label }; });
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "Solstice agent autonomy" });
		if (!pick) return;
		// Clear the legacy "never" escape hatch so the autonomy setting is authoritative.
		if (this.cfg().get("approvalPolicy") === "never" && pick.key !== "autonomous") {
			await this.cfg().update("approvalPolicy", "on-request", this.cfgTarget());
		}
		await this.cfg().update("autonomy", pick.key, this.cfgTarget());
		this.applyAutonomyToWebviews();
	}

	applyAutonomyToWebviews() {
		const msg = { type: "autonomy", level: this.autonomyLevel() };
		this.post(msg);
		this.postManager(msg);
	}

	applyProviderToWebviews() {
		const mt = { type: "thread", model: this.providerLabel() };
		this.post(mt);
		this.postManager(mt);
		this.postModelChoices();
		this.refreshModelCatalog().catch(() => { });
		this.postEngineStatus();
		if (runnerFor(this.providerKey()) !== "codex") {
			const runner = runnerFor(this.providerKey());
			const auth = { type: "auth", authMethod: runner === "claude" ? "claude-cli" : runner === "moonshot" ? "moonshot-api" : "grok-cli" };
			this.post(auth);
			this.postManager(auth);
		} else {
			this.refreshAccount().catch(() => { });
			this.refreshAccount("manager").catch(() => { });
		}
	}

	postModelChoices() {
		const models = { type: "models", list: this.modelChoices(), providers: this.modelProviders(), current: this.providerKey() };
		this.post(models);
		this.postManager(models);
	}

	// Ordered auto-failover chain. Claude is intentionally NEVER here — it is
	// manual-only (solstice.codex.allowClaude), per Thomas: the IDE runs on the
	// freshest non-Claude models. Config-driven so newer/stronger models can be
	// slotted in without code changes.
	failoverChain() {
		const def = ["gpt-5.6", "gpt-5.5", "composer-2.5", "grok-4.5"];
		let chain = this.cfg().get("failoverChain");
		if (!Array.isArray(chain) || !chain.length) chain = def;
		// hard guard: claude can never enter the automatic chain
		return chain.map((s) => String(s)).filter((k) => k && !(MODEL_REGISTRY[k] && MODEL_REGISTRY[k].manualOnly));
	}

	// Auto-failover: on a quota/rate-limit error, transparently advance to the
	// next untried model in the chain and re-run the last prompt — no user click.
	// Falls back to the manual suggestion only when the chain is exhausted.
	async autoFailover(reason) {
		const chain = this.failoverChain();
		const cur = this.providerKey();
		if (!this._failoverTried) this._failoverTried = new Set();
		this._failoverTried.add(cur);
		// only fail over to a model whose CLI is actually installed here
		const next = chain.find((k) => !this._failoverTried.has(k) && this.modelAvailable(k));
		if (!next) {
			// Chain exhausted — offer only non-Claude choices. Claude remains
			// exclusively reachable through the explicit two-stage model picker.
			this.suggestFallback();
			return;
		}
		const label = (k) => MODEL_REGISTRY[k] ? MODEL_REGISTRY[k].label : k;
		this.output.append(`\n[failover] ${label(cur)} hit ${reason}; switching to ${label(next)} and retrying.\n`);
		vscode.window.setStatusBarMessage(`Solstice: ${label(cur)} → ${label(next)} (auto-failover)`, 6000);
		await this.cfg().update("provider", next, this.cfgTarget());
		this.applyProviderToWebviews();
		this.sendBuildStatus("building", { text: `failover → ${label(next)}` });
		const prompt = this._lastUserPrompt;
		if (prompt) {
			// new provider = new turn context; clear codex thread so the retry
			// starts cleanly on the new backend.
			this.threadId = null;
			try { await this.send(prompt); }
			catch (e) { this.output.append(`[failover] retry failed: ${e && e.message || e}\n`); }
		}
	}

	suggestFallback() {
		if (this.fallbackPrompted) return;
		this.fallbackPrompted = true;
		const choices = ["GPT-5.6 Sol (Codex)", "GPT-5.5 (Codex)", "Grok 4.5 Build", "Composer 2.5 Fast", "Stay"];
		vscode.window.showWarningMessage(
			"All auto-failover models hit their limit. Switch the Solstice agent manually?",
			...choices
		).then(async (pick) => {
			const key = pick === "GPT-5.6 Sol (Codex)" ? "gpt-5.6" : pick === "GPT-5.5 (Codex)" ? "gpt-5.5" : pick === "Grok 4.5 Build" ? "grok-4.5" : pick === "Composer 2.5 Fast" ? "composer-2.5" : null;
			if (!key) return;
			await this.cfg().update("provider", key, this.cfgTarget());
			this.applyProviderToWebviews();
		});
	}

	startGrokWatcher() {
		if (this.grokWatcher) return;
		this.grokChanged = new Set();
		const track = (uri) => {
			const p = uri.fsPath;
			// grok has no plan tool — it maintains .solstice/PLAN.md per the preamble;
			// bridge it into turn/plan/updated so the panel shows a live checklist
			if (PLAN_FILE_RE.test(p)) { this.emitPlanFile(p, this.grok ? this.grok.threadId : undefined); return; }
			if (/[\\/](node_modules|\.git|\.solstice|\.next|dist)([\\/]|$)/.test(p)) return;
			this.grokChanged.add(p);
		};
		const w = vscode.workspace.createFileSystemWatcher("**/*");
		w.onDidCreate(track);
		w.onDidChange(track);
		this.grokWatcher = w;
	}

	emitPlanFile(file, threadId) {
		let text;
		try { text = fs.readFileSync(file, "utf8"); } catch { return; }
		if (text === this.lastPlanFileText) return;
		this.lastPlanFileText = text;
		const plan = this.parseRichPlan(text);
		if (plan.length) {
			this.onNotification("turn/plan/updated", { threadId: threadId || this.threadId, plan });
		}
	}

	// Parse .solstice/PLAN.md into a rich, hierarchical plan model the panel can
	// render as a visual timeline. Supports:
	//   ## Group heading            -> groups steps into phases
	//   1. [~] Step  ← current      -> top-level step (numbered or bulleted)
	//       - [ ] sub-step          -> nested checklist under the previous step
	//       _italic detail line_    -> short description attached to a step
	// Falls back gracefully to a flat list when none of that structure exists.
	parseRichPlan(text) {
		const STEP_RE = /^(\s*)(?:\d+\.|[-*])\s*\[( |x|X|~)\]\s*(.+)$/;
		const HEAD_RE = /^\s*#{1,4}\s+(.+?)\s*#*$/;
		const status = (c) => (/x/i.test(c) ? "completed" : c === "~" ? "inProgress" : "pending");
		const clean = (s) => s.replace(/\s*←\s*current\s*$/i, "").replace(/`/g, "").trim();
		const plan = [];
		let group = "";
		let last = null;        // last top-level step (to attach sub-steps/detail)
		let baseIndent = null;  // indent width of top-level steps
		for (const raw of String(text || "").split("\n")) {
			const h = raw.match(HEAD_RE);
			if (h && !STEP_RE.test(raw)) { group = clean(h[1]); continue; }
			const m = raw.match(STEP_RE);
			if (m) {
				const indent = m[1].replace(/\t/g, "    ").length;
				if (baseIndent === null) baseIndent = indent;
				const item = { status: status(m[2]), step: clean(m[3]) };
				if (indent > baseIndent && last) {
					(last.substeps || (last.substeps = [])).push(item);
				} else {
					if (group) item.group = group;
					plan.push(item);
					last = item;
				}
				continue;
			}
			// italic/quote line right after a step becomes its detail
			const d = raw.match(/^\s*[_>]\s*(.+?)_?\s*$/);
			if (d && last && !last.detail) last.detail = clean(d[1]);
		}
		return plan;
	}

	// Pull a plan and/or a site-analysis out of the assistant's chat message and
	// route them to the SAME surfaces a plan tool / RESEARCH.md would — so the
	// CENTER window shows them even when Felix only narrates in the chat panel.
	captureChatArtifacts(text, tid) {
		if (!text || typeof text !== "string") return;
		const thId = tid || this.threadId;
		const th = thId ? this.threads.get(thId) : null;
		// 1) PLAN → center timeline + inline card. Only synthesize when no real
		//    plan-tool plan exists (codex/claude set th.plan; grok/composer don't).
		if (th && (!Array.isArray(th.plan) || !th.plan.length)) {
			const plan = this.extractPlanFromText(text);
			if (plan.length) this.onNotification("turn/plan/updated", { threadId: thId, plan });
		}
		// 2) ANALYSIS → center research dashboard, only on turns that actually did
		//    web research and only if the agent hasn't authored its own doc.
		if (this.turnDidResearch) this.maybeWriteResearchFromChat(text);
	}

	// Plan extraction from prose. First try the strict checklist parser; if the
	// model wrote a plain numbered/bulleted list under a "plan/steps/תוכנית" lead,
	// treat those items as pending steps so the timeline still renders.
	extractPlanFromText(text) {
		const rich = this.parseRichPlan(text);
		if (rich.length >= 2) return rich;
		const LEAD = /\b(plan|steps|roadmap|build plan)\b|תוכנית|תכנית|שלבים/i;
		const HEAD = /^\s*#{1,4}\s+(.+?)\s*#*$/;
		const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+\S)\s*$/;
		const steps = [];
		let collecting = false, group = "";
		for (const raw of String(text).split("\n")) {
			const h = raw.match(HEAD);
			if (h) {
				if (LEAD.test(h[1])) { collecting = true; group = ""; }
				else if (collecting) group = h[1].replace(/`/g, "").trim();
				continue;
			}
			if (!collecting) {
				if (LEAD.test(raw) && /:\s*$/.test(raw)) collecting = true; // "Plan:" lead-in line
				continue;
			}
			const m = raw.match(ITEM);
			if (m) {
				const step = m[1].replace(/`/g, "").replace(/^\[[ xX~]\]\s*/, "").trim();
				if (step) { const it = { status: "pending", step }; if (group) it.group = group; steps.push(it); }
				continue;
			}
			if (/^\s*[_>]/.test(raw)) continue;   // detail/quote line — keep going
			if (steps.length && /\S/.test(raw)) break; // prose resumed after the list ends the block
		}
		return steps.length >= 2 ? steps : [];
	}

	// Mirror a chat-delivered site/design analysis into RESEARCH.md so the center
	// research dashboard opens. The agent's own RESEARCH/DECONSTRUCT/ANALYSIS doc
	// always wins — we never overwrite a file the agent authored.
	maybeWriteResearchFromChat(text) {
		const root = workspaceCwd();
		if (!root || !text) return;
		for (const n of ["RESEARCH.md", "DECONSTRUCT.md", "ANALYSIS.md"]) {
			try { if (fs.existsSync(path.join(root, n)) && this.lastResearchFile !== path.join(root, n)) return; } catch { }
		}
		const headings = (text.match(/^\s*#{1,4}\s+/gm) || []).length;
		const hasHex = /#[0-9a-fA-F]{3,8}\b/.test(text);
		const hasKw = /typograph|טיפוגרפיה|colou?r|צבע|layout|פריסה|section|מקטע|ניתוח|פירוק|font|grid|spacing|מרווח|hero|animation|אנימצי/i.test(text);
		if (!(headings >= 2 && (hasHex || hasKw))) return;
		const out = `# Research / Analysis\n\n_Captured live from Felix while researching — the agent can refine this file directly._\n\n${text.trim()}\n`;
		if (out === this.lastResearchText) return;
		this.lastResearchText = out;
		const file = path.join(root, "RESEARCH.md");
		this.lastResearchFile = file;
		try { fs.writeFileSync(file, out); } catch { return; }
		try { this.showResearch(vscode.Uri.file(file)); } catch { }
	}

	flushGrokChanges() {
		const changed = this.grokChanged ? [...this.grokChanged] : [];
		this.grokChanged = new Set();
		if (!changed.length) return;
		const item = {
			id: "gfc" + Date.now().toString(36),
			type: "fileChange",
			changes: changed.map((p) => ({ path: p })),
		};
		this.onNotification("item/completed", { threadId: this.grok ? this.grok.threadId : undefined, item });
	}

	imageCapabilityInstructions() {
		return imageCapabilityInstructions({
			extensionPath: this.context.extensionPath,
			nodePath: process.execPath,
			platform: process.platform,
		});
	}

	grokPreamble(text = "") {
		const browseJs = path.join(this.context.extensionPath, "webtools", "browse.js"); // dir is "webtools" not "tools": the Windows build's 7z -x!tools strips any nested tools/ dir
		const node = process.execPath;
		const shot = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const dom = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" dom <url>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" dom <url>`;
		const playbook = this.designPlaybook(text);
		return [
			"You are the Solstice IDE agent. Work directly on files in this workspace.",
			"Capabilities beyond your normal tools (run these as shell commands):",
			this.devServerToolInstructions(),
			`- Search the web — discover URLs for any topic / design references (Awwwards, Behance, Dribbble): ${shot.replace(" shot <url> <out.png>", ' search "<query>" [count]')}`,
			`- Read any web page as clean readable text/markdown (use this to actually research a page — much better than raw HTML): ${shot.replace(" shot <url> <out.png>", ' read <url>')}`,
			`- Crawl a site — walk same-domain pages and read each (e.g. browse an Awwwards/Behance gallery): ${shot.replace(" shot <url> <out.png>", ' crawl <url> [depth] [maxPages]')}`,
			`- LIVE ANALYSIS THE USER WATCHES — for EVERY interactive site/design research request, automatically open a REAL VISIBLE browser window on their screen, even when they did not say "live" or ask to watch. Tour the site page-by-page with slow cinematic scrolling while readable text streams back to you: ${shot.replace(" shot <url> <out.png>", ' live <url> [maxPages] [secPerPage] [keep]')}. Run it as the FIRST browser action (after URL resolution when needed), and STILL write DECONSTRUCT.md incrementally. Background engine research stays on headless search/read/crawl.`,
			`- LIVE INTERACTION — operate a site while the user WATCHES (click menus, fill forms, walk a checkout): write an actions JSON file [{"goto":"…"},{"click":"text:תפריט"},{"type":["#q","חיפוש"]},{"scroll":900},{"shot":"out.png"},{"keep":true}] then run: ${shot.replace(" shot <url> <out.png>", ' act <actions.json>')}. Every step prints the page state back to you.`,
			`- Screenshot any website: ${shot}`,
			`- Dump a website's raw rendered HTML (prefer 'read' above unless you need exact markup): ${dom}`,
			`- Sample frames from a video on any page (case-study scroll videos, domain-locked Vimeo embeds): ${shot.replace(" shot <url> <out.png>", ' videoframes <url> <outPrefix> [frames] [referrer]')}`,
			`- Search FREE stock video from Pexels/Pixabay whenever the user explicitly asks for video/footage (this does not spend generation credits): ${shot.replace(" shot <url> <out.png>", ' videosearch "<query>" [count]')}. Download the chosen clip and poster into the workspace, preserve attribution/license metadata, and embed a lazy muted playsInline <video>.`,
			`- Extract a Behance/Dribbble showcase as structured evidence (forces lazy-load, downloads best image variants, inventories players): ${shot.replace(" shot <url> <out.png>", ' showcase <url> <outDir> [maxAssets]')}`,
			`- Authorized site replica evidence (client-owned/licensed sources only; rendered evidence, never copied source code): ${shot.replace(" shot <url> <out.png>", ' replica-source <url> <outDir> --authorized')}. The CP-F1 gate runs replica-compare automatically after the rebuild.`,
			"- Research workflow: when the user asks you to imitate/take inspiration from a site or find references, SEARCH for it, READ or CRAWL the top results, and SCROLLSHOT the best ones before designing — don't guess from memory.",
			`- VIEW ANY IMAGE (you cannot see images yourself — this gives you a detailed text read of one): ${shot.replace(" shot <url> <out.png>", ' describe <image.png> ["what to focus on"]')}`,
			"  Use it for every reference screenshot BEFORE designing, and for your own verification screenshots before declaring done. It routes to a vision model for you, so it works even though your chat model is text-only.",
			`- Capture a design TOP-TO-BOTTOM in DESKTOP and MOBILE (Behance/Dribbble show both): desktop full-page → ${shot.replace(" shot <url> <out.png>", ' scrollshot <url> <outPrefix> [stops]')}; mobile full-page → ${shot.replace("shot <url> <out.png>", "shot <url> <out.png> 390x3000")}. Then 'describe' each to study layout/colors/typography in both viewports.`,
				this.imageCapabilityInstructions(),
				"- CREDIT GATE: never start paid/external video or 3D generation (Kling, Seedance, X-Field, Higgsfield, Runway, Pika, Luma, Veo, Sora, or similar) without an explicit Thomas approval card. This applies even in Autonomous.",
				"- MANDATORY — real imagery, never placeholders: every page you build MUST use real images. NEVER ship gray boxes, solid-color rectangles, `placeholder.com` / `via.placeholder` / `dummyimage` / `picsum.photos` / `unsplash.com/random` URLs, empty `<img>`, or `TODO image` comments. For EVERY image the design calls for (hero, gallery, product shots, avatars, backgrounds), GENERATE a real one with the image command above and save it under public/images/ BEFORE you finish — a build that still contains placeholders is NOT done. If generation fails, retry; only as a last resort use a tasteful CSS gradient/photographic texture styled to look intentional, never a raw placeholder service.",
			"- ALWAYS externalize your plan to a FILE — the user watches the plan in the CENTER window, not the chat. The MOMENT you start a multi-step build, WRITE the plan to `.solstice/PLAN.md` (create the .solstice folder) BEFORE doing anything else, and re-write the file after each step so the live timeline updates. Don't only describe the plan in chat. Shape: group steps under `## Phase name` headings; each step `1. [ ] Step title`; optional one-line `_short detail_`; nested `   - [ ] sub-task`. Progress marks: `[x]` done, `[~]` current, `[ ]` pending. Short, outcome-oriented titles. FOLLOW-UP PROMPTS CONTINUE THE SAME PLAN: when the user sends another request after a build, DO NOT overwrite or restart the plan — APPEND a new `## Phase` for the new request to the existing .solstice/PLAN.md and keep all completed phases with their [x] marks, so the center timeline shows the whole project evolving across prompts.",
			"- ALWAYS externalize your design/site analysis to a FILE — the user reads the analysis in the CENTER window as a research dashboard, not the chat. When deconstructing / analyzing / researching a design, website or app, the FIRST thing you do is create `RESEARCH.md` (or `DECONSTRUCT.md`) in the workspace root, and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end, and never only in chat. Include as you go: what you examined, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, detected techniques (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed frames/screenshots with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			`- PREMIUM COMPONENT LIBRARY — your fastest path to an Awwwards-bar page. BEFORE building any common section (navbar, hero, features, gallery, stats, testimonials, pricing, CTA, footer) from scratch, read ${path.join(this.context.extensionPath, "prompts", "components", "library.html")} (sections are delimited by '═══ COMPONENT: <id> ═══' markers; ids+tags in manifest.json next to it). Copy the closest component, then ADAPT it to the client: retheme the --c-* tokens to the brand palette, replace ALL copy with sector-true Hebrew, swap in real/generated imagery, rename fx- prefixes on collision. NEVER ship a component verbatim — it is a high starting bar, not a final design.`,
				this.brandContext(workspaceCwd()),
				this.agentBehavior(),
				this.appModeGuidance(),
				playbook ? "\n" + playbook : "",
			].join("\n");
		}

	claudePreamble(text = "") {
		const browseJs = path.join(this.context.extensionPath, "webtools", "browse.js"); // dir is "webtools" not "tools": the Windows build's 7z -x!tools strips any nested tools/ dir
		const node = process.execPath;
		const shot = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const dom = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" dom <url>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" dom <url>`;
		const playbook = this.designPlaybook(text);
		return [
			"You are the Solstice IDE agent. Work directly on files in this workspace.",
			"Capabilities beyond your normal tools (run these as shell commands):",
			this.devServerToolInstructions(),
			`- Search the web — discover URLs for any topic / design references (Awwwards, Behance, Dribbble): ${shot.replace(" shot <url> <out.png>", ' search "<query>" [count]')}`,
			`- Read any web page as clean readable text/markdown (use this to actually research a page — much better than raw HTML): ${shot.replace(" shot <url> <out.png>", ' read <url>')}`,
			`- Crawl a site — walk same-domain pages and read each (e.g. browse an Awwwards/Behance gallery): ${shot.replace(" shot <url> <out.png>", ' crawl <url> [depth] [maxPages]')}`,
			`- LIVE ANALYSIS THE USER WATCHES — for EVERY interactive site/design research request, automatically open a REAL VISIBLE browser window on their screen, even when they did not say "live" or ask to watch. Tour the site page-by-page with slow cinematic scrolling while readable text streams back to you: ${shot.replace(" shot <url> <out.png>", ' live <url> [maxPages] [secPerPage] [keep]')}. Run it as the FIRST browser action (after URL resolution when needed), and STILL write DECONSTRUCT.md incrementally. Background engine research stays on headless search/read/crawl.`,
			`- LIVE INTERACTION — operate a site while the user WATCHES (click menus, fill forms, walk a checkout): write an actions JSON file [{"goto":"…"},{"click":"text:תפריט"},{"type":["#q","חיפוש"]},{"scroll":900},{"shot":"out.png"},{"keep":true}] then run: ${shot.replace(" shot <url> <out.png>", ' act <actions.json>')}. Every step prints the page state back to you.`,
			`- Screenshot any website: ${shot}`,
			`- Dump a website's raw rendered HTML (prefer 'read' above unless you need exact markup): ${dom}`,
			`- Sample frames from a video on any page (case-study scroll videos, domain-locked Vimeo embeds): ${shot.replace(" shot <url> <out.png>", ' videoframes <url> <outPrefix> [frames] [referrer]')}`,
			`- Search FREE stock video from Pexels/Pixabay whenever the user explicitly asks for video/footage (this does not spend generation credits): ${shot.replace(" shot <url> <out.png>", ' videosearch "<query>" [count]')}. Download the chosen clip and poster into the workspace, preserve attribution/license metadata, and embed a lazy muted playsInline <video>.`,
			`- Extract a Behance/Dribbble showcase as structured evidence (forces lazy-load, downloads best image variants, inventories players): ${shot.replace(" shot <url> <out.png>", ' showcase <url> <outDir> [maxAssets]')}`,
			`- Authorized site replica evidence (client-owned/licensed sources only; rendered evidence, never copied source code): ${shot.replace(" shot <url> <out.png>", ' replica-source <url> <outDir> --authorized')}. The CP-F1 gate runs replica-compare automatically after the rebuild.`,
			"- Research workflow: when the user asks you to imitate/take inspiration from a site or find references, SEARCH for it, READ or CRAWL the top results, and SCROLLSHOT the best ones before designing — don't guess from memory.",
			"- You CAN view images: open any screenshot/reference image with your Read tool and study it in exhaustive detail (layout, sections, colors with hex, typography, imagery style, spacing, mood). Always do this for every reference screenshot before designing, and for your own verification screenshots before declaring done.",
			`- Capture a design TOP-TO-BOTTOM in DESKTOP and MOBILE (Behance/Dribbble show both): desktop full-page → ${shot.replace(" shot <url> <out.png>", ' scrollshot <url> <outPrefix> [stops]')}; mobile full-page → ${shot.replace("shot <url> <out.png>", "shot <url> <out.png> 390x3000")}. Open each with your Read tool to study both viewports.`,
				this.imageCapabilityInstructions(),
				"- CREDIT GATE: never start paid/external video or 3D generation (Kling, Seedance, X-Field, Higgsfield, Runway, Pika, Luma, Veo, Sora, or similar) without an explicit Thomas approval card. This applies even in Autonomous.",
				"- MANDATORY — real imagery, never placeholders: every page you build MUST use real images. NEVER ship gray boxes, solid-color rectangles, `placeholder.com` / `via.placeholder` / `dummyimage` / `picsum.photos` / `unsplash.com/random` URLs, empty `<img>`, or `TODO image` comments. Generate a real image (via the codex image command above) for EVERY slot the design needs and save it under public/images/ before finishing — placeholders mean the build is NOT done.",
			"- For multi-step builds, use your todo/plan tool and keep step statuses updated as you work — the IDE renders it as a live checklist.",
			"- When deconstructing / analyzing / researching a design, website, or app: maintain DECONSTRUCT.md (or RESEARCH.md) in the workspace root and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end. The IDE renders this file live to the user as a research dashboard. Include as you go: what you examined so far, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, techniques you detected (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed the frames/screenshots you examine as images with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- FOLLOW-UP PROMPTS CONTINUE THE SAME PLAN: append a new `## Phase` to the existing .solstice/PLAN.md for each new user request — never restart the plan file; completed phases keep their [x].",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			`- PREMIUM COMPONENT LIBRARY — your fastest path to an Awwwards-bar page. BEFORE building any common section (navbar, hero, features, gallery, stats, testimonials, pricing, CTA, footer) from scratch, read ${path.join(this.context.extensionPath, "prompts", "components", "library.html")} (sections are delimited by '═══ COMPONENT: <id> ═══' markers; ids+tags in manifest.json next to it). Copy the closest component, then ADAPT it to the client: retheme the --c-* tokens to the brand palette, replace ALL copy with sector-true Hebrew, swap in real/generated imagery, rename fx- prefixes on collision. NEVER ship a component verbatim — it is a high starting bar, not a final design.`,
				this.brandContext(workspaceCwd()),
				this.agentBehavior(),
				this.appModeGuidance(),
				playbook ? "\n" + playbook : "",
			].join("\n");
		}

	async sendClaude(text) {
		if (!this.claudeAllowed()) {
			vscode.window.showWarningMessage("Solstice: Claude is disabled. Set solstice.codex.allowClaude to true to enable it.");
			return;
		}
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		const prompt = appendResearchContract(this.withBrandPack(text, cwd));
		this.recordSkillPrompt("claude", text, prompt);
		if (!this.claude) {
			const selected = MODEL_REGISTRY[this.providerKey()] || {};
			const devServerToolEnv = await this.devServerToolEnv();
			this.claude = new ClaudeProvider({
				cwd,
				bin: this.cfg().get("claudePath") || undefined,
				model: selected.claudeId || undefined,
				permissionMode: this.cfg().get("claudePermissionMode") || undefined,
				env: devServerToolEnv,
				allowedTools: this.claudeDevServerAllowedTools(),
				log: (s) => this.output.append(s),
				notify: (m, p) => this.onNotification(m, p),
			});
			this.threadId = this.claude.threadId;
			const th = this.upsertThread({ id: this.threadId });
			th.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		await this.claude.send(prompt, this.claudePreamble(text));
	}

	async sendGrok(text, rawText = text) {
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		const prompt = appendResearchContract(this.withBrandPack(text, cwd));
		this.recordSkillPrompt("grok", rawText, prompt);
		if (!this.grok) {
			const devServerToolEnv = await this.devServerToolEnv();
			this.grok = new GrokProvider({
				cwd,
				bin: resolveGrokBinary(this.context.extensionPath, this.cfg().get("grokPath")),
				extensionPath: this.context.extensionPath,
				env: devServerToolEnv,
				allowedTools: this.grokDevServerAllowedTools(),
				authorizeTool: (input) => this.authorizeGrokTool(input),
				log: (s) => this.output.append(s),
				notify: (m, p) => this.onNotification(m, p),
			});
			this.threadId = this.grok.threadId;
			const th = this.upsertThread({ id: this.threadId });
			th.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		this.startGrokWatcher();
		await this.grok.send(this.providerKey(), prompt, this.grokPreamble(rawText), { userText: rawText });
		this.flushGrokChanges();
	}

	async sendMoonshot(text) {
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		const connection = await ensureProviderConnection(vscode, this.context, "moonshot");
		if (!connection.ok) return;
		const prompt = appendResearchContract(this.withBrandPack(text, cwd));
		this.recordSkillPrompt("moonshot", text, prompt);
		if (!this.moonshot) {
			const selected = MODEL_REGISTRY[this.providerKey()] || {};
			const apiKey = connection.credential || await providerCredential(this.context, "moonshot");
			this.moonshot = new MoonshotProvider({
				cwd,
				apiKey,
				model: selected.moonshotId || "kimi-k3",
				reasoningEffort: this.cfg().get("moonshotReasoningEffort") || "high",
				authorizeTool: (input) => this.authorizeMoonshotTool(input),
				log: (value) => this.output.append(value),
				notify: (method, params) => this.onNotification(method, params),
			});
			this.threadId = this.moonshot.threadId;
			const thread = this.upsertThread({ id: this.threadId });
			thread.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		await this.moonshot.send(prompt, this.claudePreamble(text));
	}

	async authorizeGrokTool(input) {
		if (isSafeGrokTool(input)) return { decision: "allow" };
		const descriptor = grokApprovalDescriptor(input, this.grok && this.grok.threadId || this.threadId);
		const result = await this.handleServerRequest(descriptor.method, descriptor.params);
		const decision = result && (result.decision || result.action);
		return {
			decision: ["accept", "approved", "approved_for_session"].includes(decision) ? "allow" : "deny",
			reason: decision === "decline" || decision === "denied" ? "Denied by Thomas in Felix." : undefined,
		};
	}

	async authorizeMoonshotTool(input) {
		if (isSafeGrokTool(input)) return { decision: "allow" };
		const descriptor = grokApprovalDescriptor(input, this.moonshot && this.moonshot.threadId || this.threadId);
		descriptor.params.source = "moonshot";
		const result = await this.handleServerRequest(descriptor.method, descriptor.params);
		const decision = result && (result.decision || result.action);
		return {
			decision: ["accept", "approved", "approved_for_session"].includes(decision) ? "allow" : "deny",
			reason: decision === "decline" || decision === "denied" ? "Denied by Thomas in Felix." : undefined,
		};
	}

	post(msg) {
		if (this.webview) this.webview.postMessage(msg);
	}

	postManager(msg) {
		if (this.manager) this.manager.postMessage(msg);
	}

	managerTaskList() { return this.managerTasks ? this.managerTasks.list() : []; }
	pushManagerTasks() {
		this.syncCompanionManagerTasks();
		this.postManager({ type: "managerTasks", tasks: this.managerTaskList(), limit: this.managerTasks ? this.managerTasks.limit : 0 });
	}

	async createManagerTask(label = "New build") {
		if (!this.managerTasks) throw new Error("Manager View requires an open Git workspace.");
		const task = await this.managerTasks.create(label);
		this.pushManagerTasks();
		const { id } = await this.startThread(label, task.worktree);
		this.managerTasks.attachThread(task.id, id);
		this.pushManagerTasks();
		this.postManager({ type: "managerTaskCreated", task: this.managerTasks.get(task.id) });
		return this.managerTasks.get(task.id);
	}

	async inspectManagerTask(taskId) {
		if (!this.managerTasks) throw new Error("Manager View is unavailable.");
		await this.managerTasks.inspect(taskId);
		this.pushManagerTasks();
		return this.managerTasks.get(taskId);
	}

	async reviewManagerTask(taskId) {
		if (!this.managerTasks) throw new Error("Manager View is unavailable.");
		const review = await this.managerTasks.review(taskId);
		this.pushManagerTasks();
		this.postManager({ type: "managerMergeReview", taskId, patch: review.patch, patchHash: review.patchHash, patchBytes: review.patchBytes });
		return review;
	}

	async mergeManagerTask(taskId, expectedPatchHash) {
		if (!this.managerTasks) throw new Error("Manager View is unavailable.");
		const result = await this.managerTasks.merge(taskId, expectedPatchHash);
		this.pushManagerTasks();
		this.postManager({ type: "managerMerged", taskId, patchHash: result.patchHash });
		this.stopDevServerForAgent(`manager:${taskId}`);
		vscode.window.showInformationMessage(`Solstice: merged ${result.task.label} after git apply --check (${result.patchBytes} bytes).`);
		return result;
	}

	async openManagerTaskPreview(taskId) {
		if (!this.managerTasks) throw new Error("Manager View is unavailable.");
		const task = this.managerTasks.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		const root = task.worktree;
		let url = await detectDevServerUrl(root).catch(() => null);
		if (!url && hasFramework(root)) {
			let server = this.managerDevServers.get(taskId);
			if (!server) {
				server = new DevServer(root, {
					onLog: (s) => this.output.append(`[manager:${taskId}] ${s}`),
					onStateChange: () => {
						if (!server.hasOwnedProcess() && this.managerDevServers.get(taskId) === server) {
							this.managerDevServers.delete(taskId);
							const current = this.managerTasks && this.managerTasks.get(taskId);
							if (current) this.managerTasks.setStatus(taskId, current.status, { previewUrl: "" });
							this.postManager({ type: "managerPreview", taskId, url: "" });
						}
						this.pushDevServerInventory();
					},
					idleTimeoutMs: this.devServerIdleTimeoutMs(),
				});
				this.managerDevServers.set(taskId, server);
			}
			url = await server.ensure();
			server.touch("preview-open");
		} else if (!url) {
			let server = this.managerPreviews.get(taskId);
			if (!server) { server = new PreviewServer(root, { onSelect: (pick) => this.postManager({ type: "elementSelected", taskId, pick }) }); this.managerPreviews.set(taskId, server); }
			const port = await server.ensure();
			const rel = fs.existsSync(path.join(root, "index.html")) ? "index.html" : "";
			url = `http://127.0.0.1:${port}/${rel}`;
		}
		this.managerTasks.setStatus(taskId, task.status, { previewUrl: url });
		this.pushManagerTasks();
		this.openPreviewPanel(url, "desktop");
		this.postManager({ type: "managerPreview", taskId, url });
		this.pushDevServerInventory();
		return url;
	}

	upsertThread(t) {
		if (!t || !t.id) return null;
		const cur = this.threads.get(t.id) || { id: t.id, status: "idle", activeTurnId: null, plan: null, diff: "" };
		if (t.preview !== undefined) cur.preview = t.preview;
		if (t.updatedAt !== undefined) cur.updatedAt = t.updatedAt;
		if (t.status && t.status.type) cur.status = t.status.type;
		this.threads.set(t.id, cur);
		return cur;
	}

	threadList() {
		return [...this.threads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	pushThreads() {
		this.postManager({ type: "threads", threads: this.threadList() });
	}

	artifactPackages() {
		const root = workspaceCwd();
		if (!root) return [];
		return listArtifacts(root).slice(0, 24).map((item) => {
			const dir = path.resolve(root, item.path || "");
			const inside = dir === path.resolve(root) || dir.startsWith(path.resolve(root) + path.sep);
			if (!inside) return null;
			const uri = (name) => {
				if (!name || !this.manager) return "";
				const file = path.join(dir, name);
				try { return fs.existsSync(file) ? this.manager.asWebviewUri(vscode.Uri.file(file)).toString() : ""; } catch { return ""; }
			};
			return { ...item, thumbnailUri: uri(item.thumbnail), recordingUri: uri(item.recording) };
		}).filter(Boolean);
	}

	pushArtifactPackages() {
		this.postManager({ type: "artifactPackages", artifacts: this.artifactPackages() });
	}

	openArtifactPackage(relativePath, fileName) {
		const root = workspaceCwd();
		if (!root) return;
		const target = path.resolve(root, relativePath || "", fileName || "");
		const base = path.resolve(root);
		if (target !== base && !target.startsWith(base + path.sep)) throw new Error("artifact path escapes workspace");
		if (!fs.existsSync(target)) throw new Error("artifact file does not exist");
		if (fileName) return vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target));
		return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
	}

	async ensureClient() {
		if (this.client && this.client.running) return this.client;
		const binPath = resolveCodexBinary(this.context.extensionPath, this.cfg().get("path"));
		const devServerToolEnv = await this.devServerToolEnv();
		this.client = new CodexClient({
			binPath,
			codexHome: this.cfg().get("home") || undefined,
			env: devServerToolEnv,
			configArgs: codexMcpConfigArgs(process.execPath, path.join(this.context.extensionPath, "devServerTools.js")),
			log: (s) => this.output.append(s),
			onExit: (code) => {
				this.threadId = null;
				this.loaded.clear();
				this.post({ type: "status", connected: false, detail: `codex exited (${code})` });
				this.postManager({ type: "status", connected: false, detail: `codex exited (${code})` });
			},
			onNotification: (method, params) => this.onNotification(method, params),
			onServerRequest: (method, params) => this.handleServerRequest(method, params),
		});
		try {
			this.client.start();
			let clientVersion = "0.0.0";
			try { clientVersion = (this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version) || clientVersion; } catch { }
			await this.client.request("initialize", {
				clientInfo: { name: "solstice", title: "Solstice", version: clientVersion },
				capabilities: null,
			});
			this.client.notify("initialized", {});
		} catch (e) {
			this.client = null;
			throw new Error(`Could not start codex app-server (${binPath}): ${e.message}`);
		}
		return this.client;
	}

	onNotification(method, params) {
		const tid = params && params.threadId;
		// ---- liveness pulses: classify every notification as a progress signal.
		// Streaming deltas + tool/file events = real output (strong); plain state
		// changes = weak. Lets livenessInfo() tell "really working" from "fake busy".
		if (typeof method === "string") {
			if (/delta|textDelta|outputDelta/i.test(method)) this.notePulse("_builder", "stream");
			else if (method === "item/completed" && params && params.item &&
				(params.item.type === "fileChange" || params.item.type === "commandExecution" || params.item.type === "mcpToolCall")) this.notePulse("_builder", "tool");
		}
		// keep the thread registry live
		if (method === "thread/started" && params.thread) {
			this.upsertThread(params.thread);
			this.loaded.add(params.thread.id);
			this.pushThreads();
		} else if (method === "thread/status/changed" && tid) {
			const th = this.upsertThread({ id: tid });
			th.status = (params.status && params.status.type) || "idle";
			this.pushThreads();
		} else if (method === "thread/name/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			if (params.name) th.preview = params.name;
			this.pushThreads();
		} else if (method === "turn/started" && tid) {
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = params.turn && params.turn.id;
			th.status = "active";
			th.updatedAt = Date.now() / 1000;
			this.planFileOpened = false;
			this.turnDidResearch = false;
			if (!String(tid).startsWith("grok-") && !String(tid).startsWith("claude-")) this.activeCodexThreadId = tid;
			const managerTask = this.managerTasks && this.managerTasks.forThread(tid);
			if (managerTask) { this.managerTasks.setStatus(managerTask.id, "running", { phase: "execution" }); this.pushManagerTasks(); }
			if (tid === this.threadId) { this.markBusy("_builder", true); this.notePulse("_builder", "state"); this.postPreview({ type: "building", on: true }); this.fleetFlow("building"); this.injectMercuryClient().catch(() => { }); }
			this.pushThreads();
		} else if (method === "turn/completed" && tid) {
			let browserCheckStarted = false;
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = null;
			th.status = "idle";
			if (this.activeCodexThreadId === tid) this.activeCodexThreadId = null;
			const managerTask = this.managerTasks && this.managerTasks.forThread(tid);
			if (managerTask) {
				this.managerTasks.setStatus(managerTask.id, "ready_review", { phase: "review" });
				this.managerTasks.inspect(managerTask.id).then(() => this.pushManagerTasks()).catch((e) => this.output.append("[manager] inspect failed: " + e.message + "\n"));
			}
			if (tid === this.threadId) {
				this.markBusy("_builder", false);
				this.postPreview({ type: "building", on: false });
				this._failoverTried = null;
				this.refreshPreview();
				browserCheckStarted = this.maybeRunBrowserSelfCheck();
				if (!browserCheckStarted) this.fleetFlow("done");
			}
			if (tid === this.threadId) this.noteFidelityDraftEligibility();
			if (tid === this.threadId) {
				try { captureBuild(workspaceCwd(), { prompt: this._lastUserPrompt, provider: this.providerLabel(), previewUrl: this.previewUrl }); }
				catch (e) { this.output.append("[project-brain] capture failed: " + (e && e.message || e) + "\n"); }
			}
			if (tid === this.threadId && !browserCheckStarted) this.maybeCreateWalkthrough();
			this.pushThreads();
			if (tid === this.threadId && !browserCheckStarted) this.drainSteerQueue();
		} else if (method === "turn/engineFailed" && tid) {
			// A repair model dying is a browser-gate finding, not a successful turn
			// and not a reason to leave the gate spinning forever. Preserve the
			// failure for the next check round; turn/completed will schedule it.
			const state = this._browserSelfCheck;
			if (state && tid === this.threadId) {
				const message = String(params && params.error && params.error.message || "The model engine exited before completing the repair turn.");
				state.pendingEngineFailure = message.slice(0, 1000);
				state.engineFailures = (state.engineFailures || 0) + 1;
				this.output.append(`[browser-check] repair engine failed (${state.engineFailures}): ${message}\n`);
				this.announceAgentMessage(`⚠️ מנוע התיקון נכשל; הכשל נרשם כממצא וה־self-check ימשיך לסבב הבא. ${message}`);
			}
		} else if (method === "turn/diff/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.diff = params.diff || "";
			if (tid === this.threadId) this.lastDiff = th.diff;
		} else if (method === "turn/plan/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.plan = this.normalizePlan(params.plan);
			this.writePlanFile(th);
			this.pushPlanPanel(th);
			const managerTask = this.managerTasks && this.managerTasks.forThread(tid);
			if (managerTask) { this.managerTasks.setStatus(managerTask.id, "running", { phase: "planning", plan: th.plan }); this.pushManagerTasks(); }
		}
		if (method === "usage" && params && params.total) {
			this.recordTokenUsage(params);
		}
		if (method === "item/completed" && params.item && params.item.type === "fileChange") {
			this.onFilesChanged(params.item, tid);
		}
		// flag turns that actually did web/media research
		// so we only surface a research dashboard for genuine analysis/clone work.
		if ((method === "item/started" || method === "item/completed") && params.item && params.item.type === "commandExecution") {
			const cmd = String(params.item.command || params.item.title || "");
			if (/browse\.js["']?\s+(read|crawl|search|videosearch|shot|scrollshot|live|act|videoframes|showcase|describe|dom)\b/i.test(cmd)) this.turnDidResearch = true;
		}
		// Composer/grok narrate the plan and the site analysis as CHAT TEXT instead of
		// writing .solstice/PLAN.md / RESEARCH.md or calling a plan tool — so the center
		// timeline and research dashboard never populate. Mine them from the message.
		if (method === "item/completed" && params.item && params.item.type === "agentMessage" &&
			(!tid || tid === this.threadId)) {
			this.captureChatArtifacts(params.item.text, tid);
		}
		const isImageItem = method === "item/completed" && params.item &&
			(params.item.type === "imageGeneration" || params.item.type === "imageView") &&
			params.item.status !== "failed";
		if (isImageItem) this.openImage(this.imageAbsPath(params.item));
		// #3: live Agent Browser — open the moment browsing starts, refresh on completion (screenshot)
		if ((method === "item/started" || method === "item/completed") && params.item) this.maybePushBrowser(params.item);
		try { this.captureCompanionState(method, params); } catch (e) { /* companion best-effort */ }
		if (method === "error" && params && params.error &&
			/usage limit|rate limit|quota/i.test(params.error.message || "") &&
			this.failoverChain().includes(this.providerKey())) {
			this.autoFailover("usage limit");
		}
		// A spawned CLI died with ENOENT ("Could not start the … CLI") — the
		// binary vanished/was uninstalled mid-session. Fail over to an installed
		// model rather than leaving the build stuck on a missing engine.
		else if (method === "error" && params && params.error &&
			/could not start|enoent|not found|no such file|eperm/i.test(params.error.message || "")) {
			this.autoFailover("missing CLI");
		}
		if (SIDEBAR_FORWARDED.has(method) && (!tid || tid === this.threadId)) {
			const p = isImageItem ? { ...params, item: this.withImageUri(params.item, this.webview) } : params;
			this.post({ type: "notification", method, params: p });
		}
		if (MANAGER_FORWARDED.has(method)) {
			const p = isImageItem ? { ...params, item: this.withImageUri(params.item, this.manager) } : params;
			this.postManager({ type: "notification", method, params: p });
		}
	}

	handleServerRequest(method, params) {
		const elicitation = method === "mcpServer/elicitation/request";
		// any */requestApproval (commandExecution/fileChange/permissions/…) or MCP elicitation
		if (!APPROVAL_METHODS.has(method) && !elicitation && !/\/requestApproval$/.test(method)) {
			throw new Error(`unsupported server request: ${method}`);
		}
		// three response vocabularies: legacy {decision: approved|denied},
		// item/*/requestApproval {decision: accept|decline},
		// MCP elicitation {action: accept|decline}
		const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
		const map = legacy
			? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied" }
			: { accept: "accept", acceptForSession: "acceptForSession", decline: "decline" };
		const toResult = (decision) => elicitation
			? { action: decision === "decline" ? "decline" : "accept" }
			: { decision: map[decision] || map.decline };
		// The two dev-server controls can only reach in-memory DevServer instances
		// owned by this IDE window. Auto-approve their exact generated command even
		// in Supervised mode; arbitrary commands, PIDs, ports and chained shell text
		// do not match and continue through the normal approval flow.
		const devServerToolPath = path.join(this.context.extensionPath, "devServerTools.js");
		if (!elicitation && isSafeDevServerToolApproval(params, process.execPath, devServerToolPath)) {
			this.output.append("[dev-tools] approved IDE-owned dev-server tool without card\n");
			return Promise.resolve(toResult("accept"));
		}
		// A local source edit cannot spend provider credits by itself. Grok's
		// PreToolUse bridge marks those edits so proposal copy such as "X-Field"
		// does not create a false credit card; the later shell/MCP/provider call is
		// intercepted separately and still hits the mandatory credit gate.
		const creditRisk = params && params.localFileEdit ? null : creditRiskSignal(method, params);
		if (creditRisk) {
			return this.requestCreditApproval(method, params, creditRisk).then(toResult);
		}
		// Autonomy gate: depending on the selected autonomy level (and the legacy
		// approvalPolicy "never" escape hatch) some action categories are
		// auto-approved without interrupting the user.
		if (this.shouldAutoApprove(method, elicitation)) {
			return Promise.resolve(toResult("accept"));
		}
		return new Promise((resolve) => {
			const key = crypto.randomUUID();
			this.pendingApprovals.set(key, { resolve, creditGate: false, threadId: params && params.threadId });
			const tid = params && params.threadId;
			const task = this.managerTasks && tid ? this.managerTasks.forThread(tid) : null;
			if (task) { this.managerTasks.setStatus(task.id, "awaiting_approval"); this.pushManagerTasks(); }
			if (!tid || tid === this.threadId) this.post({ type: "approvalRequest", key, method, params });
			this.postManager({ type: "approvalRequest", key, method, params });
			// headless E2E hook (xvfb, no pointer): approve after the card rendered
			if (process.env.SOLSTICE_AGENT_DEV_AUTOAPPROVE) {
				setTimeout(() => this.resolveApproval(key, "accept"), 8000);
			}
		}).then(toResult);
	}

	resolveApproval(key, decision) {
		const pending = this.pendingApprovals.get(key);
		if (pending) {
			this.pendingApprovals.delete(key);
			if (pending.creditGate && decision === "acceptForSession") {
				this.output.append("credit key: session-approve downgraded to one-shot\n");
				decision = "accept";
			}
			pending.resolve(decision);
			const task = this.managerTasks && pending.threadId ? this.managerTasks.forThread(pending.threadId) : null;
			if (task) { this.managerTasks.setStatus(task.id, "running"); this.pushManagerTasks(); }
		}
	}

	async refreshAccount(target) {
		if (runnerFor(this.providerKey()) !== "codex") {
			// grok/claude CLI auth lives in the CLI itself — no codex login flow needed
			const runner = runnerFor(this.providerKey());
			const method = runner === "claude" ? "claude-cli" : runner === "moonshot" ? "moonshot-api" : "grok-cli";
			const msg = { type: "auth", authMethod: method };
			const mt = { type: "thread", model: this.providerLabel() };
			if (target === "manager") { this.postManager(msg); this.postManager(mt); }
			else { this.post(msg); this.post(mt); }
			return { authMethod: method };
		}
		const client = await this.ensureClient();
		const auth = await client.request("getAuthStatus", {});
		const msg = { type: "auth", authMethod: auth.authMethod };
		if (target === "manager") this.postManager(msg); else this.post(msg);
		if (auth.authMethod) {
			client.request("account/rateLimits/read", undefined)
				.then((r) => {
					const n = { type: "notification", method: "account/rateLimits/updated", params: r };
					this.post(n);
					this.postManager(n);
				})
				.catch(() => { });
		}
		return auth;
	}

	async login() {
		const client = await this.ensureClient();
		const res = await client.request("account/login/start", { type: "chatgpt" });
		if (res.authUrl) {
			this.post({ type: "loginPending" });
			this.postManager({ type: "loginPending" });
			vscode.env.openExternal(vscode.Uri.parse(res.authUrl));
			const onDone = (method) => {
				if (method === "account/login/completed" || method === "account/updated") {
					this.refreshAccount().catch(() => { });
					this.refreshAccount("manager").catch(() => { });
				}
			};
			// account/login/completed isn't in the forwarded set; hook the raw stream once
			const prev = client.opts.onNotification;
			client.opts.onNotification = (method, params) => {
				onDone(method);
				prev(method, params);
			};
		}
	}

	developerInstructions(text = "", cwd = workspaceCwd()) {
		const browseJs = path.join(this.context.extensionPath, "webtools", "browse.js"); // dir is "webtools" not "tools": the Windows build's 7z -x!tools strips any nested tools/ dir
		const node = process.execPath;
		const run = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const playbook = this.designPlaybook(text);
		return [
			"You are the Solstice IDE agent. Capabilities beyond your normal tools:",
			this.devServerToolInstructions(),
			`- Web browsing & research: ${run}`,
			"  Replace mode 'shot' with: 'search \"<query>\" [count]' to discover URLs; 'videosearch \"<query>\" [count]' for FREE Pexels/Pixabay stock clips whenever video is explicitly requested; 'read <url>' for readable text; 'crawl <url> [depth] [maxPages]' for same-site research; 'live <url> [maxPages] [secPerPage] [keep]' for a VISIBLE tour; 'showcase <url> <outDir> [maxAssets]' to force lazy-load and extract Behance/Dribbble images plus video/player URLs; 'replica-source <url> <outDir> --authorized' for rendered desktop/tablet/mobile evidence of a client-owned or licensed site (never copied source code); 'dom <url>' for raw HTML; 'videoframes <url> <outPrefix> [frames] [referrer]' to sample video. Download the chosen stock clip/poster locally, retain attribution/license metadata, and use a lazy muted playsInline <video>. For every interactive site/design research request, run `live` first; keep background engine research headless.",
			"  Research workflow: when asked to imitate/take inspiration from a site or find references, SEARCH, then READ or CRAWL the top results, and screenshot the best before designing — don't guess from memory.",
			"  After taking a screenshot, ALWAYS open it with your view_image tool to study layout, colors, typography and content. Use this whenever the user asks to inspect, analyze or imitate a website or design (e.g. Behance/Dribbble references).",
				"  Capture designs TOP-TO-BOTTOM in DESKTOP and MOBILE: desktop full-page via 'scrollshot <url> <outPrefix> [stops]', mobile full-page via 'shot <url> <out.png> 390x3000'; open each with view_image to study both viewports.",
				this.imageCapabilityInstructions(),
				"- CREDIT GATE: never start paid/external video or 3D generation (Kling, Seedance, X-Field, Higgsfield, Runway, Pika, Luma, Veo, Sora, or similar) without an explicit Thomas approval card. This applies even in Autonomous.",
				"- MANDATORY — real imagery, never placeholders: every page MUST use real images. NEVER leave gray boxes, solid-color rectangles, `placeholder.com` / `via.placeholder` / `dummyimage` / `picsum.photos` / `unsplash.com/random` URLs, empty `<img>`, or `TODO image` comments. Generate a real image for EVERY slot the design needs (hero, gallery, product, avatar, background) and save it into the workspace before finishing — placeholders mean the build is NOT done.",
			"- For any multi-step build task, first create a plan with your plan tool and keep step statuses updated as you work.",
			"- When deconstructing / analyzing / researching a design, website, or app: maintain DECONSTRUCT.md (or RESEARCH.md) in the workspace root and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end. The IDE renders this file live to the user as a research dashboard. Include as you go: what you examined so far, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, techniques you detected (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed the frames/screenshots you examine as images with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			`- PREMIUM COMPONENT LIBRARY — your fastest path to an Awwwards-bar page. BEFORE building any common section (navbar, hero, features, gallery, stats, testimonials, pricing, CTA, footer) from scratch, read ${path.join(this.context.extensionPath, "prompts", "components", "library.html")} (sections are delimited by '═══ COMPONENT: <id> ═══' markers; ids+tags in manifest.json next to it). Copy the closest component, then ADAPT it to the client: retheme the --c-* tokens to the brand palette, replace ALL copy with sector-true Hebrew, swap in real/generated imagery, rename fx- prefixes on collision. NEVER ship a component verbatim — it is a high starting bar, not a final design.`,
				this.brandContext(cwd),
			"- FOLLOW-UP PROMPTS CONTINUE THE SAME PLAN: when the user sends another request after a build, keep ONE evolving plan for the project — append a new phase for the new request; never restart from scratch; completed steps stay marked done.",
				this.agentBehavior(),
				this.appModeGuidance(),
				playbook ? "\n" + playbook : "",
			].join("\n");
		}

	async startThread(text = "", cwd = workspaceCwd()) {
		const developerInstructions = this.developerInstructions(text, cwd);
		this._lastDeveloperInstructions = { bytes: Buffer.byteLength(developerInstructions), sha256: digestText(developerInstructions) };
		this.logPreambleSize("codex", developerInstructions);
		const client = await this.ensureClient();
		const th = await client.request("thread/start", {
			cwd,
			model: (MODEL_REGISTRY[this.providerKey()] && MODEL_REGISTRY[this.providerKey()].codexId) || this.cfg().get("model") || undefined,
			approvalPolicy: this.cfg().get("approvalPolicy"),
			sandbox: this.cfg().get("sandbox"),
			developerInstructions,
		});
		const id = th.thread && th.thread.id;
		if (id) {
			this.loaded.add(id);
			this.upsertThread(th.thread);
			this.pushThreads();
		}
		return { id, model: th.model };
	}

	async ensureRunnable(threadId) {
		const client = await this.ensureClient();
		if (!this.loaded.has(threadId)) {
			await client.request("thread/resume", {
				threadId,
				approvalPolicy: this.cfg().get("approvalPolicy"),
				sandbox: this.cfg().get("sandbox"),
			});
			this.loaded.add(threadId);
		}
	}

	async startTurn(threadId, text) {
		const root = this.brandPackRootForThread(threadId);
		const prompt = appendResearchContract(this.withBrandPack(text, root));
		this.recordSkillPrompt("codex", text, prompt);
		const client = await this.ensureClient();
		await this.ensureRunnable(threadId);
		const th = this.upsertThread({ id: threadId });
		if (!th.preview) {
			th.preview = text;
			this.pushThreads();
		}
		await client.request("turn/start", {
			threadId,
			input: [{ type: "text", text: prompt, text_elements: [] }],
		});
	}

	// sidebar send: lazily creates the sidebar thread
	async send(text) {
		let rawText = text;
		const browserFixTurn = /^\s*\[FELIX_BROWSER_SELF_CHECK\]/.test(String(text || ""));
		const replicaUrl = !browserFixTurn && siteReplicaSourceUrl(rawText);
		if (replicaUrl && !hasSiteReplicaAuthorization(rawText)) {
			const confirmed = await vscode.window.showWarningMessage(
				"Solstice can rebuild this URL only for internal work on a site the client owns or is licensed to reproduce. Confirm authorization before any capture.",
				{ modal: true },
				"Confirm authorized source"
			);
			if (confirmed !== "Confirm authorized source") return;
			rawText = `${rawText}\n\n[REPLICA_AUTHORIZATION_CONFIRMED] Thomas confirmed this is client-owned or licensed material for an internal rebuild.`;
			text = rawText;
		}
		const browserBuildIntent = !browserFixTurn && this.isBrowserBuildIntent(rawText);
		// Runtime-only continuation actions are resolved before any model context is
		// assembled. With a workspace-owned dev-server registration, "open the site"
		// therefore opens the exact live URL without a discovery or inventory turn.
		if (!browserFixTurn && await this.handleRuntimeIntent(rawText)) {
			if (rawText) this._lastUserPrompt = rawText;
			return;
		}
		if (this._planApprovalBypass) this._planApprovalBypass = false;
		else if (!browserFixTurn && (this.isBuildIntent(text) || browserBuildIntent)) {
			if (browserBuildIntent) {
				this.armBrowserSelfCheck(rawText);
				this._walkthroughPending = true;
			}
			this.beginFlowingPlan(text);
			text = this.flowingBuildPrompt(text);
		}
		if (text && !String(text).includes("[FELIX_WORKSPACE_STATE]")) {
			const state = workspaceContext(workspaceCwd());
			if (state) text = state + text;
		}
		if (text && !String(text).includes("[FELIX_PROJECT_BRAIN]")) {
			const memory = projectContext(workspaceCwd());
			if (memory) text = memory + text;
		}
		if (text && !String(text).includes("[FELIX_SKILLS]")) {
			const hint = await this.skillsHint(text);
			if (this._skillsDispatchBlocked) return;
			if (hint) text = hint + text;
		}
		// remember the last prompt so auto-failover can transparently re-run it
		// on the next model in the chain after a quota/rate-limit error.
		if (rawText && !browserFixTurn) this._lastUserPrompt = rawText;
		// Make sure the live provider actually has an installed CLI on THIS
		// machine before we try to spawn it — otherwise switch to one that does,
		// or show an install card. Prevents the silent ENOENT desktop failure.
		if (!this.ensureRunnableProvider()) return;
		const provider = this.providerKey();
		const runner = runnerFor(provider);
		// A spawned-CLI turn (grok/claude) is already running: never let send()
		// reject ("a turn is already running") and silently drop the prompt —
		// route it to the steer queue so it drains into the next turn.
		if (runner !== "codex") {
			const prov = runner === "claude" ? this.claude : runner === "moonshot" ? this.moonshot : this.grok;
			if (prov && prov.busy) return this.steer(this.threadId, text);
		}
		if (runner === "claude") return this.sendClaude(text);
		if (runner === "moonshot") return this.sendMoonshot(text);
		if (runner === "grok") return this.sendGrok(text, rawText);
		if (!this.threadId) {
			const { id, model } = await this.startThread(text);
			this.threadId = id;
			this.lastDiff = "";
			this.post({ type: "thread", threadId: this.threadId, model });
		}
		await this.startTurn(this.threadId, text);
	}

	async steer(threadId, text) {
		text = appendResearchContract(this.withBrandPack(text, this.brandPackRootForThread(threadId)));
		const provider = this.providerKey();
		// grok / claude run as spawned CLIs with no native mid-turn injection.
		// While they're busy, queue the steer and drain it into a follow-up turn
		// the moment the current turn completes (re-prioritised next).
		if (runnerFor(provider) !== "codex") {
			const runner = runnerFor(provider);
			const prov = runner === "claude" ? this.claude : runner === "moonshot" ? this.moonshot : this.grok;
			if (prov && prov.busy) {
				this.steerQueue.push(text);
				const r = this.liveRec("_builder"); r.queued = this.steerQueue.length;
				this.post({ type: "steerQueued", count: this.steerQueue.length });
				return;
			}
			// not actually busy — treat as a normal message
			await this.send(text);
			return;
		}
		// codex: inject straight into the running turn
		const client = await this.ensureClient();
		const th = this.threads.get(threadId);
		if (!th || !th.activeTurnId) {
			// no active turn — fall back to a normal turn
			await this.startTurn(threadId, text);
			return;
		}
		await client.request("turn/steer", {
			threadId,
			expectedTurnId: th.activeTurnId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	// grok/claude: after a turn finishes, fold any queued steers into one
	// follow-up turn so the agent picks them up as the next priority.
	drainSteerQueue() {
		if (!this.steerQueue.length) return;
		const text = this.steerQueue.join("\n\n");
		this.steerQueue = [];
		const r = this.live.get("_builder"); if (r) r.queued = 0;
		this.post({ type: "steerQueued", count: 0 });
		this.send(text).catch((e) => this.output.append(`\n[steer drain] ${e && e.message || e}\n`));
	}

	async interrupt(threadId) {
		let stopped = false;
		if (this._browserSelfCheck && (!threadId || threadId === this.threadId)) {
			this._browserSelfCheck = null;
			this._browserSelfCheckRunning = false;
			stopped = true;
		}
		if (!threadId && this.pendingPlanApproval) {
			this.pendingPlanApproval = null;
			this._planApprovalBypass = false;
			this._walkthroughPending = false;
			stopped = true;
			this.announceAgentMessage("🛑 התוכנית בוטלה לפני ביצוע.");
		}
		for (const [key, pending] of this.pendingApprovals) {
			if (threadId && pending.threadId && pending.threadId !== threadId) continue;
			this.pendingApprovals.delete(key);
			try { pending.resolve("decline"); } catch { }
			stopped = true;
		}
		this.steerQueue = [];
		if (this.claude && (!threadId || threadId === this.claude.threadId)) stopped = this.claude.interrupt() || stopped;
		if (this.moonshot && (!threadId || threadId === this.moonshot.threadId)) stopped = this.moonshot.interrupt() || stopped;
		if (this.grok && (!threadId || threadId === this.grok.threadId)) stopped = this.grok.interrupt() || stopped;
		if (!threadId) for (const child of this.activeCliChildren) { killTree(child); stopped = true; }
		const active = [...this.threads.values()].filter((th) => th && th.activeTurnId).map((th) => th.id);
		const requested = threadId ? [threadId] : [this.activeCodexThreadId, ...active, this.threadId];
		const tids = [...new Set(requested.filter((tid) =>
			tid && !String(tid).startsWith("grok-") && !String(tid).startsWith("claude-") && !String(tid).startsWith("moonshot-")))];
		if (this.client && this.client.running && tids.length) {
			stopped = true;
			const interruptOne = (tid) => new Promise((resolve) => {
				let done = false;
				const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
				const timer = setTimeout(() => { this.output.append(`[stop] codex ${tid}: interrupt acknowledgement timeout\n`); finish(); }, 1500);
				this.client.request("turn/interrupt", { threadId: tid }).then(finish).catch((e) => {
					this.output.append(`[stop] codex ${tid}: ${e && e.message || e}\n`); finish();
				});
			});
			await Promise.all(tids.map(interruptOne));
		}
		if (!threadId || threadId === this.activeCodexThreadId) this.activeCodexThreadId = null;
		if (!threadId || threadId === this.threadId) {
			this.markBusy("_builder", false);
			this.postPreview({ type: "building", on: false });
			const companion = this._companion(); companion.building = false; companion.ts = Date.now();
		}
		const managerTask = this.managerTasks && threadId ? this.managerTasks.forThread(threadId) : null;
		if (managerTask) { this.managerTasks.setStatus(managerTask.id, "idle", { phase: "stopped" }); this.pushManagerTasks(); }
		this.post({ type: "interrupted", stopped });
		this.postManager({ type: "interrupted", stopped });
		this.output.append(`[stop] completed stopped=${stopped} codexThreads=${tids.length} cliChildren=${this.activeCliChildren.size}\n`);
		return stopped;
	}

	async listThreads() {
		const client = await this.ensureClient();
		const res = await client.request("thread/list", { cwd: workspaceCwd() }).catch(() => null);
		if (res && Array.isArray(res.data)) {
			for (const t of res.data) this.upsertThread(t);
		}
		this.pushThreads();
	}

	async readThread(threadId) {
		const client = await this.ensureClient();
		const res = await client.request("thread/read", { threadId, includeTurns: true });
		const th = this.threads.get(threadId);
		this.postManager({
			type: "threadHistory",
			thread: res.thread,
			plan: th ? th.plan : null,
			diff: th ? th.diff : "",
			activeTurnId: th ? th.activeTurnId : null,
		});
	}

	async archiveThread(threadId) {
		const client = await this.ensureClient();
		await client.request("thread/archive", { threadId }).catch(() => { });
		this.threads.delete(threadId);
		this.loaded.delete(threadId);
		const managerTask = this.managerTasks && this.managerTasks.forThread(threadId);
		if (managerTask) this.stopDevServerForAgent(`manager:${managerTask.id}`);
		if (this.threadId === threadId) {
			this.threadId = null;
			this.stopDevServerForAgent("workspace");
		}
		this.pushThreads();
	}

	newThread() {
		if (this.threadId) this.stopDevServerForAgent("workspace");
		this.threadId = null;
		this.lastDiff = "";
		// drop the claude session so the next send starts a fresh conversation
		if (this.claude && !this.claude.busy) this.claude = null;
		if (this.moonshot && !this.moonshot.busy) this.moonshot = null;
		this.post({ type: "reset" });
	}

	async showDiff(threadId) {
		const th = threadId ? this.threads.get(threadId) : null;
		const diff = (th && th.diff) || this.lastDiff;
		if (!diff) {
			vscode.window.showInformationMessage("Solstice: no diff for the current turn yet.");
			return;
		}
		const doc = await vscode.workspace.openTextDocument({ content: diff, language: "diff" });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	async signOut() {
		const client = await this.ensureClient();
		await client.request("account/logout", undefined).catch(() => { });
		this.post({ type: "auth", authMethod: null });
		this.postManager({ type: "auth", authMethod: null });
	}

	// ---- live research dashboard (main editor area) ----
	// The agent maintains DECONSTRUCT.md / RESEARCH.md incrementally while it
	// deconstructs a reference; we render it live as a styled dashboard.
	showResearch(uri) {
		const p = uri.fsPath;
		if (/[\\/](node_modules|\.git|\.next|dist)([\\/]|$)/.test(p)) return;
		this.researchFile = p;
		clearTimeout(this.researchDebounce);
		this.researchDebounce = setTimeout(() => this.pushResearch(), 250);
	}

	pushResearch() {
		if (!this.researchFile) return;
		let text;
		try { text = fs.readFileSync(this.researchFile, "utf8"); } catch { return; }
		try { this.openResearchPanel(); } catch (e) { this.output.append("research panel: " + e.message + "\n"); return; }
		this.researchPanel.webview.postMessage({
			type: "doc",
			name: path.basename(this.researchFile),
			text,
			time: Date.now(),
			base: this.researchPanel.webview.asWebviewUri(vscode.Uri.file(path.dirname(this.researchFile))).toString(),
		});
		// keep the dashboard foreground while research findings stream in
		this.researchPanel.reveal(vscode.ViewColumn.One, true);
	}

	openResearchPanel() {
		if (!this.researchPanel) {
			this.researchPanel = vscode.window.createWebviewPanel(
				"solstice.research",
				"🔬 Agent Research",
				{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [
						vscode.Uri.joinPath(this.context.extensionUri, "media"),
						...(workspaceCwd() ? [vscode.Uri.file(workspaceCwd())] : []),
					],
				}
			);
			this.researchPanel.webview.html = mediaHtml(this.researchPanel.webview, this.context.extensionUri, "research.js", "research.css");
			this.researchPanel.webview.onDidReceiveMessage((m) => { if (m.type === "ready") this.pushResearch(); });
			this.researchPanel.onDidDispose(() => { this.researchPanel = null; });
		}
	}

	// ---- live Agent Browser (#3): watch Felix browse the web, like Antigravity.
	// The web tools (browse.js shot/read/crawl/search) run headless; this surfaces
	// every page the agent visits — its URL + the screenshot it captured — LIVE in
	// a browser-style panel, so the user watches the research/analysis happen.
	maybePushBrowser(item) {
		if (!item) return;
		let action = null, url = null, out = null;
		// (a) model-native web tools (Claude WebSearch/WebFetch, composer/grok native) → webSearch item
		if (item.type === "webSearch") {
			if (item.query) { action = "search"; url = "חיפוש: " + item.query; }
			else if (item.action && (item.action.url || item.action.query)) {
				action = item.action.type === "openPage" ? "read" : "search";
				url = item.action.url || ("חיפוש: " + item.action.query);
			} else if (item.url) { action = "read"; url = item.url; }
			else return;
		}
		// (b) codex/grok run the bundled web tools as a shell command → commandExecution
		else if (item.type === "commandExecution") {
			const cmd = String(item.command || (item.changes && item.changes[0] && item.changes[0].command) || "");
			if (!/browse\.js/.test(cmd)) return;
			const m = cmd.match(/browse\.js["']?\s+(shot|read|crawl|search|videosearch|dom|scrollshot|live|act|videoframes|showcase|describe)\s+((?:"[^"]+"|'[^']+'|[^\s]+))(?:\s+((?:"[^"]+"|'[^']+'|[^\s]+)))?/i);
			if (!m) return;
			action = m[1].toLowerCase();
			const arg1 = String(m[2] || "").replace(/^["']|["']$/g, "");
			const arg2 = String(m[3] || "").replace(/^["']|["']$/g, "");
			out = action === "shot" ? arg2 : (action === "describe" ? arg1 : null);
			url = (action === "search" || action === "videosearch") ? ("חיפוש: " + arg1) : arg1;
		} else return;
		this.openBrowserPanel();
		if (!this.browserPanel) return;
		let shot = null;
		if (out) {
			const abs = path.isAbsolute(out) ? out : path.join(workspaceCwd() || "", out);
			try { if (fs.statSync(abs).isFile()) shot = this.browserPanel.webview.asWebviewUri(vscode.Uri.file(abs)).toString(); } catch { }
		}
		this.browserPanel.webview.postMessage({ type: "page", action, url, shot, time: Date.now() });
		this.browserPanel.reveal(vscode.ViewColumn.One, true);
	}
	openBrowserPanel() {
		if (this.browserPanel) return;
		this.browserPanel = vscode.window.createWebviewPanel(
			"solstice.browser", "🌐 Agent Browser",
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true, retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.context.extensionUri, "media"),
					...(workspaceCwd() ? [vscode.Uri.file(workspaceCwd())] : []),
				],
			}
		);
		this.browserPanel.webview.html = mediaHtml(this.browserPanel.webview, this.context.extensionUri, "browser.js", "browser.css");
		this.browserPanel.onDidDispose(() => { this.browserPanel = null; });
	}

	// ---- center-editor plan view (high-quality visual decomposition) -------
	// When the agent decomposes a build into steps, render them as a graphical
	// timeline in the main editor column — the same rich shape as the side
	// panel, scaled up. Mirrors openResearchPanel.
	openPlanPanel() {
		if (!this.planPanel) {
			this.planPanel = vscode.window.createWebviewPanel(
				"solstice.plan",
				"🗺 Agent Plan",
				{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
				}
			);
			this.planPanel.webview.html = mediaHtml(this.planPanel.webview, this.context.extensionUri, "plan.js", "plan.css");
			this.planPanel.webview.onDidReceiveMessage(async (m) => {
				if (m.type === "ready") { this.pushPlanPanel(); this.pushPlanApproval(); }
				else if (m.type === "replanPlan" && this.pendingPlanApproval) {
					this.replanPendingBuild(m.prompt, m.answers);
					this.announceAgentMessage("🗺 התוכנית עודכנה לפי העריכות והתשובות. אפשר לעבור עליה ולאשר ביצוע.");
				} else if (m.type === "researchPlan" && this.pendingPlanApproval) {
					await this.researchPendingPlan(m.prompt, m.answers);
				}
				else if (m.type === "approvePlan" && this.pendingPlanApproval) {
					this.replanPendingBuild(m.prompt, m.answers, { final: true });
					const prompt = this.approvedBuildPrompt(this.pendingPlanApproval);
					this.pendingPlanApproval = null;
					this._planApprovalBypass = true;
					this._walkthroughPending = true;
					this.announceAgentMessage("🗺 התוכנית אושרה. מתחיל לבצע לפי הנוסח המאושר.");
					await this.send(prompt).catch((e) => vscode.window.showErrorMessage("Solstice: " + (e && e.message || e)));
				} else if (m.type === "cancelPlan") {
					await this.interrupt();
				} else if (m.type === "artifactAnnotation") {
					await this.queueArtifactAnnotation(m.artifact, m.note).catch((e) => vscode.window.showErrorMessage("Solstice annotation: " + (e && e.message || e)));
				}
			});
			this.planPanel.onDidDispose(() => { this.planPanel = null; });
		}
	}

	pushPlanPanel(th) {
		th = th || this.planThread;
		if (!th || !Array.isArray(th.plan) || !th.plan.length) return;
		this.planThread = th;
		try { this.openPlanPanel(); } catch (e) { this.output.append("plan panel: " + e.message + "\n"); return; }
		const title = (th.preview || "").split("\n")[0].slice(0, 100);
		this.planPanel.webview.postMessage({ type: "plan", plan: th.plan, title, time: Date.now() });
		this.planPanel.reveal(vscode.ViewColumn.One, true);
	}

	planProjectType(prompt) {
		const t = String(prompt || "");
		if (/animated|motion|scroll.?tell|video.?scrub|three\.js|r3f|מונפש|אנימצי|תלת.?ממד/i.test(t)) return "animated-site";
		if (/e-?commerce|shop|store|cart|checkout|product|מסחר|חנות|מוצר/i.test(t)) return "commerce";
		if (/dashboard|crm|admin|portal|saas|backend|api|דשבורד|מערכת|בקאנד/i.test(t)) return "business-app";
		return "marketing-site";
	}

	planClarifyingQuestions(type) {
		const common = [
			{ id: "outcome", label: "מה התוצאה העסקית החשובה ביותר?", placeholder: "למשל: יותר לידים איכותיים / רכישה / חיסכון תפעולי", required: true },
			{ id: "audience", label: "מי הקהל והפעולה המרכזית שלו?", placeholder: "קהל, מכשיר עיקרי ו-CTA", required: true },
		];
		const byType = {
			"animated-site": { id: "motion", label: "מה תפקיד התנועה בסיפור?", placeholder: "פרקים, רגעי שיא, reference או מגבלת ביצועים", required: true },
			commerce: { id: "catalog", label: "מהו מבנה הקטלוג וההמרה?", placeholder: "מוצרים/וריאציות, סליקה, משלוח ויעד conversion", required: true },
			"business-app": { id: "roles", label: "מי המשתמשים ומה מקור האמת?", placeholder: "roles, workflows, DB ואינטגרציות", required: true },
			"marketing-site": { id: "brand", label: "מה הכיוון המותגי והרפרנסים?", placeholder: "אופי, מתחרים, קישורים ודברים שאסור לחקות", required: false },
		};
		return common.concat(byType[type]);
	}

	planTemplate(prompt, answers, opts) {
		const type = this.planProjectType(prompt);
		const researched = !!(opts && opts.researched);
		const answerText = Object.values(answers || {}).filter(Boolean).join(" · ");
		const buildStep = type === "business-app" ? "סכימה, API וממשק לפי סדר תלות" :
			type === "commerce" ? "קטלוג, מסלול המרה ותשלום" :
			type === "animated-site" ? "פרקי עולם, נכסים ותנועה מדורגת" : "היררכיית עמודים וקומפוננטות";
		return [
			{ group: "הבהרה", step: "מטרות, קהל וגבולות", status: "completed", detail: answerText || "ממתין לתשובות תומס לפני ביצוע." },
			{ group: "מחקר", step: "רפרנסים, מתחרים ואילוצים", status: researched ? "completed" : "pending", detail: researched ? "המחקר המקדים הוזן לתוכנית." : "search / read / scrollshot זמינים מכאן לפני אישור." },
			{ group: "כיוון עיצובי", step: "שפה חזותית וחוזה חוויה", status: "pending", detail: "טיפוגרפיה, צבע, קומפוזיציה, motion והתנהגות responsive." },
			{ group: "ביצוע", step: buildStep, status: "pending", detail: "passes קטנים עם תוצר נראה בכל שלב." },
			{ group: "סיכונים", step: "תלויות, ביצועים ו-fallbacks", status: "pending", detail: "חסמים חיצוניים, מובייל, נגישות, reduced-motion ונתיב התאוששות." },
			{ group: "אימות", step: "פונקציונליות, fidelity ומכשירים", status: "pending", detail: "בדיקות, preview, mobile/desktop והשוואה מול החוזה." },
			{ group: "מסירה", step: "לינק חי וחבילת walkthrough", status: "pending", detail: "ראיות, החלטות, פתוחים ושלמות artifacts." },
		];
	}

	pushPlanApproval() {
		if (!this.planPanel || !this.pendingPlanApproval) return;
		const p = this.pendingPlanApproval;
		this.planPanel.webview.postMessage({
			type: "approval", prompt: p.prompt, answers: p.answers || {}, questions: p.questions,
			projectType: p.projectType, revision: p.revision || 0, researched: !!p.researched,
		});
	}

	replanPendingBuild(prompt, answers, opts) {
		if (!this.pendingPlanApproval) return;
		const p = this.pendingPlanApproval;
		p.prompt = String(prompt || p.prompt || "").trim();
		p.answers = answers && typeof answers === "object" ? answers : (p.answers || {});
		p.projectType = this.planProjectType(p.prompt);
		p.questions = this.planClarifyingQuestions(p.projectType);
		p.revision = (p.revision || 0) + (opts && opts.final ? 0 : 1);
		const plan = this.planTemplate(p.prompt, p.answers, { researched: p.researched });
		const th = { id: this.threadId || "pending-build", preview: p.prompt, plan };
		this.planThread = th;
		const companion = this._companion(); companion.plan = plan; companion.ts = Date.now();
		this.scheduleCompanionRelay();
		this.pushPlanPanel(th);
		this.pushPlanApproval();
	}

	async researchPendingPlan(prompt, answers) {
		this.replanPendingBuild(prompt, answers);
		const p = this.pendingPlanApproval;
		p.researched = true;
		const research = this.planTemplate(p.prompt, p.answers, { researched: false });
		const step = research.find((s) => s.group === "מחקר"); if (step) step.status = "inProgress";
		this.planThread = { id: this.threadId || "pending-build", preview: p.prompt, plan: research };
		this.pushPlanPanel(this.planThread);
		this.announceAgentMessage("🔎 מתחיל מחקר תכנון בלבד — בלי כתיבת קוד מוצר.");
		this._planApprovalBypass = true;
		const answersText = p.questions.map((q) => `${q.label}: ${p.answers[q.id] || "לא נענה"}`).join("\n");
		await this.send(`[FELIX_PLAN_ONLY_RESEARCH]\nDo planning research only. Do NOT create or edit application source code. Use search/read/scrollshot as needed, write findings to RESEARCH.md and refine .solstice/PLAN.md under the quality contract: research → design direction → implementation stages → risks → verification. Keep the build waiting for Thomas approval.\n\nTask:\n${p.prompt}\n\nClarifications:\n${answersText}`)
			.catch((e) => vscode.window.showErrorMessage("Solstice planning research: " + (e && e.message || e)));
	}

	approvedBuildPrompt(p) {
		const answers = (p.questions || []).map((q) => `- ${q.label}: ${(p.answers || {})[q.id] || "לא נענה"}`).join("\n");
		return `${p.prompt}\n\n[FELIX_APPROVED_PLAN_CONTRACT]\nProject template: ${p.projectType}.\nClarifications:\n${answers}\nExecute the approved evolving .solstice/PLAN.md. Keep exactly one step [~] current and mark every finished step [x] immediately so the live timeline stays synchronized. Preserve the quality order: research → design direction → implementation stages → risks → verification → delivery.`;
	}

	flowingBuildPrompt(prompt) {
		return `${String(prompt || "").trim()}\n\n[FELIX_FLOWING_PLAN_CONTRACT]\nStart executing now; do not wait for a separate plan approval. Before changing application source, create or update the evolving .solstice/PLAN.md, keep exactly one step [~] current, and mark completed steps [x] as work advances. Treat later [FELIX_ARTIFACT_ANNOTATION] messages as in-flight plan corrections: merge them into the active plan and continue the same turn without restarting the project. Ask only when a genuinely irreversible or externally gated decision is missing.`;
	}

	beginFlowingPlan(prompt) {
		const cleanPrompt = String(prompt || "").trim();
		const plan = this.planTemplate(cleanPrompt, {}, {});
		plan[0].status = "inProgress";
		this.pendingPlanApproval = null;
		const th = { id: this.threadId || "flowing-build", preview: cleanPrompt, plan };
		this.planThread = th;
		const companion = this._companion();
		companion.plan = plan;
		companion.ts = Date.now();
		this.scheduleCompanionRelay();
		this.openPlanPanel();
		this.pushPlanPanel(th);
		if (this.planPanel) this.planPanel.webview.postMessage({ type: "planFlowing" });
		this.post({ type: "systemNote", text: "🗺 התוכנית נפתחה במצב זורם — הביצוע התחיל, ואפשר להוסיף תיקונים תוך כדי." });
	}

	isBuildIntent(text) {
		const t = String(text || "");
		if (isPureLaunchIntent(t)) return false;
		return /\b(build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b[\s\S]{0,180}\b(site|website|app|application|page|dashboard|project|feature|frontend|backend|api|component|flow)\b/i.test(t) ||
			/(?:ת?בנה|לבנות|ת?צור|ליצור|תפתח|פתח|יישם|תקן|עצב מחדש|שכפל|לשכפל|בנה מחדש|תבנה מחדש)[\s\S]{0,180}(?:אתר|אפליקצי|עמוד|דשבורד|פרויקט|פיצ'ר|בקאנד|פרונט|API|קומפוננט|מערכת)/i.test(t);
	}

	isBrowserBuildIntent(text) {
		const t = String(text || "");
		const explicitSurface = /\b(site|website|webapp|web app|app|application|page|dashboard|frontend|component|ui|landing|storefront|pwa)\b|אתר|אפליקצי|עמוד|דשבורד|פרונט|קומפוננט|ממשק|דף נחיתה/i.test(t);
		const browserSurface = explicitSurface || /\bsystem\b|מערכת/i.test(t);
		const backendOnly = /\b(backend|api|database|schema|migration|webhook|worker|cron)\b|בקאנד|מסד נתונים|סכמה|מיגרצי|וובהוק/i.test(t) && !explicitSurface;
		const followupMutation = /\b(add|change|update|polish|style|refactor|wire|connect|animate|replace)\b|(?:הוסף|תוסיף|שנה|תשנה|עדכן|תעדכן|שפר|תשפר|חבר|תחבר|החלף|תחליף)/i.test(t);
		const statusOnly = /\b(update me|status|progress|what changed)\b|(?:עדכון מצב|מה המצב|מה השתנה)/i.test(t);
		return browserSurface && !backendOnly && !statusOnly && (this.isBuildIntent(t) || followupMutation);
	}

	requestPlanApproval(prompt) {
		const cleanPrompt = String(prompt || "").trim();
		const projectType = this.planProjectType(cleanPrompt);
		const plan = this.planTemplate(cleanPrompt, {}, {});
		plan[0].status = "inProgress";
		this.pendingPlanApproval = { prompt: cleanPrompt, createdAt: Date.now(), projectType, questions: this.planClarifyingQuestions(projectType), answers: {}, revision: 0, researched: false };
		const th = { id: this.threadId || "pending-build", preview: this.pendingPlanApproval.prompt, plan };
		this.planThread = th;
		const companion = this._companion(); companion.plan = plan; companion.ts = Date.now();
		this.scheduleCompanionRelay();
		this.openPlanPanel();
		this.post({ type: "planPending" });
		this.pushPlanPanel(th);
		this.pushPlanApproval();
	}

	// ---- projects gallery (home view inside Solstice) ----
	// Roots the gallery scans for projects agents built on this server.
	galleryRoots() {
		const home = os.homedir();
		const roots = [];
		const cfg = (this.cfg().get("projectsDir") || "").trim();
		if (cfg) roots.push(cfg);
		// Defaults: deploy targets + the live workspaces agents build into
		// (Jasper/fleet bridge → solstice-bridge-work), so in-progress agent
		// builds show up too — same roots the server gallery scans.
		roots.push(
			path.join(home, "solstice-deploys"),
			path.join(home, "solstice-bridge-work"),
			path.join(home, "solstice-bridge-keep"),
			path.join(home, "Projects"),
		);
		return roots
			.filter((d, i) => roots.indexOf(d) === i)
			.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
	}

	// Find a representative preview image inside a project (best-effort).
	projectPreview(dir) {
		const candidates = [
			".solstice/preview.png", "public/og.png", "public/og.jpg",
			"public/images/hero.png", "public/images/hero.jpg",
			"public/preview.png", "preview.png", "screenshot.png",
		];
		for (const rel of candidates) {
			const abs = path.join(dir, rel);
			try { if (fs.statSync(abs).isFile()) return abs; } catch { }
		}
		// otherwise: first image under public/images
		const imgDir = path.join(dir, "public", "images");
		try {
			const f = fs.readdirSync(imgDir).find((n) => /\.(png|jpe?g|webp)$/i.test(n));
			if (f) return path.join(imgDir, f);
		} catch { }
		return null;
	}

	detectStack(dir) {
		let pkg = null;
		try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { }
		const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
		const tags = [];
		if (deps.next) tags.push("Next.js");
		else if (deps.vite) tags.push("Vite");
		if (deps.react) tags.push("React");
		if (deps.three || deps["@react-three/fiber"]) tags.push("three.js");
		if (deps.gsap || deps["framer-motion"]) tags.push("Motion");
		if (deps.tailwindcss) tags.push("Tailwind");
		if (!tags.length) {
			try { if (fs.statSync(path.join(dir, "index.html")).isFile()) tags.push("Static"); } catch { }
		}
		return { pkg, tags };
	}

	projectDeploy(dir) {
		try {
			const file = path.join(dir, ".solstice", "deploy.json");
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if (value && /^https:\/\//i.test(value.liveUrl || "")) return value;
		} catch { }
		return null;
	}

	scanProjects(webview) {
		const out = [];
		const seen = new Set();
		for (const root of this.galleryRoots()) {
			let names;
			try { names = fs.readdirSync(root); } catch { continue; }
			for (const name of names) {
				if (name.startsWith(".") || GALLERY_SKIP_DIRS.has(name)) continue;
				const dir = path.join(root, name);
				if (seen.has(dir)) continue;
				let st;
				try { st = fs.statSync(dir); } catch { continue; }
				if (!st.isDirectory()) continue;
				const isProject = ["package.json", "index.html", ".git", ".solstice"]
					.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });
				if (!isProject) continue;
				seen.add(dir);
				const { pkg, tags } = this.detectStack(dir);
				const preview = this.projectPreview(dir);
				const deploy = this.projectDeploy(dir);
				out.push({
					name: (pkg && pkg.name) || name,
					dir,
					description: (pkg && pkg.description) || "",
					tags,
					updatedAt: st.mtimeMs,
					preview: preview && webview ? webview.asWebviewUri(vscode.Uri.file(preview)).toString() : null,
					openUrl: deploy && deploy.liveUrl || null,
					liveUrl: deploy && deploy.liveUrl || null,
					deployedAt: deploy && deploy.deployedAt || null,
					agent: this.projectAgent(dir),
				});
			}
		}
		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	// ---- project ↔ agent ownership (Batch 3) -------------------------------
	projectAgentsKey() { return "solstice.fleet.projectAgents"; }
	loadProjectAgents() {
		try { return this.context.globalState.get(this.projectAgentsKey()) || {}; } catch { return {}; }
	}
	setProjectAgent(dir, agentId) {
		const d = String(dir || ""); if (!d) return;
		const all = this.loadProjectAgents();
		if (agentId) all[d] = String(agentId); else delete all[d];
		try { this.context.globalState.update(this.projectAgentsKey(), all); } catch { }
	}
	// {id,name,glyph} for an assigned agent, or null.
	projectAgent(dir) {
		const id = this.loadProjectAgents()[String(dir || "")];
		if (!id) return null;
		const a = this.fleetAgents().find((x) => x.id === id);
		return a ? { id: a.id, name: a.name, glyph: a.glyph } : { id, name: id, glyph: "◆" };
	}

	openProjectFolder(dir, newWindow) {
		if (!dir) return;
		try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
		vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: !!newWindow })
			.then(undefined, () => { });
	}

	// ---- Solstice → Atrium client handoff ----------------------------------
	// Hand a finished Solstice build to a client's Atrium folder, where the rest
	// of that client's deliverables live. Writes a handoff.json manifest always
	// (the durable record) and copies the build when the source is on the same
	// filesystem as the clients dir (IDE + fleet share the disk).
	atriumClientsDir() {
		const cfg = (this.cfg().get("atrium.clientsDir") || "").trim();
		if (cfg) return cfg;
		const guess = path.join(os.homedir(), "Julius-cc-x", "agents", "atrium", "output");
		try { if (fs.statSync(guess).isDirectory()) return guess; } catch { }
		return guess;
	}

	// Existing client folders (skip sector templates `_x` and dotfiles).
	listAtriumClients() {
		const root = this.atriumClientsDir();
		let names;
		try { names = fs.readdirSync(root); } catch { return []; }
		return names.filter((n) => {
			if (n.startsWith(".") || n.startsWith("_")) return false;
			try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
		}).sort();
	}

	// Recursive copy that skips heavy / regenerable dirs.
	copyTree(src, dst) {
		const SKIP = new Set(["node_modules", ".next", ".git", "dist", ".turbo", ".cache"]);
		fs.mkdirSync(dst, { recursive: true });
		for (const name of fs.readdirSync(src)) {
			if (SKIP.has(name)) continue;
			const s = path.join(src, name), d = path.join(dst, name);
			let st; try { st = fs.statSync(s); } catch { continue; }
			if (st.isDirectory()) this.copyTree(s, d);
			else { try { fs.copyFileSync(s, d); } catch { } }
		}
	}

	// Is a handed-off project a web app (vs. a marketing site)? Drives the future
	// conditional "אפליקציה" tab on the Atrium client card — only builds where an
	// app was produced advertise kind:"app".
	projectKind(project) {
		const tags = ((project && project.tags) || []).join(" ").toLowerCase();
		if (/\bapp\b|pwa|expo|react-native|אפליקצי/.test(tags)) return "app";
		const dir = project && project.dir;
		if (dir && !(project.remote)) {
			try {
				if (fs.existsSync(path.join(dir, "manifest.webmanifest")) ||
					fs.existsSync(path.join(dir, "public", "manifest.json")) ||
					fs.existsSync(path.join(dir, "public", "manifest.webmanifest"))) return "app";
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
				const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
				if (deps.expo || deps["react-native"]) return "app";
			} catch { }
		}
		if (this.buildMode === "app") return "app";
		return "site";
	}

	// Returns { dest, copied, manifest } or throws. Writes the per-build handoff
	// manifest AND maintains a per-client `solstice/builds.json` index — the
	// contract the Atrium client card reads to list builds, deep-link the live
	// URL, and (when kind === "app") light up the app tab.
	handoffToClient(project, client) {
		const name = String((project && (project.name)) || "site").replace(/[^\w.-]+/g, "-");
		const cl = String(client || "").replace(/[^\w.-]+/g, "-");
		if (!cl) throw new Error("no client");
		const clientRoot = path.join(this.atriumClientsDir(), cl, "solstice");
		const dest = path.join(clientRoot, name);
		fs.mkdirSync(dest, { recursive: true });
		let copied = false;
		const srcDir = project && project.dir;
		if (srcDir && !(project.remote)) {
			try { if (fs.statSync(srcDir).isDirectory()) { this.copyTree(srcDir, path.join(dest, "build")); copied = true; } } catch { }
		}
		const kind = this.projectKind(project);
		const slug = name.toLowerCase();
		const manifest = {
			project: name,
			slug,
			client: cl,
			kind,                       // "site" | "app" — drives the Atrium app tab
			source: srcDir || null,
			remote: !!(project && project.remote),
			liveUrl: (project && (project.openUrl || project.liveUrl)) || null,
			thumbnail: (project && project.preview) || null,
			stack: (project && project.tags) || [],
			agent: (project && project.agent && project.agent.id) || null,
			provider: this.providerLabel ? this.providerLabel() : "Composer 2.5",
			copiedBuild: copied,
			handedOffAt: new Date().toISOString(),
		};
		try { fs.writeFileSync(path.join(dest, "handoff.json"), JSON.stringify(manifest, null, 2)); } catch { }
		// merge into the per-client builds index (newest first, dedup by slug)
		try {
			const idxPath = path.join(clientRoot, "builds.json");
			let builds = [];
			try { const v = JSON.parse(fs.readFileSync(idxPath, "utf8")); if (Array.isArray(v)) builds = v; } catch { }
			builds = builds.filter((b) => b && b.slug !== slug);
			builds.unshift({ slug, project: name, kind, liveUrl: manifest.liveUrl, thumbnail: manifest.thumbnail, agent: manifest.agent, handedOffAt: manifest.handedOffAt, path: dest });
			fs.mkdirSync(clientRoot, { recursive: true });
			fs.writeFileSync(idxPath, JSON.stringify(builds, null, 2));
		} catch { }
		return { dest, copied, manifest };
	}

	// Deep-link to a client's card in Atrium, if a base URL is configured. We do
	// NOT guess routes — only open when `solstice.atrium.baseUrl` is set.
	atriumClientUrl(client) {
		const base = (this.cfg().get("atrium.baseUrl") || "").trim().replace(/\/+$/, "");
		if (!base) return null;
		return base + "/clients/" + encodeURIComponent(String(client || "").toLowerCase());
	}

	// ---- Fleet (talk to Orion/Jasper/Asher from inside Solstice) ----
	// Primary transport is a live WebSocket straight to the agent's brain
	// (SolsticeBridgeChannel on the server, reached over Tailscale). Bridges are
	// declared in the `solstice.fleet.bridges` setting; the shared token comes
	// from `solstice.fleet.token` or ~/.solstice/fleet-token. Agents with no
	// bridge fall back to the legacy file-drop inbox (only works when the IDE and
	// the fleet share a filesystem).
	// Human-readable Solstice version for the status bar / Fleet badge. Prefer the
	// running product version (baked at build time from release_version) so the
	// badge tracks the IDE release; fall back to this extension's own version.
	versionLabel() {
		try {
			const pj = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
			if (pj && pj.version) return "v" + pj.version;
		} catch { }
		let ext = "";
		try { ext = (this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version) || ""; } catch { }
		return ext ? ("v" + ext) : "";
	}
	versionTooltip() {
		const ext = this.versionLabel() || "?";
		let base = "";
		try { base = vscode.version || ""; } catch { }
		return "Solstice " + ext + (base ? ("  ·  base " + base) : "");
	}

	fleetCfg() {
		return vscode.workspace.getConfiguration("solstice.fleet");
	}

	fleetToken() {
		const fromCfg = String(this.fleetCfg().get("token") || "").trim();
		if (fromCfg) return fromCfg;
		try { return fs.readFileSync(path.join(os.homedir(), ".solstice", "fleet-token"), "utf8").trim(); } catch { return ""; }
	}

	// Declared WebSocket bridges, keyed by agent id.
	fleetBridgeConfigs() {
		const raw = this.fleetCfg().get("bridges");
		const list = Array.isArray(raw) ? raw : [];
		const map = new Map();
		for (const b of list) {
			if (b && b.id && b.wsUrl) map.set(String(b.id), b);
		}
		return map;
	}

	fleetDir() {
		const cfg = (this.cfg().get("fleetDir") || "").trim();
		if (cfg) return cfg;
		const guess = path.join(os.homedir(), "Julius-cc-x", "agents");
		try { if (fs.statSync(guess).isDirectory()) return guess; } catch { }
		return guess;
	}

	fleetRepliesDir() {
		return path.join(os.homedir(), ".solstice", "fleet-replies");
	}

	fleetHidden() {
		const raw = this.fleetCfg().get("hidden");
		return new Set(Array.isArray(raw) ? raw.map(String) : []);
	}

	fleetAgents() {
		const roster = [
			{ id: "orion", name: "Orion", role: "CTO · architecture & planning", glyph: "◆", model: "Opus" },
			{ id: "jasper", name: "Jasper", role: "Web production · sites & landing pages", glyph: "❖", model: "GPT-5.5" },
			{ id: "asher", name: "Asher", role: "Systems · CRMs, software, bigger builds", glyph: "▲", model: "Composer 2.5" },
		];
		const bridges = this.fleetBridgeConfigs();
		const base = this.fleetDir();
		// surface every configured agent not already in the static roster — both live
		// bridge agents (with wsUrl) and plain manually-added ones (without).
		const rawList = Array.isArray(this.fleetCfg().get("bridges")) ? this.fleetCfg().get("bridges") : [];
		for (const b of rawList) {
			if (b && b.id && !roster.some((a) => a.id === String(b.id))) {
				roster.push({ id: String(b.id), name: b.name || b.id, role: b.role || "Fleet agent", glyph: b.glyph || "◆", model: b.model || "" });
			}
		}
		const hidden = this.fleetHidden();
		const visible = roster.filter((a) => !hidden.has(a.id));
		for (const a of visible) {
			a.removable = true;
			const b = bridges.get(a.id);
			if (b) {
				a.bridge = true;
				if (b.name) a.name = b.name;
				if (b.role) a.role = b.role;
				if (b.glyph) a.glyph = b.glyph;
				if (b.model) a.model = b.model;
				const st = this.fleetBridges.get(a.id);
				// reflect the real socket state: only a live hello flips us to "online".
				a.status = st ? st.status : "idle";
				a.present = a.status === "online";
			} else {
				a.status = "local";
				a.present = (() => { try { return fs.statSync(path.join(base, a.id)).isDirectory(); } catch { return false; } })();
			}
		}
		return visible;
	}

	// Lazily open (and cache) the WebSocket to one agent's brain. Frames are
	// forwarded to the Fleet webview so the chat renders live.
	ensureFleetBridge(agentId) {
		const id = String(agentId || "");
		const existing = this.fleetBridges.get(id);
		if (existing && existing.ws && existing.ws.connected) return existing.ws;
		if (existing && existing.ws && !existing.ws.connected && existing.status === "connecting") return existing.ws;
		const cfg = this.fleetBridgeConfigs().get(id);
		if (!cfg) return null;
		const token = cfg.token || this.fleetToken();
		const ws = new FleetBridge(cfg.wsUrl, { token, log: (s) => this.output.append("[fleet:" + id + "] " + s) });
		const rec = { ws, status: "connecting" };
		this.fleetBridges.set(id, rec);
		const post = (m) => { if (this.fleetPanel) this.fleetPanel.webview.postMessage(m); };
		const agentName = () => { const a = this.fleetAgents().find((x) => x.id === id); return a ? a.name : id; };
		ws.on("open", () => { rec.status = "connecting"; this.postFleetActivity(id, "connecting", "מתחבר…"); });
		ws.on("frame", (f) => {
			if (f.type === "hello") {
				rec.status = "online";
				if (id === this.companionBridgeId()) {
					rec.companionReady = true;
					try { ws.send({ type: "client_hello", role: "ide", instanceId: this.companionInstanceId() }); } catch { }
					setTimeout(() => this.publishCompanionState(), 50);
				}
				post({ type: "roster", agents: this.fleetAgents() });
				this.postFleetActivity(id, "online", "מחובר");
				this.flushBuildRecovery(id);
			} else if (f.type === "push") {
				post({ type: "reply", agent: id, text: String(f.text || ""), ts: Date.now(), kind: "progress" });
				this.postFleetActivity(id, "working", String(f.text || "עובד…").split("\n")[0].slice(0, 80));
			} else if (f.type === "reply") {
				const ts = Date.now();
				post({ type: "reply", agent: id, text: String(f.text || ""), ts });
				this.appendFleetThread(id, { who: "them", text: String(f.text || ""), ts });
				this.postFleetActivity(id, "replied", "ענה");
				this.notifyFleetReply(id, agentName(), String(f.text || ""));
			} else if (f.type === "action") {
				// agent-driven IDE action (see runFleetAction); echo to the activity feed too
				this.runFleetAction(id, f).catch(() => { });
			} else if (f.type === "companion_action") {
				this.handleCompanionAction(f).catch((e) => this.output.append("[companion action] " + (e && e.message || e) + "\n"));
			} else if (f.type === "error") {
				post({ type: "fleetError", agent: id, error: String(f.error || "agent error") });
				this.postFleetActivity(id, "error", String(f.error || "שגיאה").slice(0, 80));
			}
		});
		ws.on("error", (e) => {
			rec.status = "offline";
			post({ type: "fleetError", agent: id, error: e.message });
			post({ type: "roster", agents: this.fleetAgents() });
			this.postFleetActivity(id, "offline", "מנותק");
		});
		ws.on("close", () => {
			rec.status = "offline";
			this.fleetBridges.delete(id);
			post({ type: "roster", agents: this.fleetAgents() });
			this.postFleetActivity(id, "offline", "מנותק");
		});
		ws.connect();
		return ws;
	}

	closeFleetBridges() {
		for (const rec of this.fleetBridges.values()) { try { rec.ws.close(); } catch { } }
		this.fleetBridges.clear();
	}

	// ---- live activity feed -------------------------------------------------
	// Broadcast a single activity event to the Fleet webview's activity rail.
	postFleetActivity(agentId, state, text) {
		this.noteWatch(agentId, state);
		if (!this.fleetPanel) return;
		this.fleetPanel.webview.postMessage({ type: "activity", agent: agentId, state, text: String(text || ""), ts: Date.now() });
	}

	// ---- fleet → Solstice handoff pipeline ---------------------------------
	// Drive the visual workflow (You → Agent → Solstice → Preview) in the Fleet
	// webview from REAL lifecycle signals, never timers. Stages:
	//   dispatch  — a fleet agent dropped a build task into the Solstice inbox
	//   building  — the Solstice builder started a turn
	//   preview   — the live preview opened in the center column
	//   done      — the builder turn completed
	// We only emit building/preview/done while a dispatch flow is active, so a
	// plain in-panel turn (no fleet handoff) doesn't fake a pipeline.
	fleetFlow(stage, extra) {
		if (stage === "dispatch") this._flowActive = true;
		else if (!this._flowActive) return;
		// Self-verify (Phase 3): hold the first "done" of a build and run one
		// automatic verification pass (screenshot the preview → ask the agent to
		// confirm it matches the task / fix issues). The verify turn ends with its
		// own "done", which is no longer eligible (guard on _verifyTaskId), so the
		// flow closes normally then.
		if (stage === "done" && this.shouldSelfVerify()) {
			this.startSelfVerify();
			if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "flowStage", stage: "building", from: (extra && extra.from) || this.builderAgent(), ts: Date.now(), note: "self-verify" });
			return;
		}
		if (stage === "done" && this.shouldRunBugbot()) {
			this.startBugbot();
			if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "flowStage", stage: "building", from: (extra && extra.from) || this.builderAgent(), ts: Date.now(), note: "Bugbot review" });
			return;
		}
		// Gated-active learning: a completed build may write and activate candidates
		// only when a durable external browser/CI/critic signal was recorded.
		// Retrieval or a model saying "done" is never a learning signal (52% < 60%).
		if (stage === "done" && this._activeBuild && this._verifyTaskId === this._activeBuild.taskId) {
			this.learnFromVerifiedBuild(this._activeBuild);
		}
		// Round-trip the lifecycle back to the dispatching agent (Phase 1).
		// "dispatch" already reports "started" from the build handler, so map
		// building/preview/done here.
		if (stage === "building") this.sendBuildStatus("building");
		else if (stage === "preview") this.sendBuildStatus("preview", { previewUrl: this.previewUrl || (extra && extra.url) || "" });
		else if (stage === "done") this.sendBuildStatus("done", { previewUrl: this.previewUrl || "" });
		if (!this.fleetPanel) {
			if (stage === "done") { this._flowActive = false; this._activeBuild = null; }
			return;
		}
		const from = (extra && extra.from) || this.builderAgent();
		this.fleetPanel.webview.postMessage({ type: "flowStage", stage, from, ts: Date.now(), ...(extra || {}) });
		if (stage === "done") { this._flowActive = false; this._activeBuild = null; }
	}

	// Report a build lifecycle frame back to the agent that dispatched it, over
	// the same fleet bridge WS. No-op for in-panel builds (no _activeBuild).
	sendBuildStatus(phase, extra) {
		const b = this._activeBuild;
		if (!b || !b.agentId || !b.taskId) return;
		const rec = this.fleetBridges.get(b.agentId);
		if (!rec || !rec.ws) return;
		const frame = { type: "build_status", taskId: b.taskId, phase: String(phase || "") };
		const ex = extra || {};
		for (const k of ["previewUrl", "deployUrl", "diffStat", "text", "error"]) {
			if (ex[k]) frame[k] = ex[k];
		}
		// keep the on-disk journal in step so a crash mid-build is recoverable.
		if (phase === "done" || phase === "error") this.clearJournal();
		else this.writeJournal({ phase, ...(ex.previewUrl ? { previewUrl: ex.previewUrl } : {}), ...(ex.deployUrl ? { deployUrl: ex.deployUrl } : {}) });
		try { rec.ws.send(frame); } catch (e) { this.output.append("[build_status] " + (e && e.message || e) + "\n"); }
	}

	// ---- self-verify (Phase 3) ---------------------------------------------
	// Every website build gets a real browser pass before the legacy visual
	// verify/Bugbot/delivery chain. The checker clicks same-origin navigation,
	// safe controls and intercepted forms, and inspects 404/network/console and
	// desktop/mobile layout failures. Concrete failures are fed into a bounded
	// auto-fix turn, then the whole browser pass runs again until green.
	armBrowserSelfCheck(task) {
		if (this.cfg().get("selfVerify") === false) return;
		const fleetTaskId = this._activeBuild && this._activeBuild.taskId;
		this._browserSelfCheck = {
			id: fleetTaskId || `interactive-${Date.now()}`,
			task: String(task || this._lastUserPrompt || "").slice(0, 4000),
			round: 0,
			maxRounds: 3,
			token: crypto.randomBytes(12).toString("hex"),
			replicaSourceUrl: siteReplicaSourceUrl(task),
		};
		this._walkthroughTaskId = this._browserSelfCheck.id;
		this._browserSelfCheckRunning = false;
	}

	maybeRunBrowserSelfCheck() {
		const state = this._browserSelfCheck;
		if (!state || this._browserSelfCheckRunning) return false;
		this._browserSelfCheckRunning = true;
		setTimeout(() => this.runBrowserSelfCheck(state.token).catch((error) => {
			this.output.append(`[browser-check] ${error && error.stack || error}\n`);
			this.failBrowserSelfCheck(state, `Browser self-check crashed: ${error && error.message || error}`);
		}), 700);
		return true;
	}

	async browserSelfCheckUrl() {
		const cwd = workspaceCwd();
		if (!cwd) return "";
		if (!this.previewUrl) await this.openPreview("").catch(() => { });
		for (let attempt = 0; attempt < 20; attempt++) {
			if (this.previewUrl) return this.previewUrl;
			const registered = await detectDevServerUrl(cwd).catch(() => null);
			if (registered) {
				await this.openPreview(registered).catch(() => { });
				if (this.previewUrl) return this.previewUrl;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return "";
	}

	async runBrowserSelfCheck(token) {
		const state = this._browserSelfCheck;
		if (!state || state.token !== token) { this._browserSelfCheckRunning = false; return; }
		const cwd = workspaceCwd();
		const url = await this.browserSelfCheckUrl();
		if (!cwd || !url) {
			this.failBrowserSelfCheck(state, "Browser self-check could not resolve a live workspace preview.");
			return;
		}
		state.round += 1;
		const roundDir = selfCheckRoundDir(cwd, state.id, state.round);
		const runtime = this.resolveWalkthroughRuntime();
		const tool = path.join(this.context.extensionPath, "webtools", "browse.js");
		this.output.append(`[browser-check] round=${state.round}/${state.maxRounds} url=${url}\n`);
		this.announceAgentMessage(`🔍 בדיקת דפדפן אוטומטית · סבב ${state.round}/${state.maxRounds}`);
		const result = await this.runCli(runtime.bin, [tool, "check", url, roundDir], cwd, runtime.env);
		if (!this._browserSelfCheck || this._browserSelfCheck.token !== token) return;
		if (result.code !== 0) {
			const detail = String(result.stderr || result.stdout || result.error && result.error.message || "browser checker failed").trim().slice(-800);
			this.failBrowserSelfCheck(state, `Browser self-check runtime failed: ${detail}`);
			return;
		}
		let report;
		try { report = JSON.parse(result.stdout || "{}"); }
		catch (error) { this.failBrowserSelfCheck(state, `Browser self-check returned invalid JSON: ${error.message}`); return; }
		let normalized = normalizeBrowserReport(report);
		if (state.pendingEngineFailure) {
			const engineFailure = state.pendingEngineFailure;
			state.pendingEngineFailure = "";
			normalized = normalizeBrowserReport({
				...normalized,
				ok: false,
				findings: [
					...normalized.findings,
					{
						severity: "error",
						check: "repair-engine",
						message: engineFailure,
						evidence: { engineFailures: state.engineFailures || 1 },
					},
				],
			});
		}
		if (normalized.ok && state.replicaSourceUrl) {
			const sourceDir = path.join(cwd, ".solstice", "replica", "source");
			const comparisonDir = path.join(roundDir, "replica-comparison");
			const compared = await this.runCli(runtime.bin, [tool, "replica-compare", sourceDir, url, comparisonDir, state.id], cwd, runtime.env);
			let replica;
			if (compared.code === 0) {
				try { replica = JSON.parse(compared.stdout || "{}"); }
				catch (error) { replica = { ok: false, score: 0, targetScore: 80, error: `invalid visual-diff JSON: ${error.message}` }; }
			} else {
				replica = { ok: false, score: 0, targetScore: 80, error: String(compared.stderr || compared.stdout || compared.error && compared.error.message || "replica comparison failed").trim().slice(-800) };
			}
			replica.evidenceDir = path.relative(cwd, comparisonDir).split(path.sep).join("/");
			const findings = [...normalized.findings];
			if (!replica.ok) {
				const detail = replica.error
					? `${replica.error}. Capture the authorized source first with browse.js replica-source ${state.replicaSourceUrl} .solstice/replica/source --authorized, then rebuild from that evidence.`
					: `Replica visual fidelity is ${replica.score || 0}/100; target is ${replica.targetScore || 80}. Open ${replica.evidenceDir}/VISUAL_DIFF.md and fix the desktop/tablet/mobile gaps.`;
				findings.push({ severity: "error", check: "visual-fidelity", message: detail, evidence: { score: replica.score || 0, target: replica.targetScore || 80, dir: replica.evidenceDir } });
			}
			normalized = normalizeBrowserReport({ ...normalized, ok: normalized.ok && replica.ok, replica, findings });
		}
		const saved = writeBrowserSelfCheckReport(cwd, state.id, state.round, normalized);
		normalized = saved.report;
		this.output.append(`[browser-check] round=${state.round} ok=${normalized.ok} findings=${normalized.findings.length} report=${saved.file}\n`);
		if (normalized.ok) {
			this._learningSignals.set(state.id, {
				type: "browser-functional-check",
				verified: true,
				verified_by: "Solstice browser functional check",
				evidence: saved.file,
				sha256: digestFile(saved.file),
				observed_at: normalized.checkedAt || new Date().toISOString(),
				summary: normalized.summary || {},
			});
			this._walkthroughTaskId = state.id;
			this._browserSelfCheck = null;
			this._browserSelfCheckRunning = false;
			const summary = normalized.summary || {};
			const replicaNote = normalized.replica ? ` · replica ${normalized.replica.score}/100` : "";
			this.announceAgentMessage(`✅ בדיקת הדפדפן ירוקה: ${summary.linksChecked || 0} ניווטים, ${summary.buttonsChecked || 0} כפתורים, ${summary.formsChecked || 0} טפסים${replicaNote} · ${saved.file}`);
			this.post({ type: "systemNote", text: "[FELIX_BROWSER_SELF_CHECK_GREEN] ה-build עבר בדפדפן אמיתי; אין שגיאות 404/console/layout או controls מתים." });
			if (this._activeBuild && this._activeBuild.taskId === state.id) this._verifyTaskId = state.id;
			this.fleetFlow("done");
			this.maybeCreateWalkthrough();
			this.drainSteerQueue();
			return;
		}
		if (state.round >= state.maxRounds) {
			this.failBrowserSelfCheck(state, `Browser self-check stayed red after ${state.maxRounds} rounds. Last report: ${saved.file}`);
			return;
		}
		const fixPrompt = buildBrowserFixPrompt(normalized, state.round, state.maxRounds);
		this._browserSelfCheckRunning = false;
		this.announceAgentMessage(`🛠 בדיקת הדפדפן מצאה ${normalized.summary && normalized.summary.errors || normalized.findings.length} תקלות; פליקס מתקן ומריץ שוב.`);
		await this.send(fixPrompt).catch((error) => this.failBrowserSelfCheck(state, `Could not start browser auto-fix turn: ${error && error.message || error}`));
	}

	failBrowserSelfCheck(state, message) {
		if (!state || !this._browserSelfCheck || this._browserSelfCheck.token !== state.token) return;
		this._browserSelfCheck = null;
		this._browserSelfCheckRunning = false;
		this._walkthroughPending = false;
		this._walkthroughTaskId = "";
		this.output.append(`[browser-check] FAILED ${message}\n`);
		this.announceAgentMessage("❌ " + message);
		if (this._activeBuild && this._activeBuild.taskId === state.id) {
			this.sendBuildStatus("error", { error: message });
			this._flowActive = false;
			this._activeBuild = null;
		}
		this.drainSteerQueue();
	}

	// One automatic verification pass per build: screenshot the live preview and
	// feed it back to the agent so it visually checks its own work and fixes
	// regressions before declaring done — instead of trusting a turn that
	// "completed" but rendered a broken page.
	shouldSelfVerify() {
		const b = this._activeBuild;
		if (!b || !b.taskId) return false;
		if (this.cfg().get("selfVerify") === false) return false;
		if (this._verifyTaskId === b.taskId) return false; // already verified this build
		if (!this.previewUrl) return false;                // nothing live to screenshot
		return true;
	}
	async startSelfVerify() {
		const b = this._activeBuild;
		if (!b) return;
		this._verifyTaskId = b.taskId; // set before any await so a re-entrant "done" can't double-fire
		const url = this.previewUrl;
		const task = b.task || "";
		this.output.append(`[self-verify] capturing preview ${url}\n`);
		if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "activity", agent: b.agentId, state: "working", text: "בדיקה עצמית: מצלם את ה-preview…", ts: Date.now() });
		let shot = null;
		try { shot = await this.capturePreviewShot(url, b.taskId); }
		catch (e) { this.output.append("[self-verify] capture failed: " + (e && e.message || e) + "\n"); }
		const lines = [
			"🔍 בדיקה עצמית אוטומטית לפני סגירת הבנייה:",
			`ה-preview החי רץ ב-${url}.`,
		];
		if (shot) lines.push(`צילמתי screenshot של התוצאה: ${shot}`, "למד את הצילום לעומק (אותו תהליך כמו בבדיקת reference: codex exec -i עבור grok, או פתח אותו ישירות אם אתה codex).");
		else lines.push(`לא הצלחתי לצלם אוטומטית — צלם בעצמך את ${url} עם כלי ה-screenshot ולמד את הצילום.`);
		// FIDELITY LOOP: when reference material exists on disk (reference shot /
		// deconstruction frames), verification is not yes/no — it's an
		// iterate-until-convergence loop the agent runs INSIDE this turn:
		// screenshot → vision-compare vs reference → fix → re-screenshot, ≤3 rounds.
		const refs = this.fidelityReferences();
		if (refs.length) {
			lines.push(
				"",
				"🎯 לולאת נאמנות (חובה — יש reference לפרויקט הזה):",
				`חומרי הרפרנס: ${refs.slice(0, 6).join(", ")}`,
				"1. צלם את מה שבנית לכל אורכו (scrollshot של ה-preview, לא רק את החלק העליון).",
				"2. השווה חזותית מול הרפרנס (describe על שניהם אם אתה text-only) וכתוב ל-.solstice/FIDELITY.md טבלת פערים קונקרטית: layout, צבעים (hex מול hex), טיפוגרפיה, ריווח, תנועה.",
				"3. תקן את כל הפערים בקוד. 4. צלם שוב והשווה שוב.",
				"חזור על 1-4 עד שאין פער מהותי — מקסימום 3 סבבים. עדכן את FIDELITY.md בכל סבב (Round N: מה נסגר, מה נשאר).",
				"רק כשאין פערים מהותיים כתוב שהבדיקה עברה — לא אחרי סבב ראשון עם פערים פתוחים."
			);
		} else {
			lines.push(
				`האם התוצאה תואמת למשימה: "${task.slice(0, 240)}"?`,
				"אם משהו שבור / חסר / לא מיושר / לא יפה — תקן עכשיו ואז עצור.",
				"אם הכל תקין — אל תיגע בקוד, רק כתוב במשפט אחד שהבדיקה עברה."
			);
		}
		this.post({ type: "injectPrompt", text: lines.join("\n") });
	}
	shouldRunBugbot() {
		const b = this._activeBuild;
		return !!(b && b.taskId && this._verifyTaskId === b.taskId && this._bugbotTaskId !== b.taskId && !this._bugbotRunning && this.cfg().get("bugbot") !== false);
	}
	async startBugbot() {
		const b = this._activeBuild;
		if (!b) return;
		this._bugbotTaskId = b.taskId;
		this._bugbotRunning = true;
		this.output.append(`[bugbot] reviewing ${b.taskId} with composer-2.5\n`);
		try {
			const result = await runBugbot(workspaceCwd(), { extensionPath: this.context.extensionPath, bin: resolveGrokBinary(this.context.extensionPath, this.cfg().get("grokPath")), log: (line) => this.output.append("[bugbot] " + line) });
			if (!result.findings.length) { this.output.append("[bugbot] no concrete findings\n"); this.fleetFlow("done"); return; }
			const saved = result.findings.map((finding) => captureAnnotation(workspaceCwd(), `bugbot:${finding.file}:${finding.line}`, `[${finding.severity}] ${finding.message}`));
			const prompt = `[FELIX_BUGBOT_FINDINGS]\nBugbot found ${saved.length} concrete issue(s) after self-verify. Read .solstice/ANNOTATIONS.md, fix each open bugbot annotation, run focused tests, and only then finish delivery.\n[/FELIX_BUGBOT_FINDINGS]`;
			this.announceAgentMessage(`🐛 Bugbot מצא ${saved.length} ממצאים והעביר אותם לתיקון לפני המסירה.`);
			await this.steer(this.threadId, prompt);
		} catch (error) {
			this.output.append("[bugbot] review unavailable: " + (error && error.message || error) + "\n");
			this.fleetFlow("done");
		} finally { this._bugbotRunning = false; }
	}
	// Reference material the fidelity loop converges against: explicit reference
	// image, deconstruction frames, or scrollshots of the source site — whatever
	// the analysis phase left in .solstice/.
	fidelityReferences() {
		const cwd = workspaceCwd();
		if (!cwd) return [];
		const out = [];
		for (const name of ["reference.png", "reference.jpg", "ref.png"]) {
			const p = path.join(cwd, ".solstice", name);
			try { if (fs.existsSync(p)) out.push(p); } catch { }
		}
		for (const dir of ["frames", "refs"]) {
			const d = path.join(cwd, ".solstice", dir);
			try {
				for (const f of fs.readdirSync(d).slice(0, 8)) {
					if (/\.(png|jpe?g|webp)$/i.test(f)) out.push(path.join(d, f));
				}
			} catch { }
		}
		return out;
	}
	// Headless screenshot of the live preview into .solstice/verify-<taskId>.png.
	// Spawns browse.js via the same ELECTRON_RUN_AS_NODE path the agent itself
	// uses; group-spawned so a wedged Chrome is reaped on timeout.
	capturePreviewShot(url, taskId, viewport = "1440x2200") {
		return new Promise((resolve) => {
			const cwd = workspaceCwd();
			if (!cwd || !url) return resolve(null);
			const browseJs = path.join(this.context.extensionPath, "webtools", "browse.js"); // dir is "webtools" not "tools": the Windows build's 7z -x!tools strips any nested tools/ dir
			const outDir = path.join(cwd, ".solstice");
			try { fs.mkdirSync(outDir, { recursive: true }); } catch { }
			const out = path.join(outDir, `verify-${taskId || "build"}.png`);
			const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
			let child;
			// detached only on *nix (Windows DETACHED_PROCESS pops console windows + we
			// can't POSIX-group-kill it anyway — see the engine spawns).
			const detached = process.platform !== "win32";
			try { child = require("child_process").spawn(process.execPath, [browseJs, "shot", url, out, viewport], { env, detached, stdio: "ignore", windowsHide: true }); }
			catch (e) { this.output.append("[self-verify] spawn failed: " + (e && e.message || e) + "\n"); return resolve(null); }
			const timer = setTimeout(() => {
				// Windows has no POSIX process groups: process.kill(-pid) throws EPERM and
				// orphans the tree. Use taskkill /T; POSIX path unchanged.
				try {
					if (process.platform === "win32") require("child_process").execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
					else process.kill(-child.pid, "SIGTERM");
				} catch { }
				resolve(null);
			}, 90000);
			child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && fs.existsSync(out) ? out : null); });
			child.on("error", () => { clearTimeout(timer); resolve(null); });
		});
	}

	// ---- self-improvement loop (Phase 6) -----------------------------------
	recordSkillPrompt(provider, input, finalPrompt) {
		const prompt = String(finalPrompt || "");
		const source = String(input || "");
		this._lastPromptDiagnostics = {
			at: new Date().toISOString(), provider: String(provider || "unknown"),
			inputBytes: Buffer.byteLength(source), inputSha256: digestText(source),
			finalPromptBytes: Buffer.byteLength(prompt), finalPromptSha256: digestText(prompt),
			developerInstructionsBytes: this._lastDeveloperInstructions ? this._lastDeveloperInstructions.bytes : 0,
			developerInstructionsSha256: this._lastDeveloperInstructions ? this._lastDeveloperInstructions.sha256 : "",
		};
		pushSkillsPanel(this);
	}

	skillRuntimeDiagnostics() {
		let runtime = null;
		let items = [];
		let error = this.skillsInitError || "";
		try {
			if (this.skills) {
				runtime = this.skills.runtimeDiagnostics(this.context.extensionPath);
				items = this.skills.list().map((item) => item.meta.name || path.basename(item.file || ""));
			} else if (!error) error = "Felix Skills store is unavailable in this session.";
		} catch (e) { error = String(e && e.message || e); }
		let extensionVersion = "";
		try { extensionVersion = String(this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version || ""); } catch { }
		return {
			generatedAt: new Date().toISOString(),
			build: {
				productVersion: this.versionLabel() || "unknown",
				extensionVersion: extensionVersion || "unknown",
				sourceCommit: sourceCommit(this.context.extensionPath) || "unavailable-in-packaged-build",
				extensionBundleSha256: digestFile(path.join(this.context.extensionPath, "extension.js")),
				extensionPath: this.context.extensionPath,
			},
			storage: {
				globalStoragePath: this.context.globalStorageUri && this.context.globalStorageUri.fsPath || "",
				skillsPath: this.skills && this.skills.skillsDir || "",
			},
			seed: this.skillsSeedResult,
			runtime,
			list: { ok: !error, count: items.length, names: items, error },
			selectedRoute: this._lastSkillRoute,
			verticalRoute: this._lastVerticalRoute,
			prompt: this._lastPromptDiagnostics,
			learning: {
				mode: LEARNING_MODE,
				autoActivation: true,
				drafts: this.learning ? this.learning.listDrafts().filter((draft) => draft.status === "DRAFT").length : 0,
				requiresExternalSuccessSignal: true,
				requiresDoesNotApply: true,
			},
		};
	}

	showSkillsError(message) {
		const text = String(message || "Felix Skills failed");
		this.skillsInitError = text;
		this.output.append("[skills] " + text + "\n");
		if (this._skillsLastVisibleError !== text) {
			this._skillsLastVisibleError = text;
			vscode.window.showErrorMessage(text, "Open Skills").then((choice) => {
				if (choice === "Open Skills") vscode.commands.executeCommand("solstice.agent.openSkills");
			});
		}
		pushSkillsPanel(this);
	}

	// Retrieval at dispatch time: pull skills relevant to the task and return a
	// prompt block to prepend. Explicit ScrollWorld is a fail-loud exclusive route
	// with its complete portable contract; generic retrieval remains bounded.
	async skillsHint(task) {
		try {
			this._skillsDispatchBlocked = false;
			const vertical = selectVerticalTemplates(task);
			this._lastVerticalRoute = {
				at: new Date().toISOString(), requested: vertical.requested,
				selected: vertical.templates.map((item) => item.file), reason: vertical.reason,
			};
			if (vertical.reason === "no confident vertical match") {
				this.announceAgentMessage("🧭 Vertical: no confident vertical match — no vertical template was injected.");
			}
			if (!this.skills) {
				this.showSkillsError("Felix Skills is unavailable; the requested route cannot be verified.");
				if (hasExclusiveScrollWorldRoute(task)) this._skillsDispatchBlocked = true;
				return "";
			}
			const runtimeItems = this.skills.list();
			if (!runtimeItems.length) {
				this.showSkillsError("Felix Skills runtime store is empty. Open Skills to inspect and repair the installation.");
				if (hasExclusiveScrollWorldRoute(task)) this._skillsDispatchBlocked = true;
				return "";
			}
			if (hasExclusiveScrollWorldRoute(task)) {
				const health = this.skills.runtimeDiagnostics(this.context.extensionPath);
				const listed = runtimeItems.some((item) => item.meta.name === "scroll-world-gpt-image");
				if (!listed || health.status !== "healthy") {
					this._skillsDispatchBlocked = true;
					const message = `ScrollWorld route blocked: runtime status is ${listed ? health.status : "not-listed"}. Open Skills and run Repair ScrollWorld.`;
					this.showSkillsError(message);
					this.announceAgentMessage("⛔ " + message);
					return "";
				}
			}
			const hits = await this.skills.retrieve(task, 4);
			if (!hits.length) {
				this._lastSkillRoute = { at: new Date().toISOString(), exclusive: false, selected: [], reason: "no relevant skill" };
				pushSkillsPanel(this);
				return "";
			}
			const composed = composeSkillsPrompt(hits);
			const exclusive = composed.exclusive;
			if (exclusive) {
				const bridge = imageBridgeStatus({
					extensionPath: this.context.extensionPath,
					configuredPath: this.cfg().get("codexPath") || "",
				});
				if (!bridge.ok) {
					this._skillsDispatchBlocked = true;
					this.showSkillsError(bridge.message);
					this.announceAgentMessage("⛔ " + bridge.message);
					return "";
				}
			}
			// Retrieval count is telemetry, not learning. Only an externally verified
			// outcome may create and activate a learning record.
			const reasons = hits.map((h) => {
				const selection = h.retrieval || {};
				return `${h.meta.name || "skill"} — ${selection.pinned ? "pinned by explicit name" : selection.reason || "relevant"}`;
			});
			this._lastSkillRoute = {
				at: new Date().toISOString(), exclusive,
				selected: hits.map((hit) => ({ name: hit.meta.name || "skill", reason: hit.retrieval && hit.retrieval.reason || "relevant", pinned: !!(hit.retrieval && hit.retrieval.pinned) })),
				injectedBytes: composed.injectedBytes,
			};
			if (exclusive) this.announceAgentMessage("🧭 Route selected: ScrollWorld · exclusive · full SKILL.md contract injected · Animated Website Kit suppressed.");
			else this.announceAgentMessage("🧠 Skills selected: " + reasons.join(" · ") + ". To replace: say “use skill <name>” / “השתמש בסקיל <שם>”.");
			pushSkillsPanel(this);
			return composed.text;
		} catch (error) {
			if (hasExclusiveScrollWorldRoute(task)) this._skillsDispatchBlocked = true;
			this.showSkillsError("Felix Skills retrieval failed: " + String(error && error.message || error));
			return "";
		}
	}

	// crude sector/tag inference from the task text (bilingual keywords).
	inferSkillTags(task) {
		const t = String(task || "").toLowerCase();
			const map = {
				dental: ["dental", "dentist", "שיניים", "שינניות", "מרפאת שיניים"],
				medical: ["medical", "clinic", "doctor", "physio", "aesthetic", "health", "רופא", "מרפאה", "פיזיותרפיה", "אסתטיקה", "בריאות"],
				legal: ["law", "lawyer", "legal", "attorney", "notary", "עו\"ד", "עורך דין", "עורכת דין", "נוטריון", "משפט"],
				barber: ["barber", "salon", "beauty", "hair", "nails", "מספרה", "ספר גברים", "יופי", "שיער", "ציפורניים"],
				fitness: ["fitness", "gym", "coach", "trainer", "כושר", "חדר כושר", "מאמן", "מאמנת", "אימונים"],
				restaurant: ["restaurant", "menu", "מסעדה", "תפריט"],
				crm: ["crm", "leads", "לידים", "פלקון"],
				ecommerce: ["shop", "store", "ecommerce", "cart", "checkout", "חנות", "מוצרים"],
				landing: ["landing", "דף נחיתה", "לנדינג"],
				dashboard: ["dashboard", "admin", "analytics", "דשבורד"],
				portfolio: ["portfolio", "תיק עבודות"],
				auth: ["auth", "login", "signup", "התחברות"],
				animation: ["animated", "animation", "scrollytelling", "gsap", "three.js", "r3f", "מונפש", "אנימציה", "פרלקס"],
				gap: ["antigravity", "cursor", "gap", "benchmark", "פערים", "השוואה"],
			};
		const tags = [];
		for (const [tag, kws] of Object.entries(map)) if (kws.some((k) => t.includes(k))) tags.push(tag);
		return tags;
	}
	inferSkillSector(task) { const tags = this.inferSkillTags(task); return tags[0] || ""; }

	// Gated-active learning. A verified external outcome creates an auditable
	// record and activates it in the existing versioned skill store. If activation
	// fails, the DRAFT remains visible in Skills for an explicit retry or reject.
	learnFromVerifiedBuild(b) {
		try {
			if (!this.learning || !b || !b.task || !b.taskId) return;
			const signal = this._learningSignals.get(b.taskId);
			if (!signal || signal.verified !== true || !signal.sha256) {
				this.output.append(`[learning-active] skipped ${b.taskId}: no verified external success signal\n`);
				return;
			}
			const proposed = this.learning.proposeFromBuild({
				taskId: b.taskId,
				task: b.task,
				tags: this.inferSkillTags(b.task),
				buildMode: this.buildMode || "site",
				provider: this.providerLabel(),
				preview: this.previewUrl || "",
				client: workspaceCwd() ? path.basename(workspaceCwd()) : "",
			}, signal);
			this._learningSignals.delete(b.taskId);
			const result = this.learning.activatePending(proposed, this.skills, "Felix verified browser outcome gate");
			if (result.activated.length) {
				const message = `🧠 Felix הפעיל ${result.activated.length} למידות מאומתות · אות דפדפן חיצוני + SHA + does_not_apply.`;
				this.announceAgentMessage(message);
				vscode.window.showInformationMessage(message, "Open Skills").then((choice) => {
					if (choice === "Open Skills") vscode.commands.executeCommand("solstice.agent.openSkills");
				});
			}
			if (result.failed.length) {
				const message = `Felix learning activation failed for ${result.failed.length} record(s); the drafts remain available in Skills.`;
				this.output.append(`[learning-active] ${message}\n`);
				vscode.window.showErrorMessage(message, "Open Skills").then((choice) => {
					if (choice === "Open Skills") vscode.commands.executeCommand("solstice.agent.openSkills");
				});
			}
			if (result.exhausted.length) {
				const message = `Felix stopped automatic activation for ${result.exhausted.length} record(s) after the retry limit; review them manually in Skills.`;
				this.output.append(`[learning-active] ${message}\n`);
				vscode.window.showWarningMessage(message, "Open Skills").then((choice) => {
					if (choice === "Open Skills") vscode.commands.executeCommand("solstice.agent.openSkills");
				});
			}
			pushSkillsPanel(this);
		} catch (e) { this.output.append("[learning-active] outcome learning failed: " + (e && e.message || e) + "\n"); }
	}

	// Fidelity prose is evidence context, not a success signal. It remains on
	// disk for review but can never write memory/skills on its own (52% rule).
	noteFidelityDraftEligibility() {
		try {
			const cwd = workspaceCwd(); if (!cwd) return;
			const file = path.join(cwd, ".solstice", "FIDELITY.md");
			if (!fs.existsSync(file)) return;
			this.output.append(`[learning-active] fidelity candidate observed sha=${digestFile(file).slice(0, 12)}; awaiting external gate\n`);
		} catch (e) { this.output.append("[learning-active] fidelity observation failed: " + (e && e.message || e) + "\n"); }
	}

	resolveWalkthroughRuntime(platform = process.platform) {
		if (platform === "win32") {
			const signedNode = path.join(this.context.extensionPath, "bin", "node.exe");
			if (fs.existsSync(signedNode)) return { bin: signedNode, env: {}, source: "signed-node.exe" };
			this.output.append(`[walkthrough] WARNING signed node.exe missing at ${signedNode}; falling back to Electron runtime\n`);
		}
		return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, source: "electron-fallback" };
	}

	maybeCreateWalkthrough() {
		if (!this._walkthroughPending || this._walkthroughRunning) return;
		// The first fleet "done" can launch self-verify and keep _activeBuild alive.
		// Wait for that verification turn to finish before freezing the evidence.
		if (this._activeBuild) return;
		const cwd = workspaceCwd(), previewUrl = this.previewUrl;
		const taskId = this._walkthroughTaskId;
		if (!cwd || !previewUrl || !taskId) {
			this.output.append("[walkthrough] skipped: no workspace/preview URL/taskId\n");
			return;
		}
		this._walkthroughPending = false;
		this._walkthroughRunning = true;
		const tool = path.join(this.context.extensionPath, "webtools", "walkthrough.js");
		const args = [tool, cwd, previewUrl, this.lastDeployUrl || "", taskId];
		const runtime = this.resolveWalkthroughRuntime();
		this.output.append(`[walkthrough] runtime=${runtime.source} bin=${runtime.bin}\n`);
		this.runCli(runtime.bin, args, cwd, runtime.env).then((result) => {
			if (result.code !== 0) throw new Error((result.stderr || result.stdout || "walkthrough failed").trim().slice(-600));
			const parsed = JSON.parse(result.stdout);
			const artifact = parsed.artifact;
			ensureScheduledCheck(cwd, this.lastDeployUrl || previewUrl);
			const companion = this._companion(); companion.walkthrough = artifact; companion.ts = Date.now();
			this.pushArtifactPackages();
			this.announceAgentMessage("📦 חבילת walkthrough מוכנה: " + artifact);
			vscode.window.showInformationMessage("📦 Solstice יצר חבילת walkthrough", "פתח").then((choice) => {
				if (choice === "פתח") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(artifact));
			});
		}).catch((e) => {
			this.output.append("[walkthrough] " + (e && e.message || e) + "\n");
			this.announceAgentMessage("⚠️ יצירת חבילת walkthrough נכשלה: " + String(e && e.message || e).slice(0, 300));
		}).finally(() => { this._walkthroughRunning = false; this._walkthroughTaskId = ""; });
	}

	// ---- connectors: on-demand link-auth + vault (Phase 4) -----------------
	// Credentials live in the OS-keychain vault (context.secrets), never in
	// config/globalState/logs and never in the model's context. Reads fall back
	// to env/legacy-config so existing setups keep working.
	connectorSecretKey(id) { return "solstice.connector." + String(id || ""); }
	async connectorToken(id) {
		const c = CONNECTOR_CATALOG.find((x) => x.id === id);
		if (!c) return "";
		try { const v = await this.context.secrets.get(this.connectorSecretKey(id)); if (v && v.trim()) return v.trim(); } catch { }
		return String(process.env[c.tokenKey] || this.cfg().get("connector." + id + "Token") || "").trim();
	}
	async connectorConnected(id) { return !!(await this.connectorToken(id)); }
	refreshConnectorsPanel() { try { if (this._pushConnectors) this._pushConnectors(); } catch { } }

	// --- Mercury commerce bridge -------------------------------------------
	// The stored credential is "<baseURL>|<store_id>". Parsed into a config the
	// build uses to wire the storefront to the live Mercury backend.
	async mercuryConfig() {
		const raw = await this.connectorToken("mercury");
		if (!raw) return null;
		const [base, storeId] = raw.split("|").map((x) => (x || "").trim());
		if (!base || !storeId) return null;
		return { base: base.replace(/\/+$/, ""), storeId };
	}
	// On build, drop a typed Mercury client into the project (lib/mercury.ts) so
	// the storefront talks to the live commerce engine — products, cart, checkout,
	// analytics — instead of mock data. Customer storefront only; analytics data
	// is read for the OWNER side (MercuryShell), never rendered to the shopper.
	async injectMercuryClient() {
		const cfg = await this.mercuryConfig();
		const root = workspaceCwd();
		if (!cfg || !root) return false;
		const dir = path.join(root, "lib");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { }
		const src = [
			"// Auto-generated by Solstice — Mercury commerce connector (headless).",
			"export const MERCURY_BASE = " + JSON.stringify(cfg.base) + ";",
			"export const STORE_ID = " + JSON.stringify(cfg.storeId) + ";",
			"async function api(path, init) {",
			"  const r = await fetch(MERCURY_BASE + path, { ...init, headers: { 'Content-Type': 'application/json', ...((init && init.headers) || {}) } });",
			"  if (!r.ok) throw new Error('Mercury ' + path + ' ' + r.status);",
			"  return r.json();",
			"}",
			"export const getProducts = () => api('/api/stores/' + STORE_ID + '/products');",
			"export const getProduct = (id) => api('/api/stores/' + STORE_ID + '/products/' + id);",
			"export const createCheckout = (items) => api('/api/stores/' + STORE_ID + '/checkout', { method: 'POST', body: JSON.stringify({ items }) });",
			"export const trackEvent = (event, data) => api('/api/stores/' + STORE_ID + '/collect', { method: 'POST', body: JSON.stringify({ event, ...(data || {}) }) }).catch(() => {});",
			"",
		].join("\n");
		try { fs.writeFileSync(path.join(dir, "mercury.ts"), src); return true; } catch { return false; }
	}

	// The on-demand flow: open the provider's auth/token page, let Thomas log in
	// and approve online, then paste the credential into a secure (password)
	// input that stores it straight into the vault. Provider-agnostic.
	async connectProvider(id, opts) {
		const c = CONNECTOR_CATALOG.find((x) => x.id === id);
		if (!c) { vscode.window.showErrorMessage("Solstice: ספק לא ידוע — " + id); return false; }
		if (await this.connectorConnected(id)) { vscode.window.showInformationMessage(`${c.name} כבר מחובר.`); return true; }
		// 1) emit the auth link — open it so Thomas authenticates in the browser
		if (c.authUrl) { try { await vscode.env.openExternal(vscode.Uri.parse(c.authUrl)); } catch { } }
		// 2) Thomas pastes the credential (password field — not echoed, not logged)
		const token = await vscode.window.showInputBox({
			title: `חיבור ${c.name}`,
			prompt: (c.authUrl ? `נפתח בדפדפן: ${c.authUrl}\n` : "") + (c.howto || "הדבק את ה-token/מפתח כאן."),
			placeHolder: c.tokenKey,
			password: true,
			ignoreFocusOut: true,
		});
		if (!token || !token.trim()) { vscode.window.showWarningMessage(`חיבור ${c.name} בוטל.`); return false; }
		// 3) store in the vault — never to config/globalState/model context
		try { await this.context.secrets.store(this.connectorSecretKey(id), token.trim()); }
		catch (e) { vscode.window.showErrorMessage(`שמירת ה-credential נכשלה: ${e && e.message || e}`); return false; }
		try { const req = this.context.globalState.get("solstice.fleet.connectorsRequested") || {}; delete req[id]; this.context.globalState.update("solstice.fleet.connectorsRequested", req); } catch { }
		vscode.window.showInformationMessage(`✅ ${c.name} מחובר. ה-credential נשמר בכספת — לא נחשף לסוכן.`);
		this.refreshConnectorsPanel();
		if (opts && opts.agentId) this.postFleetActivity(opts.agentId, "online", `${c.name} חובר ✓`);
		return true;
	}
	async disconnectProvider(id) {
		const c = CONNECTOR_CATALOG.find((x) => x.id === id);
		try { await this.context.secrets.delete(this.connectorSecretKey(id)); } catch { }
		try { const req = this.context.globalState.get("solstice.fleet.connectorsRequested") || {}; delete req[id]; this.context.globalState.update("solstice.fleet.connectorsRequested", req); } catch { }
		vscode.window.showInformationMessage(`${c ? c.name : id} נותק.`);
		this.refreshConnectorsPanel();
	}
	// An agent that needs a not-yet-connected service requests it on-demand; we
	// surface the link to Thomas (mark "requested" so the panel reflects it).
	async requestConnect(agentId, id) {
		const c = CONNECTOR_CATALOG.find((x) => x.id === id);
		if (!c) { this.postFleetActivity(agentId, "error", "ספק לא ידוע: " + id); return false; }
		if (await this.connectorConnected(id)) { this.postFleetActivity(agentId, "online", `${c.name} כבר מחובר`); return true; }
		try { const req = this.context.globalState.get("solstice.fleet.connectorsRequested") || {}; req[id] = Date.now(); this.context.globalState.update("solstice.fleet.connectorsRequested", req); } catch { }
		this.refreshConnectorsPanel();
		this.postFleetActivity(agentId, "working", `מבקש חיבור ${c.name} — נשלח לינק ל-Thomas`);
		return this.connectProvider(id, { agentId });
	}

	// ---- build journal (relaunch recovery) ---------------------------------
	// A build is a long, multi-minute CLI turn. If the IDE/extension is closed
	// or crashes mid-build, the in-memory _activeBuild is lost and the dispatching
	// agent would wait forever for a terminal frame. We mirror the build's state
	// to .solstice/BUILD.json so the next activation can detect the interruption,
	// report a terminal "error" back over the bridge, and offer to resume.
	_journalPath() {
		const cwd = workspaceCwd();
		return cwd ? path.join(cwd, ".solstice", "BUILD.json") : null;
	}
	writeJournal(patch) {
		const p = this._journalPath();
		if (!p) return;
		try {
			let cur = {};
			try { cur = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch { }
			const next = { ...cur, ...patch, updatedAt: Date.now() };
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, JSON.stringify(next, null, 2));
		} catch (e) { this.output.append("[journal] write failed: " + (e && e.message || e) + "\n"); }
	}
	clearJournal() {
		const p = this._journalPath();
		if (!p) return;
		try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { }
	}
	// Called once on activation: if a build was left unfinished, queue a recovery
	// that fires the moment that agent's bridge reconnects (see ensureFleetBridge).
	recoverBuildJournal() {
		const p = this._journalPath();
		if (!p) return;
		let j;
		try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return; }
		if (!j || !j.taskId || !j.agentId || j.phase === "done" || j.phase === "error") { this.clearJournal(); return; }
		// stale journals (>6h) are almost certainly orphaned — drop silently.
		if (Date.now() - (j.startedAt || j.updatedAt || 0) > 6 * 3600 * 1000) { this.clearJournal(); return; }
		this._pendingRecovery = j;
		this.output.append(`[journal] interrupted build ${j.taskId} (agent ${j.agentId}) — will report on reconnect\n`);
		try { this.ensureFleetBridge(j.agentId); } catch { }
	}
	// Flush a queued recovery once the dispatching agent's bridge is online.
	flushBuildRecovery(agentId) {
		const j = this._pendingRecovery;
		if (!j || j.agentId !== agentId) return;
		this._pendingRecovery = null;
		this._activeBuild = { agentId: j.agentId, taskId: j.taskId };
		this.sendBuildStatus("error", { error: "ה-IDE נסגר/אותחל באמצע הבנייה — הריצה הופסקה (אפשר לשגר שוב)." });
		this._activeBuild = null;
		this.clearJournal();
		if (j.prompt) {
			vscode.window.showWarningMessage("Solstice: בנייה הופסקה באתחול ה-IDE. להמשיך מאיפה שעצרנו?", "המשך בנייה")
				.then((pick) => { if (pick) this.post({ type: "injectPrompt", text: j.prompt }); });
		}
	}

	// ---- xAI/Grok token meter ----------------------------------------------
	// Surfaces session token usage (real if the CLI reports it, else an
	// estimate) in the status bar + Fleet, so heavy Composer 2.5 builds don't
	// silently drain the xAI plan.
	fmtTokens(n) {
		n = Number(n || 0);
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
		return String(n);
	}
	recordTokenUsage(params) {
		const t = params.total || {};
		this.tokenTotal = { in: Number(t.in || 0), out: Number(t.out || 0), exact: !!params.exact };
		const total = this.tokenTotal.in + this.tokenTotal.out;
		// real model output = a strong liveness signal
		this.notePulse("_builder", "token", { total });
		const modelLabel = (params.model && params.model.label) || this.providerLabel();
		if (!this.tokenStatus) {
			try { this.tokenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999); this.tokenStatus.command = "solstice.agent.openFleet"; } catch { }
		}
		if (this.tokenStatus) {
			this.tokenStatus.text = "$(symbol-numeric) " + this.fmtTokens(total) + " tok";
			this.tokenStatus.tooltip = `${modelLabel} · session ${params.exact ? "" : "≈"}${this.fmtTokens(total)} tokens (in ${this.fmtTokens(this.tokenTotal.in)} / out ${this.fmtTokens(this.tokenTotal.out)})`;
			this.tokenStatus.show();
		}
		if (this.fleetPanel) {
			this.fleetPanel.webview.postMessage({ type: "tokens", inT: this.tokenTotal.in, outT: this.tokenTotal.out, exact: !!params.exact, model: modelLabel });
		}
		// also surface in the chat panel, right next to the model picker
		this.post({ type: "tokens", inT: this.tokenTotal.in, outT: this.tokenTotal.out, exact: !!params.exact, model: modelLabel });
	}

	// ---- desktop notifications ---------------------------------------------
	// Toast when an agent finishes a turn while its thread isn't in the foreground.
	notifyFleetReply(agentId, name, text) {
		const preview = String(text || "").replace(/\s+/g, " ").trim().slice(0, 90);
		vscode.window.showInformationMessage(`${name}: ${preview || "ענה"}`, "פתח Fleet").then((pick) => {
			if (pick && this.fleetPanel) {
				this.fleetPanel.reveal(vscode.ViewColumn.One);
				this.fleetPanel.webview.postMessage({ type: "focusAgent", agent: agentId });
			}
		}, () => { });
	}

	// ---- chat history persistence ------------------------------------------
	fleetThreadsKey() { return "solstice.fleet.threads"; }
	loadFleetThreads() {
		try { return this.context.globalState.get(this.fleetThreadsKey()) || {}; } catch { return {}; }
	}
	appendFleetThread(agentId, msg) {
		const id = String(agentId || ""); if (!id || !msg) return;
		const all = this.loadFleetThreads();
		const list = Array.isArray(all[id]) ? all[id] : [];
		list.push(msg);
		// cap stored history per agent so globalState stays small
		all[id] = list.slice(-200);
		try { this.context.globalState.update(this.fleetThreadsKey(), all); } catch { }
	}
	clearFleetThread(agentId) {
		const id = String(agentId || ""); if (!id) return;
		const all = this.loadFleetThreads();
		delete all[id];
		try { this.context.globalState.update(this.fleetThreadsKey(), all); } catch { }
	}

	// ---- agent-driven IDE actions (Batch 2) --------------------------------
	// An agent brain can push {type:"action", action, ...} frames to actually
	// drive the editor: open/edit files, run a terminal command, dispatch a
	// sub-task to a peer agent, etc. Mutating actions pass through an inline
	// approval gate rendered in the Fleet webview before they run.
	async runFleetAction(agentId, f) {
		const action = String(f && f.action || "").trim().toLowerCase();
		if (!action) return;
		const name = (() => { const a = this.fleetAgents().find((x) => x.id === agentId); return a ? a.name : agentId; })();
		const creditRisk = creditRiskSignal(`fleet/${action}`, f);
		try {
			if (creditRisk) {
				const ok = await this.requestFleetCreditApproval(agentId, name, creditRisk);
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחה שער קרדיטים");
			}
			if (action === "open") {
				const uri = this.resolveWorkspacePath(f.path);
				if (!uri) return this.postFleetActivity(agentId, "error", "נתיב לא חוקי");
				this.postFleetActivity(agentId, "working", "פותח " + this.relPath(uri));
				const doc = await vscode.workspace.openTextDocument(uri);
				// preserveFocus: agent-initiated open during a build must NOT steal focus
				// from the composer — otherwise the user is kicked out mid-typing every
				// time the agent opens a file. (Thomas focus-loss bug, 22/06.)
				await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
				return;
			}
			if (action === "write" || action === "edit") {
				const uri = this.resolveWorkspacePath(f.path);
				if (!uri) return this.postFleetActivity(agentId, "error", "נתיב לא חוקי");
				const rel = this.relPath(uri);
				const ok = await this.requestFleetApproval(agentId, name, "edit", rel, "כתיבה לקובץ " + rel);
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחתה כתיבה ל-" + rel);
				this.postFleetActivity(agentId, "working", "כותב " + rel);
				await this.writeWorkspaceFile(uri, String(f.content || ""));
				const doc = await vscode.workspace.openTextDocument(uri);
				// preserveFocus: see above — agent writing a file mid-build must not
				// pull focus out of the composer while the user is typing.
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
				this.postFleetActivity(agentId, "replied", "עודכן " + rel);
				return;
			}
			if (action === "run" || action === "terminal") {
				const cmd = String(f.command || "").trim();
				if (!cmd) return;
				const ok = await this.requestFleetApproval(agentId, name, "run", cmd, "הרצת פקודה: " + cmd);
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחתה פקודה");
				this.postFleetActivity(agentId, "working", "מריץ: " + cmd.slice(0, 60));
				this.runFleetTerminal(name, cmd, f.cwd);
				return;
			}
			if (action === "dispatch") {
				const to = String(f.to || "").trim();
				const text = String(f.text || "").trim();
				if (!to || !text) return;
				const toName = (() => { const a = this.fleetAgents().find((x) => x.id === to); return a ? a.name : to; })();
				const ok = await this.requestFleetApproval(agentId, name, "dispatch", to, name + " → " + toName + ": " + text.slice(0, 80));
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחה שיגור ל-" + toName);
				this.postFleetActivity(agentId, "working", "משגר ל-" + toName + ": " + text.slice(0, 50));
				const res = this.sendToFleet(to, text);
				this.appendFleetThread(to, { who: "me", text: "[מ-" + name + "] " + text, ts: Date.now() });
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "reply", agent: to, text: "↳ משימה מ-" + name + ": " + text, ts: Date.now(), kind: "dispatch" });
				if (res.live) this.postFleetActivity(to, "working", "קיבל משימה מ-" + name);
				return;
			}
			if (action === "connect") {
				// on-demand connector: the agent hit a not-yet-connected service and
				// asks Thomas to authorize it. We open the auth link + secure paste.
				const provider = String(f.provider || f.id || "").trim().toLowerCase();
				if (!provider) return this.postFleetActivity(agentId, "error", "חסר שם ספק לחיבור");
				await this.requestConnect(agentId, provider);
				return;
			}
			if (action === "build" || action === "prompt" || action === "inject") {
				// a fleet agent hands a build task to the IDE's own builder (grok/codex).
				// mirrors the inbox-watcher inject path so WS dispatch == file-drop dispatch:
				// focus panel, light the live flow, and feed the task as a builder prompt.
				const task = String(f.text || f.task || "").trim();
				if (!task) return;
				// Round-trip: remember who dispatched + the taskId so fleetFlow can
				// report lifecycle + the live preview/deploy URL back over the bridge.
				const taskId = String(f.taskId || "").trim();
				this._activeBuild = taskId ? { agentId, taskId, task } : null;
				if (taskId) { this._verifyTaskId = null; this._bugbotTaskId = null; } // a new build gets one verify + Bugbot pass
				if (this._activeBuild) this.writeJournal({ taskId, agentId, prompt: task, provider: this.providerKey(), phase: "dispatch", startedAt: Date.now() });
				await vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
				this.activeFleetAgent = agentId;
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "liveTask", from: agentId, task });
				this.fleetFlow("dispatch", { from: agentId, task });
				this.sendBuildStatus("started", { text: task.slice(0, 120) });
				this.postFleetActivity(agentId, "working", "משגר בנייה ל-Solstice: " + task.slice(0, 50));
				// Phase 6 retrieval: prepend relevant accrued skills to the task prompt.
				const hint = await this.skillsHint(task);
				if (this._skillsDispatchBlocked) {
					this.sendBuildStatus("failed", { text: "ScrollWorld runtime route is unavailable; repair required before dispatch." });
					this.postFleetActivity(agentId, "error", "ScrollWorld runtime route blocked; repair required");
					return;
				}
				const text = hint + `\u{1f4e5} \u05de\u05e9\u05d9\u05de\u05d4 \u05de-${name} (\u05e6\u05d9 \u05d4\u05e1\u05d5\u05db\u05e0\u05d9\u05dd):\n\n${task}`;
				// show the exact prompt the agent is writing into the Solstice builder
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "flowGuidance", from: agentId, prompt: text });
				setTimeout(() => this.post({ type: "injectPrompt", text }), 1200);
				return;
			}
			// unknown action — just echo it
			this.postFleetActivity(agentId, "working", "פעולה ב-IDE: " + action);
		} catch (e) {
			this.postFleetActivity(agentId, "error", String(e && e.message || e).slice(0, 80));
		}
	}

	// Resolve an agent-supplied path to a Uri inside the workspace; reject escapes.
	resolveWorkspacePath(p) {
		const raw = String(p || "").trim();
		if (!raw) return null;
		const roots = vscode.workspace.workspaceFolders || [];
		if (!roots.length) return null;
		const root = roots[0].uri.fsPath;
		const abs = path.isAbsolute(raw) ? raw : path.join(root, raw);
		const norm = path.normalize(abs);
		if (norm !== root && !norm.startsWith(root + path.sep)) return null;
		return vscode.Uri.file(norm);
	}
	relPath(uri) {
		try { return vscode.workspace.asRelativePath(uri, false); } catch { return uri.fsPath; }
	}
	async writeWorkspaceFile(uri, content) {
		const dir = vscode.Uri.file(path.dirname(uri.fsPath));
		try { await vscode.workspace.fs.createDirectory(dir); } catch { }
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
	}
	runFleetTerminal(name, cmd, cwd) {
		const key = "Fleet · " + name;
		let term = (vscode.window.terminals || []).find((t) => t.name === key);
		if (!term) {
			const opts = { name: key };
			const roots = vscode.workspace.workspaceFolders || [];
			if (cwd) opts.cwd = cwd; else if (roots.length) opts.cwd = roots[0].uri.fsPath;
			term = vscode.window.createTerminal(opts);
		}
		term.show(true);
		term.sendText(cmd, true);
	}

	// ---- inline approval gate ----------------------------------------------
	// Posts an approval card to the Fleet webview and resolves when the user
	// clicks אשר/דחה. Falls back to auto-approve only if no panel is open.
	requestFleetApproval(agentId, name, kind, detail, label) {
		if (!this.fleetApprovals) this.fleetApprovals = new Map();
		if (!this.fleetPanel) return Promise.resolve(true);
		const key = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		return new Promise((resolve) => {
			let done = false;
			const finish = (v) => { if (done) return; done = true; this.fleetApprovals.delete(key); resolve(v); };
			this.fleetApprovals.set(key, finish);
			this.fleetPanel.webview.postMessage({ type: "approval", key, agent: agentId, name, kind, detail: String(detail || ""), label: String(label || ""), ts: Date.now() });
			// safety timeout: auto-deny after 2 min so an agent never hangs forever
			setTimeout(() => finish(false), 120000);
		});
	}
	async requestFleetCreditApproval(agentId, name, risk) {
		if (this.fleetPanel) {
			return this.requestFleetApproval(
				agentId,
				name,
				"credit",
				risk.detail,
				`שער קרדיטים: ${risk.label}. נדרש אישור תומס לפני המשך.`
			);
		}
		const approveLabel = "Approve once";
		const choice = await vscode.window.showWarningMessage(
			`Solstice credit gate: ${risk.label}`,
			{ modal: true, detail: risk.detail || "This fleet action may spend credits or generate video/3D assets." },
			approveLabel,
			"Deny"
		);
		return choice === approveLabel;
	}
	resolveFleetApproval(key, decision) {
		if (!this.fleetApprovals) return;
		const fn = this.fleetApprovals.get(String(key || ""));
		if (fn) fn(decision === "approve" || decision === true);
	}

	// ---- editor context → agent --------------------------------------------
	// Grab the active editor's file + selection and feed it to an agent as a
	// context-tagged message, so the agent "sees" what the user is looking at.
	sendEditorContext(agentId) {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return { ok: false, error: "אין עורך פעיל" };
		const rel = this.relPath(ed.document.uri);
		const sel = ed.selection;
		const hasSel = sel && !sel.isEmpty;
		const body = hasSel ? ed.document.getText(sel) : ed.document.getText();
		const range = hasSel ? ` (שורות ${sel.start.line + 1}-${sel.end.line + 1})` : "";
		const lang = ed.document.languageId || "";
		const clipped = body.length > 6000 ? body.slice(0, 6000) + "\n… (קוצר)" : body;
		const text = `קונטקסט מהעורך — ${rel}${range}:\n\`\`\`${lang}\n${clipped}\n\`\`\``;
		const res = this.sendToFleet(agentId, text);
		if (res.ok) {
			this.appendFleetThread(agentId, { who: "me", text: "📎 " + rel + range, ts: Date.now() });
			this.postFleetActivity(agentId, "working", "קיבל קונטקסט: " + rel);
		}
		return { ok: res.ok, error: res.error, rel, range };
	}

	// Manually add an agent to the Fleet roster. A wsUrl makes it a live bridge
	// agent; without one it is a plain (file-drop) roster entry.
	async addFleetAgent(agent) {
		const id = String((agent && agent.id) || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
		if (!id) return { ok: false, error: "missing id" };
		const entry = {
			id,
			name: String(agent.name || id).trim(),
			role: String(agent.role || "Fleet agent").trim(),
			glyph: String(agent.glyph || "◆").trim().slice(0, 2) || "◆",
			model: String(agent.model || "").trim(),
		};
		const wsUrl = String(agent.wsUrl || "").trim();
		if (wsUrl) entry.wsUrl = wsUrl;
		if (agent.token) entry.token = String(agent.token).trim();
		const cfg = this.fleetCfg();
		const list = Array.isArray(cfg.get("bridges")) ? cfg.get("bridges").slice() : [];
		const i = list.findIndex((b) => b && String(b.id) === id);
		// bridges config only stores live-socket agents; file-drop agents need a wsUrl-less marker too
		if (i >= 0) list[i] = entry; else list.push(entry);
		await cfg.update("bridges", list, vscode.ConfigurationTarget.Global);
		// un-hide if it was previously removed
		const hidden = (Array.isArray(cfg.get("hidden")) ? cfg.get("hidden") : []).filter((h) => String(h) !== id);
		await cfg.update("hidden", hidden, vscode.ConfigurationTarget.Global);
		return { ok: true, id };
	}

	async removeFleetAgent(agentId) {
		const id = String(agentId || "").trim();
		if (!id) return { ok: false, error: "missing id" };
		const cfg = this.fleetCfg();
		const list = (Array.isArray(cfg.get("bridges")) ? cfg.get("bridges") : []).filter((b) => b && String(b.id) !== id);
		await cfg.update("bridges", list, vscode.ConfigurationTarget.Global);
		// built-in agents have no bridge entry; record them as hidden so they drop off the roster
		const hidden = new Set((Array.isArray(cfg.get("hidden")) ? cfg.get("hidden") : []).map(String));
		hidden.add(id);
		await cfg.update("hidden", Array.from(hidden), vscode.ConfigurationTarget.Global);
		const rec = this.fleetBridges.get(id);
		if (rec) { try { rec.ws.close(); } catch { } this.fleetBridges.delete(id); }
		return { ok: true, id };
	}

	sendToFleet(agentId, text) {
		const id = String(agentId || "").trim();
		const body = String(text || "").trim();
		if (!id || !body) return { ok: false, error: "empty" };

		// Preferred path: live WebSocket to the agent's brain.
		if (this.fleetBridgeConfigs().has(id)) {
			const ws = this.ensureFleetBridge(id);
			if (!ws) return { ok: false, error: "bridge not configured" };
			const reqId = "s" + Date.now().toString(36);
			const sendNow = () => ws.send({ type: "message", id: reqId, text: body });
			try {
				if (ws.connected) sendNow();
				else ws.once("frame", (f) => { if (f.type === "hello") { try { sendNow(); } catch { } } });
			} catch (e) { return { ok: false, error: e.message }; }
			return { ok: true, ts: Date.now(), live: true };
		}

		// Fallback: legacy file-drop inbox (same-filesystem only).
		const inbox = path.join(this.fleetDir(), id, "inbox");
		try { fs.mkdirSync(inbox, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
		const now = new Date();
		const stamp = now.toISOString().replace(/[:.]/g, "-");
		const job = {
			from: "solstice-ide",
			kind: "task",
			task_id: "solstice-" + Date.now().toString(36),
			title: body.split("\n")[0].slice(0, 80),
			body,
			created_at: now.toISOString(),
		};
		const file = path.join(inbox, stamp + "_solstice.json");
		try { fs.writeFileSync(file, JSON.stringify(job, null, 2)); } catch (e) { return { ok: false, error: e.message }; }
		return { ok: true, ts: now.getTime() };
	}

	// drain new reply files for an agent (file-drop fallback only); each is {agent, text, ts}
	scanFleetReplies(agentId) {
		const dir = path.join(this.fleetRepliesDir(), agentId);
		const done = path.join(dir, "seen");
		const out = [];
		let files;
		try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return out; }
		try { fs.mkdirSync(done, { recursive: true }); } catch { }
		for (const f of files) {
			const p = path.join(dir, f);
			let msg;
			try { msg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
			out.push({ text: String(msg.text || msg.body || ""), ts: msg.ts || Date.now() });
			try { fs.renameSync(p, path.join(done, Date.now() + "-" + f)); } catch { }
		}
		return out;
	}

	dispose() {
		for (const pending of this.pendingApprovals.values()) pending.resolve("abort");
		this.pendingApprovals.clear();
		clearTimeout(this.researchDebounce);
		if (this.researchPanel) this.researchPanel.dispose();
		if (this.galleryPanel) this.galleryPanel.dispose();
		this.stopAllDevServers("window-dispose");
		if (this.preview) this.preview.dispose();
		if (this.devServerToolBridge) this.devServerToolBridge.close();
		if (this.grokWatcher) this.grokWatcher.dispose();
		if (this.grok) this.grok.interrupt();
		if (this.claude) this.claude.interrupt();
		if (this.moonshot) this.moonshot.interrupt();
		if (this.client) this.client.stop();
		if (this.foundationClient) this.foundationClient.dispose();
		if (this.skillInstaller) this.skillInstaller.dispose();
		this.closeFleetBridges();
	}
}

// Preview panel HTML. Unlike mediaHtml, its CSP must allow an <iframe> to load
// the local preview server / dev server (http://127.0.0.1:*), so the agent's
// site/app renders live inside the device frame.
function previewHtml(webview, extensionUri) {
	const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
	const nonce = crypto.randomUUID().replace(/-/g, "");
	const frameSrc = "http://127.0.0.1:* http://localhost:* https:";
	return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; frame-src ${frameSrc};">
<link rel="stylesheet" href="${media("preview.css")}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("preview.js")}"></script>
</body>
</html>`;
}

function mediaHtml(webview, extensionUri, scriptFile, styleFile) {
	const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
	const nonce = crypto.randomUUID().replace(/-/g, "");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;">
<link rel="stylesheet" href="${media(styleFile)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("md.js")}"></script>
<script nonce="${nonce}" src="${media(scriptFile)}"></script>
</body>
</html>`;
}

class AgentViewProvider {
	constructor(controller, extensionUri) {
		this.controller = controller;
		this.extensionUri = extensionUri;
	}

	resolveWebviewView(view) {
		this.controller.webview = view.webview;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: webviewResourceRoots(this.extensionUri),
		};
		view.webview.html = mediaHtml(view.webview, this.extensionUri, "panel.js", "panel.css");
		view.webview.onDidReceiveMessage(async (msg) => {
			try {
				switch (msg.type) {
					case "ready":
						await this.controller.refreshAccount();
						this.controller.applyAutonomyToWebviews();
						this.controller.applyProviderToWebviews();
						break;
					case "send": await this.controller.send(await this.controller.withAttachments(msg.text, msg.attachments)); break;
						case "steer": await this.controller.steer(this.controller.threadId, await this.controller.withAttachments(msg.text, msg.attachments)); break;
					case "login": await this.controller.login(); break;
					case "approval": this.controller.resolveApproval(msg.key, msg.decision); break;
					case "interrupt": await this.controller.interrupt(); break;
					case "newThread": this.controller.newThread(); break;
					case "showDiff": await this.controller.showDiff(); break;
					case "selectModel": await this.controller.selectModel(); break;
					case "setModel": await this.controller.setModel(msg.key); break;
					case "selectAutonomy": await this.controller.selectAutonomy(); break;
					case "openImage": this.controller.openImage(msg.path); break;
					case "transcribe": await this.controller.transcribeVoice(msg.audio, msg.mime); break;
						case "buildMode": this.controller.setBuildMode(msg.mode); break;
						case "scaffoldApp": await this.controller.scaffoldAppIntoWorkspace(); break;
				}
			} catch (e) {
				this.controller.post({ type: "fatal", message: String(e && e.message || e) });
			}
		});
		view.onDidDispose(() => {
			if (this.controller.webview === view.webview) this.controller.webview = null;
		});
	}
}

let managerPanel = null;

function openManager(controller, extensionUri) {
	if (managerPanel) {
		managerPanel.reveal();
		return;
	}
	managerPanel = vscode.window.createWebviewPanel(
		"solstice.agentManager",
		"Agent Manager",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: webviewResourceRoots(extensionUri),
		}
	);
	controller.manager = managerPanel.webview;
	managerPanel.webview.html = mediaHtml(managerPanel.webview, extensionUri, "manager.js", "manager.css");
	managerPanel.webview.onDidReceiveMessage(async (msg) => {
		try {
			switch (msg.type) {
				case "ready":
					await controller.refreshAccount("manager");
					await controller.listThreads();
					controller.pushManagerTasks();
					controller.pushDevServerInventory();
					controller.pushArtifactPackages();
					break;
				case "createManagerTask": {
					const task = await controller.createManagerTask(msg.label || msg.prompt || "New build");
					if (msg.prompt) await controller.startTurn(task.threadId, msg.prompt);
					break;
				}
				case "listManagerTasks": controller.pushManagerTasks(); break;
				case "inspectManagerTask": await controller.inspectManagerTask(msg.taskId); break;
				case "reviewManagerTask": await controller.reviewManagerTask(msg.taskId); break;
				case "mergeManagerTask": await controller.mergeManagerTask(msg.taskId, msg.patchHash); break;
				case "openManagerTaskPreview": await controller.openManagerTaskPreview(msg.taskId); break;
				case "stopDevServer": controller.stopDevServerForAgent(msg.id); break;
				case "closeAllDevServers": controller.stopAllDevServers("manager-close-all"); break;
				case "listThreads": await controller.listThreads(); break;
				case "selectThread": await controller.readThread(msg.threadId); break;
				case "newThread": {
					const { id } = await controller.startThread();
					if (id) controller.postManager({ type: "threadCreated", threadId: id });
					break;
				}
				case "send": await controller.startTurn(msg.threadId, msg.text); break;
				case "steer": await controller.steer(msg.threadId, msg.text); break;
				case "interrupt": await controller.interrupt(msg.threadId); break;
				case "approval": controller.resolveApproval(msg.key, msg.decision); break;
				case "openDiff": await controller.showDiff(msg.threadId); break;
				case "openPreview": await controller.openPreview(""); break;
				case "openArtifactPackage": await controller.openArtifactPackage(msg.path); break;
				case "openArtifactFile": await controller.openArtifactPackage(msg.path, msg.file); break;
				case "archiveThread": await controller.archiveThread(msg.threadId); break;
				case "setModel": await controller.setModel(msg.key); break;
				case "selectModel": await controller.selectModel(); break;
				case "login": await controller.login(); break;
			}
		} catch (e) {
			controller.postManager({ type: "fatal", message: String(e && e.message || e) });
		}
	});
	managerPanel.onDidDispose(() => {
		if (controller.manager === managerPanel.webview) controller.manager = null;
		managerPanel = null;
	});
}

let skillsPanel = null;
function pushSkillsPanel(controller) {
	if (!skillsPanel) return;
	const skills = controller.skills ? controller.skills.list() : [];
	const lessons = controller.skills ? controller.skills.listLessons() : [];
	const learningDrafts = controller.learning ? controller.learning.listDrafts() : [];
	const map = (x, kind) => {
		const progress = kind === "skill" ? skillProgress(x.meta) : null;
		return {
			kind, name: x.meta.name || path.basename(x.file || ""), tags: x.meta.tags || [], uses: Number(x.meta.uses || 0),
			version: x.meta.version || 1, updatedAt: x.meta.updatedAt || "", preview: String(x.body || "").replace(/[#*_`]/g, "").trim().slice(0, 220),
			...(progress || {}),
		};
	};
	skillsPanel.webview.postMessage({
		type: "skills",
		items: [...skills.map((x) => map(x, "skill")), ...lessons.map((x) => map(x, "lesson"))],
		diagnostics: controller.skillRuntimeDiagnostics(),
		learning: { mode: LEARNING_MODE, drafts: learningDrafts },
	});
}
function openSkills(controller, extensionUri) {
	if (skillsPanel) { skillsPanel.reveal(vscode.ViewColumn.One); return; }
	skillsPanel = vscode.window.createWebviewPanel("solstice.skills", "🧠 Felix Skills", vscode.ViewColumn.One, {
		enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri),
	});
	skillsPanel.webview.html = mediaHtml(skillsPanel.webview, extensionUri, "skills.js", "skills.css");
	skillsPanel.webview.onDidReceiveMessage(async (m) => {
		if (m.type === "ready" || m.type === "refresh") { pushSkillsPanel(controller); return; }
		if (m.type === "approveLearning") {
			try {
				if (!controller.learning) throw new Error("Felix outcome learning is unavailable.");
				const draft = controller.learning.getDraft(String(m.id || ""));
				if (!draft || draft.status !== "DRAFT") throw new Error("Learning draft is missing or no longer pending.");
				const detail = `${draft.claim}\n\nDoes not apply:\n${draft.does_not_apply.map((item) => `• ${item}`).join("\n")}\n\nEvidence SHA: ${draft.success_signal.sha256}`;
				const accepted = await vscode.window.showWarningMessage(
					`Activate learning draft '${draft.title}'?`,
					{ modal: true, detail },
					"Approve and activate"
				);
				if (accepted !== "Approve and activate") return;
				const result = controller.learning.approve(draft.id, controller.skills, "Thomas · Solstice operator approval");
				skillsPanel.webview.postMessage({ type: "learningDecision", message: `${draft.title} אושר והופעל כ־v${result.activated.version}.` });
				pushSkillsPanel(controller);
			} catch (error) { skillsPanel.webview.postMessage({ type: "learningError", message: String(error && error.message || error) }); }
			return;
		}
		if (m.type === "rejectLearning") {
			try {
				if (!controller.learning) throw new Error("Felix outcome learning is unavailable.");
				const draft = controller.learning.getDraft(String(m.id || ""));
				if (!draft || draft.status !== "DRAFT") throw new Error("Learning draft is missing or no longer pending.");
				const accepted = await vscode.window.showWarningMessage(`Reject learning draft '${draft.title}'?`, { modal: true }, "Reject draft");
				if (accepted !== "Reject draft") return;
				controller.learning.reject(draft.id, "Rejected by Thomas in Solstice Skills");
				skillsPanel.webview.postMessage({ type: "learningDecision", message: `${draft.title} נדחה ולא יוזרק.` });
				pushSkillsPanel(controller);
			} catch (error) { skillsPanel.webview.postMessage({ type: "learningError", message: String(error && error.message || error) }); }
			return;
		}
		if (m.type === "exportDiagnostics") {
			try {
				const diagnostics = controller.skillRuntimeDiagnostics();
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const base = workspaceCwd() || controller.context.globalStorageUri.fsPath;
				const uri = await vscode.window.showSaveDialog({
					defaultUri: vscode.Uri.file(path.join(base, ".solstice", `felix-runtime-diagnostics-${stamp}.json`)),
					filters: { JSON: ["json"] },
					saveLabel: "Export diagnostics",
				});
				if (!uri) return;
				fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
				fs.writeFileSync(uri.fsPath, JSON.stringify(diagnostics, null, 2) + "\n", "utf8");
				skillsPanel.webview.postMessage({ type: "diagnosticsExported", path: uri.fsPath });
				vscode.window.showInformationMessage("Felix runtime diagnostics exported.", "Open file").then((choice) => {
					if (choice === "Open file") vscode.commands.executeCommand("vscode.open", uri);
				});
			} catch (error) {
				skillsPanel.webview.postMessage({ type: "diagnosticsError", message: String(error && error.message || error) });
			}
			return;
		}
		if (m.type === "repairScrollWorld") {
			try {
				if (!controller.skills) throw new Error("Felix Skills store is unavailable.");
				const accepted = await vscode.window.showWarningMessage(
					"Repair ScrollWorld from this installed Solstice bundle? The current runtime directory will be preserved as a backup.",
					{ modal: true }, "Repair ScrollWorld"
				);
				if (accepted !== "Repair ScrollWorld") return;
				const repaired = controller.skills.repairScrollWorld(controller.context.extensionPath);
				controller.skillsSeedResult = { ...(controller.skillsSeedResult || {}), scrollWorld: repaired };
				controller.skillsInitError = "";
				controller._skillsLastVisibleError = "";
				pushSkillsPanel(controller);
				skillsPanel.webview.postMessage({ type: "repairDone", backup: repaired.backup || "" });
				vscode.window.showInformationMessage("ScrollWorld runtime contract repaired and re-verified.");
			} catch (error) {
				controller.showSkillsError("ScrollWorld repair failed: " + String(error && error.message || error));
			}
			return;
		}
		if (!controller.skillInstaller) {
			skillsPanel.webview.postMessage({ type: "installError", message: "Skill installer is unavailable in this session." });
			return;
		}
		try {
			if (m.type === "previewInstall") {
				skillsPanel.webview.postMessage({ type: "installBusy", message: "Cloning and inspecting without running repository code…" });
				const preview = await controller.skillInstaller.preview(m.url, m.skillPath || "");
				skillsPanel.webview.postMessage({ type: preview.selectionRequired ? "skillSelection" : "installPreview", ...preview });
			} else if (m.type === "confirmInstall") {
				const preview = controller.skillInstaller.previews.get(String(m.id || ""));
				if (!preview) throw new Error("Install preview expired; preview the repository again.");
				const detail = `${preview.source.displayUrl}\ncommit ${preview.source.commit}\n${preview.files.length} files · ${preview.totalBytes} bytes\n\nDependencies are recorded only; no hooks or scripts will run.`;
				const accepted = await vscode.window.showWarningMessage(`Install Felix skill '${preview.name}'?`, { modal: true, detail }, "Install reviewed skill");
				if (accepted !== "Install reviewed skill") { skillsPanel.webview.postMessage({ type: "installCancelled" }); return; }
				skillsPanel.webview.postMessage({ type: "installBusy", message: "Installing atomically into Felix runtime storage…" });
				const result = await controller.skillInstaller.install(m.id);
				skillsPanel.webview.postMessage({ type: "installDone", ...result });
				pushSkillsPanel(controller);
			}
		} catch (error) {
			skillsPanel.webview.postMessage({ type: "installError", message: String(error && error.message || error) });
		}
	});
	skillsPanel.onDidDispose(() => { skillsPanel = null; });
}

let brandDnaPanel = null;
function brandDnaAttachedState(root) {
	if (!root) return null;
	try {
		const pack = loadBrandPack(root);
		if (!pack) return null;
		let approval = null;
		try { approval = JSON.parse(fs.readFileSync(path.join(root, BRAND_PACK_APPROVAL), "utf8")); } catch { }
		return {
			sha256: pack.sha256,
			bytes: pack.bytes,
			domain: pack.compact.domain,
			approved_at: approval && approval.sha256 === pack.sha256 ? approval.approved_at : "manual import · approval SHA unavailable",
		};
	} catch (error) {
		return { error: String(error && error.message || error) };
	}
}
function postBrandDnaState(state) {
	if (brandDnaPanel) brandDnaPanel.webview.postMessage({ type: "state", state });
}
function postBrandDnaError(error) {
	const request = error && error.requestId ? ` · request ${error.requestId}` : "";
	const statusCode = error && (error.statusCode || error.status);
	const status = statusCode ? `HTTP ${statusCode} · ` : "";
	const message = `${status}${String(error && error.message || error || "Brand-DNA request failed")}${request}`;
	if (brandDnaPanel) brandDnaPanel.webview.postMessage({ type: "error", message });
	vscode.window.showErrorMessage("Brand-DNA: " + message);
}
function openBrandDna(controller, extensionUri) {
	if (brandDnaPanel) { brandDnaPanel.reveal(vscode.ViewColumn.One); return; }
	brandDnaPanel = vscode.window.createWebviewPanel("solstice.brandDna", "◉ Brand‑DNA", vscode.ViewColumn.One, {
		enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri),
	});
	brandDnaPanel.webview.html = mediaHtml(brandDnaPanel.webview, extensionUri, "brand-dna.js", "brand-dna.css");
	let currentProfile = null;
	let health = null;
	const refreshHealth = async () => {
		health = await controller.brandDnaClient.health();
		postBrandDnaState({ health, attached: brandDnaAttachedState(workspaceCwd()) });
	};
	brandDnaPanel.webview.onDidReceiveMessage(async (message) => {
		try {
			if (message.type === "ready" || message.type === "health") { await refreshHealth(); return; }
			if (message.type === "extract") {
				if (!health || health.status !== "ok") await refreshHealth();
				currentProfile = await controller.brandDnaClient.extract(message.url, false);
				postBrandDnaState({ profile: currentProfile, domain: currentProfile.domain || "", url: currentProfile.source_url || message.url, moodboard: null, moodboardImage: "", notice: `Brand DNA חולץ מ־${currentProfile.domain}.` });
				return;
			}
			if (message.type === "recrawl") {
				const result = await controller.brandDnaClient.recrawl(message.domain);
				currentProfile = result && result.profile || await controller.brandDnaClient.profile(message.domain);
				postBrandDnaState({ profile: currentProfile, notice: `החילוץ עודכן: ${result.status || "refreshed"}.` });
				return;
			}
			if (message.type === "moodboard") {
				const moodboard = await controller.brandDnaClient.moodboard(message.domain);
				const moodboardImage = moodboard.passed ? await controller.brandDnaClient.moodboardPng(message.domain) : "";
				postBrandDnaState({ moodboard, moodboardImage, notice: moodboard.passed ? "Moodboard מאושר נטען מהמנוע." : "Moodboard לא עבר critic gate." });
				return;
			}
			if (message.type === "visualBrief") {
				const visualBrief = await controller.brandDnaClient.visualBrief(message.clientSlug);
				postBrandDnaState({ visualBrief, clientSlug: message.clientSlug, notice: `Visual Brief נטען עם ${visualBrief.evidence_count || 0} אותות.` });
				return;
			}
			if (message.type === "attach") {
				if (!currentProfile) throw new Error("Extract or load a BrandDNA profile before attaching it");
				const root = workspaceCwd();
				if (!root) throw new Error("Open a project before attaching Brand DNA");
				const existing = brandDnaAttachedState(root);
				const detail = `${currentProfile.domain || "unknown domain"}\n${currentProfile.source_url || ""}${existing ? `\n\nExisting project SHA: ${existing.sha256}` : ""}`;
				const accepted = await vscode.window.showWarningMessage(
					"Attach this approved Brand DNA snapshot as the project's source of truth?",
					{ modal: true, detail },
					"Attach approved DNA"
				);
				if (accepted !== "Attach approved DNA") { brandDnaPanel.webview.postMessage({ type: "notice", message: "הצירוף בוטל; לא נכתב דבר." }); return; }
				const installed = installBrandDnaDocument(root, currentProfile, { serviceVersion: health && health.version, sourceUrl: currentProfile.source_url });
				postBrandDnaState({ attached: { ...installed.approval }, notice: `DNA מאושר צורף לפרויקט · SHA ${installed.sha256.slice(0, 12)}.` });
				vscode.window.showInformationMessage(`Brand DNA attached: ${installed.compact.name || installed.compact.domain} · ${installed.sha256.slice(0, 12)}`);
				return;
			}
		} catch (error) { postBrandDnaError(error); }
	});
	brandDnaPanel.onDidDispose(() => { brandDnaPanel = null; });
}

let foundationPanel = null;
function postFoundationError(error) {
	const statusCode = error && (error.statusCode || error.status);
	const status = statusCode ? `HTTP ${statusCode} · ` : "";
	const message = `${status}${String(error && error.message || error || "Foundation request failed")}`;
	if (foundationPanel) foundationPanel.webview.postMessage({ type: "error", message });
	vscode.window.showErrorMessage("Foundation: " + message);
}
function openFoundation(controller, extensionUri) {
	if (foundationPanel) { foundationPanel.reveal(vscode.ViewColumn.One); return; }
	foundationPanel = vscode.window.createWebviewPanel("solstice.foundation", "Foundation", vscode.ViewColumn.One, {
		enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri),
	});
	foundationPanel.webview.html = mediaHtml(foundationPanel.webview, extensionUri, "foundation.js", "foundation.css");
	const boardClient = controller.foundationClient || new FoundationClient({
		endpoint: process.env.SOLSTICE_FOUNDATION_API_URL || controller.cfg().get("foundationApiUrl") || undefined,
		storageDir: path.join(controller.context.globalStorageUri.fsPath, "foundation-board"),
		businessFile: path.join(controller.context.globalStorageUri.fsPath, "foundation-board.json"),
	});
	let activeSlug = null;
	let activeDetail = null;
	let detailCursor = new Date(Date.now() - 1000).toISOString();
	const refresh = async () => {
		const board = await boardClient.listBusinesses();
		foundationPanel.webview.postMessage({
			type: "state",
			state: {
				board,
				endpoint: foundationBusinessesUrl(boardClient.endpoint),
				connectedAt: new Date().toISOString(),
			},
		});
	};
	const showBusiness = async (slug, silent = false) => {
		activeSlug = String(slug || "");
		if (!silent) foundationPanel.webview.postMessage({ type: "detailBusy", slug: activeSlug });
		const detail = await boardClient.getBusinessDetail(slug);
		activeDetail = detail;
		foundationPanel.webview.postMessage({
			type: "detail",
			detail,
			connectedAt: new Date().toISOString(),
		});
	};
	const detailPoll = setInterval(async () => {
		if (!foundationPanel || !activeSlug || !activeDetail || !activeDetail.business) return;
		try {
			const response = await boardClient.pollEvents(detailCursor);
			if (response.cursor) detailCursor = String(response.cursor);
			const changed = Array.isArray(response.events) && response.events.some((event) =>
				String(event.business_id || "") === String(activeDetail.business.id || "")
				&& String(event.event_type || "").startsWith("foundation.canvas."),
			);
			if (changed) await showBusiness(activeSlug, true);
		} catch { /* offline poll retries; the last canonical revision stays visible */ }
	}, 2500);
	if (detailPoll.unref) detailPoll.unref();
	foundationPanel.webview.onDidReceiveMessage(async (message) => {
		try {
			if (message.type === "ready" || message.type === "refresh") await refresh();
			else if (message.type === "show_business") await showBusiness(message.slug);
			else if (message.type === "add_canvas_node") {
				if (!activeDetail || !activeDetail.canvas) throw new Error("Open a Foundation business before adding a canvas node.");
				const title = String(message.title || "").trim();
				if (!title || title.length > 600) throw new Error("Canvas node title is invalid.");
				const current = activeDetail.canvas.snapshot || {
					version: 4, slug: activeSlug, nodes: [], edges: [], savedAt: new Date().toISOString(),
				};
				const id = crypto.randomUUID();
				const node = {
					id, type: "Solstice · note", title, meta: "origin:solstice", ftype: "note",
					note: title, x: 80 + (current.nodes.length % 3) * 380,
					y: 80 + Math.floor(current.nodes.length / 3) * 340,
				};
				const anchor = current.nodes[0];
				const snapshot = {
					...current,
					version: 4,
					nodes: [...current.nodes, node],
					edges: anchor ? [...current.edges, { from: anchor.id, to: id }] : current.edges,
					savedAt: new Date().toISOString(),
				};
				await boardClient.saveCanvas(activeSlug, snapshot, activeDetail.canvas.revision);
				await showBusiness(activeSlug, true);
			}
			else if (message.type === "open_surface") {
				const target = new URL(String(message.href || ""), boardClient.endpoint);
				if (!/^https?:$/.test(target.protocol)) throw new Error("Foundation surface URL must use HTTP(S).");
				await vscode.env.openExternal(vscode.Uri.parse(target.toString()));
			}
		} catch (error) { postFoundationError(error); }
	});
	foundationPanel.onDidDispose(() => { clearInterval(detailPoll); foundationPanel = null; });
}

let galleryPanel = null;

// Fetch a URL with the host's Node http(s) stack (webview CSP blocks remote
// fetch/img, so listing + previews are pulled here and handed to the webview).
function httpGet(url, { binary = false, timeout = 8000 } = {}) {
	return new Promise((resolve, reject) => {
		let mod;
		try { mod = require(url.startsWith("https:") ? "https" : "http"); } catch (e) { reject(e); return; }
		const req = mod.get(url, (res) => {
			if (res.statusCode && res.statusCode >= 400) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				resolve(binary ? { buf, contentType: res.headers["content-type"] || "" } : buf.toString("utf8"));
			});
		});
		req.on("error", reject);
		req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
	});
}

// Pull the project list from the remote gallery server and inline each preview
// as a data URI so the webview can render it under its strict CSP.
async function fetchServerProjects(serverUrl) {
	const base = serverUrl.replace(/\/+$/, "");
	const list = JSON.parse(await httpGet(`${base}/api/projects`));
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const p of list) {
		let preview = null;
		if (p.hasPreview) {
			try {
				const { buf, contentType } = await httpGet(`${base}/preview/${encodeURIComponent(p.slug)}`, { binary: true });
				if (buf.length <= 4 * 1024 * 1024) preview = `data:${contentType || "image/png"};base64,${buf.toString("base64")}`;
			} catch { /* preview optional */ }
		}
		out.push({
			name: p.name, description: p.description || "", tags: p.tags || [],
			updatedAt: p.updatedAt, preview, remote: true, slug: p.slug,
			openUrl: `${base}/p/${encodeURIComponent(p.slug)}/`,
			zipUrl: `${base}/zip/${encodeURIComponent(p.slug)}`,
		});
	}
	return out;
}

// Pick (or create) a client folder, then hand the project off into it.
async function handoffProjectToClient(controller, project) {
	if (!project) return;
	const clients = controller.listAtriumClients();
	const NEW = "➕ לקוח חדש…";
	const items = [...clients.map((c) => ({ label: c })), { label: NEW }];
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: "מסור את \"" + (project.name || "הפרויקט") + "\" לתיקיית לקוח ב-Atrium",
	});
	if (!pick) return;
	let client = pick.label;
	if (client === NEW) {
		client = (await vscode.window.showInputBox({ prompt: "שם הלקוח החדש (תיקייה ב-Atrium)", validateInput: (v) => v && v.trim() ? null : "נדרש שם" })) || "";
		client = client.trim();
		if (!client) return;
	}
	try {
		const { dest, copied, manifest } = controller.handoffToClient(project, client);
		openAtriumHandoffPanel(controller, { manifest, dest, copied, atriumUrl: controller.atriumClientUrl(client) });
	} catch (e) {
		vscode.window.showErrorMessage("מסירה נכשלה: " + String(e && e.message || e));
	}
}

// Visual confirmation of a Solstice → Atrium client handoff: the Build → Atrium →
// Client flow, the written manifest contract, and quick actions.
let atriumHandoffPanel = null;
function openAtriumHandoffPanel(controller, result) {
	if (!atriumHandoffPanel) {
		atriumHandoffPanel = vscode.window.createWebviewPanel(
			"solstice.atrium", "🗂 מסירה ל-Atrium",
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true,
			  localResourceRoots: [vscode.Uri.joinPath(controller.context.extensionUri, "media")] }
		);
		atriumHandoffPanel.webview.html = mediaHtml(atriumHandoffPanel.webview, controller.context.extensionUri, "atrium.js", "atrium.css");
		atriumHandoffPanel.webview.onDidReceiveMessage((m) => {
			if (m.type === "ready") atriumHandoffPanel.webview.postMessage({ type: "handoff", ...result });
			else if (m.type === "openFolder" && m.path) vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(m.path)).then(undefined, () => { });
			else if (m.type === "openAtrium" && m.url) vscode.env.openExternal(vscode.Uri.parse(m.url)).then(undefined, () => { });
		});
		atriumHandoffPanel.onDidDispose(() => { atriumHandoffPanel = null; });
	} else {
		atriumHandoffPanel.reveal(vscode.ViewColumn.One);
	}
	atriumHandoffPanel.webview.postMessage({ type: "handoff", ...result });
}

// Pull a server-built (remote) project down to a folder on Thomas's PC as a
// .zip. Local projects already live on disk, so for those we just reveal the
// folder. Remote ones are fetched from the gallery server's /zip endpoint.
async function downloadProjectToPC(controller, project) {
	if (!project) return;
	const name = String(project.name || project.slug || "project").replace(/[^\w.-]+/g, "-");
	if (!project.remote) {
		if (project.dir) vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(project.dir)).then(undefined, () => { });
		else vscode.window.showWarningMessage("אין נתיב מקומי לפרויקט.");
		return;
	}
	if (!project.zipUrl) { vscode.window.showErrorMessage("אין קישור הורדה לפרויקט המרוחק."); return; }
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(path.join(os.homedir(), name + ".zip")),
		filters: { "Zip archive": ["zip"] },
		saveLabel: "הורד ל-PC",
	});
	if (!target) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "מוריד את " + name + " ל-PC…" },
		async () => {
			try {
				const { buf } = await httpGet(project.zipUrl, { binary: true, timeout: 60000 });
				fs.writeFileSync(target.fsPath, buf);
				const reveal = "פתח בתיקייה";
				const choice = await vscode.window.showInformationMessage(
					"הורד: " + target.fsPath + "  (" + Math.max(1, Math.round(buf.length / 1024)) + "KB)", reveal);
				if (choice === reveal) vscode.commands.executeCommand("revealFileInOS", target).then(undefined, () => { });
			} catch (e) {
				vscode.window.showErrorMessage("הורדה נכשלה: " + String(e && e.message || e));
			}
		}
	);
}

// Extract a .zip to a destination dir using the host OS unzip (no extra deps):
// PowerShell Expand-Archive on Windows, `unzip` elsewhere. Resolves false on failure.
function extractZip(zipPath, destDir) {
	const cp = require("child_process");
	return new Promise((resolve) => {
		try { fs.mkdirSync(destDir, { recursive: true }); } catch { }
		const done = (err) => resolve(!err);
		if (process.platform === "win32") {
			cp.execFile("powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command",
					`Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`],
				{ windowsHide: true }, done);
		} else {
			cp.execFile("unzip", ["-o", zipPath, "-d", destDir], (err) => {
				if (!err) return done(null);
				cp.execFile("ditto", ["-x", "-k", zipPath, destDir], done); // macOS fallback
			});
		}
	});
}

// "Continue working" on a server-built project: pull the zip down, extract it to
// a folder on the PC, and open that folder in a NEW Solstice window so the user
// can keep editing it locally. Falls back to saving the raw zip if unzip fails.
async function continueWorkingOnRemote(controller, project) {
	if (!project || !project.remote) {
		if (project && project.dir) controller.openProjectFolder(project.dir, true);
		return;
	}
	if (!project.zipUrl) { vscode.window.showErrorMessage("אין קישור הורדה לפרויקט המרוחק."); return; }
	const slug = String(project.slug || project.name || "project").replace(/[^\w.-]+/g, "-");
	const baseDir = path.join(os.homedir(), "Solstice Projects");
	let dest = path.join(baseDir, slug);
	try { let i = 2; while (fs.existsSync(dest)) { dest = path.join(baseDir, `${slug}-${i++}`); } } catch { }
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "מוריד את " + slug + " ל-PC…" },
		async () => {
			let zipPath;
			try {
				const { buf } = await httpGet(project.zipUrl, { binary: true, timeout: 120000 });
				zipPath = path.join(os.tmpdir(), slug + "-" + Date.now() + ".zip");
				fs.writeFileSync(zipPath, buf);
			} catch (e) {
				vscode.window.showErrorMessage("הורדה נכשלה: " + String(e && e.message || e));
				return;
			}
			const ok = await extractZip(zipPath, dest);
			try { fs.unlinkSync(zipPath); } catch { }
			if (!ok) {
				const keep = path.join(baseDir, slug + ".zip");
				try { fs.mkdirSync(baseDir, { recursive: true }); fs.copyFileSync(zipPath, keep); } catch { }
				vscode.window.showWarningMessage("חילוץ ה-zip נכשל — נסה לפתוח אותו ידנית: " + keep);
				return;
			}
			// some zips wrap everything in a single top folder — open that if so
			let openDir = dest;
			try {
				const entries = fs.readdirSync(dest).filter((n) => !n.startsWith("."));
				if (entries.length === 1 && fs.statSync(path.join(dest, entries[0])).isDirectory())
					openDir = path.join(dest, entries[0]);
			} catch { }
			controller.openProjectFolder(openDir, true);
		}
	);
}

function openGallery(controller, extensionUri) {
	if (galleryPanel) { galleryPanel.reveal(vscode.ViewColumn.One); return; }
	const roots = controller.galleryRoots().map((d) => vscode.Uri.file(d));
	galleryPanel = vscode.window.createWebviewPanel(
		"solstice.gallery",
		"Projects",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media"), ...roots],
		}
	);
	controller.galleryPanel = galleryPanel;
	const roster = () => controller.fleetAgents().map((a) => ({ id: a.id, name: a.name, glyph: a.glyph }));
	const pushProjects = async () => {
		galleryPanel.webview.postMessage({ type: "agents", agents: roster() });
		const serverUrl = (controller.cfg().get("galleryServerUrl") || "").trim();
		if (serverUrl) {
			try {
				const projects = await fetchServerProjects(serverUrl);
				for (const p of projects) if (p && p.dir) p.agent = controller.projectAgent(p.dir);
				galleryPanel.webview.postMessage({ type: "projects", projects });
				return;
			} catch (e) {
				// Server unreachable — fall back to local scan so the panel still works.
				galleryPanel.webview.postMessage({ type: "serverError", message: String(e && e.message || e) });
			}
		}
		galleryPanel.webview.postMessage({ type: "projects", projects: controller.scanProjects(galleryPanel.webview) });
	};
	galleryPanel.webview.html = mediaHtml(galleryPanel.webview, extensionUri, "gallery.js", "gallery.css");
	galleryPanel.webview.onDidReceiveMessage((msg) => {
		switch (msg.type) {
			case "ready": pushProjects(); break;
			case "refresh": pushProjects(); break;
			case "openProject": controller.openProjectFolder(msg.dir, msg.newWindow); break;
			case "openRemote":
				if (msg.url) vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(msg.url),
					{ viewColumn: vscode.ViewColumn.Two }).then(undefined, () => vscode.commands.executeCommand("simpleBrowser.show", msg.url));
				break;
			// open the actual website in the user's real desktop browser (not embedded)
			case "openSiteExternal":
				if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url)).then(undefined, () =>
					vscode.commands.executeCommand("simpleBrowser.show", msg.url));
				else vscode.window.showWarningMessage("אין כתובת אתר חי לפרויקט הזה — בנה/פרוס אותו קודם.");
				break;
			case "deployProject": controller.deployCurrentProject(msg.dir).then(() => pushProjects()); break;
			// bring a server-built project down to the PC and open it in a fresh
			// Solstice window so the user can keep working on it locally.
			case "continueWorking": continueWorkingOnRemote(controller, msg.project); break;
			case "newProject": vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { }); break;
			case "openConnectors": openConnectors(controller, extensionUri); break;
			case "assignAgent":
				controller.setProjectAgent(msg.dir, msg.agent);
				pushProjects();
				break;
			case "openInFleet": {
				openFleet(controller, extensionUri);
				if (controller.fleetPanel) {
					controller.fleetPanel.reveal(vscode.ViewColumn.One);
					controller.fleetPanel.webview.postMessage({ type: "focusAgent", agent: msg.agent });
					if (msg.dir) {
						const name = String(msg.dir).split(/[\\/]/).pop();
						controller.fleetPanel.webview.postMessage({ type: "reply", agent: msg.agent, kind: "progress", text: "📂 פרויקט פעיל: " + name, ts: Date.now() });
					}
				}
				break;
			}
			case "handoffClient": handoffProjectToClient(controller, msg.project); break;
			case "downloadProject": downloadProjectToPC(controller, msg.project); break;
		}
	});
	galleryPanel.onDidDispose(() => {
		if (controller.galleryPanel === galleryPanel) controller.galleryPanel = null;
		galleryPanel = null;
	});
}

let connectorsPanel = null;

// Provider-agnostic connector catalog. On-demand link-auth flow (Phase 4):
// when a connection is needed, Solstice opens the provider's auth/token page,
// Thomas logs in and approves online (proving it's him), pastes the credential
// into a secure input, and it lands in the OS-keychain vault (context.secrets) —
// never in config, globalState, or the model's context. Add a provider by
// appending one row here; no hard-wiring of any single service.
// The phone Companion PWA — served by the in-extension companion server. A mobile
// app to drive Felix and watch the build live: chat, status, plan, live files.
function companionHtml() {
	return [
		'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
		'<title>Felix · Solstice</title><style>',
		'*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
		'body{margin:0;font-family:Heebo,system-ui,sans-serif;background:#08090d;color:#e6e6ea;display:flex;flex-direction:column;height:100vh}',
		'#hd{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #161b22}',
		'.fx{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#c9a7ff,#7c4dff 60%,#4a2a9e);box-shadow:0 0 16px rgba(124,77,255,.55);flex:0 0 auto}',
		'.nm{font-weight:800;font-size:15px}.sub{font-size:10px;display:flex;align-items:center;gap:5px;margin-top:2px}',
		'.dot{width:7px;height:7px;border-radius:50%}.dot.busy{background:#f59e0b;animation:pl 1.2s infinite}.dot.idle{background:#3fb950}',
		'@keyframes pl{50%{opacity:.4}}',
		'#preview{display:none;width:100%;height:160px;border:0;border-bottom:1px solid #161b22;background:#0d0f14}',
		'#live{display:none;margin:8px 14px 0;padding:9px 12px;border:1px solid #2e7d55;border-radius:12px;color:#8ce8b4;text-decoration:none;font-size:12px;font-weight:800;background:#102219}',
		'#tasks{display:none;padding:8px 14px 0;gap:7px;overflow-x:auto}.task{min-width:210px;border:1px solid #282d38;border-radius:12px;background:#0d1016;padding:9px 10px}.tt{display:flex;align-items:center;gap:7px}.tn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:800}.ts{font-size:9px;color:#8792a2}.tp{font-size:10px;color:#8792a2;margin-top:5px}.td{width:7px;height:7px;border-radius:50%;background:#3fb950}.td.run{background:#f59e0b;animation:pl 1.2s infinite}.tstop{margin-top:7px;border:1px solid #713239;border-radius:8px;background:#251216;color:#ff8f98;padding:4px 10px;font-weight:700}',
		'#plan{display:none;margin:8px 14px 0;padding:10px 12px;border:1px solid #282d38;border-radius:12px;background:#0d1016;font-size:12px}.pl{display:flex;gap:7px;padding:3px 0;color:#8792a2}.pl.run{color:#f5b84b}.pl.done{color:#6ee7a8}',
		'#chat{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:9px}',
		'.msg{display:flex}.msg.user{justify-content:flex-end}.b{max-width:82%;padding:8px 11px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
		'.msg.user .b{background:linear-gradient(135deg,#0ea5e9,#22d3ee);color:#06121a;border-bottom-left-radius:4px}',
		'.msg.agent .b{background:#12151c;border:1px solid #1d2330;border-bottom-right-radius:4px}',
		'#files{padding:0 14px 6px;font:11px ui-monospace,monospace;color:#7a8696}.f{padding:2px 0}',
		'#cmp{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #161b22}',
		'#inp{flex:1;background:#0d0f14;border:1px solid #1c212b;border-radius:14px;padding:10px 12px;color:#e6e6ea;font-size:14px;outline:none}',
		'#snd{border:0;border-radius:14px;padding:0 16px;font-weight:800;background:linear-gradient(135deg,#0ea5e9,#22d3ee);color:#06121a}',
		'</style></head><body>',
		'<div id="hd"><div class="fx"></div><div><div class="nm">Felix <span style="color:#5b6573;font-size:11px">· Solstice</span></div>',
		'<div class="sub"><span id="statusdot" class="dot idle"></span><span id="status">מוכן</span><span style="color:#5b6573">· <span id="model"></span></span></div></div></div>',
		'<a id="live" target="_blank" rel="noopener">▲ פתח אתר חי</a><div id="tasks"></div><div id="plan"></div><iframe id="preview"></iframe>',
		'<div id="chat"></div><div id="files"></div>',
		'<div id="cmp"><input id="inp" placeholder="שלח ל-Felix משימה או שינוי…" enterkeyhint="send"><button id="snd">שלח</button></div>',
		'<script>',
		'function esc(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")}',
		'function render(s){',
		'document.getElementById("model").textContent=s.model||"";',
		'document.getElementById("status").textContent=s.building?"פליקס בונה…":"מוכן";',
		'document.getElementById("statusdot").className="dot "+(s.building?"busy":"idle");',
		'var l=document.getElementById("live");if(s.liveUrl){l.style.display="block";l.href=s.liveUrl;l.textContent="▲ פתח אתר חי · "+s.liveUrl.replace(/^https?:\\/\\//,"")}else{l.style.display="none"}',
		'var ts=document.getElementById("tasks"),mt=s.managerTasks||[];ts.style.display=mt.length?"flex":"none";ts.innerHTML=mt.map(function(t){var run=t.status==="running"||t.status==="awaiting_approval";return "<div class=\\"task\\"><div class=\\"tt\\"><span class=\\"td "+(run?"run":"")+"\\"></span><span class=\\"tn\\">"+esc(t.label||t.id)+"</span><span class=\\"ts\\">"+esc(t.status)+"</span></div><div class=\\"tp\\">"+esc(t.phase||"workspace")+" · "+(t.changedFiles||0)+" קבצים</div>"+(run?"<button class=\\"tstop\\" data-id=\\""+esc(t.id)+"\\">עצור</button>":"")+"</div>"}).join("");Array.prototype.forEach.call(document.querySelectorAll(".tstop"),function(b){b.onclick=function(){fetch("/manager/stop",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:b.dataset.id})}).then(poll)}});',
		'var q=document.getElementById("plan"),ps=s.plan||[];q.style.display=ps.length?"block":"none";q.innerHTML=ps.map(function(x){var z=x.status==="completed"?"done":x.status==="inProgress"?"run":"";var m=z==="done"?"✓":z==="run"?"▸":"·";return "<div class=\\"pl "+z+"\\"><span>"+m+"</span><span>"+esc(x.step)+"</span></div>"}).join("");',
		'var p=document.getElementById("preview");if(s.previewUrl){p.style.display="block";var b=(s.previewUrl);if((p.dataset.u||"")!==b){p.dataset.u=b;p.src=b}}',
		'var c=document.getElementById("chat");c.innerHTML=(s.messages||[]).map(function(m){return "<div class=\\"msg "+m.role+"\\"><div class=\\"b\\">"+esc(m.text)+"</div></div>"}).join("");c.scrollTop=c.scrollHeight;',
		'document.getElementById("files").innerHTML=(s.files||[]).slice(0,8).map(function(f){return "<div class=\\"f\\">+ "+esc(f.path)+"</div>"}).join("");',
		'}',
		'function poll(){fetch("/state").then(function(r){return r.json()}).then(render).catch(function(){})}',
		'setInterval(poll,1500);poll();',
		'function send(){var i=document.getElementById("inp");var t=i.value.trim();if(!t)return;i.value="";fetch("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:t})}).then(poll)}',
		'document.getElementById("snd").onclick=send;document.getElementById("inp").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();send()}});',
		'</script></body></html>',
	].join("");
}

const CONNECTOR_CATALOG = [
	{ id: "vercel", name: "Vercel", glyph: "▲", blurb: "פריסת אתרים ואפליקציות בלחיצה", tokenKey: "VERCEL_TOKEN", authUrl: "https://vercel.com/account/tokens", howto: "צור Token חדש (Scope: Full Account) והדבק כאן." },
	{ id: "github", name: "GitHub", glyph: "❮❯", blurb: "דחיפת קוד הפרויקט לריפו", tokenKey: "GITHUB_TOKEN", authUrl: "https://github.com/settings/tokens/new?scopes=repo&description=Solstice", howto: "צור Personal Access Token עם הרשאת repo והדבק כאן." },
	{ id: "email", name: "Email (Resend)", glyph: "✉", blurb: "שליחת מיילים מפרויקטים", tokenKey: "EMAIL_API_KEY", authUrl: "https://resend.com/api-keys", howto: "צור API Key ב-Resend והדבק כאן." },
	{ id: "mercury", name: "Mercury Commerce", glyph: "🛒", blurb: "חיבור החנות למנוע המסחר — מוצרים, עגלה, checkout, אנליטיקס (headless)", tokenKey: "MERCURY_STORE", authUrl: "", howto: "הדבק את כתובת ה-API של Mercury ו-store_id מופרדים ב-| —\nלמשל: https://your-mercury-host|str_2eaf73ebc03b27db" },
];

// Async: presence of a credential is checked in the vault first (never logged),
// then legacy env/config for back-compat. "requested" = an agent asked Thomas to
// connect and we're waiting for the paste to complete.
async function connectorState(controller) {
	const req = controller.context.globalState.get("solstice.fleet.connectorsRequested") || {};
	const out = [];
	for (const c of CONNECTOR_CATALOG) {
		const hasToken = await controller.connectorConnected(c.id);
		out.push({ id: c.id, name: c.name, glyph: c.glyph, blurb: c.blurb, tokenKey: c.tokenKey, authUrl: c.authUrl, status: hasToken ? "connected" : (req[c.id] ? "requested" : "disconnected") });
	}
	return out;
}

function openConnectors(controller, extensionUri) {
	if (connectorsPanel) { connectorsPanel.reveal(vscode.ViewColumn.One); return; }
	connectorsPanel = vscode.window.createWebviewPanel(
		"solstice.connectors",
		"Connectors",
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri) }
	);
	connectorsPanel.webview.html = mediaHtml(connectorsPanel.webview, extensionUri, "connectors.js", "connectors.css");
	const push = async () => { if (connectorsPanel) connectorsPanel.webview.postMessage({ type: "connectors", connectors: await connectorState(controller) }); };
	controller._pushConnectors = push;
	connectorsPanel.webview.onDidReceiveMessage(async (msg) => {
		switch (msg.type) {
			case "ready": push(); break;
			case "connect": await controller.connectProvider(msg.id); push(); break;
			case "disconnect": await controller.disconnectProvider(msg.id); push(); break;
		}
	});
	connectorsPanel.onDidDispose(() => { connectorsPanel = null; controller._pushConnectors = null; });
}

let workflowPanel = null;

function openWorkflow(controller, extensionUri) {
	if (workflowPanel) { workflowPanel.reveal(vscode.ViewColumn.One); return; }
	workflowPanel = vscode.window.createWebviewPanel(
		"solstice.workflow",
		"How Solstice works",
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri) }
	);
	workflowPanel.webview.html = mediaHtml(workflowPanel.webview, extensionUri, "workflow.js", "workflow.css");
	const push = () => {
		const agents = controller.fleetAgents().map((a) => ({ id: a.id, name: a.name, glyph: a.glyph, model: a.model || "" }));
		workflowPanel.webview.postMessage({ type: "model", provider: controller.providerLabel(), version: controller.versionLabel(), agents });
	};
	workflowPanel.webview.onDidReceiveMessage((msg) => { if (msg.type === "ready") push(); });
	workflowPanel.onDidDispose(() => { workflowPanel = null; });
}

let fleetPanel = null;

function openFleet(controller, extensionUri) {
	if (fleetPanel) { fleetPanel.reveal(vscode.ViewColumn.One); return; }
	fleetPanel = vscode.window.createWebviewPanel(
		"solstice.fleet",
		"Fleet",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
		}
	);
	controller.fleetPanel = fleetPanel;
	fleetPanel.webview.html = mediaHtml(fleetPanel.webview, extensionUri, "fleet.js", "fleet.css");
	let pollTimer = null;
	const poll = () => {
		// WS bridges push replies live; only file-drop agents need polling.
		for (const a of controller.fleetAgents()) {
			if (a.bridge) continue;
			const replies = controller.scanFleetReplies(a.id);
			for (const r of replies) fleetPanel.webview.postMessage({ type: "reply", agent: a.id, text: r.text, ts: r.ts });
		}
	};
	fleetPanel.webview.onDidReceiveMessage((msg) => {
		switch (msg.type) {
			case "ready":
				fleetPanel.webview.postMessage({ type: "version", text: controller.versionLabel(), tip: controller.versionTooltip() });
				fleetPanel.webview.postMessage({ type: "roster", agents: controller.fleetAgents() });
				fleetPanel.webview.postMessage({ type: "history", threads: controller.loadFleetThreads() });
				// warm every live bridge so the roster reflects real online state, not a guess
				for (const a of controller.fleetAgents()) {
					if (controller.fleetBridgeConfigs().has(a.id)) controller.ensureFleetBridge(a.id);
				}
				if (!pollTimer) pollTimer = setInterval(poll, 2000);
				break;
			case "select":
				// warm the socket as soon as the user opens an agent's thread
				controller.activeFleetAgent = msg.agent;
				if (controller.fleetBridgeConfigs().has(msg.agent)) controller.ensureFleetBridge(msg.agent);
				break;
			case "resumeAgent":
				controller.resumeBuilder();
				break;
			case "send": {
				controller.appendFleetThread(msg.agent, { who: "me", text: msg.text, ts: Date.now() });
				const res = controller.sendToFleet(msg.agent, msg.text);
				if (res.live) controller.postFleetActivity(msg.agent, "working", "חושב…");
				fleetPanel.webview.postMessage({ type: "sent", agent: msg.agent, ok: res.ok, ts: res.ts, error: res.error, live: res.live });
				break;
			}
			case "clearThread":
				controller.clearFleetThread(msg.agent);
				break;
			case "approval":
				controller.resolveFleetApproval(msg.key, msg.decision);
				break;
			case "sendContext": {
				const res = controller.sendEditorContext(msg.agent);
				fleetPanel.webview.postMessage({ type: "contextSent", agent: msg.agent, ok: res.ok, error: res.error, rel: res.rel, range: res.range });
				break;
			}
			case "addAgent":
				controller.addFleetAgent(msg.agent || {}).then((res) => {
					fleetPanel.webview.postMessage({ type: "rosterUpdate", agents: controller.fleetAgents(), select: res.ok ? res.id : null, error: res.error });
				});
				break;
			case "removeAgent":
				controller.removeFleetAgent(msg.id).then(() => {
					fleetPanel.webview.postMessage({ type: "rosterUpdate", agents: controller.fleetAgents() });
				});
				break;
			case "openAgentPanel":
				vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
				break;
			case "clearStuck":
				controller.watch.delete(msg.agent);
				break;
		}
	});
	fleetPanel.onDidDispose(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (controller.fleetPanel === fleetPanel) controller.fleetPanel = null;
		fleetPanel = null;
	});
}

function activate(context) {
	const controller = new AgentController(context);
	context.subscriptions.push(controller);
	const provider = new AgentViewProvider(controller, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("solstice.agentPanel", provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("solstice.agent.newThread", () => controller.newThread()),
		vscode.commands.registerCommand("solstice.agent.showDiff", () => controller.showDiff()),
		vscode.commands.registerCommand("solstice.agent.signOut", () => controller.signOut()),
		vscode.commands.registerCommand("solstice.agent.openManager", () => openManager(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openPreview", (url) => controller.openPreview(typeof url === "string" ? url : "")),
		vscode.commands.registerCommand("solstice.agent.closeAllDevServers", () => {
			const result = controller.stopAllDevServers("command-close-all");
			if (!result.ok) vscode.window.showErrorMessage(`Solstice could stop only ${result.stopped}/${result.requested} preview servers.`);
			else vscode.window.showInformationMessage(`Solstice: closed ${result.stopped} preview server${result.stopped === 1 ? "" : "s"}.`);
		}),
		vscode.commands.registerCommand("solstice.agent.showDevServers", () => controller.showDevServers()),
		vscode.commands.registerCommand("solstice.agent.deployVercel", () => controller.deployCurrentProject()),
		vscode.commands.registerCommand("solstice.agent.openSkills", () => openSkills(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openBrandDna", () => openBrandDna(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openFoundation", () => openFoundation(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.loadBrandPack", () => controller.loadBrandPackIntoWorkspace()),
		vscode.commands.registerCommand("solstice.agent.scaffoldApp", () => controller.scaffoldAppIntoWorkspace()),
		vscode.commands.registerCommand("solstice.agent.selectModel", () => controller.selectModel()),
		vscode.commands.registerCommand("solstice.agent.selectAutonomy", () => controller.selectAutonomy()),
		vscode.commands.registerCommand("solstice.agent.toggleDesignElevation", () => controller.toggleDesignElevation()),
		vscode.commands.registerCommand("solstice.agent.openTerminal", () => controller.openTerminal()),
		vscode.commands.registerCommand("solstice.agent.openGallery", () => openGallery(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openCompanion", () => controller.startCompanion()),
		vscode.commands.registerCommand("solstice.agent.openConnectors", () => openConnectors(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openWorkflow", () => openWorkflow(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openFleet", () => openFleet(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.checkEngines", () => controller.checkEngines())
	);
	try {
		const devServerItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1001);
		devServerItem.command = "solstice.agent.showDevServers";
		controller.devServerStatus = devServerItem;
		controller.updateDevServerStatus();
		context.subscriptions.push(devServerItem);
	} catch { }
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
		const ownedRoots = [controller.devServer, ...controller.managerDevServers.values()].filter(Boolean).map((server) => path.resolve(server.root));
		if (event.removed.some((folder) => ownedRoots.includes(path.resolve(folder.uri.fsPath)))) {
			controller.stopAllDevServers("project-closed");
		}
	}));
	// Always-visible Solstice version badge (bottom status bar) → opens Fleet on click.
	try {
		const verItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
		verItem.text = "$(sparkle) Solstice " + (controller.versionLabel() || "");
		verItem.tooltip = controller.versionTooltip();
		verItem.command = "solstice.agent.openFleet";
		verItem.show();
		context.subscriptions.push(verItem);
	} catch { }
	// stuck-agent watchdog: warn when an agent loops in a busy state (e.g.
	// "Exploring…") past the threshold with no fresh progress event.
	controller.startWatchdog();
	controller.startScheduledChecks();
	setTimeout(() => controller.ensureCompanionRelay(), 800);
	context.subscriptions.push({ dispose: () => { if (controller.watchTimer) { clearInterval(controller.watchTimer); controller.watchTimer = null; } } });
	context.subscriptions.push({ dispose: () => { if (controller.scheduledCheckTimer) { clearInterval(controller.scheduledCheckTimer); controller.scheduledCheckTimer = null; } } });
	context.subscriptions.push({ dispose: () => { if (controller._companionRelayTimer) { clearTimeout(controller._companionRelayTimer); controller._companionRelayTimer = null; } } });
	// relaunch recovery: if a build was interrupted by an IDE restart, report a
	// terminal frame to the dispatching agent the moment its bridge reconnects.
	try { controller.recoverBuildJournal(); } catch { }
	// live research dashboard: render DECONSTRUCT.md / RESEARCH.md as the agent writes it
	// (no brace glob — filter by basename; grok writes from outside the editor)
	const researchWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
	const onResearchFile = (u) => {
		if (/^(DECONSTRUCT|RESEARCH|ANALYSIS)\.md$/.test(path.basename(u.fsPath))) controller.showResearch(u);
	};
	researchWatcher.onDidCreate(onResearchFile);
	researchWatcher.onDidChange(onResearchFile);
	context.subscriptions.push(researchWatcher);
	// PLAN.md is engine-agnostic: Codex, Grok, Composer and Claude all flow
	// through the same workspace watcher instead of the old Grok-only bridge.
	const planWatcher = vscode.workspace.createFileSystemWatcher("**/.solstice/PLAN.md");
	const onPlanFile = (u) => controller.emitPlanFile(u.fsPath, controller.threadId);
	planWatcher.onDidCreate(onPlanFile);
	planWatcher.onDidChange(onPlanFile);
	context.subscriptions.push(planWatcher);
	// fleet bridge: external agents (Orion/Jasper/Niko) drop a task JSON into the
	// inbox dir (relayed from Telegram or written directly); we focus the panel,
	// inject the task as a prompt, and archive the file so it runs exactly once.
	// We poll with Node fs rather than vscode.createFileSystemWatcher because the
	// inbox lives OUTSIDE the workspace, where VS Code watchers don't fire.
	const inboxDir = process.env.SOLSTICE_AGENT_INBOX || path.join(os.homedir(), ".solstice", "agent-inbox");
	const inboxDone = path.join(inboxDir, "processed");
	try { fs.mkdirSync(inboxDone, { recursive: true }); } catch { }
	let inboxBusy = false;
	const handleInboxTask = async (p) => {
		let job;
		try { job = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return; }
		const from = String(job.from || "fleet");
		const task = String(job.task || job.text || "").trim();
		// archive first so a slow agent turn can't cause the same task to fire twice
		try { fs.renameSync(p, path.join(inboxDone, Date.now() + "-" + path.basename(p))); } catch { }
		if (!task) return;
		await vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
		const text = `\u{1f4e5} \u05de\u05e9\u05d9\u05de\u05d4 \u05de-${from} (\u05e6\u05d9 \u05d4\u05e1\u05d5\u05db\u05e0\u05d9\u05dd):\n\n${task}`;
		// light up the Fleet panel: a fleet agent just dispatched a build to Solstice
		controller.activeFleetAgent = from;
		if (controller.fleetPanel) {
			controller.fleetPanel.webview.postMessage({ type: "liveTask", from, task });
			controller.fleetPanel.webview.postMessage({ type: "flowGuidance", from, prompt: text });
		}
		controller.fleetFlow("dispatch", { from, task });
		setTimeout(() => controller.post({ type: "injectPrompt", text }), 1200);
	};
	const scanInbox = async () => {
		if (inboxBusy) return;
		inboxBusy = true;
		try {
			const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json")).sort();
			for (const f of files) await handleInboxTask(path.join(inboxDir, f));
		} catch { } finally { inboxBusy = false; }
	};
	const inboxTimer = setInterval(scanInbox, 1500);
	setTimeout(scanInbox, 1000); // catch tasks dropped before the panel armed
	context.subscriptions.push({ dispose: () => clearInterval(inboxTimer) });
	// chat lives in the secondary side bar (right of the editor); reveal it on first run
	if (!context.globalState.get("solstice.revealedAgentPanel")) {
		context.globalState.update("solstice.revealedAgentPanel", true);
		setTimeout(() => vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { }), 1500);
	}
	// with no folder open, show the Projects gallery as the home view
	if (!vscode.workspace.workspaceFolders) {
		setTimeout(() => openGallery(controller, context.extensionUri), 900);
	}
	// headless E2E hooks (xvfb, no pointer)
	if (process.env.SOLSTICE_AGENT_DEV_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agentPanel.focus");
			setTimeout(() => controller.post({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_PROMPT }), 5000);
		}, 5000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_PREVIEW) {
		setTimeout(() => vscode.commands.executeCommand("solstice.agent.openPreview").then(undefined, () => { }),
			Number(process.env.SOLSTICE_AGENT_DEV_PREVIEW) * 1000 || 60000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agent.openManager");
			setTimeout(() => controller.postManager({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT }), 5000);
		}, 5000);
	}
}

function deactivate() { }

module.exports = { activate, deactivate };
