"use strict";
const vscode = require("vscode");
const crypto = require("crypto");
const { CodexClient, resolveCodexBinary } = require("./codexClient");

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
		this.output = vscode.window.createOutputChannel("Solstice Agent");
	}

	cfg() {
		return vscode.workspace.getConfiguration("solstice.codex");
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
		}
		if (SIDEBAR_FORWARDED.has(method) && (!tid || tid === this.threadId)) {
			this.post({ type: "notification", method, params });
		}
		if (MANAGER_FORWARDED.has(method)) {
			this.postManager({ type: "notification", method, params });
		}
	}

	handleServerRequest(method, params) {
		if (!APPROVAL_METHODS.has(method)) {
			throw new Error(`unsupported server request: ${method}`);
		}
		// legacy methods (execCommandApproval/applyPatchApproval) use a different
		// decision vocabulary than the item/*/requestApproval family
		const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
		const map = legacy
			? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied" }
			: { accept: "accept", acceptForSession: "acceptForSession", decline: "decline" };
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
		}).then((decision) => ({ decision: map[decision] || map.decline }));
	}

	resolveApproval(key, decision) {
		const resolve = this.pendingApprovals.get(key);
		if (resolve) {
			this.pendingApprovals.delete(key);
			resolve(decision);
		}
	}

	async refreshAccount(target) {
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

	async startThread() {
		const client = await this.ensureClient();
		const th = await client.request("thread/start", {
			cwd: workspaceCwd(),
			model: this.cfg().get("model") || undefined,
			approvalPolicy: this.cfg().get("approvalPolicy"),
			sandbox: this.cfg().get("sandbox"),
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
		vscode.commands.registerCommand("solstice.agent.openManager", () => openManager(controller, context.extensionUri))
	);
	// headless E2E hooks (xvfb, no pointer)
	if (process.env.SOLSTICE_AGENT_DEV_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("workbench.view.extension.solstice-agent");
			setTimeout(() => controller.post({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_PROMPT }), 5000);
		}, 5000);
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
