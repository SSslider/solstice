"use strict";

function isPureLaunchIntent(text) {
	const value = String(text || "");
	const launch = /(?:^|\s)(?:פתח|תפתח|הרץ|תריץ|הפעל|תפעיל)(?:\s|$)|\b(?:open|run|start|launch)\b/i.test(value);
	const build = /\b(?:build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|יישם|תקן|עצב מחדש)/i.test(value);
	return launch && !build;
}

function isPureStopRuntimeIntent(text) {
	const value = String(text || "");
	const stop = /\b(?:stop|terminate|kill|close|shut\s*down)\b|(?:עצור|תעצור|סגור|תסגור|תהרוג|הרוג)/i.test(value);
	const runtime = /\b(?:dev\s*server|server|site\s*process|website\s*process|preview|localhost|npm\s+run\s+(?:dev|start))\b|(?:שרת(?:\s+הפיתוח)?|פרוסס(?:\s+של)?(?:\s+האתר)?|תהליך(?:\s+של)?(?:\s+האתר)?|האתר\s+שרץ|התצוגה\s+החיה)/i.test(value);
	const build = /\b(?:build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|יישם|תקן|עצב מחדש)/i.test(value);
	return stop && runtime && !build;
}

module.exports = { isPureLaunchIntent, isPureStopRuntimeIntent };
