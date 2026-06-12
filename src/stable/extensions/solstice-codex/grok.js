"use strict";
const { spawn } = require("child_process");

// Both fallback models are served by the same `grok` CLI (Grok Build TUI).
const GROK_MODELS = {
	"grok-build": { id: "grok-build", label: "Grok 4.3 Build" },
	"composer-2.5": { id: "grok-composer-2.5-fast", label: "Composer 2.5 Fast" },
};

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
