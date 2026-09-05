"use strict";

const { spawn } = require("child_process");
const readline = require("readline");
const { resolveWinSpawn } = require("./winspawn");

const PROVIDER_LABELS = {
	gpt: "GPT",
	grok: "Grok",
	composer: "Composer",
	claude: "Claude",
	moonshot: "Moonshot",
};

function providerForModel(id, runner) {
	if (runner === "claude") return "claude";
	if (runner === "moonshot") return "moonshot";
	if (runner === "grok") return /^grok-composer-/i.test(id) ? "composer" : "grok";
	return "gpt";
}

function grokLabel(id) {
	if (id === "grok-4.5") return "Grok 4.5 Build";
	if (id === "grok-composer-2.5-fast") return "Composer 2.5 Fast";
	return id;
}

function parseGrokModels(output) {
	return String(output || "").split(/\r?\n/)
		.map((line) => /^\s*(?:\*|-)\s+([^\s]+)(\s+\(default\))?\s*$/.exec(line))
		.filter(Boolean)
		.map((match) => ({
			key: match[1] === "grok-composer-2.5-fast" ? "composer-2.5" : match[1],
			modelId: match[1],
			isDefault: Boolean(match[2]),
			label: grokLabel(match[1]),
			description: /^grok-composer-/i.test(match[1]) ? "Fast composer tier reported by grok CLI" : "Agentic build model reported by grok CLI",
			runner: "grok",
			provider: providerForModel(match[1], "grok"),
		}));
}

function parseCodexModelList(result) {
	const data = result && Array.isArray(result.data) ? result.data : [];
	const declaredDefault = String(result && (result.defaultModel || result.default_model || result.default) || "");
	return data.filter((model) => model && !model.hidden && (model.model || model.id)).map((model) => {
		const id = String(model.model || model.id);
		return {
			key: id,
			modelId: id,
			isDefault: Boolean(model.isDefault || model.is_default || model.default || (declaredDefault && declaredDefault === id)),
			label: model.displayName || id,
			description: model.description || "Model reported by Codex CLI",
			runner: "codex",
			provider: "gpt",
		};
	});
}

function selectCodexDefault(models) {
	const available = Array.isArray(models) ? models.filter((model) => model && model.key) : [];
	const declared = available.find((model) => model.isDefault);
	return String((declared || available[0] || {}).key || "");
}

function discoverCodexModels(bin, timeoutMs = 6000) {
	return new Promise((resolve) => {
		let settled = false;
		let child;
		const finish = (models) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { if (child && child.pid) child.kill(); } catch { }
			resolve(models || []);
		};
		const timer = setTimeout(() => finish([]), timeoutMs);
		try {
			const plan = resolveWinSpawn(bin, ["app-server"]);
			child = spawn(plan.cmd, plan.args, {
				stdio: ["pipe", "pipe", "ignore"],
				env: plan.env || process.env,
				windowsHide: true,
			});
			child.on("error", () => finish([]));
			child.on("exit", () => finish([]));
			const lines = readline.createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let message;
				try { message = JSON.parse(line); } catch { return; }
				if (message.id === 2) finish(message.error ? [] : parseCodexModelList(message.result));
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "solstice-model-picker", title: "Solstice", version: "1" }, capabilities: null } }) + "\n");
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} }) + "\n");
		} catch { finish([]); }
	});
}

function discoverGrokModels(bin, timeoutMs = 6000) {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let child;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(parseGrokModels(output));
		};
		const timer = setTimeout(() => { try { if (child) child.kill(); } catch { } finish(); }, timeoutMs);
		try {
			const plan = resolveWinSpawn(bin, ["models"]);
			child = spawn(plan.cmd, plan.args, { stdio: ["ignore", "pipe", "pipe"], env: plan.env || process.env, windowsHide: true });
			child.stdout.on("data", (chunk) => { output += String(chunk); });
			child.stderr.on("data", (chunk) => { output += String(chunk); });
			child.on("error", finish);
			child.on("close", finish);
		} catch { finish(); }
	});
}

function groupModels(models, allowClaude) {
	const list = [...(models || [])].filter((model) => allowClaude || model.provider !== "claude");
	const order = ["gpt", "grok", "composer", "claude", "moonshot"];
	return order.map((key) => ({
		key,
		label: PROVIDER_LABELS[key],
		models: list.filter((model) => model.provider === key),
	})).filter((group) => group.models.length);
}

module.exports = {
	PROVIDER_LABELS,
	providerForModel,
	parseGrokModels,
	parseCodexModelList,
	selectCodexDefault,
	discoverCodexModels,
	discoverGrokModels,
	groupModels,
};
