"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { killTree } = require("./grok");
const { MOONSHOT_API_BASE } = require("./providerOnboarding");

const MAX_TOOL_ROUNDS = 24;
const MAX_TOOL_OUTPUT = 200 * 1024;

const MOONSHOT_TOOLS = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a UTF-8 text file inside the current workspace.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "list_files",
			description: "List files under a workspace directory, bounded to 500 results.",
			parameters: { type: "object", properties: { path: { type: "string", default: "." }, depth: { type: "integer", minimum: 0, maximum: 6, default: 2 } }, additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "search_text",
			description: "Search UTF-8 workspace files for a literal string.",
			parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string", default: "." } }, required: ["query"], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Create or replace a UTF-8 file inside the workspace. Requires Felix approval according to autonomy policy.",
			parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "replace_in_file",
			description: "Replace one exact, unique text fragment in a workspace file. Requires Felix approval according to autonomy policy.",
			parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "run_command",
			description: "Run a shell command in the workspace. Requires Felix approval according to autonomy policy.",
			parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"], additionalProperties: false },
		},
	},
];

function workspacePath(root, value = ".") {
	const base = path.resolve(root);
	const target = path.resolve(base, String(value || "."));
	if (target !== base && !target.startsWith(base + path.sep)) throw new Error("Path is outside the workspace.");
	// Lexical containment is not enough: a symlink inside the workspace may point
	// outside it. Resolve the closest existing ancestor before any read/write.
	const realBase = fs.realpathSync(base);
	let existing = target;
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	const realExisting = fs.realpathSync(existing);
	if (realExisting !== realBase && !realExisting.startsWith(realBase + path.sep)) throw new Error("Path resolves outside the workspace.");
	return target;
}

function bounded(value, max = MAX_TOOL_OUTPUT) {
	const text = String(value == null ? "" : value);
	return text.length <= max ? text : text.slice(0, max) + `\n… truncated ${text.length - max} characters`;
}

function listWorkspaceFiles(root, relative = ".", depth = 2) {
	const start = workspacePath(root, relative);
	const out = [];
	const skip = new Set([".git", "node_modules", ".next", "dist", "build", "out"]);
	const walk = (dir, level) => {
		if (out.length >= 500 || level < 0) return;
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (out.length >= 500 || skip.has(entry.name)) continue;
			const absolute = path.join(dir, entry.name);
			const rel = path.relative(root, absolute) || ".";
			out.push(entry.isDirectory() ? `${rel}/` : rel);
			if (entry.isDirectory() && level > 0) walk(absolute, level - 1);
		}
	};
	walk(start, Math.max(0, Math.min(6, Number(depth) || 0)));
	return out;
}

function searchWorkspace(root, query, relative = ".") {
	const needle = String(query || "");
	if (!needle) throw new Error("Search query is empty.");
	const files = listWorkspaceFiles(root, relative, 6).filter((file) => !file.endsWith("/")).slice(0, 500);
	const matches = [];
	for (const file of files) {
		if (matches.length >= 200) break;
		let text = "";
		try {
			const stat = fs.statSync(workspacePath(root, file));
			if (stat.size > 2 * 1024 * 1024) continue;
			text = fs.readFileSync(workspacePath(root, file), "utf8");
		} catch { continue; }
		text.split(/\r?\n/).forEach((line, index) => {
			if (matches.length < 200 && line.includes(needle)) matches.push(`${file}:${index + 1}:${line.slice(0, 500)}`);
		});
	}
	return matches;
}

async function consumeSse(response, onPayload) {
	let pending = "";
	const consume = (chunk) => {
		pending += chunk;
		let split;
		while ((split = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, split).replace(/\r$/, "");
			pending = pending.slice(split + 1);
			if (!line.startsWith("data:")) continue;
			const raw = line.slice(5).trim();
			if (!raw || raw === "[DONE]") continue;
			try { onPayload(JSON.parse(raw)); } catch { /* ignore malformed keepalive */ }
		}
	};
	if (response.body && typeof response.body.getReader === "function") {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			consume(decoder.decode(value, { stream: true }));
		}
		consume(decoder.decode());
	} else if (response.body && response.body[Symbol.asyncIterator]) {
		for await (const chunk of response.body) consume(Buffer.from(chunk).toString("utf8"));
	} else {
		consume(await response.text());
	}
	consume("\n");
}

class MoonshotProvider {
	constructor(opts = {}) {
		this.cwd = opts.cwd;
		this.apiKey = opts.apiKey || "";
		this.baseUrl = String(opts.baseUrl || MOONSHOT_API_BASE).replace(/\/+$/, "");
		this.model = opts.model || "kimi-k3";
		this.reasoningEffort = opts.reasoningEffort || "high";
		this.fetch = opts.fetchImpl || globalThis.fetch;
		this.spawn = opts.spawnImpl || spawn;
		this.authorizeTool = opts.authorizeTool || null;
		this.log = opts.log || (() => {});
		this.notify = opts.notify || (() => {});
		this.threadId = "moonshot-" + Date.now().toString(36);
		this.messages = [];
		this.system = "";
		this.turns = 0;
		this.seq = 0;
		this.abortController = null;
		this.activeChild = null;
		this._busy = false;
	}

	get busy() { return this._busy; }

	interrupt() {
		const wasBusy = this.busy;
		try { if (this.abortController) this.abortController.abort(); } catch {}
		killTree(this.activeChild);
		return wasBusy;
	}

	dispose() { this.interrupt(); }

	async authorize(name, args) {
		if (["read_file", "list_files", "search_text"].includes(name)) return true;
		if (!this.authorizeTool) return false;
		const result = await this.authorizeTool({ toolName: name, toolInput: args });
		return !!(result && result.decision === "allow");
	}

	async runCommand(command, itemId) {
		return new Promise((resolve) => {
			const isWin = process.platform === "win32";
			const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/bash";
			const args = isWin ? ["/d", "/s", "/c", String(command)] : ["-lc", String(command)];
			const child = this.spawn(shell, args, { cwd: this.cwd, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
			this.activeChild = child;
			let output = "";
			const add = (chunk) => {
				if (output.length >= MAX_TOOL_OUTPUT) return;
				const delta = String(chunk).slice(0, MAX_TOOL_OUTPUT - output.length);
				output += delta;
				this.notify("item/commandExecution/outputDelta", { threadId: this.threadId, itemId, delta });
			};
			if (child.stdout) child.stdout.on("data", add);
			if (child.stderr) child.stderr.on("data", add);
			const timer = setTimeout(() => killTree(child), 5 * 60 * 1000);
			child.on("error", (error) => { clearTimeout(timer); this.activeChild = null; resolve({ ok: false, output: bounded(`${output}\n${error.message}`), exitCode: 1 }); });
			child.on("close", (code) => { clearTimeout(timer); this.activeChild = null; resolve({ ok: code === 0, output: bounded(output), exitCode: code == null ? 1 : code }); });
		});
	}

	async executeTool(call) {
		const name = String(call && call.function && call.function.name || "");
		let args = {};
		try { args = JSON.parse(call && call.function && call.function.arguments || "{}"); }
		catch (error) { return { ok: false, output: `Invalid tool arguments: ${error.message}` }; }
		if (!await this.authorize(name, args)) return { ok: false, output: "Denied by Felix approval policy." };

		const id = "mtl" + this.seq++;
		const isFileChange = name === "write_file" || name === "replace_in_file";
		const command = name === "run_command" ? String(args.command || "") : `${name} ${args.path || args.query || ""}`.trim();
		this.notify("item/started", { threadId: this.threadId, item: isFileChange ? { id, type: "fileChange" } : { id, type: "commandExecution", command } });
		try {
			let result;
			if (name === "read_file") {
				result = { ok: true, output: bounded(fs.readFileSync(workspacePath(this.cwd, args.path), "utf8")) };
			} else if (name === "list_files") {
				result = { ok: true, output: listWorkspaceFiles(this.cwd, args.path, args.depth).join("\n") || "(empty)" };
			} else if (name === "search_text") {
				result = { ok: true, output: searchWorkspace(this.cwd, args.query, args.path).join("\n") || "(no matches)" };
			} else if (name === "write_file") {
				const target = workspacePath(this.cwd, args.path);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, String(args.content), "utf8");
				result = { ok: true, output: `Wrote ${Buffer.byteLength(String(args.content), "utf8")} bytes to ${path.relative(this.cwd, target)}` };
			} else if (name === "replace_in_file") {
				const target = workspacePath(this.cwd, args.path);
				const current = fs.readFileSync(target, "utf8");
				const oldText = String(args.old_text);
				const first = current.indexOf(oldText);
				if (first < 0) throw new Error("old_text was not found");
				if (current.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text is not unique");
				fs.writeFileSync(target, current.slice(0, first) + String(args.new_text) + current.slice(first + oldText.length), "utf8");
				result = { ok: true, output: `Updated ${path.relative(this.cwd, target)}` };
			} else if (name === "run_command") {
				result = await this.runCommand(command, id);
			} else {
				result = { ok: false, output: `Unknown tool: ${name}` };
			}
			if (isFileChange) {
				this.notify("item/completed", { threadId: this.threadId, item: { id, type: "fileChange", status: result.ok ? "completed" : "failed", changes: args.path ? [{ path: args.path }] : [] } });
			} else {
				this.notify("item/completed", { threadId: this.threadId, item: { id, type: "commandExecution", command, exitCode: result.exitCode == null ? (result.ok ? 0 : 1) : result.exitCode, aggregatedOutput: result.output } });
			}
			return result;
		} catch (error) {
			const result = { ok: false, output: String(error && error.message || error) };
			if (isFileChange) this.notify("item/completed", { threadId: this.threadId, item: { id, type: "fileChange", status: "failed", changes: [] } });
			else this.notify("item/completed", { threadId: this.threadId, item: { id, type: "commandExecution", command, exitCode: 1, aggregatedOutput: result.output } });
			return result;
		}
	}

	async completion(messages) {
		if (typeof this.fetch !== "function") throw new Error("Moonshot requires a Solstice runtime with fetch().");
		this.abortController = new AbortController();
		const timeout = setTimeout(() => this.abortController && this.abortController.abort(), 5 * 60 * 1000);
		const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify({
				model: this.model,
				messages,
				tools: MOONSHOT_TOOLS,
				stream: true,
				stream_options: { include_usage: true },
				reasoning_effort: this.reasoningEffort,
			}),
			signal: this.abortController.signal,
		});
		if (!response.ok) {
			clearTimeout(timeout);
			const detail = await response.text().catch(() => "");
			const hint = response.status === 401 || response.status === 403 ? " Reconnect Moonshot from the model picker." : "";
			throw new Error(`Moonshot API HTTP ${response.status}: ${detail.slice(0, 500)}${hint}`);
		}

		const assistant = { role: "assistant", content: "" };
		let reasoning = "";
		let reasoningItem = null;
		let messageItem = null;
		let usage = null;
		const closeReasoning = () => {
			if (!reasoningItem) return;
			this.notify("item/completed", { threadId: this.threadId, item: { id: reasoningItem, type: "reasoning", text: reasoning } });
			reasoningItem = null;
		};
		const closeMessage = () => {
			if (!messageItem) return;
			this.notify("item/completed", { threadId: this.threadId, item: { id: messageItem, type: "agentMessage", text: assistant.content } });
			messageItem = null;
		};
		try { await consumeSse(response, (payload) => {
			if (payload.usage) usage = payload.usage;
			const delta = payload && payload.choices && payload.choices[0] && payload.choices[0].delta;
			if (!delta) return;
			if (delta.reasoning_content) {
				if (!reasoningItem) {
					reasoningItem = "mr" + this.seq++;
					this.notify("item/started", { threadId: this.threadId, item: { id: reasoningItem, type: "reasoning" } });
				}
				reasoning += delta.reasoning_content;
				this.notify("item/reasoning/textDelta", { threadId: this.threadId, itemId: reasoningItem, delta: delta.reasoning_content });
			}
			if (delta.content) {
				closeReasoning();
				if (!messageItem) {
					messageItem = "mm" + this.seq++;
					this.notify("item/started", { threadId: this.threadId, item: { id: messageItem, type: "agentMessage" } });
				}
				assistant.content += delta.content;
				this.notify("item/agentMessage/delta", { threadId: this.threadId, itemId: messageItem, delta: delta.content });
			}
			for (const fragment of delta.tool_calls || []) {
				if (!assistant.tool_calls) assistant.tool_calls = [];
				const index = Number(fragment.index || 0);
				if (!assistant.tool_calls[index]) assistant.tool_calls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
				const target = assistant.tool_calls[index];
				if (fragment.id) target.id += fragment.id;
				if (fragment.function && fragment.function.name) target.function.name += fragment.function.name;
				if (fragment.function && fragment.function.arguments) target.function.arguments += fragment.function.arguments;
			}
		}); } finally { clearTimeout(timeout); }
		closeReasoning();
		closeMessage();
		if (reasoning) assistant.reasoning_content = reasoning;
		if (usage) this.notify("usage", { threadId: this.threadId, model: this.model, exact: true, total: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 } });
		return assistant;
	}

	async send(text, preamble) {
		if (this.busy) throw new Error("a turn is already running");
		if (!this.apiKey) throw new Error("Moonshot is not connected. Select Kimi K3 and complete the connection flow.");
		this._busy = true;
		this.turns++;
		const turnId = "mt" + this.turns;
		this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
		try {
			if (preamble) this.system = String(preamble);
			this.messages.push({ role: "user", content: String(text || "") });
			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				const requestMessages = [{ role: "system", content: this.system }, ...this.messages];
				const assistant = await this.completion(requestMessages);
				this.messages.push(assistant);
				const calls = (assistant.tool_calls || []).filter((call) => call && call.id && call.function && call.function.name);
				if (!calls.length) break;
				for (const call of calls) {
					const result = await this.executeTool(call);
					this.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
				}
				if (round === MAX_TOOL_ROUNDS - 1) throw new Error(`Moonshot exceeded ${MAX_TOOL_ROUNDS} tool rounds.`);
			}
			if (this.messages.length > 60) this.messages = this.messages.slice(-60);
		} catch (error) {
			const message = error && error.name === "AbortError" ? "Moonshot turn interrupted." : String(error && error.message || error);
			this.notify("turn/engineFailed", { threadId: this.threadId, turnId, model: this.model, error: { message } });
			this.notify("error", { threadId: this.threadId, error: { message } });
			this.log(`[moonshot] ${message}\n`);
		} finally {
			this.abortController = null;
			this._busy = false;
			this.notify("turn/completed", { threadId: this.threadId, turn: { id: turnId } });
		}
	}
}

module.exports = {
	MAX_TOOL_ROUNDS,
	MOONSHOT_TOOLS,
	MoonshotProvider,
	bounded,
	consumeSse,
	listWorkspaceFiles,
	searchWorkspace,
	workspacePath,
};
