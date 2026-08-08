"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");


const STUDIO_KEY_PATHS = [
	process.env.SOLSTICE_FOUNDATION_STUDIO_KEY_FILE,
	path.join(os.homedir(), ".solstice", "foundation-studio-key"),
	"/home/thomas/Julius-cc-x/agents/atrium/output/_marketing/_agent_access/key",
].filter(Boolean);

function readStudioKeyFromDisk() {
	for (const candidate of STUDIO_KEY_PATHS) {
		try {
			const value = fs.readFileSync(candidate, "utf-8").trim();
			if (value) return value;
		} catch { /* try the next candidate */ }
	}
	return "";
}

const FOUNDATION_EVENTS_URL = "https://srv1404664.tailf3ebe4.ts.net:10000/api/foundation/events";
const BUSINESS_NAME_EVENT = "business.name_updated";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class FoundationSyncError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = "FoundationSyncError";
		Object.assign(this, details);
	}
}

function readJson(file, fallback) {
	let text;
	try { text = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if (error && error.code === "ENOENT") return fallback;
		throw new FoundationSyncError(`Cannot read Foundation state at ${file}.`, { code: "state_read_failed", cause: error });
	}
	try { return JSON.parse(text); }
	catch (error) {
		throw new FoundationSyncError(`Foundation state is corrupt at ${file}; refusing to discard it.`, {
			code: "corrupt_local_state", cause: error,
		});
	}
}

function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { }
	}
}

function normalizeBusinessId(value) {
	const id = String(value || "").trim();
	if (!id || id.length > 240 || /[\u0000-\u001f]/.test(id)) {
		throw new FoundationSyncError("Foundation business_id is invalid.", { code: "invalid_business_id" });
	}
	return id;
}

function normalizeBusinessName(value) {
	const name = String(value || "").trim();
	if (!name || name.length > 240 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name)) {
		throw new FoundationSyncError("Foundation business name is invalid.", { code: "invalid_business_name" });
	}
	return name;
}

function eventId(event) {
	return String(event && (event.event_id || event.payload && event.payload.event_id || event.id) || "");
}

function eventBusinessName(event) {
	if (!event || event.event_type !== BUSINESS_NAME_EVENT) return "";
	const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
	if (payload.field && payload.field !== "name") return "";
	return String(payload.value || payload.name || "").trim();
}

function requestJson(endpoint, options = {}) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(endpoint);
			for (const [key, value] of Object.entries(options.query || {})) {
				if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
			}
		} catch {
			reject(new FoundationSyncError("Foundation events URL is invalid.", { code: "invalid_url" }));
			return;
		}
		if (!/^https?:$/.test(url.protocol)) {
			reject(new FoundationSyncError("Foundation events URL must use HTTP(S).", { code: "invalid_url" }));
			return;
		}
		const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
		const headers = { accept: "application/json", ...(options.headers || {}) };
		if (body) Object.assign(headers, { "content-type": "application/json", "content-length": body.length });
		const transport = url.protocol === "https:" ? https : http;
		const request = transport.request(url, {
			method: options.method || "GET",
			headers,
			timeout: options.timeout || 10000,
		}, (response) => {
			const chunks = [];
			let bytes = 0;
			response.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > MAX_RESPONSE_BYTES) {
					request.destroy(new FoundationSyncError("Foundation response exceeded the safe size limit.", { code: "response_too_large" }));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let parsed;
				try { parsed = text ? JSON.parse(text) : {}; }
				catch { reject(new FoundationSyncError("Foundation returned invalid JSON.", { code: "invalid_json" })); return; }
				if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
					reject(new FoundationSyncError(`Foundation returned HTTP ${response.statusCode}.`, {
						code: "http_error", statusCode: response.statusCode, response: parsed,
					}));
					return;
				}
				resolve(parsed);
			});
		});
		request.on("timeout", () => request.destroy(new FoundationSyncError("Foundation request timed out.", { code: "timeout" })));
		request.on("error", (error) => reject(error instanceof FoundationSyncError ? error : new FoundationSyncError(
			`Foundation is unavailable at ${url.origin}: ${error.message}`,
			{ code: "service_unavailable", cause: error }
		)));
		if (body) request.write(body);
		request.end();
	});
}

function foundationBusinessesUrl(endpoint, studioKey = "") {
	let url;
	try { url = new URL(String(endpoint || FOUNDATION_EVENTS_URL)); }
	catch { throw new FoundationSyncError("Foundation events URL is invalid.", { code: "invalid_url" }); }
	url.pathname = "/api/foundation/businesses";
	url.search = "";
	if (!String(studioKey || "").trim()) url.searchParams.set("dev", "studio");
	url.hash = "";
	return url.toString();
}

function normalizeBusinessSlug(value) {
	const slug = String(value || "").trim();
	if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
		throw new FoundationSyncError("Foundation business slug is invalid.", { code: "invalid_business_slug" });
	}
	return slug;
}

function foundationBusinessDetailUrl(endpoint, businessSlug, studioKey = "") {
	let url;
	try { url = new URL(String(endpoint || FOUNDATION_EVENTS_URL)); }
	catch { throw new FoundationSyncError("Foundation events URL is invalid.", { code: "invalid_url" }); }
	const slug = normalizeBusinessSlug(businessSlug);
	url.pathname = `/api/foundation/businesses/${encodeURIComponent(slug)}`;
	url.search = "";
	url.searchParams.set("projection", "atrium");
	if (!String(studioKey || "").trim()) url.searchParams.set("dev", "studio");
	url.hash = "";
	return url.toString();
}

class FoundationClient {
	constructor(options = {}) {
		this.endpoint = options.endpoint || FOUNDATION_EVENTS_URL;
		this.storageDir = path.resolve(options.storageDir || path.join(process.cwd(), ".solstice", "foundation-sync"));
		this.businessFile = path.resolve(options.businessFile || path.join(process.cwd(), ".solstice", "foundation.json"));
		this.businessId = String(options.businessId || "").trim();
		this.businessName = "";
		// Reads accept the ?dev=studio bypass; writes no longer do — the events
		// endpoint appends to every business's history and the dev server sits
		// behind a Tailscale funnel, so an unauthenticated write path was not
		// acceptable. Fall back to the key Atrium mints on disk so a local
		// Solstice keeps working without anyone having to paste a secret.
		this.studioKey = String(
			Object.prototype.hasOwnProperty.call(options, "studioKey")
				? options.studioKey
				: readStudioKeyFromDisk(),
		).trim();
		this.pollMs = Math.max(1000, Number(options.pollMs) || 5000);
		this.timeout = Math.max(250, Number(options.timeout) || 10000);
		this.log = typeof options.log === "function" ? options.log : () => {};
		this.cursorFile = path.join(this.storageDir, "cursor.json");
		this.outboxFile = path.join(this.storageDir, "outbox.json");
		this.cursor = null;
		this.outbox = [];
		this.timer = null;
		this.watcher = null;
		this.watchDebounce = null;
		this.syncPromise = null;
		this.disposed = false;
	}

	_load() {
		fs.mkdirSync(this.storageDir, { recursive: true });
		const cursor = readJson(this.cursorFile, {});
		this.cursor = cursor && cursor.cursor || null;
		const outbox = readJson(this.outboxFile, { events: [] });
		this.outbox = Array.isArray(outbox && outbox.events) ? outbox.events : [];
		const business = readJson(this.businessFile, {});
		if (!this.businessId && business.business_id) this.businessId = normalizeBusinessId(business.business_id);
		if (business.name) this.businessName = normalizeBusinessName(business.name);
	}

	_headers() {
		return this.studioKey ? { "x-studio-key": this.studioKey } : {};
	}

	_saveCursor() {
		writeJsonAtomic(this.cursorFile, { cursor: this.cursor, updated_at: new Date().toISOString() });
	}

	_saveOutbox() {
		writeJsonAtomic(this.outboxFile, { events: this.outbox });
	}

	_writeBusiness(source, occurredAt) {
		if (!this.businessId || !this.businessName) return;
		writeJsonAtomic(this.businessFile, {
			business_id: this.businessId,
			name: this.businessName,
			updated_at: occurredAt || new Date().toISOString(),
			source,
		});
	}

	_watchBusinessFile() {
		fs.mkdirSync(path.dirname(this.businessFile), { recursive: true });
		this.watcher = fs.watch(path.dirname(this.businessFile), { persistent: false }, (_event, filename) => {
			if (filename && path.basename(String(filename)) !== path.basename(this.businessFile)) return;
			clearTimeout(this.watchDebounce);
			this.watchDebounce = setTimeout(() => {
				let business;
				try { business = readJson(this.businessFile, null); }
				catch (error) { this.log(`[foundation] ignored unreadable local file: ${error.message}`); return; }
				if (!business || !business.business_id || !business.name) return;
				let id;
				let name;
				try {
					id = normalizeBusinessId(business.business_id);
					name = normalizeBusinessName(business.name);
				} catch (error) {
					this.log(`[foundation] ignored invalid local file: ${error.message}`);
					return;
				}
				if (this.businessId && id !== this.businessId) {
					this.log(`[foundation] ignored business_id change; CP-1 is locked to ${this.businessId}`);
					return;
				}
				if (name === this.businessName) return;
				this.updateBusinessName(id, name).catch((error) => this.log(`[foundation] local update failed: ${error.message}`));
			}, 120);
		});
	}

	async start() {
		if (this.disposed) throw new FoundationSyncError("Foundation client is disposed.", { code: "disposed" });
		this._load();
		this._watchBusinessFile();
		if (this.businessId) await this.syncNow();
		this.timer = setInterval(() => this.syncNow().catch(() => {}), this.pollMs);
		if (this.timer.unref) this.timer.unref();
		return this.status();
	}

	status() {
		return {
			business_id: this.businessId || null,
			name: this.businessName || null,
			cursor: this.cursor,
			queued: this.outbox.length,
		};
	}

	async listBusinesses() {
		const response = await requestJson(foundationBusinessesUrl(this.endpoint, this.studioKey), {
			headers: this._headers(),
			timeout: this.timeout,
		});
		if (!response || response.ok !== true || !Array.isArray(response.businesses)) {
			throw new FoundationSyncError("Foundation returned an invalid businesses board.", { code: "invalid_businesses_response" });
		}
		return response;
	}

	async getBusinessDetail(businessSlug) {
		const response = await requestJson(foundationBusinessDetailUrl(this.endpoint, businessSlug, this.studioKey), {
			headers: this._headers(),
			timeout: this.timeout,
		});
		if (!response || response.ok !== true || !response.business || !response.domain
			|| !Array.isArray(response.connections) || !Array.isArray(response.events) || !Array.isArray(response.relationships)) {
			throw new FoundationSyncError("Foundation returned an invalid business workspace.", { code: "invalid_business_detail_response" });
		}
		return response;
	}

	async updateBusinessName(businessId, name) {
		const id = normalizeBusinessId(businessId || this.businessId);
		const nextName = normalizeBusinessName(name);
		if (this.businessId && id !== this.businessId) {
			throw new FoundationSyncError("CP-1 supports one fixed business per workspace.", { code: "business_mismatch" });
		}
		this.businessId = id;
		this.businessName = nextName;
		const occurredAt = new Date().toISOString();
		const event = {
			event_id: crypto.randomUUID(),
			business_id: id,
			event_type: BUSINESS_NAME_EVENT,
			aggregate_type: "business",
			aggregate_id: id,
			actor_type: "user",
			actor_id: "solstice",
			origin: "solstice",
			occurred_at: occurredAt,
			payload: { field: "name", value: nextName, name: nextName },
		};
		this.outbox.push(event);
		this._saveOutbox();
		// Persist the retryable event before reflecting the change locally. If the
		// process dies between these writes, the event survives and is drained on
		// the next startup instead of silently losing an acknowledged local edit.
		this._writeBusiness("solstice", occurredAt);
		const sync = await this.syncNow();
		return { event, sync };
	}

	async _drainOutbox() {
		let delivered = 0;
		while (this.outbox.length) {
			const batch = this.outbox.slice(0, 100);
			const response = await requestJson(this.endpoint, {
				method: "POST",
				headers: this._headers(),
				body: { events: batch },
				timeout: this.timeout,
			});
			const rejectedIds = new Set((Array.isArray(response.rejected) ? response.rejected : [])
				.map((item) => String(item && item.event_id || "")).filter(Boolean));
			const accepted = batch.filter((item) => !rejectedIds.has(item.event_id));
			const acknowledged = Number(response.applied || 0) + Number(response.duplicate || 0);
			if (acknowledged !== accepted.length) {
				throw new FoundationSyncError("Foundation did not acknowledge the complete outbox batch.", {
					code: "incomplete_ack", response,
				});
			}
			this.outbox.splice(0, batch.length, ...batch.filter((item) => rejectedIds.has(item.event_id)));
			delivered += accepted.length;
			this._saveOutbox();
			if (rejectedIds.size) break;
		}
		return delivered;
	}

	async _pull() {
		if (!this.businessId) return 0;
		let applied = 0;
		for (let page = 0; page < 20; page += 1) {
			const response = await requestJson(this.endpoint, {
				headers: this._headers(),
				query: { since: this.cursor, exclude_origin: "solstice", limit: 200 },
				timeout: this.timeout,
			});
			const events = Array.isArray(response.events) ? response.events : [];
			for (const event of events) {
				if (String(event.business_id || "") !== this.businessId) continue;
				const name = eventBusinessName(event);
				if (!name) continue;
				this.businessName = normalizeBusinessName(name);
				this._writeBusiness("atrium", event.occurred_at);
				applied += 1;
			}
			if (response.cursor) {
				this.cursor = String(response.cursor);
				this._saveCursor();
			}
			if (events.length < 200) break;
		}
		return applied;
	}

	async syncNow() {
		if (this.syncPromise) return this.syncPromise;
		this.syncPromise = (async () => {
			try {
				const pushed = await this._drainOutbox();
				const pulled = await this._pull();
				return { ok: true, pushed, pulled, ...this.status() };
			} catch (error) {
				this.log(`[foundation] offline: ${error.message}`);
				return { ok: false, error: error.message, ...this.status() };
			} finally {
				this.syncPromise = null;
			}
		})();
		return this.syncPromise;
	}

	dispose() {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		if (this.watcher) this.watcher.close();
		clearTimeout(this.watchDebounce);
		this.timer = null;
		this.watcher = null;
	}
}

module.exports = {
	BUSINESS_NAME_EVENT,
	FOUNDATION_EVENTS_URL,
	FoundationClient,
	FoundationSyncError,
	eventBusinessName,
	eventId,
	foundationBusinessDetailUrl,
	foundationBusinessesUrl,
	normalizeBusinessId,
	normalizeBusinessName,
	normalizeBusinessSlug,
};
