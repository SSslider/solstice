"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { parseMercuryCredential, mercuryClientSource, mercuryClientSourceJs, formatMercuryCredential, normalizeMercuryBase, mercuryHealth, openMercuryStore, mercuryStoreStatus, validateMercurySeed, seedMercuryStore, syncMercurySeedFromProject, MERCURY_SEED_FILE, MERCURY_SEEDED_FILE } = require("./mercuryBridge");

test("parseMercuryCredential accepts <base>|<store_id> and rejects junk", () => {
	assert.deepEqual(parseMercuryCredential("http://127.0.0.1:8791/|str_abc123"), { base: "http://127.0.0.1:8791", storeId: "str_abc123" });
	assert.deepEqual(parseMercuryCredential("  https://shop.example.com | str_ZZ9 "), { base: "https://shop.example.com", storeId: "str_ZZ9" });
	assert.equal(parseMercuryCredential(""), null);
	assert.equal(parseMercuryCredential("str_abc123"), null);
	assert.equal(parseMercuryCredential("http://x|"), null);
	assert.equal(parseMercuryCredential("ftp://x|str_1"), null);
	assert.equal(parseMercuryCredential("http://x|not-a-store"), null);
});

test("generated client only targets routes Mercury really serves", () => {
	const ts = mercuryClientSource({ base: "http://h", storeId: "str_1" });
	assert.match(ts, /'\/api\/stores\/' \+ STORE_ID \+ '\/products'/);
	assert.match(ts, /'\/api\/stores\/' \+ STORE_ID \+ '\/checkout'/);
	assert.match(ts, /MERCURY_BASE \+ '\/api\/collect'/);
	assert.doesNotMatch(ts, /\/products\/' \+ id/, "Mercury has no GET /products/:id route");
	assert.doesNotMatch(ts, /STORE_ID \+ '\/collect'/, "collector is engine-wide, not per store");
	assert.match(ts, /store_id: STORE_ID, sid: visitorSid\(\), type:/, "collector schema is store_id/sid/type");
	assert.match(ts, /type === 'purchase'\) return/, "purchase is server-attributed only");
	assert.throws(() => mercuryClientSource(null));
});

test("plain-ESM variant carries no TypeScript and exports the same surface", async () => {
	const js = mercuryClientSourceJs({ base: "http://h", storeId: "str_1" });
	assert.doesNotMatch(js, /: string|<T\b|as any|Promise<|export type /);
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mercury-js-")), "mercury.mjs");
	fs.writeFileSync(file, js);
	const mod = await import(file);
	assert.deepEqual(Object.keys(mod).sort(), ["MERCURY_BASE", "PIXEL_SRC", "STORE_ID", "createCheckout", "getProduct", "getProducts", "trackEvent", "validateDiscount"]);
	assert.equal(mod.PIXEL_SRC, "http://h/pixel.js");
});

// Exercise the generated client against a faithful stand-in for Mercury's router
// (same paths and payloads as genesis/commerce/server.mjs), so a route drift in
// the generator fails here instead of silently 404-ing in a shopper's browser.
test("generated client round-trips catalog, product lookup, checkout and analytics", async () => {
	const seen = [];
	const catalog = [{ id: "prd_1", title: "A", variants: [{ id: "var_1", title: "A3", price_cents: 18000, stock: 3 }] }, { id: "prd_2", title: "B", variants: [] }];
	const server = http.createServer((req, res) => {
		let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
			seen.push({ method: req.method, url: req.url, body });
			const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
			if (req.method === "GET" && req.url === "/api/stores/str_1/products") return send(200, catalog);
			if (req.method === "POST" && req.url === "/api/stores/str_1/checkout") {
				const b = JSON.parse(body); if (!Array.isArray(b.items) || !b.items.length) return send(400, { error: "items[] required" });
				return send(201, { session_id: "cs_1", provider: "mock", total_cents: 36000, url: "http://mercury/pay/cs_1" });
			}
			if (req.method === "POST" && req.url === "/api/collect") { res.writeHead(204); return res.end(); }
			return send(404, { error: "no route" });
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = "http://127.0.0.1:" + server.address().port;
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mercury-live-")), "mercury.mjs");
	fs.writeFileSync(file, mercuryClientSourceJs({ base, storeId: "str_1" }));
	const m = await import(file);
	try {
		assert.equal((await m.getProducts()).length, 2);
		assert.equal((await m.getProduct("prd_1")).variants[0].id, "var_1");
		assert.equal(await m.getProduct("prd_missing"), null);
		const co = await m.createCheckout([{ variant_id: "var_1", qty: 2 }]);
		assert.equal(co.url, "http://mercury/pay/cs_1");
		await m.trackEvent("add_to_cart", { variant_id: "var_1" });
		await m.trackEvent("purchase", {});
		const collect = seen.filter((s) => s.url === "/api/collect");
		assert.equal(collect.length, 1, "purchase must never reach the collector");
		const payload = JSON.parse(collect[0].body);
		assert.equal(payload.store_id, "str_1"); assert.equal(payload.type, "add_to_cart"); assert.ok(payload.sid);
		assert.ok(!seen.some((s) => s.url.includes("/products/prd_")), "no per-product GET was attempted");
	} finally { server.close(); }
});

// ---- opening a store + seeding ------------------------------------------------

// Faithful stand-in for the engine's store/product routes with an in-memory DB.
function mercuryStandIn(opts) {
	const o = opts || {};
	const state = { stores: {}, seen: [], healthy: o.healthy !== false, engine: o.engine || "mercury" };
	let n = 0;
	const server = http.createServer((req, res) => {
		let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
			state.seen.push({ method: req.method, url: req.url, body });
			const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
			const seg = req.url.split("?")[0].split("/").filter(Boolean);
			if (req.method === "GET" && req.url === "/api/health") return state.healthy ? send(200, { ok: true, engine: state.engine, stripe: false }) : send(500, { ok: false });
			if (req.method === "POST" && req.url === "/api/stores") {
				const b = JSON.parse(body || "{}"); if (!b.name) return send(400, { error: "name required" });
				const id = "str_" + String(++n).padStart(4, "0"); state.stores[id] = { id, name: b.name, vertical: b.vertical || "", currency: (b.currency || "USD").toUpperCase(), products: [] };
				const { products, ...row } = state.stores[id]; return send(201, row);
			}
			if (seg[0] === "api" && seg[1] === "stores" && seg[2]) {
				const st = state.stores[seg[2]]; if (!st) return send(404, { error: "unknown store" });
				if (req.method === "GET" && seg.length === 3) { const { products, ...row } = st; return send(200, row); }
				if (seg[3] === "products" && seg.length === 4 && req.method === "GET") return send(200, st.products);
				if (seg[3] === "products" && seg.length === 4 && req.method === "POST") {
					const b = JSON.parse(body || "{}"); if (!b.title || !Array.isArray(b.variants) || !b.variants.length) return send(400, { error: "title + variants[] required" });
					const p = { id: "prd_" + String(++n), title: b.title, description: b.description || "", image: b.image || "", images: b.images || [], status: "active", variants: b.variants.map((v, i) => ({ id: "var_" + n + "_" + i, title: v.title || "Default", sku: v.sku || "", price_cents: v.price_cents, stock: v.stock || 0 })) };
					st.products.unshift(p); return send(201, p);
				}
			}
			return send(404, { error: "no route" });
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: "http://127.0.0.1:" + server.address().port })));
}

test("credential formatting and base normalization", () => {
	assert.equal(formatMercuryCredential("http://h:1/", "str_ab1"), "http://h:1|str_ab1");
	assert.throws(() => formatMercuryCredential("h:1", "str_ab1"));
	assert.throws(() => formatMercuryCredential("http://h", "nope"));
	assert.equal(normalizeMercuryBase(""), "http://127.0.0.1:8791");
	assert.equal(normalizeMercuryBase(" https://m.example.com/// "), "https://m.example.com");
	assert.throws(() => normalizeMercuryBase("m.example.com"));
	assert.throws(() => normalizeMercuryBase("http://a|b"));
});

test("health probe accepts only a live Mercury engine", async () => {
	const good = await mercuryStandIn();
	const other = await mercuryStandIn({ engine: "atrium" });
	const down = await mercuryStandIn({ healthy: false });
	try {
		assert.deepEqual(await mercuryHealth(good.base + "/"), { base: good.base, stripe: false });
		await assert.rejects(mercuryHealth(other.base), /אינה מנוע Mercury/);
		await assert.rejects(mercuryHealth(down.base), /אינה מנוע Mercury/);
		await assert.rejects(mercuryHealth("http://127.0.0.1:1"), /לא עונה/);
	} finally { good.server.close(); other.server.close(); down.server.close(); }
});

test("openMercuryStore creates the store and returns a vault-ready credential", async () => {
	const m = await mercuryStandIn();
	try {
		const r = await openMercuryStore(m.base, { name: "  דפוס  יפו ", currency: "ils", vertical: "print" });
		assert.equal(r.storeId, "str_0001");
		assert.equal(r.credential, m.base + "|str_0001");
		assert.deepEqual(m.state.stores.str_0001, { id: "str_0001", name: "דפוס יפו", vertical: "print", currency: "ILS", products: [] });
		assert.equal(parseMercuryCredential(r.credential).storeId, "str_0001");
		await assert.rejects(openMercuryStore(m.base, { name: "   " }), /שם חנות נדרש/);
		await assert.rejects(openMercuryStore(m.base, { name: "x", currency: "shekel" }), /מטבע/);
		assert.equal(m.state.seen.filter((s) => s.method === "POST").length, 1, "invalid specs never reach the engine");
		const status = await mercuryStoreStatus({ base: m.base, storeId: "str_0001" });
		assert.deepEqual(status, { id: "str_0001", name: "דפוס יפו", currency: "ILS", vertical: "print", products: 0 });
		await assert.rejects(mercuryStoreStatus({ base: m.base, storeId: "str_zzz" }), /לא קיימת/);
	} finally { m.server.close(); }
});

test("openMercuryStore refuses a non-201 status or a malformed store id", async () => {
	let mode = "status200";
	const server = http.createServer((req, res) => {
		if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, engine: "mercury" })); }
		if (mode === "status200") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "str_looksfine" })); }
		res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "nope" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = "http://127.0.0.1:" + server.address().port;
	try {
		await assert.rejects(openMercuryStore(base, { name: "x" }), /פתיחת החנות נכשלה \(200\)/, "200 with a plausible id is still not a created store");
		mode = "badid";
		await assert.rejects(openMercuryStore(base, { name: "x" }), /מזהה חנות לא צפוי: nope/, "201 with a non str_ id must not be vaulted");
	} finally { server.close(); }
});

test("seed validation is total: a bad seed never half-creates a catalog", async () => {
	assert.throws(() => validateMercurySeed({}), /products/);
	assert.throws(() => validateMercurySeed({ products: [] }), /ריק/);
	assert.throws(() => validateMercurySeed({ products: [{ title: "", variants: [{ price_cents: 1 }] }] }), /title חסר/);
	assert.throws(() => validateMercurySeed({ products: [{ title: "A", variants: [] }] }), /variant/);
	assert.throws(() => validateMercurySeed({ products: [{ title: "A", variants: [{ price_cents: 12.5 }] }] }), /price_cents/);
	assert.throws(() => validateMercurySeed({ products: [{ title: "A", variants: [{ price_cents: 100, stock: -1 }] }] }), /stock/);
	assert.throws(() => validateMercurySeed({ products: [{ title: "A", variants: [{ price_cents: 1 }] }, { title: "A", variants: [{ price_cents: 1 }] }] }), /כפול/);
	const ok = validateMercurySeed({ products: [{ title: " A ", images: ["i1", "i2"], variants: [{ price_cents: 1500 }] }] });
	assert.deepEqual(ok, [{ title: "A", description: "", image: "i1", images: ["i1", "i2"], variants: [{ title: "Default", sku: "", price_cents: 1500, stock: 0 }] }]);
	const m = await mercuryStandIn();
	try {
		await openMercuryStore(m.base, { name: "s" });
		await assert.rejects(seedMercuryStore({ base: m.base, storeId: "str_0001" }, { products: [{ title: "ok", variants: [{ price_cents: 1 }] }, { title: "bad", variants: [] }] }), /variant/);
		assert.equal(m.state.stores.str_0001.products.length, 0, "no product was created before validation finished");
	} finally { m.server.close(); }
});

test("seeding is idempotent by title across builds and records a receipt", async () => {
	const m = await mercuryStandIn();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-seed-"));
	try {
		const { storeId } = await openMercuryStore(m.base, { name: "s" });
		const cfg = { base: m.base, storeId };
		const seed = { products: [
			{ title: "פוסטר יפו", description: "A2", image: "https://x/a.jpg", variants: [{ title: "A2", sku: "YP-A2", price_cents: 18000, stock: 5 }] },
			{ title: "גלויה", variants: [{ price_cents: 1200, stock: 50 }] },
		] };
		const first = await seedMercuryStore(cfg, seed);
		assert.equal(first.created.length, 2); assert.deepEqual(first.skipped, []); assert.equal(first.total, 2);
		const second = await seedMercuryStore(cfg, seed);
		assert.deepEqual(second.created, []); assert.deepEqual(second.skipped, ["פוסטר יפו", "גלויה"]); assert.equal(second.total, 2);
		assert.equal(m.state.stores[storeId].products.length, 2, "re-seeding never duplicates products");
		// project sync: no seed → null; seed → receipt; unchanged seed → no network; edited seed → only the new title
		assert.equal(await syncMercurySeedFromProject(root, cfg), null);
		fs.mkdirSync(path.join(root, ".solstice/mercury"), { recursive: true });
		fs.writeFileSync(path.join(root, MERCURY_SEED_FILE), JSON.stringify(seed));
		const posts = () => m.state.seen.filter((s) => s.method === "POST" && s.url.endsWith("/products")).length;
		const before = posts();
		const r1 = await syncMercurySeedFromProject(root, cfg);
		assert.equal(r1.skipped.length, 2); assert.equal(posts(), before);
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, MERCURY_SEEDED_FILE), "utf8")).storeId, storeId);
		const r2 = await syncMercurySeedFromProject(root, cfg);
		assert.equal(r2.unchanged, true);
		assert.equal(m.state.seen.filter((s) => s.url.endsWith("/products")).length, m.state.seen.filter((s) => s.url.endsWith("/products")).length, "unchanged seed makes no request");
		const reqs = m.state.seen.length;
		await syncMercurySeedFromProject(root, cfg);
		assert.equal(m.state.seen.length, reqs, "unchanged seed makes no request");
		seed.products.push({ title: "מגנט", variants: [{ price_cents: 900 }] });
		fs.writeFileSync(path.join(root, MERCURY_SEED_FILE), JSON.stringify(seed));
		const r3 = await syncMercurySeedFromProject(root, cfg);
		assert.deepEqual(r3.created.map((c) => c.title), ["מגנט"]); assert.equal(r3.total, 3);
		fs.writeFileSync(path.join(root, MERCURY_SEED_FILE), "{ not json");
		await assert.rejects(syncMercurySeedFromProject(root, cfg), /JSON/);
	} finally { m.server.close(); }
});

// The real engine (genesis/commerce/server.mjs) on a throw-away SQLite DB: the exact
// router Thomas runs, zero residue in the production store list. Skipped where the
// engine is not on disk (CI).
const ENGINE = process.env.MERCURY_ENGINE_PATH || "/home/thomas/genesis/commerce/server.mjs";
test("live engine: open a store, seed it, and buy through the generated client", { skip: !fs.existsSync(ENGINE) && "mercury engine not on this machine" }, async () => {
	const probe = http.createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
	const port = probe.address().port; await new Promise((r) => probe.close(r));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-engine-"));
	const child = spawn(process.execPath, [ENGINE], { env: { ...process.env, MERCURY_DB_PATH: path.join(dir, "m.db"), MERCURY_PORT: String(port), MERCURY_BASE: "http://127.0.0.1:" + port, STRIPE_SECRET_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
	let logs = ""; child.stdout.on("data", (d) => { logs += d; }); child.stderr.on("data", (d) => { logs += d; });
	const base = "http://127.0.0.1:" + port;
	try {
		let up = false;
		for (let i = 0; i < 100 && !up; i++) { try { up = (await mercuryHealth(base)).base === base; } catch { await new Promise((r) => setTimeout(r, 100)); } }
		assert.ok(up, "engine did not come up: " + logs.slice(-500));
		const opened = await openMercuryStore(base, { name: "Solstice open-store proof", currency: "ILS", vertical: "solstice" });
		assert.match(opened.storeId, /^str_[a-f0-9]{16}$/);
		assert.equal(opened.store.currency, "ILS");
		const cfg = parseMercuryCredential(opened.credential);
		const seed = { products: [
			{ title: "פוסטר יפו A2", description: "הדפס פיגמנט", image: base + "/uploads/none.jpg", variants: [{ title: "A2", sku: "YP-A2", price_cents: 18000, stock: 5 }, { title: "A3", sku: "YP-A3", price_cents: 12000, stock: 9 }] },
			{ title: "גלויות (סט 6)", variants: [{ price_cents: 3600, stock: 40 }] },
		] };
		const s1 = await seedMercuryStore(cfg, seed); assert.equal(s1.created.length, 2);
		const s2 = await seedMercuryStore(cfg, seed); assert.equal(s2.created.length, 0); assert.equal(s2.skipped.length, 2);
		const status = await mercuryStoreStatus(cfg); assert.equal(status.products, 2); assert.equal(status.name, "Solstice open-store proof");
		const file = path.join(dir, "mercury.mjs"); fs.writeFileSync(file, mercuryClientSourceJs(cfg));
		const m = await import(file);
		const products = await m.getProducts();
		assert.equal(products.length, 2);
		const poster = products.find((p) => p.title === "פוסטר יפו A2");
		assert.equal(poster.variants.length, 2); assert.equal(poster.variants.find((v) => v.sku === "YP-A2").price_cents, 18000);
		const co = await m.createCheckout([{ variant_id: poster.variants[0].id, qty: 2 }]);
		assert.equal(co.provider, "mock"); assert.ok(/\/pay\/cs_/.test(co.url), co.url);
		assert.equal(co.total_cents, 2 * poster.variants[0].price_cents);
		// Update the existing catalog, preserving the IDs already stored in carts.
		const oldIds = poster.variants.map(v => v.id).sort();
		seed.products[0].variants[0].price_cents = 19500;
		seed.products[0].description = "מהדורה מעודכנת";
		const edited = await seedMercuryStore(cfg, seed);
		assert.equal(edited.updated.length, 1);
		const after = (await m.getProducts()).find(p => p.id === poster.id);
		assert.equal(after.description, "מהדורה מעודכנת");
		assert.deepEqual(after.variants.map(v => v.id).sort(), oldIds);
		assert.equal(after.variants.find(v => v.sku === "YP-A2").price_cents, 19500);
		const existingCart = await m.createCheckout([{ variant_id: poster.variants.find(v => v.sku === "YP-A2").id, qty: 1 }]);
		assert.equal(existingCart.total_cents, 19500);
		// A project receipt tracks desired values. Content edits must not restock
		// variants whose inventory was changed by the store since the last sync.
		const seedDir = path.join(dir, ".solstice/mercury"); fs.mkdirSync(seedDir, { recursive: true });
		const seedFile = path.join(dir, MERCURY_SEED_FILE);
		fs.writeFileSync(seedFile, JSON.stringify(seed));
		await syncMercurySeedFromProject(dir, cfg);
		const inventory = after.variants.map(v => ({ ...v, stock: v.sku === "YP-A2" ? 2 : v.stock }));
		await fetch(base + "/api/stores/" + cfg.storeId + "/products/" + poster.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variants: inventory }) });
		seed.products[0].description = "תיאור חדש לאחר מכירה";
		fs.writeFileSync(seedFile, JSON.stringify(seed));
		await syncMercurySeedFromProject(dir, cfg);
		const afterSale = (await m.getProducts()).find(p => p.id === poster.id);
		assert.equal(afterSale.variants.find(v => v.sku === "YP-A2").stock, 2, "unrelated edits must not reset inventory");
		// Omitted variants/optional fields remain intact, including option maps.
		const partial = { products: [{ title: poster.title, variants: [{ sku: "YP-A2", price_cents: 20500 }] }] };
		await seedMercuryStore(cfg, partial);
		const preserved = (await m.getProducts()).find(p => p.id === poster.id);
		assert.deepEqual(preserved.variants.map(v => v.id).sort(), oldIds);
		assert.equal(preserved.description, afterSale.description);
		assert.equal(preserved.variants.find(v => v.sku === "YP-A2").stock, 2);
		partial.products[0].variants[0].stock = 50;
		const adoption = await seedMercuryStore(cfg, partial);
		assert.deepEqual(adoption.preservedInventory, [{ product: poster.title, variant: "YP-A2", requested: 50, actual: 2 }]);
		assert.equal((await m.getProducts()).find(p => p.id === poster.id).variants.find(v => v.sku === "YP-A2").stock, 2, "first adoption never overwrites live stock");
		// A 200 response is insufficient when the write was not persisted.
		const ignoredWrite = async (url, init) => init.method === "POST" ? { status: 200, ok: true, json: async () => ({ id: poster.id }) } : fetch(url, init);
		partial.products[0].variants[0].price_cents = 99999;
		await assert.rejects(seedMercuryStore(cfg, partial, ignoredWrite), /אינם תואמים/);
		await m.trackEvent("view_product", { id: poster.id });
		const analytics = await (await fetch(base + "/api/stores/" + cfg.storeId + "/analytics")).json();
		assert.ok(analytics && typeof analytics === "object");
		fs.writeFileSync(path.join(dir, "PROOF.json"), JSON.stringify({ base, store: opened.store, seed: s1, reseed: s2, status, checkout: co }, null, 2));
		process.env.MERCURY_LIVE_PROOF_DIR = dir;
		console.log("# live-engine proof: " + path.join(dir, "PROOF.json"));
	} finally { child.kill("SIGTERM"); }
});

test("project receipt is scoped to the engine as well as store id", async () => {
 const a = await mercuryStandIn(), b = await mercuryStandIn();
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-engines-"));
 try {
  const first = await openMercuryStore(a.base, { name: "dev" });
  const second = await openMercuryStore(b.base, { name: "staging" });
  assert.equal(first.storeId, second.storeId);
  fs.mkdirSync(path.join(root, ".solstice/mercury"), { recursive: true });
  fs.writeFileSync(path.join(root, MERCURY_SEED_FILE), JSON.stringify({ products: [{ title: "Print", variants: [{ price_cents: 2500 }] }] }));
  await syncMercurySeedFromProject(root, { base: a.base, storeId: first.storeId });
  const result = await syncMercurySeedFromProject(root, { base: b.base, storeId: second.storeId });
  assert.equal(result.created.length, 1);
  assert.equal(b.state.stores[second.storeId].products.length, 1, "new engine must receive its own catalog");
  assert.equal(result.base, b.base);
 } finally { a.server.close(); b.server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("overlapping seed requests serialize and a failed request releases the queue", async () => {
 const m = await mercuryStandIn();
 try {
  const { storeId } = await openMercuryStore(m.base, { name: "parallel" });
  const cfg = { base: m.base, storeId };
  const seed = { products: [{ title: "Only once", variants: [{ price_cents: 100 }] }] };
  const replies = await Promise.all([seedMercuryStore(cfg, seed), seedMercuryStore(cfg, seed), seedMercuryStore(cfg, seed)]);
  assert.equal(m.state.stores[storeId].products.length, 1);
  assert.equal(replies.reduce((sum, r) => sum + r.created.length, 0), 1);
  let fail = true;
  const flakyFetch = async (url, init) => {
   if (fail && init.method === "POST") { fail = false; throw new Error("disconnected"); }
   return fetch(url, init);
  };
  const next = { products: [{ title: "Retry", variants: [{ price_cents: 200 }] }] };
  const results = await Promise.allSettled([seedMercuryStore(cfg, next, flakyFetch), seedMercuryStore(cfg, next, flakyFetch)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(m.state.stores[storeId].products.length, 2);
 } finally { m.server.close(); }
});

test("invalid prices and stocks never become free products or implicit inventory", () => {
 for (const value of [null, "", true, "100", Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => validateMercurySeed({ products: [{ title: "Print", variants: [{ price_cents: value }] }] }), /price_cents/);
  assert.throws(() => validateMercurySeed({ products: [{ title: "Print", variants: [{ price_cents: 100, stock: value }] }] }), /stock/);
 }
 assert.throws(() => validateMercurySeed({ products: [{ title: "Print", variants: [null] }] }), /price_cents/);
});

test("duplicate variants and ambiguous live titles fail before any product write", async () => {
 const product = { title: "Print", variants: [{ sku: "A", price_cents: 100 }, { sku: "A", price_cents: 200 }] };
 assert.throws(() => validateMercurySeed({ products: [product] }), /variant כפול/);
 const m = await mercuryStandIn();
 try {
  const { storeId } = await openMercuryStore(m.base, { name: "duplicates" });
  m.state.stores[storeId].products = [{ id: "prd_a", title: "Same" }, { id: "prd_b", title: "Same" }];
  const before = m.state.seen.length;
  await assert.rejects(seedMercuryStore({ base: m.base, storeId }, { products: [{ title: "First", variants: [{ price_cents: 1 }] }, { title: "Same", variants: [{ price_cents: 2 }] }] }), /לא חד-משמעי/);
  assert.equal(m.state.seen.slice(before).filter(x => x.method === 'POST').length, 0);
 } finally { m.server.close(); }
});

test("sync failure is persisted, stale success is rejected, recovery clears failure", async () => {
 const { mercurySyncStatus } = require('./mercuryBridge');
 const { projectReadiness, acceptanceContext } = require('./projectReadiness');
 const m = await mercuryStandIn(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-status-'));
 try {
  const dir = path.join(root,'.solstice/mercury'); fs.mkdirSync(dir,{recursive:true});
  const seed = {products:[{title:'Proof',variants:[{price_cents:500}]}]};
  fs.writeFileSync(path.join(root,MERCURY_SEED_FILE),JSON.stringify(seed));
  assert.equal(mercurySyncStatus(root).status,'unverified');
  await assert.rejects(syncMercurySeedFromProject(root,null),/חבר חנות/);
  assert.equal(mercurySyncStatus(root).status,'failed');
  assert.equal(projectReadiness(root).rows.find(x=>x.id==='mercury').status,'failed');
  assert.match(acceptanceContext(root,__dirname),/FELIX_MERCURY_SYNC.*failed/);
  assert.equal(fs.existsSync(path.join(root,MERCURY_SEEDED_FILE)),false);
  const {storeId}=await openMercuryStore(m.base,{name:'recovery'}),cfg={base:m.base,storeId};
  await syncMercurySeedFromProject(root,cfg);
  assert.equal(mercurySyncStatus(root).status,'passed');
  assert.equal(projectReadiness(root).rows.find(x=>x.id==='mercury').status,'passed');
  seed.products.push({title:'Next',variants:[{price_cents:1}]});
  fs.writeFileSync(path.join(root,MERCURY_SEED_FILE),JSON.stringify(seed));
  assert.equal(mercurySyncStatus(root).status,'stale');
  assert.match(acceptanceContext(root,__dirname),/FELIX_MERCURY_SYNC.*stale/);
  const receiptBefore=fs.readFileSync(path.join(root,MERCURY_SEEDED_FILE),'utf8');
  await assert.rejects(syncMercurySeedFromProject(root,cfg,async()=>{throw Error('offline');}),/offline/);
  assert.equal(fs.readFileSync(path.join(root,MERCURY_SEEDED_FILE),'utf8'),receiptBefore);
  const results=await Promise.all([syncMercurySeedFromProject(root,cfg),syncMercurySeedFromProject(root,cfg)]);
  assert.equal(results[0].created.length,1);assert.equal(results[1].unchanged,true);
  assert.equal(mercurySyncStatus(root).status,'passed');
  // A pre-update receipt is not proof that an existing product was updated.
  const receipt=JSON.parse(fs.readFileSync(path.join(root,MERCURY_SEEDED_FILE),'utf8'));delete receipt.version;
  fs.writeFileSync(path.join(root,MERCURY_SEEDED_FILE),JSON.stringify(receipt));
  const requests=m.state.seen.length;
  await syncMercurySeedFromProject(root,cfg);
  assert.ok(m.state.seen.length>requests,'legacy receipt must be revalidated');
 } finally { m.server.close();fs.rmSync(root,{recursive:true,force:true}); }
});
