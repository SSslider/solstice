"use strict";
const vscode = require("vscode");
const crypto = require("crypto");
const { CodexClient, resolveCodexBinary } = require("./codexClient");

const FORWARDED_NOTIFICATIONS = new Set([
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

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);

class AgentController {
	constructor(context) {
		this.context = context;
		this.client = null;
		this.threadId = null;
		this.lastDiff = "";
		this.webview = null;
		this.pendingApprovals = new Map(); // approvalKey -> resolve(decision)
		this.output = vscode.window.createOutputChannel("Solstice Agent");
	}

	cfg() {
		return vscode.workspace.getConfiguration("solstice.codex");
	}

	post(msg) {
		if (this.webview) this.webview.postMessage(msg);
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
				this.post({ type: "status", connected: false, detail: `codex exited (${code})` });
			},
			onNotification: (method, params) => {
				if (method === "turn/diff/updated") this.lastDiff = params.diff || "";
				if (FORWARDED_NOTIFICATIONS.has(method)) this.post({ type: "notification", method, params });
			},
			onServerRequest: (method, params) => this.handleServerRequest(method, params),
		});
		try {
			this.client.start();
			await this.client.request("initialize", {
				clientInfo: { name: "solstice", title: "Solstice", version: "0.2.0" },
				capabilities: null,
			});
			this.client.notify("initialized", {});
		} catch (e) {
			this.client = null;
			throw new Error(`Could not start codex app-server (${binPath}): ${e.message}`);
		}
		return this.client;
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
			this.post({ type: "approvalRequest", key, method, params });
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

	async refreshAccount() {
		const client = await this.ensureClient();
		const auth = await client.request("getAuthStatus", {});
		this.post({ type: "auth", authMethod: auth.authMethod });
		if (auth.authMethod) {
			client.request("account/rateLimits/read", undefined)
				.then((r) => this.post({ type: "notification", method: "account/rateLimits/updated", params: r }))
				.catch(() => { });
		}
		return auth;
	}

	async login() {
		const client = await this.ensureClient();
		const res = await client.request("account/login/start", { type: "chatgpt" });
		if (res.authUrl) {
			this.post({ type: "loginPending" });
			vscode.env.openExternal(vscode.Uri.parse(res.authUrl));
			const onDone = (method) => {
				if (method === "account/login/completed" || method === "account/updated") {
					this.refreshAccount().catch(() => { });
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

	async send(text) {
		const client = await this.ensureClient();
		if (!this.threadId) {
			const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
				? vscode.workspace.workspaceFolders[0].uri.fsPath
				: undefined;
			const th = await client.request("thread/start", {
				cwd,
				model: this.cfg().get("model") || undefined,
				approvalPolicy: this.cfg().get("approvalPolicy"),
				sandbox: this.cfg().get("sandbox"),
			});
			this.threadId = th.thread && th.thread.id;
			this.lastDiff = "";
			this.post({ type: "thread", threadId: this.threadId, model: th.model });
		}
		await client.request("turn/start", {
			threadId: this.threadId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	async interrupt() {
		if (this.client && this.client.running && this.threadId) {
			await this.client.request("turn/interrupt", { threadId: this.threadId }).catch(() => { });
		}
	}

	newThread() {
		this.threadId = null;
		this.lastDiff = "";
		this.post({ type: "reset" });
	}

	async showDiff() {
		if (!this.lastDiff) {
			vscode.window.showInformationMessage("Solstice: no diff for the current turn yet.");
			return;
		}
		const doc = await vscode.workspace.openTextDocument({ content: this.lastDiff, language: "diff" });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	async signOut() {
		const client = await this.ensureClient();
		await client.request("account/logout", undefined).catch(() => { });
		this.post({ type: "auth", authMethod: null });
	}

	dispose() {
		for (const resolve of this.pendingApprovals.values()) resolve("abort");
		this.pendingApprovals.clear();
		if (this.client) this.client.stop();
	}
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
		view.webview.html = this.html(view.webview);
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

	html(webview) {
		const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
		const nonce = crypto.randomUUID().replace(/-/g, "");
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${media("panel.css")}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
	}
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
	);
	// headless E2E hook (xvfb, no pointer): open the view and submit a prompt
	if (process.env.SOLSTICE_AGENT_DEV_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("workbench.view.extension.solstice-agent");
			setTimeout(() => controller.post({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_PROMPT }), 5000);
		}, 5000);
	}
}

function deactivate() { }

module.exports = { activate, deactivate };
