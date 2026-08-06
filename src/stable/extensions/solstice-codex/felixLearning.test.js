"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FelixLearning, LEARNING_MODE, inferLearningShape, normalizeDraft, renderApprovedSkill } = require("./felixLearning");

const sha = (char) => char.repeat(64);
const signal = (char, evidence) => ({
	type: "browser-functional-check",
	verified: true,
	verified_by: "browser-check",
	evidence,
	sha256: sha(char),
	observed_at: "2026-08-05T00:00:00Z",
});

(function run() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "felix-learning-active-"));
	const learning = new FelixLearning({ dir: root });
	assert.equal(LEARNING_MODE, "gated-active");
	assert.deepEqual(inferLearningShape("fitness dashboard with animation", ["fitness", "animation"]), { capability: "animation", vertical: "fitness" });
	assert.deepEqual(inferLearningShape("בנה ScrollWorld למאמן כושר", ["fitness", "animation"]), { capability: "scroll-scrub", vertical: "fitness" });
	assert.throws(() => learning.proposeFromBuild({ task: "fitness site" }, null), /verified external success signal/);
	assert.throws(() => normalizeDraft({ level: "capability", name: "x", claim: "x", mechanism: "y", applies_when: ["a"], does_not_apply: [], success_signal: signal("a", "report") }), /does_not_apply/);

	const first = learning.proposeFromBuild({ taskId: "one", task: "fitness dashboard with animation", tags: ["fitness", "animation"], buildMode: "site", provider: "codex" }, signal("a", ".solstice/check-one/report.json"));
	assert.equal(first.length, 2);
	assert.ok(first.every((item) => item.draft.status === "DRAFT" && item.draft.mode === "gated-active"));
	assert.ok(first.every((item) => item.draft.does_not_apply.length >= 3));
	assert.equal(learning.listDrafts().length, 2);
	const autoLearned = [];
	const active = learning.activatePending(first, { learn: (record) => { autoLearned.push(record); return { file: `/active/${record.name}.md`, version: 1 }; } });
	assert.equal(active.activated.length, 2);
	assert.equal(active.failed.length, 0);
	assert.equal(autoLearned.length, 2);
	assert.ok(learning.listDrafts().every((draft) => draft.status === "ACTIVE" && draft.activation.activated_by === "Felix verified outcome gate"));
	assert.equal(learning.proposeFromBuild({ taskId: "one", task: "fitness dashboard with animation", tags: ["fitness", "animation"] }, signal("a", ".solstice/check-one/report.json")).filter((item) => item.created).length, 0);
	const clientDrafts = learning.proposeFromBuild({ taskId: "client", task: "fitness dashboard with animation", tags: ["fitness", "animation"], client: "moshiko" }, signal("a", ".solstice/check-one/report.json"));
	assert.ok(clientDrafts.some((item) => item.draft.level === "client" && item.draft.hierarchy.client === "moshiko"));

	const second = learning.proposeFromBuild({ taskId: "two", task: "dental site with animation", tags: ["dental", "animation"], buildMode: "site", provider: "grok" }, signal("b", ".solstice/check-two/report.json"));
	assert.ok(second.some((item) => item.draft.level === "principle"));
	const principle = learning.listDrafts().find((draft) => draft.level === "principle");
	assert.deepEqual(principle.success_signal.summary.verticals.sort(), ["dental", "fitness"]);

	const pending = learning.listDrafts().find((draft) => draft.level === "capability");
	const learned = [];
	const approval = learning.approve(pending.id, { learn: (record) => { learned.push(record); return { file: "/active/skill.md", version: 1 }; } }, "Thomas");
	assert.equal(approval.draft.status, "APPROVED");
	assert.equal(approval.draft.approval.approved_by, "Thomas");
	assert.equal(learned.length, 1);
	assert.match(learned[0].body, /## Does not apply/);
	assert.match(renderApprovedSkill(approval.draft), /browser-functional-check/);
	assert.throws(() => learning.approve(pending.id, { learn() {} }), /no longer pending/);
	const retryable = learning.listDrafts().find((draft) => draft.status === "DRAFT" && draft.level === "client");
	let retries = 0;
	const failed = learning.activatePending([{ draft: retryable, created: false }], { learn() { retries++; throw new Error("store unavailable"); } });
	assert.equal(failed.failed.length, 1);
	const retried = learning.activatePending([{ draft: retryable, created: false }], { learn() { retries++; return { file: "/active/retry.md", version: 1 }; } });
	assert.equal(retried.activated.length, 1);
	assert.equal(retries, 2);

	const rejectable = learning.listDrafts().find((draft) => draft.status === "DRAFT" && draft.level === "vertical");
	assert.equal(learning.reject(rejectable.id, "too client-specific").status, "REJECTED");
	assert.equal(learning.getDraft(rejectable.id).rejection.reason, "too client-specific");
	assert.equal(fs.readdirSync(path.join(root, "outcome-records")).filter((file) => file.endsWith(".json")).length, 6);
	fs.rmSync(root, { recursive: true, force: true });
	console.log("felixLearning.test.js: 28/28 checks passed");
})();
