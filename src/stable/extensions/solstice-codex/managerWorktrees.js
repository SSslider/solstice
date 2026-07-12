"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ACTIVE_STATES = new Set(["creating", "idle", "running", "awaiting_approval", "ready_review"]);

function safeId(value) {
	return String(value || "task")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "task";
}

function runGit(cwd, args, input, allowedCodes = [0]) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += String(d); });
		child.stderr.on("data", (d) => { stderr += String(d); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (allowedCodes.includes(code)) resolve(stdout);
			else reject(new Error(`git ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim()}`));
		});
		if (input) child.stdin.end(input); else child.stdin.end();
	});
}

class ManagerWorktrees {
	constructor(root, opts = {}) {
		this.root = path.resolve(root);
		this.limit = Math.max(1, Number(opts.limit || 2));
		this.log = typeof opts.log === "function" ? opts.log : () => {};
		this.tasks = new Map();
		this.threadToTask = new Map();
		this.storeDir = path.join(this.root, ".git", "solstice-manager");
		this.storeFile = path.join(this.storeDir, "tasks.json");
		this.worktreeRoot = path.join(path.dirname(this.root), ".solstice-worktrees");
		this.load();
	}

	load() {
		let rows = [];
		try { rows = JSON.parse(fs.readFileSync(this.storeFile, "utf8")); } catch {}
		for (const raw of Array.isArray(rows) ? rows : []) {
			if (!raw || !raw.id || !raw.worktree) continue;
			const task = { ...raw };
			if (!fs.existsSync(task.worktree) && task.status !== "merged" && task.status !== "removed") task.status = "missing";
			this.tasks.set(task.id, task);
			if (task.threadId) this.threadToTask.set(task.threadId, task.id);
		}
	}

	persist() {
		fs.mkdirSync(this.storeDir, { recursive: true });
		fs.writeFileSync(this.storeFile, JSON.stringify(this.list(), null, 2) + "\n", "utf8");
	}

	list() {
		return [...this.tasks.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
	}

	get(id) { return this.tasks.get(id) || null; }
	forThread(threadId) { return this.get(this.threadToTask.get(threadId)); }

	activeCount() {
		return this.list().filter((task) => ACTIVE_STATES.has(task.status)).length;
	}

	async create(label) {
		if (this.activeCount() >= this.limit) throw new Error(`Manager View supports ${this.limit} concurrent builds in this release.`);
		const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
		const id = `${safeId(label || "build")}-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
		const repo = safeId(path.basename(this.root));
		const worktree = path.join(this.worktreeRoot, `${repo}-${id}`);
		fs.mkdirSync(this.worktreeRoot, { recursive: true });
		const task = { id, label: String(label || "New build").slice(0, 100), worktree, status: "creating", createdAt: Date.now(), updatedAt: Date.now(), threadId: null, diffStat: "" };
		this.tasks.set(id, task);
		this.persist();
		try {
			await runGit(this.root, ["worktree", "add", "--detach", worktree, "HEAD"]);
			task.status = "idle";
			task.baseCommit = (await runGit(worktree, ["rev-parse", "HEAD"])).trim();
			task.updatedAt = Date.now();
			this.persist();
			this.log(`[manager] created ${id} at ${worktree}\n`);
			return task;
		} catch (error) {
			task.status = "error";
			task.error = error.message;
			this.persist();
			throw error;
		}
	}

	attachThread(taskId, threadId) {
		const task = this.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		task.threadId = threadId;
		task.updatedAt = Date.now();
		this.threadToTask.set(threadId, taskId);
		this.persist();
		return task;
	}

	setStatus(taskId, status, extra = {}) {
		const task = this.get(taskId);
		if (!task) return null;
		Object.assign(task, extra, { status, updatedAt: Date.now() });
		this.persist();
		return task;
	}

	async inspect(taskId) {
		const task = this.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		const [status, stat, untrackedRaw] = await Promise.all([
			runGit(task.worktree, ["status", "--short"]),
			runGit(task.worktree, ["diff", "--stat", "--", "."]),
			runGit(task.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
		]);
		const untracked = untrackedRaw.split("\0").filter(Boolean);
		task.changedFiles = status.split(/\r?\n/).filter(Boolean).length;
		task.untrackedFiles = untracked;
		task.diffStat = stat.trim();
		task.updatedAt = Date.now();
		this.persist();
		return { status, stat, untracked };
	}

	async patch(taskId) {
		const task = this.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		const untrackedRaw = await runGit(task.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
		const untracked = untrackedRaw.split("\0").filter(Boolean);
		try {
			// Intent-to-add makes Git emit canonical new-file patches (including binary
			// files and paths with spaces) without staging content or creating commits.
			if (untracked.length) await runGit(task.worktree, ["add", "-N", "--", ...untracked]);
			return await runGit(task.worktree, ["diff", "--binary", "--", "."]);
		} finally {
			if (untracked.length) await runGit(task.worktree, ["reset", "--", ...untracked]).catch(() => {});
		}
	}

	async review(taskId) {
		const task = this.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		if (task.status === "running" || task.status === "awaiting_approval") throw new Error("Stop or finish the build before reviewing its merge.");
		await this.inspect(taskId);
		const patch = await this.patch(taskId);
		if (!patch.trim()) throw new Error("This build has no changes to review.");
		return {
			patch,
			patchHash: crypto.createHash("sha256").update(patch).digest("hex"),
			patchBytes: Buffer.byteLength(patch),
			task: this.get(taskId),
		};
	}

	async merge(taskId, expectedPatchHash) {
		const task = this.get(taskId);
		if (!task) throw new Error(`Unknown manager task: ${taskId}`);
		if (task.status === "running" || task.status === "awaiting_approval") throw new Error("Stop or finish the build before merging.");
		const patch = await this.patch(taskId);
		if (!patch.trim()) throw new Error("This build has no changes to merge.");
		const patchHash = crypto.createHash("sha256").update(patch).digest("hex");
		if (!expectedPatchHash || expectedPatchHash !== patchHash) throw new Error("The diff changed after review. Review the latest diff before merging.");
		await runGit(this.root, ["apply", "--check", "--binary", "-"], patch);
		await runGit(this.root, ["apply", "--binary", "-"], patch);
		this.setStatus(taskId, "merged", { mergedAt: Date.now() });
		return { patchBytes: Buffer.byteLength(patch), patchHash, task: this.get(taskId) };
	}

	async remove(taskId) {
		const task = this.get(taskId);
		if (!task) return;
		if (task.status === "running" || task.status === "awaiting_approval") throw new Error("Stop the build before removing its worktree.");
		await runGit(this.root, ["worktree", "remove", "--force", task.worktree]);
		this.setStatus(taskId, "removed", { removedAt: Date.now() });
	}
}

module.exports = { ManagerWorktrees, runGit, safeId };
