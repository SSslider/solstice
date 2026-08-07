"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installBrandDnaDocument } = require("./brandPack");

const BRAND_DNA_BASE_URL = "http://100.88.154.26:8794";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function readBrandDnaKeyFromDisk() {
	const candidates = [
		process.env.SOLSTICE_BRAND_DNA_KEY_FILE,
		path.join(os.homedir(), ".solstice", "brand-dna-key"),
		path.join(os.homedir(), ".solstice", "foundation-studio-key"),
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			const value = fs.readFileSync(candidate, "utf8").trim();
			if (value) return value;
		} catch { }
	}
	return "";
}

class BrandDnaError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = "BrandDnaError";
		Object.assign(this, details);
	}
}

function normalizeBrandInput(value) {
	const raw = String(value || "").trim();
	if (!raw) throw new BrandDnaError("Enter a public website URL or domain.", { code: "missing_input" });
	let url;
	try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
	catch { throw new BrandDnaError("The website URL is invalid.", { code: "invalid_url" }); }
	if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) {
		throw new BrandDnaError("Use a public HTTP(S) website without embedded credentials.", { code: "invalid_url" });
	}
	url.hash = "";
	return {
		sourceUrl: url.toString(),
		domain: url.hostname.toLowerCase().replace(/^www\./, ""),
	};
}

function safePathSegment(value, label) {
	const segment = String(value || "").trim();
	if (!segment || segment.length > 240 || !/^[a-z0-9._-]+$/i.test(segment)) {
		throw new BrandDnaError(`${label} is invalid.`, { code: "invalid_path_segment" });
	}
	return encodeURIComponent(segment);
}

function request(baseUrl, pathname, options = {}) {
	return new Promise((resolve, reject) => {
		let url;
		try { url = new URL(pathname, String(baseUrl || BRAND_DNA_BASE_URL).replace(/\/$/, "") + "/"); }
		catch { reject(new BrandDnaError("Brand-DNA service URL is invalid.", { code: "invalid_service_url" })); return; }
		const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
		const maxBytes = options.maxBytes || MAX_JSON_BYTES;
		const transport = url.protocol === "https:" ? https : http;
		const headers = { ...(options.headers || {}) };
		if (body) Object.assign(headers, { "content-type": "application/json", "content-length": body.length });
		const req = transport.request(url, {
			method: options.method || "GET",
			headers,
			timeout: options.timeout || 15000,
		}, (res) => {
			const requestId = String(res.headers["x-request-id"] || res.headers["x-correlation-id"] || "");
			const chunks = [];
			let bytes = 0;
			res.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					req.destroy(new BrandDnaError("Brand-DNA response exceeded the safe size limit.", { code: "response_too_large" }));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				const payload = Buffer.concat(chunks);
				if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
					let detail = payload.toString("utf8").slice(0, 1200);
					try {
						const parsed = JSON.parse(detail);
						detail = parsed.error && parsed.error.message || parsed.detail && parsed.detail.message || parsed.detail || detail;
					} catch { }
					reject(new BrandDnaError(`Brand-DNA returned HTTP ${res.statusCode}: ${String(detail)}`, {
						code: "http_error", statusCode: res.statusCode, pathname, requestId,
					}));
					return;
				}
				resolve({ payload, contentType: String(res.headers["content-type"] || ""), headers: res.headers });
			});
		});
		req.on("timeout", () => req.destroy(new BrandDnaError("Brand-DNA timed out.", { code: "timeout" })));
		req.on("error", (error) => reject(error instanceof BrandDnaError ? error : new BrandDnaError(
			`Brand-DNA is unavailable at ${url.origin}: ${error.message}`,
			{ code: "service_unavailable", cause: error }
		)));
		if (body) req.write(body);
		req.end();
	});
}

async function requestJson(baseUrl, pathname, options = {}) {
	const result = await request(baseUrl, pathname, options);
	try { return JSON.parse(result.payload.toString("utf8")); }
	catch { throw new BrandDnaError("Brand-DNA returned invalid JSON.", { code: "invalid_json", pathname }); }
}

class BrandDnaClient {
	constructor(options = {}) {
		this.baseUrl = options.baseUrl || BRAND_DNA_BASE_URL;
		this.authKey = String(options.authKey || process.env.SOLSTICE_BRAND_DNA_AUTH_KEY || readBrandDnaKeyFromDisk()).trim();
		this.timeout = options.timeout || 90000;
	}

	_requestOptions(options = {}) {
		return { ...options, headers: this.authKey ? { ...(options.headers || {}), "x-brand-dna-key": this.authKey } : options.headers };
	}
	health() { return requestJson(this.baseUrl, "/health", this._requestOptions({ timeout: Math.min(this.timeout, 5000) })); }
	extract(value, refresh = false) {
		const input = normalizeBrandInput(value);
		return requestJson(this.baseUrl, "/extract", this._requestOptions({ method: "POST", body: { url: input.sourceUrl, refresh: !!refresh }, timeout: this.timeout }));
	}
	profile(value) {
		const input = normalizeBrandInput(value);
		return requestJson(this.baseUrl, `/dna/${safePathSegment(input.domain, "Domain")}`, this._requestOptions({ timeout: this.timeout }));
	}
	recrawl(value) {
		const input = normalizeBrandInput(value);
		return requestJson(this.baseUrl, `/recrawl/${safePathSegment(input.domain, "Domain")}`, this._requestOptions({ method: "POST", timeout: this.timeout }));
	}
	moodboard(value) {
		const input = normalizeBrandInput(value);
		return requestJson(this.baseUrl, `/moodboard/${safePathSegment(input.domain, "Domain")}`, this._requestOptions({ timeout: this.timeout }));
	}
	async moodboardPng(value) {
		const input = normalizeBrandInput(value);
		const result = await request(this.baseUrl, `/moodboard/${safePathSegment(input.domain, "Domain")}?format=png`, this._requestOptions({ timeout: this.timeout, maxBytes: MAX_IMAGE_BYTES }));
		if (!/^image\/png\b/i.test(result.contentType)) throw new BrandDnaError("Moodboard endpoint did not return a PNG.", { code: "invalid_image" });
		return `data:image/png;base64,${result.payload.toString("base64")}`;
	}
	visualBrief(clientSlug) {
		return requestJson(this.baseUrl, `/visual-brief/${safePathSegment(clientSlug, "Client slug")}`, this._requestOptions({ timeout: this.timeout }));
	}
}

function attachApprovedBrandDna(root, profile, approval = {}) {
	try { return installBrandDnaDocument(root, profile, approval); }
	catch (error) {
		throw error instanceof BrandDnaError ? error : new BrandDnaError(error.message, { code: "attach_failed", cause: error });
	}
}

module.exports = {
	BRAND_DNA_BASE_URL,
	BrandDnaClient,
	BrandDnaError,
	attachApprovedBrandDna,
	normalizeBrandInput,
	readBrandDnaKeyFromDisk,
};
