"use strict";

const assert = require("assert");
const {
	MOONSHOT_API_BASE,
	MOONSHOT_CONNECT_URL,
	MOONSHOT_SECRET_KEY,
	providerCredential,
	validateMoonshotCredential,
} = require("./providerOnboarding");

(async () => {
	assert.equal(MOONSHOT_API_BASE, "https://api.moonshot.ai/v1");
	assert.match(MOONSHOT_CONNECT_URL, /^https:\/\/platform\.kimi\.ai\/console\/api-keys$/);
	assert.equal(await providerCredential(null, "moonshot", { MOONSHOT_API_KEY: "env-key" }), "env-key");
	const context = { secrets: { get: async (key) => key === MOONSHOT_SECRET_KEY ? "stored-key" : "" } };
	assert.equal(await providerCredential(context, "moonshot", {}), "stored-key");
	let requested = "";
	const ok = await validateMoonshotCredential("test-key", {
		fetchImpl: async (url, init) => {
			requested = url;
			assert.equal(init.headers.Authorization, "Bearer test-key");
			return { ok: true, json: async () => ({ data: [{ id: "kimi-k3" }] }) };
		},
	});
	assert.equal(requested, "https://api.moonshot.ai/v1/models");
	assert.deepEqual(ok.models, ["kimi-k3"]);
	await assert.rejects(() => validateMoonshotCredential("bad", {
		fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
	}), /HTTP 401/);
	await assert.rejects(() => validateMoonshotCredential("limited", {
		fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "kimi-k2.6" }] }) }),
	}), /kimi-k3 is unavailable/);
	console.log("providerOnboarding.test.js: 8/8 checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
