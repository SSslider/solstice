"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixSkills } = require("./felixSkills");
const { SkillInstaller, normalizeGithubUrl, normalizeSkillMarkdown } = require("./skillInstaller");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-skill-installer-test-"));
const store = path.join(root, "felix-skills");
const commit = "1234567890abcdef1234567890abcdef12345678";
const skillSource = [
	"---",
	"name: portable-demo",
	"description: A portable external skill",
	"allowed-tools: Read, Bash",
	"---",
	"# Portable demo",
	"Read `references/guide.md` before acting.",
].join("\n");
const blobs = {
	"skills/demo/SKILL.md": Buffer.from(skillSource),
	"skills/demo/references/guide.md": Buffer.from("# Guide\nNo scripts are executed.\n"),
	"README.md": Buffer.from("outside skill directory"),
};

function treeFor(sourceBlobs = blobs, modes = {}) {
	return Buffer.from(Object.entries(sourceBlobs).map(([file, body], i) => `${modes[file] || "100644"} blob ${String(i + 1).padStart(40, "a")} ${body.length}\t${file}\0`).join(""));
}

function fakeGit(sourceBlobs = blobs, modes = {}) {
	const calls = [];
	const run = async (_bin, args) => {
		calls.push(args.slice());
		if (args.includes("clone")) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		if (args.includes("rev-parse")) return { stdout: Buffer.from(commit + "\n"), stderr: Buffer.alloc(0) };
		if (args.includes("ls-tree")) return { stdout: treeFor(sourceBlobs, modes), stderr: Buffer.alloc(0) };
		const ref = args.find((arg) => String(arg).startsWith("HEAD:"));
		if (ref) return { stdout: sourceBlobs[ref.slice(5)], stderr: Buffer.alloc(0) };
		throw new Error("unexpected git call: " + args.join(" "));
	};
	return { run, calls };
}

assert.equal(normalizeGithubUrl("https://github.com/oso95/scroll-world").url, "https://github.com/oso95/scroll-world.git");
assert.throws(() => normalizeGithubUrl("http://github.com/oso95/scroll-world"), /Only public HTTPS/);
assert.throws(() => normalizeGithubUrl("https://gitlab.com/oso95/scroll-world"), /Only public HTTPS/);
assert.throws(() => normalizeGithubUrl("https://github.com/oso95/scroll-world/tree/main"), /repository URL/);
const normalized = normalizeSkillMarkdown(skillSource, { owner: "owner", repo: "repo", displayUrl: "https://github.com/owner/repo", commit });
assert.equal(normalized.name, "portable-demo");
assert.deepEqual(normalized.requirements, ["Read", "Bash"]);
assert.match(normalized.markdown, /sourceCommit: 1234567890abcdef/);
assert.match(normalized.markdown, /verified: false/);

(async () => {
	const git = fakeGit();
	const installer = new SkillInstaller({ skillsDir: path.join(store, "skills"), run: git.run });
	const preview = await installer.preview("https://github.com/owner/repo");
	assert.equal(preview.name, "portable-demo");
	assert.equal(preview.fileCount, 2);
	assert.equal(preview.skillPath, "skills/demo/SKILL.md");
	assert.deepEqual(preview.requirements, ["Read", "Bash"]);
	assert.ok(git.calls.find((args) => args.includes("--bare")));
	assert.ok(git.calls.find((args) => args.includes("core.hooksPath=/dev/null")));
	assert.ok(!git.calls.some((args) => args.includes("checkout") || args.includes("submodule")));

	const installed = await installer.install(preview.id);
	assert.equal(installed.ok, true);
	assert.ok(fs.existsSync(path.join(installed.destination, "SKILL.md")));
	assert.ok(fs.existsSync(path.join(installed.destination, "references", "guide.md")));
	assert.ok(!fs.existsSync(path.join(installed.destination, "README.md")));
	assert.match(fs.readFileSync(path.join(installed.destination, "SKILL.md"), "utf8"), /provenance: github:owner\/repo@1234567890ab/);

	const felix = new FelixSkills({ dir: store });
	const listed = felix.list().find((item) => item.meta.name === "portable-demo");
	assert.ok(listed);
	assert.equal(listed.skillDir, installed.destination);
	assert.ok(listed.body.includes("references/guide.md"));

	await assert.rejects(() => installer.preview("file:///tmp/skill"), /Only public HTTPS/);
	await assert.rejects(() => installer.preview("https://github.com/owner/repo", "missing/SKILL.md"), /not present/);

	const multiBlobs = { ...blobs, "second/SKILL.md": Buffer.from("# second") };
	const multi = new SkillInstaller({ skillsDir: path.join(root, "multi"), run: fakeGit(multiBlobs).run });
	const selection = await multi.preview("https://github.com/owner/repo");
	assert.equal(selection.selectionRequired, true);
	assert.deepEqual(selection.candidates, ["second/SKILL.md", "skills/demo/SKILL.md"]);

	const symlink = new SkillInstaller({ skillsDir: path.join(root, "symlink"), run: fakeGit(blobs, { "skills/demo/references/guide.md": "120000" }).run });
	await assert.rejects(() => symlink.preview("https://github.com/owner/repo"), /Symlinks and submodules/);

	const seededStore = path.join(root, "seeded");
	const seeded = new FelixSkills({ dir: seededStore });
	seeded.seedFrom(__dirname);
	const scrollWorld = seeded.list().find((item) => item.meta.name === "scroll-world-gpt-image");
	assert.ok(scrollWorld);
	assert.ok(fs.existsSync(path.join(scrollWorld.skillDir, "references", "scrub-engine.js")));

	installer.dispose(); multi.dispose(); symlink.dispose();
	fs.rmSync(root, { recursive: true, force: true });
	console.log("skillInstaller.test.js: 30/30 checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
