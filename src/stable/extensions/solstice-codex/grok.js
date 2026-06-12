"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Synthesize a unified diff from a full-file edit (oldText -> newText) by
// trimming the common prefix/suffix lines — enough for the panel's Changes card.
function unifiedDiff(relPath, oldText, newText) {
	const a = oldText == null ? [] : String(oldText).split("\n");
	const b = newText == null ? [] : String(newText).split("\n");
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const aMid = a.slice(p, a.length - s);
	const bMid = b.slice(p, b.length - s);
	if (!aMid.length && !bMid.length) return "";
	const ctx = 2;
	const cs = Math.max(0, p - ctx);
	const preCtx = a.slice(cs, p);
	const postCtx = a.slice(a.length - s, Math.min(a.length, a.length - s + ctx));
	const lines = ["--- a/" + relPath, "+++ b/" + relPath];
	lines.push("@@ -" + (cs + 1) + "," + (preCtx.length + aMid.length + postCtx.length) +
		" +" + (cs + 1) + "," + (preCtx.length + bMid.length + postCtx.length) + " @@");
	for (const l of preCtx) lines.push(" " + l);
	for (const l of aMid) lines.push("-" + l);
	for (const l of bMid) lines.push("+" + l);
	for (const l of postCtx) lines.push(" " + l);
	return lines.join("\n");
}

// Both fallback models are served by the same `grok` CLI (Grok Build TUI).
const GROK_MODELS = {
	"grok-build": { id: "grok-build", label: "Grok 4.3 Build" },
	"composer-2.5": { id: "grok-composer-2.5-fast", label: "Composer 2.5 Fast" },
};

// The grok CLI's streaming-json stdout only carries thought/text chunks.
// Tool activity (shell commands, file edits, reads) is written to the
// session's updates.jsonl under ~/.grok/sessions/<urlencoded-cwd>/<id>/.
// Tail that file in parallel so the webviews get the same rich cards
// (commandExecution / fileChange / mcpToolCall) codex turns produce.
class UpdatesTailer {
	constructor(cwd, sinceMs, onUpdate, log) {
		this.sessionsDir = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(cwd));
		this.sinceMs = sinceMs;
		this.onUpdate = onUpdate;
		this.log = log;
		this.file = null;
		this.offset = 0;
		this.timer = null;
		this.stopped = false;
	}

	start() {
		this.timer = setInterval(() => this.tick(), 300);
	}

	tick() {
		try {
			if (!this.file) {
				this.file = this.findFile();
				if (!this.file) return;
			}
			const size = fs.statSync(this.file).size;
			if (size <= this.offset) return;
			const fd = fs.openSync(this.file, "r");
			const buf = Buffer.alloc(size - this.offset);
			fs.readSync(fd, buf, 0, buf.length, this.offset);
			fs.closeSync(fd);
			this.offset = size;
			for (const line of buf.toString("utf8").split("\n")) {
				const s = line.trim();
				if (!s) continue;
				try {
					const e = JSON.parse(s);
					const u = e && e.params && e.params.update;
					if (u) this.onUpdate(u);
				} catch { /* partial last line — re-read next tick via offset rollback */
					this.offset -= Buffer.byteLength(line, "utf8");
					break;
				}
			}
		} catch (err) {
			this.log("updates tailer: " + err.message + "\n");
		}
	}

	findFile() {
		let dirs;
		try { dirs = fs.readdirSync(this.sessionsDir); } catch { return null; }
		let best = null, bestMtime = 0;
		for (const d of dirs) {
			const f = path.join(this.sessionsDir, d, "updates.jsonl");
			try {
				const st = fs.statSync(f);
				if (st.mtimeMs >= this.sinceMs && st.mtimeMs > bestMtime) { best = f; bestMtime = st.mtimeMs; }
			} catch { }
		}
		return best;
	}

	// flush any remaining lines, then stop
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.tick();
		clearInterval(this.timer);
	}
}

// Drives the grok CLI in headless streaming-json mode and re-emits its events
// using the codex app-server notification vocabulary, so both webviews render
// grok turns with zero changes.
class GrokProvider {
	constructor(opts) {
		this.cwd = opts.cwd;
		this.bin = opts.bin || "grok";
		this.log = opts.log || (() => { });
		this.notify = opts.notify;
		this.threadId = "grok-" + Date.now().toString(36);
		this.child = null;
		this.turns = 0;
		this.seq = 0;
	}

	get busy() { return !!this.child; }

	interrupt() {
		if (this.child) { try { this.child.kill("SIGTERM"); } catch { } }
	}

	send(providerKey, text, preamble) {
		if (this.child) return Promise.reject(new Error("a turn is already running"));
		const model = GROK_MODELS[providerKey] || GROK_MODELS["grok-build"];
		const prompt = this.turns === 0 && preamble ? `${preamble}\n\n## Task\n${text}` : text;
		const args = ["--cwd", this.cwd, "-m", model.id, "--always-approve", "--output-format", "streaming-json"];
		// -c continues the CLI's most recent session for this cwd (turn 2+)
		if (this.turns > 0) args.push("-c");
		args.push("-p", prompt);
		this.turns++;
		const env = { ...process.env };
		delete env.XAI_API_KEY;    // force grok CLI OAuth, never API-key billing
		delete env.OPENAI_API_KEY;
		const tid = this.threadId;
		const turnId = "gt" + this.turns;
		this.notify("turn/started", { threadId: tid, turn: { id: turnId } });

		let reasoning = null; // { id, text }
		let message = null;   // { id, text }
		const closeReasoning = () => {
			if (!reasoning) return;
			this.notify("item/completed", { threadId: tid, item: { id: reasoning.id, type: "reasoning", text: reasoning.text } });
			reasoning = null;
		};
		const closeMessage = () => {
			if (!message) return;
			this.notify("item/completed", { threadId: tid, item: { id: message.id, type: "agentMessage", text: message.text } });
			message = null;
		};
		const onEvent = (e) => {
			if (e.type === "thought") {
				closeMessage();
				if (!reasoning) {
					reasoning = { id: "gr" + this.seq++, text: "" };
					this.notify("item/started", { threadId: tid, item: { id: reasoning.id, type: "reasoning" } });
				}
				reasoning.text += e.data || "";
				this.notify("item/reasoning/textDelta", { threadId: tid, itemId: reasoning.id, delta: e.data || "" });
			} else if (e.type === "text") {
				closeReasoning();
				if (!message) {
					message = { id: "gm" + this.seq++, text: "" };
					this.notify("item/started", { threadId: tid, item: { id: message.id, type: "agentMessage" } });
				}
				message.text += e.data || "";
				this.notify("item/agentMessage/delta", { threadId: tid, itemId: message.id, delta: e.data || "" });
			} else if (e.type === "error") {
				this.notify("error", { threadId: tid, error: { message: e.message || "grok error" } });
			}
		};

		// ---- tool activity from updates.jsonl → codex item vocabulary ----
		const tools = new Map(); // toolCallId -> { id, kind, command, out, paths, done, started }
		const turnDiffs = []; // cumulative synthesized diffs for this turn
		const updateText = (u) => {
			const c = Array.isArray(u.content) && u.content[0];
			if (c && c.type === "content" && c.content && typeof c.content.text === "string") return c.content.text;
			return null;
		};
		const updatePaths = (u) => {
			const out = [];
			for (const c of u.content || []) if (c && c.type === "diff" && c.path) out.push(c.path);
			for (const l of u.locations || []) if (l && l.path) out.push(l.path);
			return [...new Set(out)];
		};
		const onUpdate = (u) => {
			if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return;
			const tcId = u.toolCallId;
			if (!tcId) return;
			let t = tools.get(tcId);
			if (!t) {
				t = { id: "gtl" + this.seq++, kind: null, command: null, out: "", paths: [], done: false, started: false, title: "" };
				tools.set(tcId, t);
			}
			if (u.title) t.title = u.title;
			if (u.rawInput && u.rawInput.command) t.command = u.rawInput.command;
			if (u.kind) t.kind = u.kind;
			if (!t.kind) {
				if (t.command) t.kind = "execute";
				else if ((u.content || []).some((c) => c && c.type === "diff")) t.kind = "edit";
			}
			const paths = updatePaths(u);
			for (const p of paths) if (!t.paths.includes(p)) t.paths.push(p);
			for (const c of u.content || []) {
				if (c && c.type === "diff" && c.path) {
					if (!t.diffs) t.diffs = new Map();
					t.diffs.set(c.path, { o: c.oldText, n: c.newText });
				}
			}

			// start the card once the kind is known
			if (!t.started && t.kind) {
				t.started = true;
				if (t.kind === "execute") {
					this.notify("item/started", { threadId: tid, item: { id: t.id, type: "commandExecution", command: t.command || t.title } });
				} else if (t.kind === "edit") {
					this.notify("item/started", { threadId: tid, item: { id: t.id, type: "fileChange" } });
				} else {
					this.notify("item/started", { threadId: tid, item: { id: t.id, type: "mcpToolCall", tool: t.title || t.kind } });
				}
			}
			if (!t.started || t.done) return;

			// stream command output (updates carry the FULL text each time)
			if (t.kind === "execute") {
				const txt = updateText(u);
				if (txt !== null && txt.length > t.out.length && txt.startsWith(t.out)) {
					const delta = txt.slice(t.out.length);
					t.out = txt;
					this.notify("item/commandExecution/outputDelta", { threadId: tid, itemId: t.id, delta });
				} else if (txt !== null && txt !== t.out && txt.length >= t.out.length) {
					t.out = txt;
				}
			}

			if (u.status === "completed" || u.status === "failed") {
				t.done = true;
				if (t.kind === "execute") {
					const exitCode = u.rawOutput && typeof u.rawOutput.exit_code === "number" ? u.rawOutput.exit_code : (u.status === "failed" ? 1 : 0);
					this.notify("item/completed", {
						threadId: tid,
						item: { id: t.id, type: "commandExecution", command: t.command || t.title, exitCode, aggregatedOutput: t.out },
					});
				} else if (t.kind === "edit") {
					this.notify("item/completed", {
						threadId: tid,
						item: { id: t.id, type: "fileChange", changes: t.paths.map((p) => ({ path: p })) },
					});
					if (t.diffs) {
						for (const [p, d] of t.diffs) {
							const rel = path.relative(this.cwd, p);
							const ud = unifiedDiff(rel && !rel.startsWith("..") ? rel : p, d.o, d.n);
							if (ud) turnDiffs.push(ud);
						}
						t.diffs = null;
						if (turnDiffs.length) this.notify("turn/diff/updated", { threadId: tid, diff: turnDiffs.join("\n") });
					}
				} else {
					this.notify("item/completed", {
						threadId: tid,
						item: { id: t.id, type: "mcpToolCall", tool: t.title || t.kind, status: u.status === "failed" ? "failed" : "completed" },
					});
				}
			}
		};
		const tailer = new UpdatesTailer(this.cwd, Date.now() - (this.turns > 1 ? 6 * 3600 * 1000 : 2000), onUpdate, this.log);
		tailer.start();
		// turn 2+ continues an existing session file — skip its history
		if (this.turns > 1) {
			const f = tailer.findFile();
			if (f) { tailer.file = f; try { tailer.offset = fs.statSync(f).size; } catch { } }
		}

		return new Promise((resolve) => {
			const child = spawn(this.bin, args, { cwd: this.cwd, env });
			this.child = child;
			let buf = "";
			child.stdout.on("data", (d) => {
				buf += d.toString();
				let i;
				while ((i = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line) continue;
					try { onEvent(JSON.parse(line)); } catch { this.log(line + "\n"); }
				}
			});
			child.stderr.on("data", (d) => this.log(d.toString()));
			child.on("error", (e) => {
				this.child = null;
				tailer.stop();
				this.notify("error", {
					threadId: tid,
					error: { message: `Could not start the grok CLI (${this.bin}): ${e.message}. Install it and sign in once, then retry.` },
				});
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
			child.on("close", (code) => {
				if (!this.child) return; // already resolved via "error"
				this.child = null;
				tailer.stop();
				closeReasoning();
				closeMessage();
				if (code !== 0 && code !== null) {
					this.notify("error", { threadId: tid, error: { message: `grok exited with code ${code} — check the Solstice Agent output log.` } });
				}
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
		});
	}
}

module.exports = { GrokProvider, GROK_MODELS };
