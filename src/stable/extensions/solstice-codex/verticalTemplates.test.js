"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { selectVerticalTemplates, buildVerticalTemplatePack } = require("./verticalTemplates");

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

console.log(`verticalTemplates.test.js: ${checks}/${checks} checks passed`);
