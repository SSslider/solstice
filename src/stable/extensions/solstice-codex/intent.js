"use strict";

function isPureLaunchIntent(text) {
	const value = String(text || "");
	const launch = /(?:^|\s)(?:פתח|תפתח|הרץ|תריץ|הפעל|תפעיל)(?:\s|$)|\b(?:open|run|start|launch)\b/i.test(value);
	const build = /\b(?:build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|יישם|תקן|עצב מחדש)/i.test(value);
	return launch && !build;
}

function isPureStopRuntimeIntent(text) {
	const value = String(text || "");
	return runtimeStopIntent(text) !== null;
}

function runtimeStopIntent(text) {
	const value = String(text || "");
	const stop = /\b(?:stop|terminate|kill|close|shut\s*down|turn\s*off|do(?:n't| not)\s+need)\b|(?:עצור|תעצור|סגור|תסגור|כבה|תכבה|הפסק|תפסיק|תהרוג|הרוג|לא\s+צריך|לא\s+זקוק)/i.test(value);
	const runtime = /\b(?:dev\s*servers?|servers?|sites?|websites?|site\s*process|website\s*process|previews?|localhost|npm\s+run\s+(?:dev|start))\b|(?:שרתי?(?:\s+הפיתוח)?|פרוסס(?:\s+של)?(?:\s+האתר)?|תהליך(?:\s+של)?(?:\s+האתר)?|האתר(?:ים)?(?:\s+שרץ|\s+שרצים)?|האתרים|התצוגה\s+החיה)/i.test(value);
	const build = /\b(?:build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|יישם|תקן|עצב מחדש)/i.test(value);
	if (!stop || !runtime || build) return null;
	const all = /\b(?:all|every)\b|(?:\bכל\b|כולם|כולן)/i.test(value)
		|| /\b(?:sites|websites|servers|previews)\b|(?:האתרים|השרתים)/i.test(value);
	return all ? "all" : "workspace";
}

module.exports = { isPureLaunchIntent, isPureStopRuntimeIntent, runtimeStopIntent };
