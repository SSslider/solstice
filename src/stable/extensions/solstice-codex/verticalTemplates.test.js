"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { VERTICAL_TEMPLATE_CATALOG, selectVerticalTemplates, buildVerticalTemplatePack } = require("./verticalTemplates");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

const fitness = selectVerticalTemplates("בנה אתר ScrollWorld למאמן כושר עם תוכנית עסקית ואימונים אישיים");
ok(fitness.templates.length === 1, "fitness prompt selects exactly one vertical");
ok(fitness.templates[0].file === "verticals/fitness-coach.md", "fitness prompt selects the fitness coach pack");
ok(!fitness.templates.some((item) => item.file === "verticals/medical-clinic.md"), "fitness prompt never selects Dental or Medical");

const englishFitness = selectVerticalTemplates("Build a website for a personal trainer and gym");
ok(englishFitness.templates.length === 1 && englishFitness.templates[0].file === "verticals/fitness-coach.md", "English fitness intent selects the same pack");

const unknown = selectVerticalTemplates("בנה תבנית לתחום הפינטק");
ok(unknown.requested && unknown.templates.length === 0, "unknown requested vertical fails closed with no template");
ok(unknown.reason === "no confident vertical match", "unknown vertical exposes the required visible reason");

const generic = selectVerticalTemplates("בנה אתר חדש לעסק");
ok(!generic.requested && generic.templates.length === 0, "generic request does not inject a vertical");

const fitnessPack = fs.readFileSync(path.join(__dirname, "prompts", "verticals", "fitness-coach.md"), "utf8");
ok(/audience/i.test(fitnessPack) && /offer ladder/i.test(fitnessPack), "fitness pack carries audience and business-offer guidance");
ok(/scroll-depth/i.test(fitnessPack) && /real client/i.test(fitnessPack), "fitness pack requires motion verification and real proof");
ok(!/dental|dentist|clinic/i.test(fitnessPack), "fitness pack contains no Dental or Medical leakage");

const assembledFitnessPrompt = buildVerticalTemplatePack(
	"בנה אתר ScrollWorld לתחום הכושר ולמאמן כושר",
	(file) => fs.readFileSync(path.join(__dirname, "prompts", file), "utf8")
).text;
ok(/Fitness Coach \/ Personal Training/.test(assembledFitnessPrompt), "assembled fitness prompt contains the correct vertical contract");
ok(!/Dental|Medical Clinic|dentist/i.test(assembledFitnessPrompt), "assembled fitness prompt contains zero Dental content");

const extensionSource = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
ok(extensionSource.includes("no confident vertical match") && extensionSource.includes("this._lastVerticalRoute"), "extension surfaces no-match truth in the Felix interface and diagnostics");

const expectedVerticals = [
	"barber-beauty", "beauty-cosmetics", "dental-clinic", "ecommerce", "education-courses", "events",
	"fitness-coach", "jewelry", "law-firm", "medical-clinic", "portfolio", "real-estate",
	"renovation-services", "restaurant", "saas", "travel-agency",
];
const actualVerticals = VERTICAL_TEMPLATE_CATALOG.map((item) => path.basename(item.file, ".md")).sort();
ok(JSON.stringify(actualVerticals) === JSON.stringify(expectedVerticals), "catalog exposes the complete 16-vertical Stage 2 set");

const bilingualRoutes = [
	["בנה אתר למרפאת שיניים", "dental-clinic"], ["website for a private medical clinic", "medical-clinic"],
	["אתר למספרת גברים", "barber-beauty"], ["fitness coach website", "fitness-coach"],
	["אתר למשרד עורכי דין", "law-firm"], ["restaurant reservations website", "restaurant"],
	["אתר תיווך ונדל\"ן", "real-estate"], ["online ecommerce shop", "ecommerce"],
	["אתר למוצר SaaS", "saas"], ["creative portfolio website", "portfolio"],
	["אתר לסוכנות טיולים", "travel-agency"], ["luxury jewelry website", "jewelry"],
	["אתר לקורסים אונליין", "education-courses"], ["event production website", "events"],
	["אתר לקליניקת קוסמטיקה", "beauty-cosmetics"], ["renovation contractor website", "renovation-services"],
];
for (const [brief, slug] of bilingualRoutes) {
	const selected = selectVerticalTemplates(brief).templates;
	ok(selected.length === 1 && selected[0].file === `verticals/${slug}.md`, `${brief} routes only to ${slug}`);
}
const ambiguousDental = selectVerticalTemplates("בנה אתר למרפאה לרפואת שיניים").templates;
ok(ambiguousDental.length === 1 && ambiguousDental[0].file === "verticals/dental-clinic.md", "the longest specific tag resolves dental over generic clinic");
const ambiguousJewelry = selectVerticalTemplates("בנה חנות אונליין לתכשיטים").templates;
ok(ambiguousJewelry.length === 1 && ambiguousJewelry[0].file === "verticals/jewelry.md", "the longest specific tag resolves jewelry over generic ecommerce");

for (const item of VERTICAL_TEMPLATE_CATALOG) {
	const body = fs.readFileSync(path.join(__dirname, "prompts", item.file), "utf8");
	const urls = body.match(/https:\/\/[^\s)]+/g) || [];
	ok(/## Content Structure/.test(body), `${item.file} defines a content structure`);
	ok(/## Hebrew Copy/.test(body), `${item.file} defines Hebrew copy direction`);
	ok(/## Image Direction/.test(body), `${item.file} defines image direction`);
	ok(/## Live References/.test(body) && urls.length >= 3 && urls.length <= 5, `${item.file} carries 3-5 live references`);
}

console.log(`verticalTemplates.test.js: ${checks}/${checks} checks passed`);
