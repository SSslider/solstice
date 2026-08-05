"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "media", "skills.js"), "utf8");
const learning = fs.readFileSync(path.join(__dirname, "felixLearning.js"), "utf8");

assert.match(extension, /new FelixLearning\(/);
assert.match(extension, /type: "browser-functional-check"[\s\S]*?sha256: digestFile\(saved\.file\)/);
assert.match(extension, /draftLearningFromBuild\(this\._activeBuild\)/);
assert.match(extension, /this\._learningSignals\.delete\(b\.taskId\)/);
assert.doesNotMatch(extension, /this\.skills\.recordUse\(/);
assert.doesNotMatch(extension, /this\.skills\.rememberLesson\(/);
assert.doesNotMatch(extension, /learnFromBuild\(/);
assert.match(extension, /approveLearning[\s\S]*?"Approve and activate"[\s\S]*?controller\.learning\.approve/);
assert.match(extension, /rejectLearning[\s\S]*?controller\.learning\.reject/);
assert.match(panel, /does_not_apply/);
assert.match(panel, /SHADOW/);
assert.match(learning, /new Set\(\["principle", "capability", "vertical", "client"\]\)/);
assert.match(learning, /status: "DRAFT"/);
assert.match(learning, /A verified external success signal is required/);
assert.match(learning, /does_not_apply is required/);

console.log("felixLearningIntegration.test.js: 15/15 checks passed");
