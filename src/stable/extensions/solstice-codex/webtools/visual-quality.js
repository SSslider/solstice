"use strict";

const PASS_SCORE = 80;

function clamp(value) {
	return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function hierarchyScore(view) {
	const sample = view && typeof view === "object" ? view : {};
	const headings = Array.isArray(sample.headings) ? sample.headings : [];
	const h1Count = Math.max(0, Number(sample.h1Count) || 0);
	const body = Math.max(1, Number(sample.bodyFontPx) || 16);
	const largest = headings.reduce((max, heading) => Math.max(max, Number(heading.fontSize) || 0), 0);
	let score = 100;
	if (h1Count === 0) score -= 45;
	else if (h1Count > 1) score -= Math.min(30, 10 + ((h1Count - 1) * 10));
	if (headings.length < 2) score -= 20;
	if (largest < body * 1.45) score -= 25;
	let previous = 0;
	for (const heading of headings) {
		const level = Number(heading.level) || 0;
		if (previous && level > previous + 1) { score -= 10; break; }
		previous = level;
	}
	return clamp(score);
}

function contrastScore(views) {
	let samples = 0;
	let failures = 0;
	for (const view of views) {
		samples += Math.max(0, Number(view && view.contrastSamples) || 0);
		failures += Math.max(0, Number(view && view.contrastFailures) || 0);
	}
	if (!samples) return 0;
	return clamp(100 - ((failures / samples) * 250));
}

function mobileScore(view) {
	const sample = view && typeof view === "object" ? view : {};
	const controls = Math.max(0, Number(sample.controlCount) || 0);
	const undersized = Math.max(0, Number(sample.undersizedControls) || 0);
	let score = 100;
	if ((Number(sample.overflowPx) || 0) > 4) score -= 45;
	score -= Math.min(30, (Number(sample.clippedControls) || 0) * 12);
	score -= Math.min(35, controls ? (undersized / controls) * 45 : 0);
	score -= Math.min(20, (Number(sample.brokenImages) || 0) * 10);
	return clamp(score);
}

function scoreVisualQuality(input) {
	const desktop = input && input.desktop || {};
	const mobile = input && input.mobile || {};
	const categories = {
		hierarchy: clamp((hierarchyScore(desktop) + hierarchyScore(mobile)) / 2),
		contrast: contrastScore([desktop, mobile]),
		mobile: mobileScore(mobile),
	};
	const score = clamp((categories.hierarchy * 0.35) + (categories.contrast * 0.35) + (categories.mobile * 0.30));
	const findings = [];
	if (categories.hierarchy < PASS_SCORE) findings.push({
		check: "visual-hierarchy",
		message: `Visual hierarchy scored ${categories.hierarchy}/100: use exactly one clear H1, a readable body size, and a descending H1→H2→H3 scale.`,
		evidence: { desktopHeadings: desktop.headings || [], mobileHeadings: mobile.headings || [] },
	});
	if (categories.contrast < PASS_SCORE) findings.push({
		check: "visual-contrast",
		message: `Text contrast scored ${categories.contrast}/100: repair sampled text below WCAG AA contrast.`,
		evidence: {
			desktop: { samples: desktop.contrastSamples || 0, failures: desktop.contrastFailures || 0, examples: desktop.contrastFailureExamples || [] },
			mobile: { samples: mobile.contrastSamples || 0, failures: mobile.contrastFailures || 0, examples: mobile.contrastFailureExamples || [] },
		},
	});
	if (categories.mobile < PASS_SCORE) findings.push({
		check: "visual-mobile",
		message: `Mobile composition scored ${categories.mobile}/100: remove overflow/clipping and make touch targets at least 44×44px.`,
		evidence: {
			overflowPx: mobile.overflowPx || 0,
			clippedControls: mobile.clippedControls || 0,
			undersizedControls: mobile.undersizedControls || 0,
			controlCount: mobile.controlCount || 0,
		},
	});
	return {
		score,
		grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F",
		threshold: PASS_SCORE,
		passed: score >= PASS_SCORE && Object.values(categories).every((value) => value >= PASS_SCORE),
		categories,
		findings,
	};
}

module.exports = { PASS_SCORE, scoreVisualQuality };
