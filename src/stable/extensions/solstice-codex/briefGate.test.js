"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { needsSiteBriefApproval, approvedSiteBuildPrompt } = require("./siteBuildPolicy");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

ok(needsSiteBriefApproval("בנה לי אתר לרופא שיניים"), "new Hebrew website build requires brief approval");
ok(needsSiteBriefApproval("build a website for a dentist, clean modern design"), "new English website build requires brief approval");
ok(!needsSiteBriefApproval("תקן את צבע הכפתור באתר הקיים"), "editing an existing site is not blocked behind a new-site brief");
ok(!needsSiteBriefApproval("פתח את האתר בדפדפן"), "runtime launch intent is not a site brief");
ok(!needsSiteBriefApproval("בנה API ללידים"), "backend-only work is not a site brief");
ok(needsSiteBriefApproval("build a website with an API-backed lead form"), "mixed website and backend scope still requires the site brief");

const approved = approvedSiteBuildPrompt({
	prompt: "בנה לי אתר לרופא שיניים",
	brief: {
		audience: "משפחות שמחפשות רופא שיניים מקומי",
		sections: ["Hero", "שירותים", "הוכחה חברתית", "קביעת תור"],
		tone: "נקי, רגוע ואמין",
		references: ["מרפאות פרימיום מקומיות"],
		motion: { level: "static", label: "סטטי" },
	},
});
ok(approved.includes("[FELIX_APPROVED_SITE_BRIEF]"), "approved prompt carries an explicit immutable brief marker");
ok(approved.includes("משפחות שמחפשות רופא שיניים מקומי"), "approved prompt carries the audience");
ok(approved.includes("קביעת תור"), "approved prompt carries the section plan");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
ok(/needsSiteBriefApproval\(text\)[\s\S]{0,180}requestSiteBriefApproval\(text\)[\s\S]{0,60}return/.test(extension), "send() stops before model invocation and opens the site brief approval gate");
ok(/approveSiteBrief[\s\S]{0,500}approvedSiteBuildPrompt/.test(extension), "brief approval resumes through the approved-site contract");

console.log(`briefGate.test.js: ${checks}/${checks} checks passed`);
