"use strict";

// Reviewed runtime installer for portable Felix skills. Repositories are cloned
// bare, so checkout filters/hooks/scripts never execute. Files are read as Git
// blobs, validated, then atomically copied into globalStorage.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { slug } = require("./felixSkills");

const MAX_FILES = 600;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SINGLE_FILE = 8 * 1024 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function installError(message, code = "SKILL_INSTALL_FAILED") {
	const error = new Error(message);
	error.code = code;
	return error;
}

function normalizeGithubUrl(value) {
	let url;
	try { url = new URL(String(value || "").trim()); } catch { throw installError("Enter a valid GitHub HTTPS repository URL.", "BAD_URL"); }
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
		throw installError("Only public HTTPS github.com repository URLs are allowed in v1.", "BAD_URL");
	}
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 2) throw installError("Use the repository URL: https://github.com/owner/repo", "BAD_URL");
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");
	if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo)) throw installError("Invalid GitHub owner or repository name.", "BAD_URL");
	return { url: `https://github.com/${owner}/${repo}.git`, displayUrl: `https://github.com/${owner}/${repo}`, owner, repo };
}

function run(bin, args, options = {}) {
	return new Promise((resolve, reject) => {
		let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), child;
		try {
			child = spawn(bin, args, { cwd: options.cwd, env: options.env || process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) { reject(error); return; }
		const append = (current, chunk) => {
			const next = Buffer.concat([current, Buffer.from(chunk)]);
			if (next.length > (options.maxBuffer || 24 * 1024 * 1024)) throw installError("Git output exceeded the installer limit.", "TOO_LARGE");
			return next;
		};
		child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { child.kill(); reject(error); } });
		child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { child.kill(); reject(error); } });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(installError(`${bin} exited ${code}: ${stderr.toString("utf8").slice(-800)}`, "GIT_FAILED"));
			else resolve({ stdout, stderr });
		});
	});
}

function parseTree(buffer) {
	const records = buffer.toString("utf8").split("\0").filter(Boolean);
	return records.map((record) => {
		const tab = record.indexOf("\t");
		if (tab < 0) throw installError("Malformed git tree record.", "BAD_TREE");
		const header = record.slice(0, tab).trim().split(/\s+/);
		const file = record.slice(tab + 1);
		return { mode: header[0], type: header[1], sha: header[2], size: Number(header[3]), file };
	});
}

function safeRepoPath(file) {
	const normalized = String(file || "").replace(/\\/g, "/");
	return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") && !normalized.includes("\0");
}

function parseFrontmatter(raw) {
	const match = String(raw || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	const meta = {};
	let body = String(raw || "");
	if (match) {
		body = match[2];
		for (const line of match[1].split(/\r?\n/)) {
			const at = line.indexOf(":");
			if (at < 0 || /^\s/.test(line)) continue;
			meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
	}
	return { meta, body };
}

function csv(value) {
	return String(value || "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function normalizeSkillMarkdown(raw, source) {
	const parsed = parseFrontmatter(raw);
	const originalName = parsed.meta.name || source.repo;
	const name = slug(originalName);
	const tags = [...new Set([...csv(parsed.meta.tags), "external", "github"])];
	const version = Math.max(1, parseInt(parsed.meta.version, 10) || 1);
	const requirements = [...new Set([
		...csv(parsed.meta.requirements),
		...csv(parsed.meta["allowed-tools"]),
		...csv(parsed.meta.tools),
		...csv(parsed.meta.mcp),
		...csv(parsed.meta.dependencies),
	])];
	const frontmatter = [
		"---",
		`name: ${name}`,
		`tags: ${tags.join(", ")}`,
		`version: ${version}`,
		`provenance: github:${source.owner}/${source.repo}@${source.commit.slice(0, 12)}`,
		"verified: false",
		`source: ${source.displayUrl}`,
		`sourceCommit: ${source.commit}`,
		`requirements: ${requirements.join(", ")}`,
		"---",
		"",
	].join("\n");
	return { name, tags, version, requirements, markdown: frontmatter + parsed.body.replace(/^\s+/, "") };
}

class SkillInstaller {
	constructor(options) {
		this.skillsDir = options.skillsDir;
		this.gitBin = options.gitBin || "git";
		this.log = options.log || (() => { });
		this.run = options.run || run;
		this.previews = new Map();
		fs.mkdirSync(this.skillsDir, { recursive: true });
	}

	cleanupExpired() {
		const now = Date.now();
		for (const [id, preview] of this.previews) {
			if (now - preview.createdAt <= PREVIEW_TTL_MS) continue;
			this.discard(id);
		}
	}

	async preview(urlValue, selectedSkill = "") {
		this.cleanupExpired();
		const source = normalizeGithubUrl(urlValue);
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-skill-preview-"));
		const bare = path.join(temp, "repo.git");
		try {
			await this.run(this.gitBin, [
				"-c", "core.hooksPath=/dev/null",
				"-c", "protocol.file.allow=never",
				"-c", "submodule.recurse=false",
				"clone", "--bare", "--depth", "1", "--filter=blob:none", "--no-tags", source.url, bare,
			]);
			const commitResult = await this.run(this.gitBin, ["--git-dir", bare, "rev-parse", "HEAD"]);
			const commit = commitResult.stdout.toString("utf8").trim();
			if (!/^[a-f0-9]{40}$/i.test(commit)) throw installError("GitHub repository returned an invalid commit id.", "BAD_TREE");
			const treeResult = await this.run(this.gitBin, ["--git-dir", bare, "ls-tree", "-r", "-z", "-l", "HEAD"]);
			const tree = parseTree(treeResult.stdout);
			if (!tree.length || tree.length > MAX_FILES) throw installError(`Repository file count must be 1-${MAX_FILES}.`, "TOO_LARGE");
			let totalBytes = 0;
			for (const entry of tree) {
				if (!safeRepoPath(entry.file) || entry.type !== "blob") throw installError(`Unsupported repository entry: ${entry.file}`, "BAD_TREE");
				if (entry.mode === "120000" || entry.mode === "160000") throw installError(`Symlinks and submodules are not allowed: ${entry.file}`, "BAD_TREE");
				if (!Number.isFinite(entry.size) || entry.size < 0 || entry.size > MAX_SINGLE_FILE) throw installError(`File is too large: ${entry.file}`, "TOO_LARGE");
				totalBytes += entry.size;
			}
			if (totalBytes > MAX_BYTES) throw installError(`Skill repository exceeds ${MAX_BYTES} bytes.`, "TOO_LARGE");
			const candidates = tree.filter((entry) => path.posix.basename(entry.file) === "SKILL.md").map((entry) => entry.file).sort();
			if (!candidates.length) throw installError("No SKILL.md was found in the repository.", "NO_SKILL");
			if (selectedSkill && !candidates.includes(selectedSkill)) throw installError("Selected SKILL.md is not present in this commit.", "NO_SKILL");
			if (!selectedSkill && candidates.length > 1) {
				fs.rmSync(temp, { recursive: true, force: true });
				return { selectionRequired: true, sourceUrl: source.displayUrl, candidates };
			}
			const skillPath = selectedSkill || candidates[0];
			const rawResult = await this.run(this.gitBin, ["--git-dir", bare, "show", `HEAD:${skillPath}`], { maxBuffer: MAX_SINGLE_FILE + 1024 });
			const normalized = normalizeSkillMarkdown(rawResult.stdout.toString("utf8"), { ...source, commit });
			const base = path.posix.dirname(skillPath) === "." ? "" : path.posix.dirname(skillPath) + "/";
			const files = tree.filter((entry) => !base || entry.file.startsWith(base)).map((entry) => ({ path: base ? entry.file.slice(base.length) : entry.file, bytes: entry.size, sourcePath: entry.file }));
			const id = crypto.randomBytes(18).toString("hex");
			const preview = { id, createdAt: Date.now(), temp, bare, source: { ...source, commit }, skillPath, base, files, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0), ...normalized };
			this.previews.set(id, preview);
			return this.publicPreview(preview);
		} catch (error) {
			try { fs.rmSync(temp, { recursive: true, force: true }); } catch { }
			throw error;
		}
	}

	publicPreview(preview) {
		return {
			id: preview.id,
			sourceUrl: preview.source.displayUrl,
			commit: preview.source.commit,
			skillPath: preview.skillPath,
			name: preview.name,
			tags: preview.tags,
			version: preview.version,
			requirements: preview.requirements,
			fileCount: preview.files.length,
			totalBytes: preview.totalBytes,
			files: preview.files.map((file) => ({ path: file.path, bytes: file.bytes })),
		};
	}

	async install(id) {
		this.cleanupExpired();
		const preview = this.previews.get(String(id || ""));
		if (!preview) throw installError("Install preview expired; preview the repository again.", "PREVIEW_EXPIRED");
		const destination = path.join(this.skillsDir, preview.name);
		if (fs.existsSync(destination)) throw installError(`Skill '${preview.name}' is already installed. Updates require a new reviewed flow.`, "ALREADY_INSTALLED");
		const tempTarget = destination + `.installing-${crypto.randomBytes(8).toString("hex")}`;
		try {
			fs.mkdirSync(tempTarget, { recursive: false });
			for (const file of preview.files) {
				if (!safeRepoPath(file.path)) throw installError(`Unsafe skill path: ${file.path}`, "PATH_ESCAPE");
				const target = path.resolve(tempTarget, file.path);
				const rel = path.relative(tempTarget, target);
				if (rel.startsWith("..") || path.isAbsolute(rel)) throw installError(`Skill path escapes install root: ${file.path}`, "PATH_ESCAPE");
				fs.mkdirSync(path.dirname(target), { recursive: true });
				let content;
				if (file.sourcePath === preview.skillPath) content = Buffer.from(preview.markdown, "utf8");
				else content = (await this.run(this.gitBin, ["--git-dir", preview.bare, "show", `HEAD:${file.sourcePath}`], { maxBuffer: Math.max(file.bytes + 1024, 1024 * 1024) })).stdout;
				if (content.length > MAX_SINGLE_FILE) throw installError(`File is too large: ${file.path}`, "TOO_LARGE");
				fs.writeFileSync(target, content, { flag: "wx" });
			}
			if (!fs.existsSync(path.join(tempTarget, "SKILL.md"))) throw installError("Normalized SKILL.md was not installed at the skill root.", "NO_SKILL");
			fs.renameSync(tempTarget, destination);
			const result = { ok: true, name: preview.name, destination, sourceUrl: preview.source.displayUrl, commit: preview.source.commit, fileCount: preview.files.length, totalBytes: preview.totalBytes };
			this.log(`[skills] installed ${preview.name} from ${preview.source.displayUrl}@${preview.source.commit.slice(0, 12)}`);
			this.discard(id, false);
			return result;
		} catch (error) {
			try { fs.rmSync(tempTarget, { recursive: true, force: true }); } catch { }
			throw error;
		}
	}

	discard(id, removeTarget = true) {
		const preview = this.previews.get(String(id || ""));
		if (!preview) return;
		this.previews.delete(String(id));
		if (removeTarget !== false || preview.temp) {
			try { fs.rmSync(preview.temp, { recursive: true, force: true }); } catch { }
		}
	}

	dispose() {
		for (const id of [...this.previews.keys()]) this.discard(id);
	}
}

module.exports = { SkillInstaller, normalizeGithubUrl, normalizeSkillMarkdown, parseFrontmatter, parseTree, safeRepoPath };
