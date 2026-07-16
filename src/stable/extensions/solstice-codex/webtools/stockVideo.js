"use strict";

const PEXELS_API = "https://api.pexels.com/videos/search";
const PIXABAY_API = "https://pixabay.com/api/videos/";

function clampCount(value) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.min(20, Math.max(1, parsed)) : 8;
}

function decodeHtml(value) {
	return String(value || "")
		.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ").trim();
}

function normalizePexelsSearchHtml(html, limit) {
	const out = [];
	const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of String(html || "").matchAll(re)) {
		let href = decodeHtml(match[1]);
		try {
			if (href.startsWith("//")) href = `https:${href}`;
			const redirect = new URL(href);
			href = redirect.searchParams.get("uddg") || href;
		} catch { continue; }
		const idMatch = href.match(/^https:\/\/(?:www\.)?pexels\.com\/video\/[^?#]*?-(\d+)\/?(?:[?#]|$)/i);
		if (!idMatch || out.some((item) => item.id === idMatch[1])) continue;
		const id = idMatch[1];
		out.push({
			provider: "pexels",
			id,
			title: decodeHtml(match[2]) || `Pexels video ${id}`,
			pageUrl: href,
			videoUrl: `https://www.pexels.com/download/video/${id}/`,
			posterUrl: "",
			duration: 0,
			width: 0,
			height: 0,
			fileType: "video/mp4",
			fileSize: 0,
			author: "Pexels creator",
			authorUrl: href,
			attribution: "Video on Pexels — retain the source page and creator credit shown there",
			licenseUrl: "https://www.pexels.com/license/",
			posterRequired: true,
		});
		if (out.length >= limit) break;
	}
	return out;
}

function bestPexelsFile(files) {
	const candidates = (Array.isArray(files) ? files : [])
		.filter((file) => file && /^https:\/\//i.test(String(file.link || "")) && /^video\/(mp4|webm)$/i.test(String(file.file_type || "")));
	if (!candidates.length) return null;
	const webSized = candidates.filter((file) => Number(file.width) <= 1920 && Number(file.height) <= 1080);
	return (webSized.length ? webSized : candidates).slice().sort((a, b) => {
		const pixels = (file) => (Number(file.width) || 0) * (Number(file.height) || 0);
		return webSized.length ? pixels(b) - pixels(a) : pixels(a) - pixels(b);
	})[0];
}

function normalizePexels(data) {
	return (Array.isArray(data && data.videos) ? data.videos : []).map((video) => {
		const file = bestPexelsFile(video.video_files);
		if (!file) return null;
		const author = String(video.user && video.user.name || "Pexels creator");
		return {
			provider: "pexels",
			id: String(video.id),
			title: `Pexels video ${video.id}`,
			pageUrl: String(video.url || ""),
			videoUrl: String(file.link),
			posterUrl: String(video.image || ""),
			duration: Number(video.duration) || 0,
			width: Number(file.width) || Number(video.width) || 0,
			height: Number(file.height) || Number(video.height) || 0,
			fileType: String(file.file_type || "video/mp4"),
			fileSize: Number(file.size) || 0,
			author,
			authorUrl: String(video.user && video.user.url || ""),
			attribution: `Video by ${author} on Pexels`,
			licenseUrl: "https://www.pexels.com/license/",
		};
	}).filter(Boolean);
}

function bestPixabayFile(videos) {
	for (const key of ["large", "medium", "small", "tiny"]) {
		const file = videos && videos[key];
		if (file && /^https:\/\//i.test(String(file.url || ""))) return file;
	}
	return null;
}

function normalizePixabay(data) {
	return (Array.isArray(data && data.hits) ? data.hits : []).map((video) => {
		const file = bestPixabayFile(video.videos);
		if (!file) return null;
		const author = String(video.user || "Pixabay creator");
		const poster = file.thumbnail || video.pictureURL || video.previewURL || "";
		return {
			provider: "pixabay",
			id: String(video.id),
			title: String(video.tags || `Pixabay video ${video.id}`),
			pageUrl: String(video.pageURL || ""),
			videoUrl: String(file.url),
			posterUrl: String(poster),
			duration: Number(video.duration) || 0,
			width: Number(file.width) || 0,
			height: Number(file.height) || 0,
			fileType: "video/mp4",
			fileSize: Number(file.size) || 0,
			author,
			authorUrl: String(video.userImageURL || ""),
			attribution: `Video by ${author} on Pixabay`,
			licenseUrl: "https://pixabay.com/service/license-summary/",
		};
	}).filter(Boolean);
}

async function requestJson(provider, url, init, fetchImpl) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetchImpl(url, { ...init, signal: controller.signal });
		if (!response || !response.ok) throw new Error(`${provider} returned HTTP ${response ? response.status : "unknown"}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

async function searchPexelsWeb(query, count, fetchImpl) {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", `site:pexels.com/video/ ${query}`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 Solstice stock-video search" }, signal: controller.signal });
		if (!response || !response.ok) throw new Error(`search index returned HTTP ${response ? response.status : "unknown"}`);
		const results = normalizePexelsSearchHtml(await response.text(), count);
		await Promise.all(results.map(async (result) => {
			try {
				const resolved = await fetchImpl(result.videoUrl, { method: "HEAD", redirect: "follow", signal: controller.signal });
				if (resolved && resolved.ok && /^https:\/\/videos\.pexels\.com\/.*\.mp4(?:[?#]|$)/i.test(String(resolved.url || ""))) {
					result.videoUrl = String(resolved.url);
				}
			} catch { /* The stable download endpoint remains a usable <video> source. */ }
		}));
		return results;
	} finally {
		clearTimeout(timer);
	}
}

function interleave(groups, limit) {
	const out = [];
	for (let index = 0; out.length < limit; index++) {
		let added = false;
		for (const group of groups) {
			if (group[index]) { out.push(group[index]); added = true; }
			if (out.length >= limit) break;
		}
		if (!added) break;
	}
	return out;
}

async function searchStockVideo(query, requestedCount, options = {}) {
	const cleanQuery = String(query || "").trim();
	if (!cleanQuery) throw new Error("videosearch requires a non-empty query");
	const count = clampCount(requestedCount);
	const env = options.env || process.env;
	const fetchImpl = options.fetch || globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("videosearch requires Node 18+ (global fetch)");
	const warnings = [];
	const jobs = [];
	const pexelsUrl = new URL(PEXELS_API);
	pexelsUrl.searchParams.set("query", cleanQuery);
	pexelsUrl.searchParams.set("per_page", String(count));
	const pexelsHeaders = env.PEXELS_API_KEY ? { Authorization: env.PEXELS_API_KEY } : {};
	jobs.push(requestJson("Pexels", pexelsUrl, { headers: pexelsHeaders }, fetchImpl).then(normalizePexels));

	if (env.PIXABAY_API_KEY) {
		const pixabayUrl = new URL(PIXABAY_API);
		pixabayUrl.searchParams.set("key", env.PIXABAY_API_KEY);
		pixabayUrl.searchParams.set("q", cleanQuery);
		pixabayUrl.searchParams.set("per_page", String(Math.max(3, count)));
		pixabayUrl.searchParams.set("safesearch", "true");
		jobs.push(requestJson("Pixabay", pixabayUrl, {}, fetchImpl).then(normalizePixabay));
	} else {
		warnings.push("Pixabay skipped: set PIXABAY_API_KEY to include its free stock library.");
	}

	const settled = await Promise.allSettled(jobs);
	const groups = settled.map((result, index) => {
		if (result.status === "fulfilled") return result.value;
		warnings.push(`${index === 0 ? "Pexels API" : "Pixabay"} unavailable: ${result.reason && result.reason.message || "request failed"}`);
		return [];
	});
	if (!groups[0].length) {
		try {
			groups[0] = await searchPexelsWeb(cleanQuery, count, fetchImpl);
			if (groups[0].length) warnings.push("Pexels search-index fallback used: download the chosen clip and extract a local poster frame before embedding.");
		} catch (error) {
			warnings.push(`Pexels search fallback unavailable: ${error && error.message || "request failed"}`);
		}
	}
	const results = interleave(groups, count);
	if (!results.length) throw new Error(`No free stock videos found for "${cleanQuery}". ${warnings.join(" ")}`.trim());
	return {
		query: cleanQuery,
		searchedAt: new Date().toISOString(),
		usage: "Download the chosen video/poster into the project when practical; retain pageUrl, attribution, and licenseUrl in the project manifest.",
		warnings,
		results,
	};
}

module.exports = {
	clampCount,
	bestPexelsFile,
	normalizePexels,
	normalizePexelsSearchHtml,
	bestPixabayFile,
	normalizePixabay,
	interleave,
	searchPexelsWeb,
	searchStockVideo,
};
