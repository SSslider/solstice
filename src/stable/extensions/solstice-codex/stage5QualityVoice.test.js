"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { scoreVisualQuality } = require("./webtools/visual-quality");

let checks = 0;
function ok(value, label) {
	assert.ok(value, label);
	checks += 1;
}

const strong = {
	desktop: {
		h1Count: 1,
		headings: [{ level: 1, fontSize: 58 }, { level: 2, fontSize: 36 }, { level: 2, fontSize: 34 }],
		bodyFontPx: 18,
		contrastSamples: 40,
		contrastFailures: 0,
		controlCount: 8,
		undersizedControls: 0,
		overflowPx: 0,
		clippedControls: 0,
		brokenImages: 0,
	},
	mobile: {
		h1Count: 1,
		headings: [{ level: 1, fontSize: 40 }, { level: 2, fontSize: 28 }, { level: 2, fontSize: 26 }],
		bodyFontPx: 17,
		contrastSamples: 32,
		contrastFailures: 0,
		controlCount: 7,
		undersizedControls: 0,
		overflowPx: 0,
		clippedControls: 0,
		brokenImages: 0,
	},
};

const passing = scoreVisualQuality(strong);
ok(passing.passed === true, "a strong hierarchy, contrast and mobile layout passes");
ok(passing.score >= 90, "a strong page earns an A-range visual score");
ok(passing.categories.hierarchy >= 80 && passing.categories.contrast >= 80 && passing.categories.mobile >= 80, "all three named visual categories are scored");

const weakHierarchy = scoreVisualQuality({
	...strong,
	desktop: { ...strong.desktop, h1Count: 0, headings: [{ level: 2, fontSize: 19 }], bodyFontPx: 18 },
});
ok(weakHierarchy.passed === false && weakHierarchy.categories.hierarchy < 80, "flat or missing heading hierarchy fails closed");

const weakContrast = scoreVisualQuality({
	...strong,
	desktop: { ...strong.desktop, contrastSamples: 20, contrastFailures: 8 },
	mobile: { ...strong.mobile, contrastSamples: 20, contrastFailures: 7 },
});
ok(weakContrast.passed === false && weakContrast.categories.contrast < 80, "systemic WCAG contrast failures fail closed");

const weakMobile = scoreVisualQuality({
	...strong,
	mobile: { ...strong.mobile, overflowPx: 180, clippedControls: 2, undersizedControls: 5 },
});
ok(weakMobile.passed === false && weakMobile.categories.mobile < 80, "overflow, clipping and small touch targets fail the mobile score");
ok(weakMobile.findings.some((finding) => finding.check === "visual-mobile"), "failure includes a concrete mobile repair finding");

const browse = fs.readFileSync(path.join(__dirname, "webtools", "browse.js"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "media", "panel.js"), "utf8");
const planPanel = fs.readFileSync(path.join(__dirname, "media", "plan.js"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
ok(browse.includes("scoreVisualQuality"), "real-browser QA invokes the scored visual critic");
ok(browse.includes("visualScore"), "browser evidence publishes the visual score");
ok(/case "transcribed"[\s\S]{0,600}send\(\)/.test(panel), "push-to-talk sends automatically after transcription");
ok(panel.includes("בריף קולי"), "the microphone control is labeled as a voice brief");
const planPanelSource = extension.slice(extension.indexOf("openPlanPanel()"), extension.indexOf("planProjectType(", extension.indexOf("openPlanPanel()")));
ok(planPanelSource.indexOf("onDidReceiveMessage") < planPanelSource.indexOf("webview.html ="), "plan-panel ready listener is installed before HTML can emit ready");
ok(planPanel.includes("setInterval(requestPlanState, 500)") && planPanel.includes('vscode.postMessage({ type: "ready" })'), "plan panel retries its ready handshake until the approval payload arrives");

console.log(`stage5QualityVoice.test.js: ${checks}/${checks} checks passed`);
