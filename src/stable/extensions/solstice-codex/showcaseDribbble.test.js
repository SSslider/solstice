"use strict";

// Dribbble renders a shot's own media with alt="" inside a content block, while
// recommendation cards carry descriptive alts. The alt-only rule downloaded 0
// images from real dental shots (26/09). The shot media flag must be computed in
// the page and accepted by the Dribbble project-asset rule.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "webtools", "browse.js"), "utf8");
const body = src.match(/async function showcase\([\s\S]*?\n}\n/)[0];
let checks = 0;
const ok = (fn) => { fn(); checks++; };

ok(() => assert.match(body, /const shotMedia = img\.matches\('\[data-test="v-img"\], \.content-block'\)/));
ok(() => assert.match(body, /alt: img\.alt \|\| '', shotMedia,/));
const rule = body.match(/: \/dribbble\\\.com\$\/i\.test\(sourceHost\)\n\t*\? ([^\n]+)/);
ok(() => assert.ok(rule, "dribbble asset rule present"));
ok(() => assert.match(rule[1], /asset\.shotMedia \|\|/));

// Evaluate the rule on the two real shapes seen on dribbble.com.
const accept = new Function("asset", `return ${rule[1]};`);
const cdn = "https://cdn.dribbble.com/userupload/36643723/file/original-350abab3.png";
ok(() => assert.equal(accept({ url: cdn, alt: "", shotMedia: true }), true));
ok(() => assert.equal(accept({ url: cdn, alt: "", shotMedia: false }), false));
ok(() => assert.equal(accept({ url: cdn, alt: "Natbety - Beauty Product Landing Page", shotMedia: false }), true));
ok(() => assert.equal(accept({ url: "https://example.com/x.png", alt: "", shotMedia: true }), false));

console.log(`showcaseDribbble.test.js: ${checks}/${checks} checks passed`);
