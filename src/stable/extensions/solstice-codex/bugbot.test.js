"use strict";
const assert = require("assert");
const { parseFindings } = require("./bugbot");

const findings = parseFindings('```json\n{"findings":[{"severity":"HIGH","file":"src/a.js","line":12,"message":"Race drops the stop request."},{"file":"src/b.js","line":0,"message":"Unhandled null."}]}\n```');
assert.equal(findings.length, 2);
assert.equal(findings[0].severity, "high");
assert.equal(findings[0].line, 12);
assert.equal(findings[1].severity, "medium");
assert.equal(findings[1].line, 1);
assert.deepEqual(parseFindings("not json"), []);
assert.deepEqual(parseFindings('{"findings":[]}'), []);
console.log("bugbot.test.js: 7/7 checks passed");
