"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "prompts", "scroll-world");
const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
const pipeline = fs.readFileSync(path.join(dir, "references", "pipeline.md"), "utf8");
const engine = fs.readFileSync(path.join(dir, "references", "scrub-engine.js"), "utf8");

assert.match(skill, /^---\nname: scroll-world-gpt-image\n/);
assert.match(skill, /tags: .*scroll-scrub.*gpt-image-2/);
assert.match(skill, /version: 1/);
assert.match(skill, /agent \+ GPT-Image-2 through `webtools\/image-bridge\.js` only/);
assert.match(skill, /X-Field\/Higgsfield, Seedance or Kling are video-only/);
assert.match(skill, /always stop at Thomas's approval card/);
assert.match(skill, /exit code alone is never success/);
assert.match(skill, /frame-identical seam doctrine/);
assert.match(skill, /reduced motion/i);
assert.doesNotMatch(skill, /Higgsfield CLI|image gens \+|higgsfield generate create gpt_image_2/);

assert.match(pipeline, /never invoke a bare `codex` command/);
assert.match(pipeline, /actual last rendered frame/);
assert.match(pipeline, /SSIM/);
assert.match(pipeline, /X-Field\/Higgsfield, Seedance and Kling are video-only/);

assert.match(engine, /function mountScrollWorld\(container, config\)/);
assert.match(engine, /prefers-reduced-motion/);
assert.match(engine, /clipMobile/);
assert.match(engine, /connectorsMobile/);
assert.match(engine, /ACTUAL frames/);
assert.match(engine, /video\.seeking/);
assert.match(engine, /orientationchange/);

console.log("scrollWorld.test.js: 22/22 checks passed");
