"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ManagerWorktrees } = require("./managerWorktrees");

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

async function main() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-manager-test-"));
	const repo = path.join(base, "project");
	fs.mkdirSync(repo);
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "felix@example.test"]);
	git(repo, ["config", "user.name", "Felix Test"]);
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "base.txt"]);
	git(repo, ["commit", "-m", "base"]);

	const manager = new ManagerWorktrees(repo, { limit: 2 });
	const one = await manager.create("Landing page");
	const two = await manager.create("Dashboard");
	assert.notStrictEqual(one.worktree, two.worktree);
	assert.strictEqual(manager.activeCount(), 2);
	await assert.rejects(() => manager.create("Third"), /supports 2 concurrent builds/);

	manager.attachThread(one.id, "thread-one");
	assert.strictEqual(manager.forThread("thread-one").id, one.id);
	fs.writeFileSync(path.join(one.worktree, "base.txt"), "changed by task one\n");
	fs.writeFileSync(path.join(one.worktree, "new file.txt"), "new file\n");
	fs.writeFileSync(path.join(one.worktree, "pixel.bin"), Buffer.from([0, 255, 1, 2, 3]));
	manager.setStatus(one.id, "ready_review");
	const inspected = await manager.inspect(one.id);
	assert.match(inspected.status, /base\.txt/);
	assert.deepStrictEqual(inspected.untracked, ["new file.txt", "pixel.bin"]);

	const review = await manager.review(one.id);
	assert.ok(review.patch.includes("base.txt"));
	assert.match(review.patchHash, /^[a-f0-9]{64}$/);
	await assert.rejects(() => manager.merge(one.id, "stale"), /changed after review/);
	const result = await manager.merge(one.id, review.patchHash);
	assert.ok(result.patchBytes > 0);
	assert.strictEqual(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "changed by task one\n");
	assert.strictEqual(fs.readFileSync(path.join(repo, "new file.txt"), "utf8"), "new file\n");
	assert.deepStrictEqual([...fs.readFileSync(path.join(repo, "pixel.bin"))], [0, 255, 1, 2, 3]);
	assert.strictEqual(manager.get(one.id).status, "merged");

	await manager.remove(two.id);
	assert.strictEqual(manager.get(two.id).status, "removed");
	fs.rmSync(base, { recursive: true, force: true });
	process.stdout.write("managerWorktrees: 16/16 assertions passed\n");
}

main().catch((error) => {
	process.stderr.write(String(error && error.stack || error) + "\n");
	process.exitCode = 1;
});
