"use strict";

const fs = require("fs");
const path = require("path");

const MOTION_LEVELS = Object.freeze({
	STATIC: "static",
	SUBTLE: "subtle",
	CINEMATIC: "cinematic",
	SCROLLWORLD: "scrollworld",
});

const SITE_SURFACE = /\b(site|website|landing|homepage|web\s*page|microsite|storefront)\b|(?:אתר|דף\s*נחיתה|עמוד\s*נחיתה|לנדינג|מיניסייט)/i;
const NEW_BUILD = /\b(build|create|make|develop|design|scaffold|launch|start)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|תפתח|עצב|תעצב|הקם|להקים|אני\s+רוצה|צריך)/i;
const EXISTING_EDIT = /\b(existing|current|already|fix|change|update|edit|polish|replace|debug)\b|(?:קיים|הקיים|כבר|תקן|תתקן|שנה|תשנה|עדכן|ערוך|שפר|החלף)/i;
const LAUNCH_ONLY = /\b(open|run|serve|preview|browser|chrome)\b|(?:פתח|תפתח|הרץ|תריץ|הצג|פריוויו|דפדפן|כרום)/i;

const SCROLLWORLD = /\bscroll[\s_-]*world\b|סקול[\s_-]*וורלד/i;
const SCROLLWORLD_NEGATION = /(?:אל\s+תשתמש|לא\s+להשתמש|בלי|במקום|חוץ\s+מ[-־]?|דלג\s+על)[\s\S]{0,48}(?:scroll[\s_-]*world|סקול[\s_-]*וורלד)|(?:do\s+not|don't|without|instead\s+of|rather\s+than|skip|no)[\s\S]{0,48}scroll[\s_-]*world/i;
const CINEMATIC = /\b(cinematic|scrollytelling|scroll[-\s]?telling|scroll[-\s]?scrub|scrolltrigger|parallax|webgl|three\.?js|react[-\s]?three[-\s]?fiber|r3f|shader|canvas\s+sequence|video\s+scroll|sticky\s+chapters?|apple[-\s]?style)\b|(?:סינמטי|סיפור\s+בגלילה|סקראב|פרלקס|תלת[-\s]?ממד|תלת\s*מימד|וובגל|קנבס\s+פריימים|פרקים\s+בגלילה|בסגנון\s+אפל)/i;
const SUBTLE = /\b(subtle|gentle|micro[-\s]?interaction|hover|fade|small\s+motion|button\s+motion|smooth\s+scroll(?:ing)?)\b|(?:תנועה\s+עדינה|קצת\s+תנועה|מיקרו[-\s]?אינטראקצי|הובר|פייד|גלילה\s+חלקה|תנועה\s+בכפתורים)/i;

const VERTICALS = [
	{ id: "dental", re: /\b(dentist|dental)\b|רופא\s+שיניים|מרפאת\s+שיניים/i, audience: "מטופלים ומשפחות שמחפשים טיפול מקצועי ונגיש", sections: ["Hero עם קביעת תור", "טיפולים מרכזיים", "היכרות עם המרפאה", "הוכחה חברתית", "שאלות נפוצות", "קביעת תור"], tone: "נקי, רגוע, רפואי ואמין", references: "3–5 מרפאות שיניים מקומיות ברמת פרימיום" },
	{ id: "barber", re: /\b(barber|salon|hair)\b|מספרה|ספר\s+גברים|שיער/i, audience: "לקוחות מקומיים שמחפשים תוצאה, סגנון וזמינות", sections: ["Hero עם הזמנה", "שירותים ומחירים", "גלריית תוצאות", "הצוות", "ביקורות", "קביעת תור"], tone: "אופנתי, חד ובטוח", references: "3–5 מספרות וסטודיואים מקומיים חזקים" },
	{ id: "fitness", re: /\b(fitness|gym|trainer|coach)\b|כושר|חדר\s+כושר|מאמן|אימונים/i, audience: "מתאמנים שמחפשים תהליך ברור והוכחת תוצאות", sections: ["Hero עם יעד", "שיטת האימון", "מסלולים", "תוצאות מתאמנים", "על המאמן", "שיחת התאמה"], tone: "אנרגטי, מדויק ומניע", references: "3–5 מאמנים ומועדוני כושר עם conversion חזק" },
];

function classifyMotionLevel(text) {
	const source = String(text || "");
	if (SCROLLWORLD.test(source) && !SCROLLWORLD_NEGATION.test(source)) {
		return { level: MOTION_LEVELS.SCROLLWORLD, label: "ScrollWorld מפורש", injectAnimatedKit: false, injectScrollWorld: true, reason: "ScrollWorld was named explicitly" };
	}
	if (CINEMATIC.test(source)) {
		return { level: MOTION_LEVELS.CINEMATIC, label: "סינמטי", injectAnimatedKit: true, injectScrollWorld: false, reason: "cinematic motion intent" };
	}
	if (SUBTLE.test(source)) {
		return { level: MOTION_LEVELS.SUBTLE, label: "תנועה עדינה", injectAnimatedKit: false, injectScrollWorld: false, reason: "subtle interaction intent" };
	}
	return { level: MOTION_LEVELS.STATIC, label: "סטטי / ללא תנועה מהותית", injectAnimatedKit: false, injectScrollWorld: false, reason: "no explicit motion intent" };
}

function siteBuildIntent(text) {
	const source = String(text || "");
	if (!SITE_SURFACE.test(source)) return false;
	if (EXISTING_EDIT.test(source)) return false;
	if (LAUNCH_ONLY.test(source) && !NEW_BUILD.test(source)) return false;
	return NEW_BUILD.test(source) || /^\s*(?:אתר|לנדינג|דף\s+נחיתה)(?:\s|$)/i.test(source) || /(?:אתר|לנדינג)\s+(?:עם|ל|עבור)/i.test(source);
}

function needsSiteBriefApproval(text) {
	const source = String(text || "");
	if (/\[FELIX_APPROVED_SITE_BRIEF\]/.test(source)) return false;
	return siteBuildIntent(source);
}

function buildSiteBrief(text) {
	const source = String(text || "").trim();
	const vertical = VERTICALS.find((item) => item.re.test(source));
	const motion = classifyMotionLevel(source);
	return {
		vertical: vertical ? vertical.id : "general",
		audience: vertical ? vertical.audience : "הקהל העסקי המרכזי והלקוחות שצריכים לבצע את הפעולה הראשית",
		sections: vertical ? vertical.sections : ["Hero והצעת ערך", "שירותים / מוצר", "הוכחה ואמון", "קריאה לפעולה"],
		tone: vertical ? vertical.tone : "ברור, מובחן ומותאם למותג",
		references: [vertical ? vertical.references : "3–5 רפרנסים חיים מהוורטיקל לפני כתיבת קוד"],
		motion,
		source,
	};
}

function briefFromAnswers(brief, answers) {
	const base = brief || buildSiteBrief("");
	const input = answers || {};
	return {
		...base,
		audience: String(input.audience || base.audience || "").trim(),
		sections: String(input.sections || (base.sections || []).join(" · ")).split(/\s*(?:·|,|\n)\s*/).filter(Boolean),
		tone: String(input.tone || base.tone || "").trim(),
		references: String(input.references || (base.references || []).join(" · ")).split(/\s*(?:·|,|\n)\s*/).filter(Boolean),
	};
}

function approvedSiteBuildPrompt(state) {
	const prompt = String(state && state.prompt || "").trim();
	const brief = briefFromAnswers(state && state.brief, state && state.answers);
	return [
		prompt,
		"",
		"[FELIX_APPROVED_SITE_BRIEF]",
		`Vertical: ${brief.vertical}.`,
		`Audience: ${brief.audience}`,
		`Sections: ${brief.sections.join(" → ")}`,
		`Tone: ${brief.tone}`,
		`References: ${brief.references.join(" · ")}`,
		`Motion level: ${brief.motion.label} (${brief.motion.level}).`,
		"This one-page brief was approved by Thomas. Execute it without silently changing direction; ask before any material scope change.",
		"[/FELIX_APPROVED_SITE_BRIEF]",
	].join("\n");
}

function promptFile(name, fallback) {
	try { return fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim() || fallback; }
	catch { return fallback; }
}

function appendSiteBuildPolicy(text) {
	let out = String(text || "");
	if (!siteBuildIntent(out) && !/\[FELIX_APPROVED_SITE_BRIEF\]/.test(out)) return out;
	const motion = classifyMotionLevel(out);
	if (!/\[SOLSTICE_HEBREW_RTL_PLAYBOOK\]/.test(out)) {
		out += `\n\n[SOLSTICE_HEBREW_RTL_PLAYBOOK]\n${promptFile("hebrew-rtl-site-playbook.md", "Build Hebrew-first and RTL-correct. Research 3–5 live vertical references before code; define typography, palette, spacing and reusable components.")}\n[/SOLSTICE_HEBREW_RTL_PLAYBOOK]`;
	}
	if (!/\[SOLSTICE_SITE_BRIEF\]/.test(out)) {
		out += `\n\n[SOLSTICE_SITE_BRIEF]\n${promptFile("site-brief-contract.md", "Follow the approved audience, sections, tone, references and motion level. Do not write code before approval.")}\nMotion decision: ${motion.label} (${motion.level}); ${motion.reason}.\n[/SOLSTICE_SITE_BRIEF]`;
	}
	return out;
}

module.exports = {
	MOTION_LEVELS,
	classifyMotionLevel,
	siteBuildIntent,
	needsSiteBriefApproval,
	buildSiteBrief,
	briefFromAnswers,
	approvedSiteBuildPrompt,
	appendSiteBuildPolicy,
};
