"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { FoundationClient } = require("./foundationClient");

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-foundation-client-"));
	const storageDir = path.join(root, "storage");
	const businessFile = path.join(root, "workspace", ".solstice", "foundation.json");
	const businessId = "11111111-1111-4111-8111-111111111111";
	const received = [];
	const remote = [];
	let cursorCounter = 0;
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			const url = new URL(req.url, "http://127.0.0.1");
			if (req.method === "POST") {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				received.push(...body.events);
				res.end(JSON.stringify({ applied: body.events.length, duplicate: 0, rejected: [], received: body.events.length }));
				return;
			}
			assert.equal(url.searchParams.get("exclude_origin"), "solstice");
			assert.equal(url.searchParams.get("limit"), "200");
			const since = url.searchParams.get("since");
			const events = since ? remote.filter((event) => event.occurred_at > since) : [...remote];
			const cursor = events.length ? events[events.length - 1].occurred_at : since;
			res.end(JSON.stringify({ events, cursor, count: events.length }));
		});
	});

	const offlinePort = 19000 + Math.floor(Math.random() * 1000);
	let client = new FoundationClient({
		endpoint: `http://127.0.0.1:${offlinePort}/api/foundation/events?dev=studio`,
		storageDir,
		businessFile,
		businessId,
		pollMs: 60000,
		timeout: 250,
	});
	await client.start();
	const local = await client.updateBusinessName(businessId, "Rafael from Solstice");
	assert.equal(local.event.origin, "solstice");
	assert.equal(local.event.event_type, "business.name_updated");
	assert.match(local.event.event_id, /^[0-9a-f-]{36}$/);
	assert.equal(local.sync.ok, false);
	assert.equal(client.status().queued, 1);
	assert.equal(JSON.parse(fs.readFileSync(businessFile, "utf8")).name, "Rafael from Solstice");
	assert.equal(JSON.parse(fs.readFileSync(path.join(storageDir, "outbox.json"), "utf8")).events.length, 1);

	client.dispose();
	await listen(server);
	client = new FoundationClient({
		endpoint: `http://127.0.0.1:${server.address().port}/api/foundation/events?dev=studio`,
		storageDir,
		businessFile,
		pollMs: 60000,
		timeout: 1000,
	});
	const resumed = await client.start();
	assert.equal(resumed.queued, 0);
	assert.equal(client.status().queued, 0);
	assert.equal(received.length, 1);
	assert.equal(received[0].payload.value, "Rafael from Solstice");

	cursorCounter += 1;
	remote.push({
		id: "server-row-1",
		business_id: businessId,
		event_type: "business.name_updated",
		payload: { origin: "atrium", event_id: "atrium-event-1", field: "name", value: "Rafael from Atrium" },
		occurred_at: `2026-08-07T03:00:0${cursorCounter}.000Z`,
	});
	const pulled = await client.syncNow();
	assert.equal(pulled.pulled, 1);
	assert.equal(JSON.parse(fs.readFileSync(businessFile, "utf8")).name, "Rafael from Atrium");
	assert.equal(JSON.parse(fs.readFileSync(businessFile, "utf8")).source, "atrium");
	assert.equal(received.length, 1, "remote apply must not echo back into the outbox");
	assert.equal(JSON.parse(fs.readFileSync(path.join(storageDir, "cursor.json"), "utf8")).cursor, remote[0].occurred_at);

	const edited = JSON.parse(fs.readFileSync(businessFile, "utf8"));
	edited.name = "Rafael edited in Solstice";
	fs.writeFileSync(businessFile, JSON.stringify(edited, null, 2) + "\n");
	for (let attempt = 0; attempt < 30 && received.length < 2; attempt += 1) await wait(50);
	assert.equal(received.length, 2);
	assert.equal(received[1].payload.value, "Rafael edited in Solstice");
	assert.notEqual(received[0].event_id, received[1].event_id);
	assert.equal(client.status().queued, 0);
	const extensionSource = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	assert.match(extensionSource, /new FoundationClient\(/);
	assert.match(extensionSource, /foundationClient\.dispose\(\)/);

	client.dispose();
	await close(server);
	const corruptDir = path.join(root, "corrupt-storage");
	fs.mkdirSync(corruptDir, { recursive: true });
	fs.writeFileSync(path.join(corruptDir, "outbox.json"), "{broken-json\n");
	const corruptClient = new FoundationClient({
		endpoint: "http://127.0.0.1:1/api/foundation/events?dev=studio",
		storageDir: corruptDir,
		businessFile,
		businessId,
		pollMs: 60000,
		timeout: 250,
	});
	await assert.rejects(() => corruptClient.start(), /refusing to discard/);
	assert.equal(fs.readFileSync(path.join(corruptDir, "outbox.json"), "utf8"), "{broken-json\n");
	corruptClient.dispose();
	fs.rmSync(root, { recursive: true, force: true });
	console.log("foundationClient.test.js: 25/25 checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
