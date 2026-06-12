"use strict";
const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CodexClient, resolveCodexBinary } = require("./codexClient");
const { PreviewServer } = require("./preview");
const { GrokProvider, GROK_MODELS } = require("./grok");

const SIDEBAR_FORWARDED = new Set([
	"thread/started",
	"turn/started",
	"turn/completed",
	"turn/plan/updated",
	"item/started",
	"item/completed",
	"item/agentMessage/delta",
	"item/reasoning/textDelta",
	"item/reasoning/summaryTextDelta",
	"item/commandExecution/outputDelta",
	"item/fileChange/patchUpdated",
	"account/rateLimits/updated",
	"error",
]);

const MANAGER_FORWARDED = new Set([
	...SIDEBAR_FORWARDED,
	"thread/status/changed",
	"thread/name/updated",
	"turn/diff/updated",
]);

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);

function workspaceCwd() {
	const f = vscode.workspace.workspaceFolders;
	return f && f[0] ? f[0].uri.fsPath : undefined;
}

class AgentController {
	constructor(context) {
		this.context = context;
		this.client = null;
		this.threadId = null;          // the sidebar's active thread
		this.lastDiff = "";
		this.webview = null;           // sidebar webview
		this.manager = null;           // manager panel webview
		this.threads = new Map();      // threadId -> {id, preview, status, activeTurnId, plan, diff, updatedAt}
		this.loaded = new Set();       // threadIds resumed/started in this server process
		this.pendingApprovals = new Map(); // approvalKey -> resolve(decision)
		this.preview = null;
		this.previewUrl = "";
		this.grok = null;
		this.grokWatcher = null;
		this.grokChanged = null;
		this.fallbackPrompted = false;
		this.output = vscode.window.createOutputChannel("Solstice Agent");
	}

	async openPreview(explicitUrl) {
		let url = explicitUrl || "";
		if (!url) {
			const root = workspaceCwd();
			if (!root) { vscode.window.showWarningMessage("Open a folder to preview."); return; }
			if (!this.preview) this.preview = new PreviewServer(root);
			const port = await this.preview.ensure();
			let rel = "index.html";
			if (!fs.existsSync(path.join(root, rel))) {
				const found = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**", 1);
				if (found.length) rel = vscode.workspace.asRelativePath(found[0]);
			}
			url = `http://127.0.0.1:${port}/${rel}`;
		}
		this.previewUrl = url;
		await vscode.commands.executeCommand(
			"simpleBrowser.api.open", vscode.Uri.parse(url),
			{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true }
		).then(undefined, () => vscode.commands.executeCommand("simpleBrowser.show", url));
	}

	refreshPreview() {
		if (!this.previewUrl) return;
		vscode.commands.executeCommand(
			"simpleBrowser.api.open", vscode.Uri.parse(this.previewUrl),
			{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true }
		).then(undefined, () => { });
	}

	writePlanFile(th) {
		const root = workspaceCwd();
		if (!root || !th || !Array.isArray(th.plan) || !th.plan.length) return;
		const dir = path.join(root, ".solstice");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
		const marks = { completed: "[x]", inProgress: "[~]", pending: "[ ]" };
		const lines = th.plan.map((s, i) =>
			`${i + 1}. ${marks[s.status] || "[ ]"} ${s.step}${s.status === "inProgress" ? "   ← current" : ""}`);
		const title = (th.preview || "").split("\n")[0].slice(0, 80);
		const text = `# Agent Plan\n\n${title ? "_" + title + "_\n\n" : ""}${lines.join("\n")}\n`;
		const file = path.join(dir, "PLAN.md");
		try { fs.writeFileSync(file, text); } catch { return; }
		if (!this.planFileOpened) {
			this.planFileOpened = true;
			vscode.window.showTextDocument(vscode.Uri.file(file), {
				viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
			}).then(undefined, () => { });
		}
	}

	onFilesChanged(item) {
		const root = workspaceCwd();
		const paths = (item.changes || []).map((c) => c.path || c.file).filter(Boolean);
		for (const p of paths.slice(0, 3)) {
			const abs = path.isAbsolute(p) ? p : path.join(root || "", p);
			let stat;
			try { stat = fs.statSync(abs); } catch { continue; }
			if (!stat.isFile() || stat.size > 1500000) continue;
			vscode.window.showTextDocument(vscode.Uri.file(abs), {
				viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
			}).then(undefined, () => { });
		}
		// first .html the agent writes → open the live preview automatically
		if (!this.previewUrl && paths.some((p) => p.endsWith(".html"))) {
			this.openPreview("").then(undefined, () => { });
			return;
		}
		this.refreshPreview();
	}

	cfg() {
		return vscode.workspace.getConfiguration("solstice.codex");
	}

	providerKey() {
		return this.cfg().get("provider") || "composer-2.5";
	}

	providerLabel() {
		const k = this.providerKey();
		return k === "gpt-5.5" ? "gpt-5.5" : (GROK_MODELS[k] ? GROK_MODELS[k].label : k);
	}

	async selectModel() {
		const cur = this.providerKey();
		const items = [
			{ key: "gpt-5.5", label: "GPT-5.5 (Codex)", description: "ChatGPT subscription — full agent: plans, approvals, image gen" },
			{ key: "grok-build", label: "Grok 4.3 Build", description: "grok CLI — agentic fallback when Codex quota runs out" },
			{ key: "composer-2.5", label: "Composer 2.5 Fast", description: "grok CLI — fast builder" },
		].map((it) => (it.key === cur ? { ...it, label: "$(check) " + it.label } : it));
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "Solstice agent model" });
		if (!pick) return;
		await this.cfg().update("provider", pick.key, vscode.ConfigurationTarget.Global);
		this.applyProviderToWebviews();
	}

	applyProviderToWebviews() {
		const mt = { type: "thread", model: this.providerLabel() };
		this.post(mt);
		this.postManager(mt);
		if (this.providerKey() !== "gpt-5.5") {
			const auth = { type: "auth", authMethod: "grok-cli" };
			this.post(auth);
			this.postManager(auth);
		} else {
			this.refreshAccount().catch(() => { });
			this.refreshAccount("manager").catch(() => { });
		}
	}

	suggestFallback() {
		if (this.fallbackPrompted) return;
		this.fallbackPrompted = true;
		vscode.window.showWarningMessage(
			"Codex (GPT-5.5) hit its usage limit. Switch the Solstice agent to a fallback model?",
			"Grok 4.3 Build", "Composer 2.5 Fast", "Stay"
		).then(async (pick) => {
			const key = pick === "Grok 4.3 Build" ? "grok-build" : pick === "Composer 2.5 Fast" ? "composer-2.5" : null;
			if (!key) return;
			await this.cfg().update("provider", key, vscode.ConfigurationTarget.Global);
			this.applyProviderToWebviews();
		});
	}

	startGrokWatcher() {
		if (this.grokWatcher) return;
		this.grokChanged = new Set();
		const track = (uri) => {
			const p = uri.fsPath;
			if (/[\\/](node_modules|\.git|\.solstice|\.next|dist)([\\/]|$)/.test(p)) return;
			this.grokChanged.add(p);
		};
		const w = vscode.workspace.createFileSystemWatcher("**/*");
		w.onDidCreate(track);
		w.onDidChange(track);
		this.grokWatcher = w;
	}

	flushGrokChanges() {
		const changed = this.grokChanged ? [...this.grokChanged] : [];
		this.grokChanged = new Set();
		if (!changed.length) return;
		const item = {
			id: "gfc" + Date.now().toString(36),
			type: "fileChange",
			changes: changed.map((p) => ({ path: p })),
		};
		this.onNotification("item/completed", { threadId: this.grok ? this.grok.threadId : undefined, item });
	}

	grokPreamble() {
		const browseJs = path.join(this.context.extensionPath, "tools", "browse.js");
		const node = process.execPath;
		const shot = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const dom = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" dom <url>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" dom <url>`;
		let playbook = "";
		try {
			playbook = fs.readFileSync(path.join(this.context.extensionPath, "prompts", "design-playbook.md"), "utf8");
		} catch { /* missing playbook must not break the agent */ }
		return [
			"You are the Solstice IDE agent. Work directly on files in this workspace.",
			"Capabilities beyond your normal tools (run these as shell commands):",
			`- Screenshot any website: ${shot}`,
			`- Read any website's rendered HTML: ${dom}`,
			"- You cannot view images yourself. To study a screenshot or any image, subcontract vision to codex:",
			'  codex exec --skip-git-repo-check -i <image.png> "Describe this design in exhaustive detail: layout, every section top-to-bottom, colors (hex if possible), typography, imagery style, spacing, mood."',
			"  Always do this for every reference screenshot before designing, and for your own verification screenshots before declaring done.",
			"- Generate images by subcontracting to codex (it has an image generation tool):",
			'  codex exec --skip-git-repo-check --full-auto "Use your image generation tool to create: <detailed description>. Then copy the EXACT file you just generated (by its precise filename from ~/.codex/generated_images/ — never the most recent file, other jobs may write there concurrently) into <workspace>/public/images/<descriptive-name>.png"',
			"  Verify the file exists in the workspace afterwards, and view it with codex vision to confirm it shows the right subject before using it.",
			"- For multi-step builds, first write a short numbered plan to .solstice/PLAN.md and keep step markers updated as you work ([x] done, [~] current, [ ] pending).",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			playbook ? "\n" + playbook : "",
		].join("\n");
	}

	async sendGrok(text) {
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		if (!this.grok) {
			this.grok = new GrokProvider({
				cwd,
				log: (s) => this.output.append(s),
				notify: (m, p) => this.onNotification(m, p),
			});
			this.threadId = this.grok.threadId;
			const th = this.upsertThread({ id: this.threadId });
			th.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		this.startGrokWatcher();
		await this.grok.send(this.providerKey(), text, this.grokPreamble());
		this.flushGrokChanges();
	}

	post(msg) {
		if (this.webview) this.webview.postMessage(msg);
	}

	postManager(msg) {
		if (this.manager) this.manager.postMessage(msg);
	}

	upsertThread(t) {
		if (!t || !t.id) return null;
		const cur = this.threads.get(t.id) || { id: t.id, status: "idle", activeTurnId: null, plan: null, diff: "" };
		if (t.preview !== undefined) cur.preview = t.preview;
		if (t.updatedAt !== undefined) cur.updatedAt = t.updatedAt;
		if (t.status && t.status.type) cur.status = t.status.type;
		this.threads.set(t.id, cur);
		return cur;
	}

	threadList() {
		return [...this.threads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	pushThreads() {
		this.postManager({ type: "threads", threads: this.threadList() });
	}

	async ensureClient() {
		if (this.client && this.client.running) return this.client;
		const binPath = resolveCodexBinary(this.context.extensionPath, this.cfg().get("path"));
		this.client = new CodexClient({
			binPath,
			codexHome: this.cfg().get("home") || undefined,
			log: (s) => this.output.append(s),
			onExit: (code) => {
				this.threadId = null;
				this.loaded.clear();
				this.post({ type: "status", connected: false, detail: `codex exited (${code})` });
				this.postManager({ type: "status", connected: false, detail: `codex exited (${code})` });
			},
			onNotification: (method, params) => this.onNotification(method, params),
			onServerRequest: (method, params) => this.handleServerRequest(method, params),
		});
		try {
			this.client.start();
			await this.client.request("initialize", {
				clientInfo: { name: "solstice", title: "Solstice", version: "0.3.0" },
				capabilities: null,
			});
			this.client.notify("initialized", {});
		} catch (e) {
			this.client = null;
			throw new Error(`Could not start codex app-server (${binPath}): ${e.message}`);
		}
		return this.client;
	}

	onNotification(method, params) {
		const tid = params && params.threadId;
		// keep the thread registry live
		if (method === "thread/started" && params.thread) {
			this.upsertThread(params.thread);
			this.loaded.add(params.thread.id);
			this.pushThreads();
		} else if (method === "thread/status/changed" && tid) {
			const th = this.upsertThread({ id: tid });
			th.status = (params.status && params.status.type) || "idle";
			this.pushThreads();
		} else if (method === "thread/name/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			if (params.name) th.preview = params.name;
			this.pushThreads();
		} else if (method === "turn/started" && tid) {
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = params.turn && params.turn.id;
			th.status = "active";
			th.updatedAt = Date.now() / 1000;
			this.planFileOpened = false;
			this.pushThreads();
		} else if (method === "turn/completed" && tid) {
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = null;
			th.status = "idle";
			this.pushThreads();
		} else if (method === "turn/diff/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.diff = params.diff || "";
			if (tid === this.threadId) this.lastDiff = th.diff;
		} else if (method === "turn/plan/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.plan = params.plan || null;
			this.writePlanFile(th);
		}
		if (method === "item/completed" && params.item && params.item.type === "fileChange") {
			this.onFilesChanged(params.item);
		}
		if (method === "error" && params && params.error &&
			/usage limit|rate limit/i.test(params.error.message || "") && this.providerKey() === "gpt-5.5") {
			this.suggestFallback();
		}
		if (SIDEBAR_FORWARDED.has(method) && (!tid || tid === this.threadId)) {
			this.post({ type: "notification", method, params });
		}
		if (MANAGER_FORWARDED.has(method)) {
			this.postManager({ type: "notification", method, params });
		}
	}

	handleServerRequest(method, params) {
		const elicitation = method === "mcpServer/elicitation/request";
		// any */requestApproval (commandExecution/fileChange/permissions/…) or MCP elicitation
		if (!APPROVAL_METHODS.has(method) && !elicitation && !/\/requestApproval$/.test(method)) {
			throw new Error(`unsupported server request: ${method}`);
		}
		// three response vocabularies: legacy {decision: approved|denied},
		// item/*/requestApproval {decision: accept|decline},
		// MCP elicitation {action: accept|decline}
		const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
		const map = legacy
			? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied" }
			: { accept: "accept", acceptForSession: "acceptForSession", decline: "decline" };
		const toResult = (decision) => elicitation
			? { action: decision === "decline" ? "decline" : "accept" }
			: { decision: map[decision] || map.decline };
		// approvalPolicy "never" = user opted out of prompts, but codex still asks
		// for MCP tool calls — honor the policy by auto-accepting
		if (this.cfg().get("approvalPolicy") === "never") {
			return Promise.resolve(toResult("accept"));
		}
		return new Promise((resolve) => {
			const key = crypto.randomUUID();
			this.pendingApprovals.set(key, resolve);
			const tid = params && params.threadId;
			if (!tid || tid === this.threadId) this.post({ type: "approvalRequest", key, method, params });
			this.postManager({ type: "approvalRequest", key, method, params });
			// headless E2E hook (xvfb, no pointer): approve after the card rendered
			if (process.env.SOLSTICE_AGENT_DEV_AUTOAPPROVE) {
				setTimeout(() => this.resolveApproval(key, "accept"), 8000);
			}
		}).then(toResult);
	}

	resolveApproval(key, decision) {
		const resolve = this.pendingApprovals.get(key);
		if (resolve) {
			this.pendingApprovals.delete(key);
			resolve(decision);
		}
	}

	async refreshAccount(target) {
		if (this.providerKey() !== "gpt-5.5") {
			// grok CLI auth lives in the CLI itself — no codex login flow needed
			const msg = { type: "auth", authMethod: "grok-cli" };
			const mt = { type: "thread", model: this.providerLabel() };
			if (target === "manager") { this.postManager(msg); this.postManager(mt); }
			else { this.post(msg); this.post(mt); }
			return { authMethod: "grok-cli" };
		}
		const client = await this.ensureClient();
		const auth = await client.request("getAuthStatus", {});
		const msg = { type: "auth", authMethod: auth.authMethod };
		if (target === "manager") this.postManager(msg); else this.post(msg);
		if (auth.authMethod) {
			client.request("account/rateLimits/read", undefined)
				.then((r) => {
					const n = { type: "notification", method: "account/rateLimits/updated", params: r };
					this.post(n);
					this.postManager(n);
				})
				.catch(() => { });
		}
		return auth;
	}

	async login() {
		const client = await this.ensureClient();
		const res = await client.request("account/login/start", { type: "chatgpt" });
		if (res.authUrl) {
			this.post({ type: "loginPending" });
			this.postManager({ type: "loginPending" });
			vscode.env.openExternal(vscode.Uri.parse(res.authUrl));
			const onDone = (method) => {
				if (method === "account/login/completed" || method === "account/updated") {
					this.refreshAccount().catch(() => { });
					this.refreshAccount("manager").catch(() => { });
				}
			};
			// account/login/completed isn't in the forwarded set; hook the raw stream once
			const prev = client.opts.onNotification;
			client.opts.onNotification = (method, params) => {
				onDone(method);
				prev(method, params);
			};
		}
	}

	developerInstructions() {
		const browseJs = path.join(this.context.extensionPath, "tools", "browse.js");
		const node = process.execPath;
		const run = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		let playbook = "";
		try {
			playbook = fs.readFileSync(path.join(this.context.extensionPath, "prompts", "design-playbook.md"), "utf8");
		} catch { /* missing playbook must not break the agent */ }
		return [
			"You are the Solstice IDE agent. Capabilities beyond your normal tools:",
			`- Web browsing: take a screenshot of any website with: ${run}`,
			"  (replace mode 'shot' with 'dom' to dump the rendered HTML to stdout).",
			"  After taking a screenshot, ALWAYS open it with your view_image tool to study layout, colors, typography and content. Use this whenever the user asks to inspect, analyze or imitate a website or design (e.g. Behance/Dribbble references).",
			"- Image generation: you can generate images; afterwards copy the generated file from your image output directory into the workspace with a proper name and reference it from the site.",
			"- For any multi-step build task, first create a plan with your plan tool and keep step statuses updated as you work.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			playbook ? "\n" + playbook : "",
		].join("\n");
	}

	async startThread() {
		const client = await this.ensureClient();
		const th = await client.request("thread/start", {
			cwd: workspaceCwd(),
			model: this.cfg().get("model") || undefined,
			approvalPolicy: this.cfg().get("approvalPolicy"),
			sandbox: this.cfg().get("sandbox"),
			developerInstructions: this.developerInstructions(),
		});
		const id = th.thread && th.thread.id;
		if (id) {
			this.loaded.add(id);
			this.upsertThread(th.thread);
			this.pushThreads();
		}
		return { id, model: th.model };
	}

	async ensureRunnable(threadId) {
		const client = await this.ensureClient();
		if (!this.loaded.has(threadId)) {
			await client.request("thread/resume", {
				threadId,
				approvalPolicy: this.cfg().get("approvalPolicy"),
				sandbox: this.cfg().get("sandbox"),
			});
			this.loaded.add(threadId);
		}
	}

	async startTurn(threadId, text) {
		const client = await this.ensureClient();
		await this.ensureRunnable(threadId);
		const th = this.upsertThread({ id: threadId });
		if (!th.preview) {
			th.preview = text;
			this.pushThreads();
		}
		await client.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	// sidebar send: lazily creates the sidebar thread
	async send(text) {
		if (this.providerKey() !== "gpt-5.5") return this.sendGrok(text);
		if (!this.threadId) {
			const { id, model } = await this.startThread();
			this.threadId = id;
			this.lastDiff = "";
			this.post({ type: "thread", threadId: this.threadId, model });
		}
		await this.startTurn(this.threadId, text);
	}

	async steer(threadId, text) {
		const client = await this.ensureClient();
		const th = this.threads.get(threadId);
		if (!th || !th.activeTurnId) {
			// no active turn — fall back to a normal turn
			await this.startTurn(threadId, text);
			return;
		}
		await client.request("turn/steer", {
			threadId,
			expectedTurnId: th.activeTurnId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	async interrupt(threadId) {
		if (this.grok && this.grok.busy && (!threadId || threadId === this.grok.threadId)) {
			this.grok.interrupt();
			return;
		}
		const tid = threadId || this.threadId;
		if (this.client && this.client.running && tid) {
			await this.client.request("turn/interrupt", { threadId: tid }).catch(() => { });
		}
	}

	async listThreads() {
		const client = await this.ensureClient();
		const res = await client.request("thread/list", { cwd: workspaceCwd() }).catch(() => null);
		if (res && Array.isArray(res.data)) {
			for (const t of res.data) this.upsertThread(t);
		}
		this.pushThreads();
	}

	async readThread(threadId) {
		const client = await this.ensureClient();
		const res = await client.request("thread/read", { threadId, includeTurns: true });
		const th = this.threads.get(threadId);
		this.postManager({
			type: "threadHistory",
			thread: res.thread,
			plan: th ? th.plan : null,
			diff: th ? th.diff : "",
			activeTurnId: th ? th.activeTurnId : null,
		});
	}

	async archiveThread(threadId) {
		const client = await this.ensureClient();
		await client.request("thread/archive", { threadId }).catch(() => { });
		this.threads.delete(threadId);
		this.loaded.delete(threadId);
		if (this.threadId === threadId) this.threadId = null;
		this.pushThreads();
	}

	newThread() {
		this.threadId = null;
		this.lastDiff = "";
		this.post({ type: "reset" });
	}

	async showDiff(threadId) {
		const th = threadId ? this.threads.get(threadId) : null;
		const diff = (th && th.diff) || this.lastDiff;
		if (!diff) {
			vscode.window.showInformationMessage("Solstice: no diff for the current turn yet.");
			return;
		}
		const doc = await vscode.workspace.openTextDocument({ content: diff, language: "diff" });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	async signOut() {
		const client = await this.ensureClient();
		await client.request("account/logout", undefined).catch(() => { });
		this.post({ type: "auth", authMethod: null });
		this.postManager({ type: "auth", authMethod: null });
	}

	dispose() {
		for (const resolve of this.pendingApprovals.values()) resolve("abort");
		this.pendingApprovals.clear();
		if (this.preview) this.preview.dispose();
		if (this.grokWatcher) this.grokWatcher.dispose();
		if (this.grok) this.grok.interrupt();
		if (this.client) this.client.stop();
	}
}

function mediaHtml(webview, extensionUri, scriptFile, styleFile) {
	const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
	const nonce = crypto.randomUUID().replace(/-/g, "");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${media(styleFile)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("md.js")}"></script>
<script nonce="${nonce}" src="${media(scriptFile)}"></script>
</body>
</html>`;
}

class AgentViewProvider {
	constructor(controller, extensionUri) {
		this.controller = controller;
		this.extensionUri = extensionUri;
	}

	resolveWebviewView(view) {
		this.controller.webview = view.webview;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		view.webview.html = mediaHtml(view.webview, this.extensionUri, "panel.js", "panel.css");
		view.webview.onDidReceiveMessage(async (msg) => {
			try {
				switch (msg.type) {
					case "ready": await this.controller.refreshAccount(); break;
					case "send": await this.controller.send(msg.text); break;
					case "login": await this.controller.login(); break;
					case "approval": this.controller.resolveApproval(msg.key, msg.decision); break;
					case "interrupt": await this.controller.interrupt(); break;
					case "newThread": this.controller.newThread(); break;
					case "showDiff": await this.controller.showDiff(); break;
				}
			} catch (e) {
				this.controller.post({ type: "fatal", message: String(e && e.message || e) });
			}
		});
		view.onDidDispose(() => {
			if (this.controller.webview === view.webview) this.controller.webview = null;
		});
	}
}

let managerPanel = null;

function openManager(controller, extensionUri) {
	if (managerPanel) {
		managerPanel.reveal();
		return;
	}
	managerPanel = vscode.window.createWebviewPanel(
		"solstice.agentManager",
		"Agent Manager",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
		}
	);
	controller.manager = managerPanel.webview;
	managerPanel.webview.html = mediaHtml(managerPanel.webview, extensionUri, "manager.js", "manager.css");
	managerPanel.webview.onDidReceiveMessage(async (msg) => {
		try {
			switch (msg.type) {
				case "ready":
					await controller.refreshAccount("manager");
					await controller.listThreads();
					break;
				case "listThreads": await controller.listThreads(); break;
				case "selectThread": await controller.readThread(msg.threadId); break;
				case "newThread": {
					const { id } = await controller.startThread();
					if (id) controller.postManager({ type: "threadCreated", threadId: id });
					break;
				}
				case "send": await controller.startTurn(msg.threadId, msg.text); break;
				case "steer": await controller.steer(msg.threadId, msg.text); break;
				case "interrupt": await controller.interrupt(msg.threadId); break;
				case "approval": controller.resolveApproval(msg.key, msg.decision); break;
				case "openDiff": await controller.showDiff(msg.threadId); break;
				case "openPreview": await controller.openPreview(""); break;
				case "archiveThread": await controller.archiveThread(msg.threadId); break;
				case "login": await controller.login(); break;
			}
		} catch (e) {
			controller.postManager({ type: "fatal", message: String(e && e.message || e) });
		}
	});
	managerPanel.onDidDispose(() => {
		if (controller.manager === managerPanel.webview) controller.manager = null;
		managerPanel = null;
	});
}

function activate(context) {
	const controller = new AgentController(context);
	context.subscriptions.push(controller);
	const provider = new AgentViewProvider(controller, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("solstice.agentPanel", provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("solstice.agent.newThread", () => controller.newThread()),
		vscode.commands.registerCommand("solstice.agent.showDiff", () => controller.showDiff()),
		vscode.commands.registerCommand("solstice.agent.signOut", () => controller.signOut()),
		vscode.commands.registerCommand("solstice.agent.openManager", () => openManager(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openPreview", (url) => controller.openPreview(typeof url === "string" ? url : "")),
		vscode.commands.registerCommand("solstice.agent.selectModel", () => controller.selectModel())
	);
	// chat lives in the secondary side bar (right of the editor); reveal it on first run
	if (!context.globalState.get("solstice.revealedAgentPanel")) {
		context.globalState.update("solstice.revealedAgentPanel", true);
		setTimeout(() => vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { }), 1500);
	}
	// headless E2E hooks (xvfb, no pointer)
	if (process.env.SOLSTICE_AGENT_DEV_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agentPanel.focus");
			setTimeout(() => controller.post({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_PROMPT }), 5000);
		}, 5000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_PREVIEW) {
		setTimeout(() => vscode.commands.executeCommand("solstice.agent.openPreview").then(undefined, () => { }),
			Number(process.env.SOLSTICE_AGENT_DEV_PREVIEW) * 1000 || 60000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agent.openManager");
			setTimeout(() => controller.postManager({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT }), 5000);
		}, 5000);
	}
}

function deactivate() { }

module.exports = { activate, deactivate };
