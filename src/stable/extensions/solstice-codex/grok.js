"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { resolveWinSpawn, whichFull } = require("./winspawn");

// ── Bundled grok engine ────────────────────────────────────────────────────
// Composer 2.5 / Grok run on the @xai-official/grok engine — a native per-
// platform binary. It was NEVER bundled (only codex was), so on a clean install
// switching GPT-5.5 → Composer had NO engine to spawn: bare `spawn grok EPERM`,
// or the "isn't installed" snap-back. THAT — not switch order — is why Composer
// kept failing. We now bundle the engine like codex.exe so every model is
// runnable out of the box, in any order. The payload ships brotli-compressed
// (bin/grok[.exe].br, ~31MB) and is decompressed to bin/grok[.exe] (~107MB) on
// first use — the same scheme @xai-official/grok's own trampoline uses.
function grokBinName() {
	return process.platform === "win32" ? "grok.exe" : "grok";
}
// Cheap presence check (NO decompression) — used for availability before send.
function grokBundlePresent(extensionPath) {
	const out = path.join(extensionPath, "bin", grokBinName());
	try { return fs.existsSync(out) || fs.existsSync(out + ".br"); } catch { return false; }
}
// Ensure the bundled engine is decompressed and return its path, or null when
// no bundled payload is present. Decompress is atomic (tmp + rename) and only
// happens once (first Composer/Grok run after install).
function ensureBundledGrok(extensionPath) {
	const out = path.join(extensionPath, "bin", grokBinName());
	try {
		if (fs.existsSync(out)) return out;
		const br = out + ".br";
		if (!fs.existsSync(br)) return null;
		const data = zlib.brotliDecompressSync(fs.readFileSync(br));
		const tmp = out + ".tmp." + process.pid;
		fs.writeFileSync(tmp, data);
		if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
		fs.renameSync(tmp, out);
		return out;
	} catch { return null; }
}
// Resolution order: explicit setting → bundled engine → PATH. Mirrors
// resolveCodexBinary so Composer/Grok behave like GPT-5.5 (always runnable).
function resolveGrokBinary(extensionPath, configuredPath) {
	// Ignore a configuredPath that points back at our OWN bundled bin dir. An
	// earlier broken build may have persisted that path into the user's settings —
	// and it's the UNSIGNED binary Defender blocks. Honor only a real, external
	// user-set path. (Prime regression suspect: the bundled engine, and any setting
	// pointing at it, did NOT exist in the build that worked for a week.)
	const bundledDir = path.join(extensionPath, "bin");
	const pointsAtOurBundle = (p) => {
		try { return path.resolve(p).toLowerCase().startsWith(path.resolve(bundledDir).toLowerCase()); }
		catch { return false; }
	};
	if (configuredPath && fs.existsSync(configuredPath) && !pointsAtOurBundle(configuredPath)) return configuredPath;
	// Prefer the user's INSTALLED grok — Defender-trusted, and the EXACT path that
	// worked for a week of Composer use (run the npm-global grok.cmd via the user's
	// node). whichFull now also searches the npm/node install dirs a GUI PATH omits.
	try { const g = whichFull("grok"); if (g) return g; } catch { /* ignore */ }
	// Only when the user has NO grok at all: the bundled engine. It is UNSIGNED, so
	// spawning it ahead of an installed grok is exactly what Defender blocks →
	// `spawn EPERM` + a Defender alert. Last resort, never the default.
	const bundled = ensureBundledGrok(extensionPath);
	if (bundled) return bundled;
	return "grok";
}

// SIGTERM the whole process group, not just the CLI parent. The grok/claude
// CLIs spawn their own model subprocess; killing only the parent orphans it.
// detached:true at spawn makes the child a group leader so process.kill(-pid)
// reaches the entire subtree. Falls back to a plain kill if the group is gone.
function killTree(child, signal = "SIGTERM") {
	if (!child || child.killed || !child.pid) return;
	// Windows has NO POSIX process groups: process.kill(-pid) throws a bare
	// `EPERM` (this is the "EPERM on model switch" Thomas hit — switching tears
	// down the previous model's detached child, and the group-kill blew up on
	// Windows while it was a no-op cost on Linux/mac). Use taskkill /T to kill
	// the whole tree the detached child leads; fall back to a plain kill.
	if (process.platform === "win32") {
		try { require("child_process").execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }
		catch { try { child.kill(); } catch { } }
		return;
	}
	try { process.kill(-child.pid, signal); }
	catch { try { child.kill(signal); } catch { } }
}

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

// Declarative model registry — the single source of truth for every provider
// Felix can drive. Slotting in a newer/stronger model is one entry here:
//   runner: which CLI spawns it (codex | grok | claude)
//   grokId: the model id passed to the grok CLI (grok runner only)
//   gated:  true => hidden unless explicitly opted in (e.g. claudeAllowed())
//   order:  display order in the model picker
// The auto-failover chain (package.json solstice.codex.failoverChain) references
// these keys; Claude is intentionally excluded from any auto chain (gated).
const MODEL_REGISTRY = {
	"gpt-5.5": { label: "GPT-5.5 (Codex)", desc: "ChatGPT subscription — full agent: plans, approvals, image gen", runner: "codex", order: 0 },
	"claude": { label: "Claude Code", desc: "claude CLI — opt-in via solstice.codex.allowClaude", runner: "claude", gated: true, order: 1 },
	"grok-build": { label: "Grok 4.3 Build", desc: "grok CLI — agentic fallback when Codex quota runs out", runner: "grok", grokId: "grok-build", order: 2 },
	"composer-2.5": { label: "Composer 2.5 Fast", desc: "grok CLI — fast builder", runner: "grok", grokId: "grok-composer-2.5-fast", order: 3 },
};

// Which CLI runner serves a given model key (defaults to codex).
function runnerFor(key) {
	const m = MODEL_REGISTRY[key];
	return (m && m.runner) || "codex";
}

// Both fallback models are served by the same `grok` CLI (Grok Build TUI).
// Derived from MODEL_REGISTRY so there is a single source of truth.
const GROK_MODELS = Object.fromEntries(
	Object.entries(MODEL_REGISTRY)
		.filter(([, m]) => m.runner === "grok")
		.map(([key, m]) => [key, { id: m.grokId || key, label: m.label }])
);

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
		this.extensionPath = opts.extensionPath || "";
		this.log = opts.log || (() => { });
		this.notify = opts.notify;
		this.threadId = "grok-" + Date.now().toString(36);
		this.child = null;
		this.turns = 0;
		this.seq = 0;
		this.tokens = { in: 0, out: 0 }; // session-cumulative (real if CLI emits usage, else estimate)
		this.tokensExact = false;
		// Conversation history kept in-process. Each turn re-sends the recent
		// history baked into the prompt instead of using grok's `-c` resume —
		// see the comment in send() for why.
		this.history = []; // [{ role: "user"|"assistant", text }]
		this._sys = "";    // remembered system prompt (sent every turn)
	}

	get busy() { return !!this.child; }

	interrupt() {
		killTree(this.child);
	}

	// Bake the recent conversation into the prompt (stateless multi-turn). Last 8
	// entries (~4 exchanges) is enough context to continue without re-sending the
	// whole transcript every turn.
	_composePrompt(text) {
		const recent = this.history.slice(-8);
		if (!recent.length) return text;
		const block = recent.map((h) => (h.role === "user" ? "User: " : "Assistant: ") + h.text).join("\n\n");
		return `══ recent conversation so far (context only — continue from it, don't repeat it) ══\n${block}\n\n══ current request ══\n${text}`;
	}

	send(providerKey, text, preamble) {
		if (this.child) return Promise.reject(new Error("a turn is already running"));
		const model = GROK_MODELS[providerKey] || GROK_MODELS["grok-build"];

		// STATELESS turn — NO `-c` resume. Root cause of "stuck after the first
		// prompt": `grok -c` resuming a large session (after a long build) performs
		// a long, completely SILENT context reload — no stdout AND no tool activity —
		// that scales with session size, so any idle watchdog kills it before it
		// speaks. Our own fleet runs the SAME grok/Composer binary robustly by NOT
		// resuming: it re-sends recent history in the prompt, splits the system
		// prompt from the user prompt, and uses a generous total-time budget with no
		// idle kill. We mirror that proven pattern here.
		if (preamble) this._sys = preamble;            // remember system prompt across turns
		const userPrompt = this._composePrompt(text);
		// History+prompt can be large → pass via --prompt-file (avoids ARG_MAX).
		const promptFile = path.join(os.tmpdir(), `solstice-grok-${Date.now().toString(36)}-${this.seq++}.txt`);
		try { fs.writeFileSync(promptFile, userPrompt, "utf8"); } catch { }
		const args = ["--cwd", this.cwd, "-m", model.id,
			"--permission-mode", "bypassPermissions",
			// Composer occasionally hallucinates PascalCase Claude-Code tool names;
			// blocking them makes those fail fast instead of SIGTERM-killing the turn.
			"--disallowed-tools", "Read,Write,Edit,Bash,Glob,Grep,List,LS,WebFetch,WebSearch",
			"--output-format", "streaming-json"];
		if (this._sys) args.push("--system-prompt-override", this._sys);
		args.push("--prompt-file", promptFile);
		this.turns++;
		const turnIn = Math.ceil((userPrompt || "").length / 4);
		let turnOut = 0; // estimated from streamed deltas unless the CLI reports real usage
		this.tokens.in += turnIn;
		const env = { ...process.env };
		delete env.XAI_API_KEY;    // force grok CLI OAuth, never API-key billing
		delete env.OPENAI_API_KEY;
		const tid = this.threadId;
		const turnId = "gt" + this.turns;
		this.notify("turn/started", { threadId: tid, turn: { id: turnId } });

		let reasoning = null; // { id, text }
		let message = null;   // { id, text }
		let assistantOut = ""; // full assistant text this turn → saved to history
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
				turnOut += Math.ceil((e.data || "").length / 4);
				this.notify("item/reasoning/textDelta", { threadId: tid, itemId: reasoning.id, delta: e.data || "" });
			} else if (e.type === "usage" && e.data && typeof e.data === "object") {
				// real token usage if the grok CLI ever reports it — overrides the estimate
				const inT = Number(e.data.input_tokens || e.data.prompt_tokens || 0);
				const outT = Number(e.data.output_tokens || e.data.completion_tokens || 0);
				if (inT || outT) { this.tokens.in += inT - turnIn; this.tokens.out += outT; turnOut = -1; this.tokensExact = true; }
			} else if (e.type === "text") {
				closeReasoning();
				if (!message) {
					message = { id: "gm" + this.seq++, text: "" };
					this.notify("item/started", { threadId: tid, item: { id: message.id, type: "agentMessage" } });
				}
				message.text += e.data || "";
				assistantOut += e.data || "";
				turnOut += Math.ceil((e.data || "").length / 4);
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
		// Every turn is now a fresh grok session (stateless), so always tail the
		// newest session file created from ~now — the same logic that made turn 1 work.
		const tailer = new UpdatesTailer(this.cwd, Date.now() - 2000, onUpdate, this.log);
		tailer.start();

		return new Promise((resolve) => {
			// On Windows the grok CLI is an npm .cmd shim that CreateProcess can't
			// launch directly (=> `spawn grok EPERM`); resolveWinSpawn rewrites it to
			// a direct `node <cli.js>` invocation, preserving the newline-bearing
			// --system-prompt-override arg. No-op on Linux/macOS.
			const sp = resolveWinSpawn(this.bin, args);
			// detached:true everywhere — the 04075-proven flag set (see the EMPIRICAL
			// note in codexClient.js:start; same reasoning, same field evidence).
			const child = spawn(sp.cmd, sp.args, { cwd: this.cwd, env: sp.env ? { ...env, ...sp.env } : env, detached: true, windowsHide: true });
			this.child = child;
			let buf = "";
			const cleanupFile = () => { try { fs.unlinkSync(promptFile); } catch { } };
			// Total-turn budget — NOT an idle watchdog. A turn is ended only if it
			// exceeds the whole-turn wall-clock ceiling; we never kill on "silence"
			// because real work (npm install, big edits, model thinking) is legitimately
			// quiet for stretches. 30 min mirrors the fleet's proven Composer budget.
			const TURN_BUDGET_MS = 30 * 60 * 1000;
			let timedOut = false;
			const budgetTimer = setTimeout(() => {
				if (!this.child) return;
				timedOut = true;
				killTree(this.child);
			}, TURN_BUDGET_MS);
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
				clearTimeout(budgetTimer);
				tailer.stop();
				cleanupFile();
				// EPERM diagnostic — on Windows a bare `spawn <name> EPERM` means the
				// resolver handed CreateProcess a .cmd/.bat shim it can't launch. Log
				// the EXACT command we tried so this is never a guessing game again:
				// which bin, which resolved cmd, whether winspawn cracked the shim.
				let epermDiag = "";
				if (e && (e.code === "EPERM" || /EPERM/i.test(e.message || ""))) {
					const grokOnPath = require("./winspawn").whichFull(this.bin);
					const nodeOnPath = require("./winspawn").whichFull("node");
					const bundledDir = path.join(this.extensionPath || "", "bin");
					const usingBundled = sp.cmd && bundledDir && path.resolve(sp.cmd).toLowerCase().startsWith(path.resolve(bundledDir).toLowerCase());
					epermDiag =
						`\n\n[EPERM] grok spawn failed — exact cause:\n` +
						`• tried to launch : ${sp.cmd}\n` +
						`• that file is    : ${usingBundled ? "the UNSIGNED bundled engine (Defender blocks this)" : "your installed grok"}\n` +
						`• your installed grok : ${grokOnPath || "NOT FOUND on PATH"}\n` +
						`• node : ${nodeOnPath || "NOT FOUND on PATH"}`;
					this.log(epermDiag + "\n");
				}
				this.notify("error", {
					threadId: tid,
					// Surface the FULL diagnostic INLINE in the chat — never make the user
					// dig through View → Output. The next failure explains itself here.
					error: { message: `Could not start Composer/grok (${this.bin}): ${e.message}.${epermDiag}` },
				});
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
			child.on("close", (code) => {
				if (!this.child) return; // already resolved via "error"
				this.child = null;
				clearTimeout(budgetTimer);
				tailer.stop();
				cleanupFile();
				closeReasoning();
				closeMessage();
				// Record the exchange so the NEXT turn has context (stateless multi-turn).
				this.history.push({ role: "user", text });
				this.history.push({ role: "assistant", text: assistantOut.trim() || "(no text response)" });
				if (this.history.length > 16) this.history = this.history.slice(-16);
				if (timedOut) {
					this.notify("error", { threadId: tid, error: { message: `grok turn exceeded the ${Math.round(TURN_BUDGET_MS / 60000)}-minute budget and was ended. Anything already produced is kept — your next message continues from here.` } });
				} else if (code !== 0 && code !== null) {
					this.notify("error", { threadId: tid, error: { message: `grok exited with code ${code} — check the Felix output log.` } });
				}
				if (turnOut >= 0) this.tokens.out += turnOut; // estimate path (real usage already applied)
				this.notify("usage", { threadId: tid, model, exact: this.tokensExact, turn: { in: turnIn, out: turnOut < 0 ? null : turnOut }, total: { in: this.tokens.in, out: this.tokens.out } });
				this.notify("turn/completed", { threadId: tid, turn: { id: turnId } });
				resolve();
			});
		});
	}
}

module.exports = { GrokProvider, GROK_MODELS, MODEL_REGISTRY, runnerFor, unifiedDiff, killTree, resolveGrokBinary, grokBundlePresent };
