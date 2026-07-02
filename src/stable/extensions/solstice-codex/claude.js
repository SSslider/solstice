"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { unifiedDiff, killTree } = require("./grok");
const { resolveWinSpawn } = require("./winspawn");

const CLAUDE_LABEL = "Claude Code";

// Flatten a tool_result content payload (string | [{type:"text",text}…]) to text.
function contentText(c) {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c.map((b) => (b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n");
	}
	return "";
}

// Drives the `claude` CLI (Claude Code) in --print stream-json mode and re-emits
// its events using the codex app-server notification vocabulary, so both
// webviews render Claude turns with zero changes (same trick as grok.js).
//
// Event mapping (claude stream-json → codex item vocabulary):
//   system/init                  → capture session_id (for --resume on turn 2+)
//   stream_event text_delta      → item/agentMessage/delta
//   stream_event thinking_delta  → item/reasoning/textDelta
//   assistant tool_use Bash      → item/started commandExecution
//   assistant tool_use Read      → commandExecution + commandActions[{type:"read"}]
//   assistant tool_use Grep/Glob → commandExecution + commandActions[{type:"search"}]
//   assistant tool_use Edit/Write/NotebookEdit → item/started fileChange (+synth diff)
//   assistant tool_use WebSearch → webSearch {query}; WebFetch → webSearch openPage
//   assistant tool_use Task      → collabAgentToolCall
//   assistant tool_use TodoWrite → turn/plan/updated (no card)
//   assistant tool_use mcp__s__t / other → mcpToolCall
//   user tool_result             → item/completed (aggregatedOutput / exit info)
//   rate_limit_event             → account/rateLimits/updated
//   result                       → error (if is_error) ; close → turn/completed
class ClaudeProvider {
	constructor(opts) {
		this.cwd = opts.cwd;
		this.bin = opts.bin || "claude";
		this.model = opts.model || "";                          // "" = CLI default
		this.permissionMode = opts.permissionMode || "acceptEdits";
		this.log = opts.log || (() => { });
		this.notify = opts.notify;
		this.threadId = "claude-" + Date.now().toString(36);
		this.sessionId = null;  // claude CLI session — resumed on turn 2+
		this.child = null;
		this.turns = 0;
		this.seq = 0;
	}

	get busy() { return !!this.child; }

	interrupt() {
		killTree(this.child);
	}

	relPath(p) {
		if (!p) return p;
		const r = path.relative(this.cwd, p);
		return r && !r.startsWith("..") ? r : p;
	}

	// fileChange `changes` entries (with a synthesized diff for the Changes card)
	fileChangeFor(name, input) {
		if (name === "Edit") {
			const p = input.file_path || "";
			return [{ path: p, diff: unifiedDiff(this.relPath(p), input.old_string, input.new_string) }];
		}
		if (name === "Write") {
			const p = input.file_path || "";
			const abs = path.isAbsolute(p) ? p : path.join(this.cwd, p);
			let old = null;
			try { old = fs.readFileSync(abs, "utf8"); } catch { /* new file */ }
			return [{
				path: p,
				kind: { type: old == null ? "add" : "update" },
				diff: unifiedDiff(this.relPath(p), old || "", input.content || ""),
			}];
		}
		// NotebookEdit & friends — path only, no diff
		return [{ path: input.notebook_path || input.file_path || "" }];
	}

	// codex-vocabulary item for a claude tool_use block (null = no card)
	startItemFor(name, input) {
		input = input || {};
		switch (name) {
			case "Bash":
				return { type: "commandExecution", command: input.command || "" };
			case "Read":
				return {
					type: "commandExecution", command: "read " + (input.file_path || ""),
					commandActions: [{ type: "read", path: input.file_path || "" }],
				};
			case "Grep":
				return {
					type: "commandExecution", command: "grep " + (input.pattern || ""),
					commandActions: [{ type: "search", query: input.pattern || "", path: input.path || "" }],
				};
			case "Glob":
				return {
					type: "commandExecution", command: "glob " + (input.pattern || ""),
					commandActions: [{ type: "search", query: input.pattern || "", path: input.path || "" }],
				};
			case "Edit":
			case "Write":
			case "NotebookEdit":
				return { type: "fileChange", changes: this.fileChangeFor(name, input) };
			case "WebSearch":
				return { type: "webSearch", query: input.query || "" };
			case "WebFetch":
				return { type: "webSearch", action: { type: "openPage", url: input.url || "" } };
			case "Task":
			case "Agent":
				return {
					type: "collabAgentToolCall",
					tool: input.subagent_type || "agent",
					prompt: input.description || input.prompt || "",
				};
			default: {
				if (name.startsWith("mcp__")) {
					const rest = name.slice(5);
					const i = rest.indexOf("__");
					if (i > 0) return { type: "mcpToolCall", server: rest.slice(0, i), tool: rest.slice(i + 2) };
					return { type: "mcpToolCall", tool: rest };
				}
				return { type: "mcpToolCall", tool: name };
			}
		}
	}

	send(text, preamble) {
		if (this.child) return Promise.reject(new Error("a turn is already running"));
		const prompt = this.turns === 0 && preamble ? `${preamble}\n\n## Task\n${text}` : text;
		const args = [
			"--print",
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			"--permission-mode", this.permissionMode,
		];
		if (this.sessionId) args.push("--resume", this.sessionId);
		if (this.model) args.push("--model", this.model);
		this.turns++;
		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY;   // force Claude Max OAuth, never API-key billing
		delete env.ANTHROPIC_BASE_URL;
		const tid = this.threadId;
		const turnId = "ct" + this.turns;
		this.notify("turn/started", { threadId: tid, turn: { id: turnId } });

		// ---- per-turn stream state ----
		const blocks = new Map();  // stream index -> {kind, id, text, done} for the current message
		const tools = new Map();   // tool_use_id -> {item, silent, done}
		const turnDiffs = [];      // cumulative synthesized diffs → turn/diff/updated

		const completeBlock = (b, fullText) => {
			if (!b || b.done) return;
			b.done = true;
			if (b.kind === "agentMessage") {
				this.notify("item/completed", { threadId: tid, item: { id: b.id, type: "agentMessage", text: fullText != null ? fullText : b.text } });
			} else if (b.kind === "reasoning") {
				this.notify("item/completed", { threadId: tid, item: { id: b.id, type: "reasoning", text: fullText != null ? fullText : b.text } });
			}
		};

		const onStream = (ev) => {
			if (ev.type === "message_start") { blocks.clear(); return; }
			if (ev.type === "content_block_start") {
				const cb = ev.content_block || {};
				if (cb.type === "text") {
					const b = { kind: "agentMessage", id: "cm" + this.seq++, text: cb.text || "", done: false };
					blocks.set(ev.index, b);
					this.notify("item/started", { threadId: tid, item: { id: b.id, type: "agentMessage" } });
					if (b.text) this.notify("item/agentMessage/delta", { threadId: tid, itemId: b.id, delta: b.text });
				} else if (cb.type === "thinking") {
					const b = { kind: "reasoning", id: "cr" + this.seq++, text: cb.thinking || "", done: false };
					blocks.set(ev.index, b);
					this.notify("item/started", { threadId: tid, item: { id: b.id, type: "reasoning" } });
				} else {
					// tool_use — card starts from the full `assistant` event (complete input)
					blocks.set(ev.index, { kind: "tool", done: false });
				}
				return;
			}
			if (ev.type === "content_block_delta") {
				const b = blocks.get(ev.index);
				const d = ev.delta || {};
				if (!b || b.done) return;
				if (d.type === "text_delta" && b.kind === "agentMessage" && d.text) {
					b.text += d.text;
					this.notify("item/agentMessage/delta", { threadId: tid, itemId: b.id, delta: d.text });
				} else if (d.type === "thinking_delta" && b.kind === "reasoning" && d.thinking) {
					b.text += d.thinking;
					this.notify("item/reasoning/textDelta", { threadId: tid, itemId: b.id, delta: d.thinking });
				}
				return;
			}
		};

		const onToolUse = (cb) => {
			if (tools.has(cb.id)) return;
			const input = cb.input || {};
			if (cb.name === "TodoWrite") {
				// claude's native plan tool → live checklist, no card
				const todos = Array.isArray(input.todos) ? input.todos : [];
				const plan = todos.map((t) => ({
					step: (t && (t.content || t.activeForm)) || "",
					status: t && t.status === "completed" ? "completed" : t && t.status === "in_progress" ? "inProgress" : "pending",
				})).filter((s) => s.step);
				if (plan.length) this.notify("turn/plan/updated", { threadId: tid, plan });
				tools.set(cb.id, { silent: true, done: false });
				return;
			}
			const base = this.startItemFor(cb.name, input);
			const item = { id: "ctl" + this.seq++, ...base };
			tools.set(cb.id, { item, silent: false, done: false });
			this.notify("item/started", { threadId: tid, item });
		};

		const onAssistant = (msg) => {
			const content = Array.isArray(msg.content) ? msg.content : [];
			content.forEach((cb, i) => {
				if (!cb) return;
				if (cb.type === "text") {
					const b = blocks.get(i);
					if (b && b.kind === "agentMessage") completeBlock(b, cb.text || b.text);
					else if (!b) {
						// no partial stream (e.g. --include-partial-messages unsupported) — render final
						const nb = { kind: "agentMessage", id: "cm" + this.seq++, text: cb.text || "", done: false };
						blocks.set(i, nb);
						completeBlock(nb);
					}
				} else if (cb.type === "thinking") {
					const b = blocks.get(i);
					if (b && b.kind === "reasoning") completeBlock(b, cb.thinking || b.text);
				} else if (cb.type === "tool_use") {
					onToolUse(cb);
				}
			});
		};

		const onToolResults = (e) => {
			const content = e.message && e.message.content;
			if (!Array.isArray(content)) return;
			const results = content.filter((c) => c && c.type === "tool_result");
			for (const cb of results) {
				const t = tools.get(cb.tool_use_id);
				if (!t || t.done) continue;
				t.done = true;
				if (t.silent) continue;
				const isErr = !!cb.is_error;
				const status = isErr ? "failed" : "completed";
				let out = contentText(cb.content);
				// top-level tool_use_result is only attributable with a single result
				const tur = results.length === 1 ? e.tool_use_result : null;
				const item = t.item;
				if (item.type === "commandExecution") {
					let exitCode = isErr ? 1 : 0;
					if (tur && (typeof tur.stdout === "string" || typeof tur.stderr === "string")) {
						const s = [tur.stdout, tur.stderr].filter(Boolean).join("\n");
						if (s) out = s;
						if (typeof tur.exitCode === "number") exitCode = tur.exitCode;
						else if (typeof tur.exit_code === "number") exitCode = tur.exit_code;
						if (tur.interrupted && !exitCode) exitCode = 130;
					}
					this.notify("item/completed", {
						threadId: tid,
						item: { ...item, exitCode, aggregatedOutput: out, status },
					});
				} else if (item.type === "fileChange") {
					this.notify("item/completed", { threadId: tid, item: { ...item, status } });
					if (!isErr) {
						for (const c of item.changes || []) if (c && c.diff) turnDiffs.push(c.diff);
						if (turnDiffs.length) this.notify("turn/diff/updated", { threadId: tid, diff: turnDiffs.join("\n") });
					}
				} else if (item.type === "webSearch") {
					this.notify("item/completed", { threadId: tid, item: { ...item, status } });
				} else { // mcpToolCall / collabAgentToolCall
					this.notify("item/completed", {
						threadId: tid,
						item: {
							...item, status,
							result: out ? { content: [{ text: out }] } : undefined,
							error: isErr ? { message: out.split("\n")[0] || "failed" } : undefined,
						},
					});
				}
			}
		};

		const onLine = (e) => {
			if (e.type === "system" && e.subtype === "init") {
				if (e.session_id) this.sessionId = e.session_id;
				return;
			}
			if (e.type === "rate_limit_event" && e.rate_limit_info) {
				const info = e.rate_limit_info;
				const mins = info.rateLimitType === "seven_day" ? 7 * 24 * 60
					: info.rateLimitType === "five_hour" ? 300 : undefined;
				this.notify("account/rateLimits/updated", {
					rateLimits: { primary: { usedPercent: Math.round((info.utilization || 0) * 100), windowDurationMins: mins } },
				});
				return;
			}
			// nested sub-agent traffic stays inside its collabAgentToolCall card
			if (e.parent_tool_use_id) return;
			if (e.type === "stream_event" && e.event) { onStream(e.event); return; }
			if (e.type === "assistant" && e.message) { onAssistant(e.message); return; }
			if (e.type === "user" && e.message) { onToolResults(e); return; }
			if (e.type === "result") {
				if (e.session_id) this.sessionId = e.session_id;
				if (e.is_error) {
					this.notify("error", {
						threadId: tid,
						error: { message: (typeof e.result === "string" && e.result) || ("claude turn failed (" + (e.subtype || "error") + ")") },
					});
				}
				return;
			}
		};

		return new Promise((resolve) => {
			// Windows npm-shim EPERM guard (see winspawn.js) — no-op on Linux/macOS.
			const sp = resolveWinSpawn(this.bin, args);
			// EXACT 04075-proven flag set: { cwd, env, detached:true } — NO windowsHide
			// (the Friday-06/27 delta from the last build that ran; ignored under
			// DETACHED_PROCESS anyway). See GROUND-TRUTH note in codexClient.js:start.
			const child = spawn(sp.cmd, sp.args, { cwd: this.cwd, env: sp.env ? { ...env, ...sp.env } : env, detached: true });
			this.child = child;
			child.stdin.write(prompt);
			child.stdin.end();
			let buf = "";
			child.stdout.on("data", (d) => {
				buf += d.toString();
				let i;
				while ((i = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line) continue;
					try { onLine(JSON.parse(line)); } catch { this.log(line + "\n"); }
				}
			});
			child.stderr.on("data", (d) => this.log(d.toString()));
			child.on("error", (e) => {
				this.child = null;
				this.notify("error", {
					threadId: tid,
					error: { message: `Could not start the claude CLI (${this.bin}): ${e.message}. Install Claude Code and sign in once (claude auth), then retry.` },
				});
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
			child.on("close", (code) => {
				if (!this.child) return; // already resolved via "error"
				this.child = null;
				// close any block still streaming (interrupted turn)
				for (const b of blocks.values()) completeBlock(b);
				if (code !== 0 && code !== null) {
					this.notify("error", { threadId: tid, error: { message: `claude exited with code ${code} — check the Felix output log.` } });
				}
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
		});
	}
}

module.exports = { ClaudeProvider, CLAUDE_LABEL };
