"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const planUi = fs.readFileSync(path.join(__dirname, "media", "plan.js"), "utf8");
const vega = fs.readFileSync("/home/thomas/Julius-cc-x/fleet-app/pwa/index.html", "utf8");
const noteInput = { value: "  update the plan  " };
const sent = [];
let accepted = true;
const context = { document: { getElementById: () => noteInput }, solAction: (...args) => { sent.push(args); return accepted; } };
vm.createContext(context);
vm.runInContext(vega.match(/^function solPlan\(\).*$/m)[0], context);
context.solPlan();
const phoneAccepted = sent[0][0] === "annotate_plan" && sent[0][1].note === "update the plan" && noteInput.value === "";
accepted = false; noteInput.value = "preserve this correction"; context.solPlan();
const phoneRejected = noteInput.value === "preserve this correction";

const checks = [
	["build intent enters flowing mode", /this\.beginFlowingPlan\(text\);[\s\S]{0,100}text = this\.flowingBuildPrompt\(text\)/.test(extension)],
	["build intent no longer returns at approval gate", !/isBuildIntent\(text\)\) \{ this\.requestPlanApproval\(text\); return; \}/.test(extension)],
	["flow contract starts immediately", /Start executing now; do not wait for a separate plan approval/.test(extension)],
	["flow contract preserves evolving PLAN", /Treat later \[FELIX_ARTIFACT_ANNOTATION\] messages as in-flight plan corrections/.test(extension)],
	["desktop note targets active turn", /queueArtifactAnnotation\(m\.artifact, m\.note\)/.test(extension) && /this\.steer\(this\.threadId, saved\.prompt\)/.test(extension)],
	["phone sends plan note and retains it when dispatch fails", phoneAccepted && phoneRejected],
	["relay handles in-flight plan note", /action === "annotate_plan"[\s\S]{0,300}queueArtifactAnnotation\("PLAN\.md", note\)/.test(extension)],
	["plan UI describes non-blocking behavior", /הביצוע מתחיל מיד/.test(planUi) && /עדכן תוך כדי/.test(planUi)],
];

for (const [name, ok] of checks) { assert.ok(ok, name); console.log("ok - " + name); }
console.log(`${checks.length}/${checks.length} checks passed`);
