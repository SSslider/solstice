"use strict";

const MOONSHOT_SECRET_KEY = "solstice.provider.moonshot.apiKey";
const MOONSHOT_API_BASE = "https://api.moonshot.ai/v1";
const MOONSHOT_CONNECT_URL = "https://platform.kimi.ai/console/api-keys";

const PROVIDER_CONNECTIONS = {
	moonshot: {
		label: "Moonshot / Kimi",
		envKey: "MOONSHOT_API_KEY",
		secretKey: MOONSHOT_SECRET_KEY,
		connectUrl: MOONSHOT_CONNECT_URL,
	},
};

async function storedSecret(context, key) {
	if (!context || !context.secrets || typeof context.secrets.get !== "function") return "";
	try { return String(await context.secrets.get(key) || "").trim(); }
	catch { return ""; }
}

async function providerCredential(context, provider, env = process.env) {
	const spec = PROVIDER_CONNECTIONS[provider];
	if (!spec) return "";
	const fromEnv = String(env && env[spec.envKey] || "").trim();
	return fromEnv || storedSecret(context, spec.secretKey);
}

async function validateMoonshotCredential(apiKey, opts = {}) {
	const fetchImpl = opts.fetchImpl || globalThis.fetch;
	const baseUrl = String(opts.baseUrl || MOONSHOT_API_BASE).replace(/\/+$/, "");
	if (typeof fetchImpl !== "function") throw new Error("This Solstice runtime does not provide fetch().");
	const response = await fetchImpl(`${baseUrl}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Moonshot credential validation failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
	}
	const body = await response.json();
	const ids = Array.isArray(body && body.data) ? body.data.map((item) => String(item && item.id || "")).filter(Boolean) : [];
	if (!ids.includes("kimi-k3")) throw new Error(`Moonshot connected, but kimi-k3 is unavailable for this account. Available: ${ids.join(", ") || "none reported"}`);
	return { ok: true, models: ids };
}

async function ensureProviderConnection(vscode, context, provider, opts = {}) {
	const spec = PROVIDER_CONNECTIONS[provider];
	if (!spec) return { ok: true, credential: "" };
	const existing = await providerCredential(context, provider, opts.env || process.env);
	if (existing) return { ok: true, credential: existing, source: (opts.env || process.env)[spec.envKey] ? "env" : "secret" };

	const choice = await vscode.window.showWarningMessage(
		`${spec.label} needs a connection before this model can run.`,
		{ modal: true, detail: `Open the provider site, create an API key, then paste it into Solstice. The key is stored in VS Code SecretStorage — never in settings or the workspace.` },
		"Connect Moonshot",
		"Show terminal setup"
	);
	if (!choice) return { ok: false, reason: "cancelled" };
	if (choice === "Show terminal setup") {
		const terminal = vscode.window.createTerminal({ name: "Connect Moonshot / Kimi" });
		terminal.show(false);
		const command = process.platform === "win32"
			? `start "" "${spec.connectUrl}"`
			: process.platform === "darwin" ? `open "${spec.connectUrl}"` : `xdg-open "${spec.connectUrl}"`;
		terminal.sendText(command, true);
		vscode.window.showInformationMessage(`After creating a key, set ${spec.envKey} in your user environment and restart Solstice, or select Kimi K3 again and choose Connect Moonshot.`);
		return { ok: false, reason: "terminal-setup" };
	}

	await vscode.env.openExternal(vscode.Uri.parse(spec.connectUrl));
	const entered = String(await vscode.window.showInputBox({
		title: `Connect ${spec.label}`,
		prompt: `Paste your ${spec.envKey}. Solstice validates it against the direct Moonshot API before saving.`,
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => String(value || "").trim().length < 16 ? "Paste a complete API key." : undefined,
	}) || "").trim();
	if (!entered) return { ok: false, reason: "cancelled" };
	await validateMoonshotCredential(entered, { fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl });
	if (!context || !context.secrets || typeof context.secrets.store !== "function") throw new Error("VS Code SecretStorage is unavailable.");
	await context.secrets.store(spec.secretKey, entered);
	vscode.window.showInformationMessage(`${spec.label} connected. Kimi K3 is ready.`);
	return { ok: true, credential: entered, source: "secret" };
}

module.exports = {
	MOONSHOT_API_BASE,
	MOONSHOT_CONNECT_URL,
	MOONSHOT_SECRET_KEY,
	PROVIDER_CONNECTIONS,
	ensureProviderConnection,
	providerCredential,
	validateMoonshotCredential,
};
