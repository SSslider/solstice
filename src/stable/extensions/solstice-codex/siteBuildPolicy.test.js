"use strict";

const assert = require("assert");
const {
	MOTION_LEVELS,
	classifyMotionLevel,
	buildSiteBrief,
	appendSiteBuildPolicy,
} = require("./siteBuildPolicy");

let checks = 0;
function equal(actual, expected, message) { checks++; assert.equal(actual, expected, message); }
function ok(value, message) { checks++; assert.ok(value, message); }

const briefs = [
	{
		text: "בנה לי אתר לרופא שיניים",
		level: MOTION_LEVELS.STATIC,
		animated: false,
		description: "Hebrew dental brief stays motion-free",
	},
	{
		text: "אתר עם קצת תנועה בכפתורים",
		level: MOTION_LEVELS.SUBTLE,
		animated: false,
		description: "small button motion is subtle, not cinematic",
	},
	{
		text: "אתר נחיתה למספרה עם גלילה חלקה",
		level: MOTION_LEVELS.SUBTLE,
		animated: false,
		description: "smooth scrolling alone is subtle",
	},
	{
		text: "build a website for a dentist, clean modern design",
		level: MOTION_LEVELS.STATIC,
		animated: false,
		description: "generic English site build stays motion-free",
	},
];

for (const sample of briefs) {
	const policy = classifyMotionLevel(sample.text);
	equal(policy.level, sample.level, sample.description);
	equal(policy.injectAnimatedKit, sample.animated, sample.description + " does not inject Animated Kit");
	equal(policy.injectScrollWorld, false, sample.description + " does not inject ScrollWorld");
	const brief = buildSiteBrief(sample.text);
	ok(brief.audience && Array.isArray(brief.sections) && brief.sections.length >= 4, sample.description + " produces a one-page structured brief");
	equal(brief.motion.level, sample.level, sample.description + " exposes the motion decision in the brief");
	const composed = appendSiteBuildPolicy(sample.text);
	ok(composed.includes("[SOLSTICE_HEBREW_RTL_PLAYBOOK]"), sample.description + " always receives the Hebrew/RTL playbook");
	ok(composed.includes("[SOLSTICE_SITE_BRIEF]"), sample.description + " receives the structured site brief contract");
	ok(!composed.includes("[SOLSTICE_ANIMATED_WEBSITE_KIT]"), sample.description + " does not receive the cinematic kit");
}

const cinematic = classifyMotionLevel("בנה אתר סינמטי עם פרלקס ו-scroll-scrub בפרקים");
equal(cinematic.level, MOTION_LEVELS.CINEMATIC, "explicit cinematic language selects level 3");
equal(cinematic.injectAnimatedKit, true, "level 3 injects Animated Kit");
equal(cinematic.injectScrollWorld, false, "cinematic language does not imply ScrollWorld");

const scrollWorld = classifyMotionLevel("בנה לי אתר עם ScrollWorld");
equal(scrollWorld.level, MOTION_LEVELS.SCROLLWORLD, "named ScrollWorld request selects level 4");
equal(scrollWorld.injectAnimatedKit, false, "ScrollWorld route suppresses generic Animated Kit");
equal(scrollWorld.injectScrollWorld, true, "named ScrollWorld request selects its own route");

console.log(`siteBuildPolicy.test.js: ${checks}/${checks} checks passed`);
