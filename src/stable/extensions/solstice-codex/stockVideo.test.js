"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
	clampCount,
	bestPexelsFile,
	normalizePexels,
	normalizePexelsSearchHtml,
	normalizePixabay,
	interleave,
	searchStockVideo,
} = require("./webtools/stockVideo");

assert.equal(clampCount(undefined), 8);
assert.equal(clampCount(0), 1);
assert.equal(clampCount(99), 20);

const pexelsFiles = [
	{ file_type: "video/mp4", width: 3840, height: 2160, link: "https://cdn/4k.mp4" },
	{ file_type: "video/mp4", width: 1280, height: 720, link: "https://cdn/720.mp4" },
	{ file_type: "video/mp4", width: 1920, height: 1080, link: "https://cdn/1080.mp4" },
];
assert.equal(bestPexelsFile(pexelsFiles).link, "https://cdn/1080.mp4");
assert.equal(bestPexelsFile([{ file_type: "video/mp4", width: 3840, height: 2160, link: "https://cdn/4k.mp4" }]).link, "https://cdn/4k.mp4");
assert.equal(bestPexelsFile([{ file_type: "video/mp4", link: "http://unsafe/video.mp4" }]), null);

const pexels = normalizePexels({ videos: [{
	id: 7, url: "https://pexels/video/7", image: "https://img/poster.jpg", duration: 9,
	user: { name: "Ada", url: "https://pexels/@ada" }, video_files: pexelsFiles,
}] });
assert.equal(pexels.length, 1);
assert.equal(pexels[0].provider, "pexels");
assert.equal(pexels[0].videoUrl, "https://cdn/1080.mp4");
assert.equal(pexels[0].posterUrl, "https://img/poster.jpg");
assert.match(pexels[0].attribution, /Ada.*Pexels/);

const fallbackHtml = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.pexels.com%2Fvideo%2Fcalm%2Dclinic%2D9335857%2F&amp;rut=x">Calm &amp; clean clinic</a>`;
const fallback = normalizePexelsSearchHtml(fallbackHtml, 3);
assert.equal(fallback.length, 1);
assert.equal(fallback[0].id, "9335857");
assert.equal(fallback[0].videoUrl, "https://www.pexels.com/download/video/9335857/");
assert.equal(fallback[0].posterRequired, true);

const pixabay = normalizePixabay({ hits: [{
	id: 8, tags: "night, city", pageURL: "https://pixabay/video/8", duration: 12, user: "Lin",
	videos: { medium: { url: "https://cdn/pix.mp4", width: 1280, height: 720, size: 123, thumbnail: "https://cdn/pix.jpg" } },
}] });
assert.equal(pixabay.length, 1);
assert.equal(pixabay[0].provider, "pixabay");
assert.equal(pixabay[0].posterUrl, "https://cdn/pix.jpg");
assert.match(pixabay[0].licenseUrl, /pixabay/);

assert.deepEqual(interleave([[1, 2, 3], ["a", "b"]], 4), [1, "a", 2, "b"]);

const calls = [];
const fakeFetch = async (url, init) => {
	calls.push({ url: String(url), init });
	if (String(url).includes("pexels")) return { ok: true, status: 200, json: async () => ({ videos: [{ id: 1, url: "https://pexels/1", image: "https://poster/1", video_files: pexelsFiles }] }) };
	return { ok: true, status: 200, json: async () => ({ hits: [{ id: 2, pageURL: "https://pixabay/2", videos: { small: { url: "https://cdn/2.mp4" } } }] }) };
};

(async () => {
	const result = await searchStockVideo("  city night  ", 2, { env: { PEXELS_API_KEY: "pexels-secret", PIXABAY_API_KEY: "pixabay-secret" }, fetch: fakeFetch });
	assert.equal(result.query, "city night");
	assert.equal(result.results.length, 2);
	assert.deepEqual(result.results.map((item) => item.provider), ["pexels", "pixabay"]);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].init.headers.Authorization, "pexels-secret");
	assert.match(calls[1].url, /safesearch=true/);
	assert.doesNotMatch(JSON.stringify(result), /pexels-secret|pixabay-secret/);

	const pexelsOnly = await searchStockVideo("clinic", 1, { env: {}, fetch: fakeFetch });
	assert.equal(pexelsOnly.results[0].provider, "pexels");
	assert.match(pexelsOnly.warnings[0], /PIXABAY_API_KEY/);

	const fallbackFetch = async (url, init = {}) => {
		if (String(url).includes("api.pexels.com")) return { ok: false, status: 401, json: async () => ({}) };
		if (init.method === "HEAD") return { ok: true, status: 200, url: "https://videos.pexels.com/video-files/9335857/9335857-hd_1920_1080_25fps.mp4" };
		return { ok: true, status: 200, text: async () => fallbackHtml };
	};
	const fallbackResult = await searchStockVideo("clinic", 1, { env: {}, fetch: fallbackFetch });
	assert.equal(fallbackResult.results[0].id, "9335857");
	assert.match(fallbackResult.results[0].videoUrl, /^https:\/\/videos\.pexels\.com\/.*\.mp4$/);
	assert.match(fallbackResult.warnings.join(" "), /search-index fallback/);

	const browse = fs.readFileSync(path.join(__dirname, "webtools", "browse.js"), "utf8");
	assert.match(browse, /mode === "videosearch"[\s\S]{0,500}searchStockVideo/);
	assert.ok(browse.indexOf('mode === "videosearch"') < browse.indexOf("const bin = findBrowser()"));
	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const kit = fs.readFileSync(path.join(__dirname, "prompts", "animated-website-kit.md"), "utf8");
	const xfield = fs.readFileSync(path.join(__dirname, "prompts", "xfield-animated-wiring-plan.md"), "utf8");
	const browserUi = fs.readFileSync(path.join(__dirname, "media", "browser.js"), "utf8");
	assert.ok((extension.match(/videosearch/g) || []).length >= 6);
	assert.match(kit, /Images remain the default/);
	assert.match(kit, /<video muted playsInline preload="metadata" poster="\.\.\.">/);
	assert.match(kit, /IntersectionObserver/);
	assert.match(kit, /trimStart[\s\S]{0,80}trimEnd/);
	assert.match(kit, /may propose X-Field\/Seedance/);
	assert.match(kit, /no provider bridge is implemented/);
	assert.match(xfield, /proposal is not execution/);
	assert.match(xfield, /Autonomous never bypasses/);
	assert.match(browserUi, /videosearch:\s*"🎬 מחפש וידאו חינמי"/);
	console.log("stockVideo.test.js: 42/42 checks passed");
})().catch((err) => { console.error(err); process.exit(1); });
