"use strict";

function isPureLaunchIntent(text) {
	const value = String(text || "");
	const launch = /(?:^|\s)(?:פתח|תפתח|הרץ|תריץ|הפעל|תפעיל)(?:\s|$)|\b(?:open|run|start|launch)\b/i.test(value);
	const build = /\b(?:build|create|make|implement|develop|scaffold|redesign|rebuild|clone|ship|code|fix)\b|(?:ת?בנה|לבנות|ת?צור|ליצור|יישם|תקן|עצב מחדש)/i.test(value);
	return launch && !build;
}

module.exports = { isPureLaunchIntent };
