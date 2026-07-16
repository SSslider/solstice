#!/usr/bin/env node
"use strict";
// Headless-browser helper for the Solstice agent.
//   node browse.js search <query> [count]    → ranked web results (title/url/snippet), no API key
//   node browse.js read <url>                 → page main content as clean readable text/markdown
//   node browse.js crawl <url> [depth] [maxPages] → same-site crawl, prints text of each page
//   node browse.js shot <url> <out.png> [widthxheight]
//   node browse.js scrollshot <url> <outPrefix> [stops]   → outPrefix_s0..sN.png at scroll positions
//   node browse.js dom  <url>
//   node browse.js videoframes <url> <outPrefix> [frames] [referrer] → outPrefix_f0..fN.png seeked across the video
//   node browse.js showcase <url> <outDir> [maxAssets] → lazy-load page, download embedded media + manifest
// Uses an installed Chrome/Chromium/Edge in headless mode.
// search/read/crawl give the agent real autonomous research: discover URLs, read pages as
// text, and walk a site (e.g. an Awwwards/Behance gallery) — beyond single-URL screenshots.
// scrollshot exists because scroll-reveal sites (GSAP/IntersectionObserver) render
// below-the-fold sections at opacity:0 in a single no-scroll capture.
// videoframes exists for case-study videos (Behance/Dribbble embed Vimeo players that
// 401 on direct download but play fine in-browser with the right referrer).
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { searchStockVideo } = require("./stockVideo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
	if (process.env.SOLSTICE_BROWSER && fs.existsSync(process.env.SOLSTICE_BROWSER)) {
		return process.env.SOLSTICE_BROWSER;
	}
	const candidates = [];
	if (process.platform === "win32") {
		for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
			if (!base) continue;
			candidates.push(
				path.join(base, "Google/Chrome/Application/chrome.exe"),
				path.join(base, "Microsoft/Edge/Application/msedge.exe"),
				path.join(base, "BraveSoftware/Brave-Browser/Application/brave.exe")
			);
		}
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
		);
	} else {
		candidates.push(
			"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
			"/usr/bin/chromium", "/usr/bin/chromium-browser",
			"/snap/bin/chromium", "/usr/bin/microsoft-edge"
		);
	}
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

async function scrollshot(bin, url, outPrefix, nStops, dims) {
	if (typeof WebSocket !== "function") {
		console.error("scrollshot needs Node >= 22 (global WebSocket). Falling back: use 'shot' at several heights.");
		process.exit(4);
	}
	const [w, h] = dims.split(",").map(Number);
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const chrome = spawn(bin, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		`--user-data-dir=${tmpProfile}`, `--window-size=${w},${h}`,
		"--remote-debugging-port=0", "about:blank",
	], { stdio: "ignore", windowsHide: true });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await new Promise(r => setTimeout(r, 100));
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		// Use the initial tab + Page.navigate: tabs opened via /json/new are backgrounded
		// and Page.captureScreenshot hangs forever on a hidden target.
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
		const tab = tabs.find(t => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		};
		// Every command gets a deadline — a wedged page must produce an error, not a silent hang.
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms (page may be wedged)`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.navigate", { url }, 30000);
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
		for (let i = 0; i < 30; i++) { // dev servers compile on first hit — wait for real load
			if (await evalJs("document.readyState === 'complete'")) break;
			await new Promise(r => setTimeout(r, 500));
		}
		await new Promise(r => setTimeout(r, 2500)); // settle: fonts + first animations
		const height = await evalJs("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)");
		const stops = Array.from({ length: nStops }, (_, i) => Math.floor(Math.max(0, height - h) * (nStops === 1 ? 0 : i / (nStops - 1))));
		for (let i = 0; i < stops.length; i++) {
			await evalJs(`window.scrollTo({ top: ${stops[i]}, behavior: 'instant' }); ''`);
			await new Promise(r => setTimeout(r, 1500)); // let reveal animations fire
			const shot = await send("Page.captureScreenshot", { format: "png" });
			const file = path.resolve(`${outPrefix}_s${i}.png`);
			fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
			console.log(file);
		}
		ws.close();
	} finally {
		try { chrome.kill(); } catch { }
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

async function videoframes(bin, url, outPrefix, nFrames, referrer) {
	if (typeof WebSocket !== "function") {
		console.error("videoframes needs Node >= 22 (global WebSocket).");
		process.exit(4);
	}
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const chrome = spawn(bin, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		"--autoplay-policy=no-user-gesture-required",
		`--user-data-dir=${tmpProfile}`, "--window-size=1440,810",
		"--remote-debugging-port=0", "about:blank",
	], { stdio: "ignore", windowsHide: true });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await new Promise(r => setTimeout(r, 100));
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
		const tab = tabs.find(t => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		};
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.navigate", referrer ? { url, referrer } : { url }, 30000);
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
		let duration = 0;
		for (let i = 0; i < 60; i++) { // wait for a <video> with known duration (player JS + manifest load)
			duration = await evalJs("(() => { const v = document.querySelector('video'); return v && isFinite(v.duration) ? v.duration : 0; })()");
			if (duration > 0) break;
			await new Promise(r => setTimeout(r, 1000));
		}
		if (!duration) throw new Error("no playable <video> found on the page (player may have blocked the referrer)");
		console.log(`video duration: ${duration.toFixed(1)}s`);
		await evalJs("(() => { const v = document.querySelector('video'); v.pause(); v.muted = true; return 1; })()");
		for (let i = 0; i < nFrames; i++) {
			// keep 2% off both ends — t=0 is often a blank poster, t=duration snaps back to 0 on looped players
			const t = duration * (0.02 + 0.96 * (nFrames === 1 ? 0 : i / (nFrames - 1)));
			await evalJs(`(() => new Promise(res => {
				const v = document.querySelector('video');
				const done = () => { v.removeEventListener('seeked', done); setTimeout(() => res(1), 400); };
				v.addEventListener('seeked', done);
				v.currentTime = ${t};
				setTimeout(() => res(0), 8000);
			}))()`);
			const shot = await send("Page.captureScreenshot", { format: "png" });
			const file = path.resolve(`${outPrefix}_f${i}.png`);
			fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
			console.log(`${file} @ ${t.toFixed(1)}s`);
		}
		ws.close();
	} finally {
		try { chrome.kill(); } catch { }
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

// Behance and Dribbble case studies hide useful evidence behind lazy loading,
// srcsets, hydration payloads, and nested players. Turn the rendered showcase
// into a deterministic evidence bundle for DECONSTRUCT.md.
async function showcase(bin, url, outDir, maxAssets) {
	const root = path.resolve(outDir);
	fs.mkdirSync(root, { recursive: true });
	await withChrome(bin, async ({ evalJs, goto }) => {
		await goto(url, 1800);
		// Lazy galleries grow while scrolling. Recalculate height on every pass
		// and stop only after the bottom has remained stable several times.
		let previousHeight = 0, stablePasses = 0;
		for (let i = 0; i < 60 && stablePasses < 4; i++) {
			const height = await evalJs("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)");
			const y = Math.min(Math.max(0, height - 900), i * 850);
			await evalJs(`window.scrollTo({top:${y}, behavior:'instant'}); ''`);
			await sleep(450);
			const nextHeight = await evalJs("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)");
			stablePasses = y >= nextHeight - 950 && nextHeight === previousHeight ? stablePasses + 1 : 0;
			previousHeight = nextHeight;
		}
		await sleep(1200);
		const page = await evalJs(`(() => {
			const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
			const bestSrc = (img) => {
				const candidates = [];
				for (const item of (img.srcset || '').split(',')) {
					const m = item.trim().match(/^(\\S+)(?:\\s+(\\d+)w)?/);
					if (m) candidates.push({u: abs(m[1]), w: Number(m[2]) || 0});
				}
				candidates.push({u: abs(img.currentSrc || img.src || img.dataset.src || ''), w: img.naturalWidth || 0});
				return candidates.filter(x => x.u).sort((a,b) => b.w-a.w)[0]?.u || '';
			};
			const domImages = [...document.images].map((img, index) => {
				const r = img.getBoundingClientRect();
				return {index, url: bestSrc(img), alt: img.alt || '', width: img.naturalWidth || 0,
					height: img.naturalHeight || 0, renderedWidth: Math.round(r.width), renderedHeight: Math.round(r.height)};
			}).filter(x => x.url && x.width >= 280 && x.height >= 180);
			const videos = [...document.querySelectorAll('video')].map((v, index) => ({
				index, url: abs(v.currentSrc || v.src || v.querySelector('source')?.src || ''), poster: abs(v.poster || ''),
				duration: isFinite(v.duration) ? v.duration : 0, width: v.videoWidth || 0, height: v.videoHeight || 0
			})).filter(x => x.url || x.poster);
			const iframes = [...document.querySelectorAll('iframe')].map((f, index) => ({index, url: abs(f.src || ''), title: f.title || ''}))
				.filter(x => /vimeo|youtube|player|video/i.test(x.url + ' ' + x.title));
			return {title: document.title, finalUrl: location.href, pageHeight: document.documentElement.scrollHeight,
				viewport: {width: innerWidth, height: innerHeight}, images: domImages, videos, iframes,
				hydrationHtml: document.documentElement.innerHTML};
		})()`);
		if (!page) throw new Error("showcase extraction returned no page data");
		// Some case studies never mount off-screen modules in the DOM, but keep
		// canonical media in JSON hydration. Parse that payload in Node so page
		// script escaping cannot break the CDP evaluation expression.
		const hydrated = String(page.hydrationHtml || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
		delete page.hydrationHtml;
		const hydratedImageUrls = [...new Set([
			...(hydrated.match(/https?:[^"'<>\s]+mir-s3-cdn-cf\.behance\.net\/project_modules\/(?:source|max_3840(?:_webp)?|2800(?:_webp)?)[^"'<>\s]+/gi) || []),
			...(hydrated.match(/https?:[^"'<>\s]+cdn\.dribbble\.com\/(?:userupload|users\/[^/]+\/screenshots)\/[^"'<>\s]*original-[^"'<>\s]+/gi) || [])
		])];
		// Prefer the rendered project modules: hydration also contains recommendation
		// cards from unrelated projects. Use hydration images only when the showcase
		// mounted no real image modules at all.
		// A Dribbble animation shot is often video-only. In that case hydration
		// also lists unrelated recommendation thumbnails; do not misreport them
		// as project screens just because the page has no standalone <img>.
		if (!page.images.length && !page.videos.length) page.images.push(...hydratedImageUrls.map((assetUrl, index) => ({
			index, url: assetUrl, alt: "", width: 0, height: 0, source: "hydration"
		})));
		page.embedded = [...new Set(hydrated.match(/https?:[^"'<>\s]+(?:mp4|webm|m3u8)(?:\?[^"'<>\s]*)?/gi) || [])]
			.map((assetUrl, index) => ({index, url: assetUrl}));
		const playerUrls = [...new Set(hydrated.match(/https?:[^"'<>\s]*(?:player\.vimeo\.com|youtube\.com\/embed)[^"'<>\s]*/gi) || [])];
		page.iframes.push(...playerUrls.map((playerUrl, index) => ({index: page.iframes.length + index, url: playerUrl, title: "hydration player"})));
		const seen = new Set();
		const chosen = [];
		const sourceHost = new URL(page.finalUrl).hostname;
		for (const asset of page.images || []) {
			const isProjectAsset = /behance\.net$/i.test(sourceHost)
				? /mir-s3-cdn-cf\.behance\.net\/project_modules\//i.test(asset.url)
				: /dribbble\.com$/i.test(sourceHost)
					? /cdn\.dribbble\.com\/(?:userupload|users\/\d+\/screenshots)\//i.test(asset.url) && (asset.source === "hydration" || !!String(asset.alt || "").trim())
					: asset.renderedWidth >= 700;
			if (!isProjectAsset || (asset.source !== "hydration" && asset.renderedWidth < 600)) continue;
			const clean = asset.url.replace(/([?&])resize=[^&]+/i, '$1').replace(/[?&]$/, '');
			const identity = clean.split('/').pop().replace(/\?.*$/, '');
			if (seen.has(identity)) continue;
			seen.add(identity);
			chosen.push({...asset, url: clean});
			if (chosen.length >= maxAssets) break;
		}
		const downloads = [];
		for (let i = 0; i < chosen.length; i++) {
			const asset = chosen[i];
			try {
				const preferred = /mir-s3-cdn-cf\.behance\.net\/project_modules\//i.test(asset.url)
					? asset.url.replace(/\/project_modules\/[^/]+\//, "/project_modules/source/")
					: asset.url.replace(/\?.*$/, "");
				let response = await fetch(preferred, { headers: { Referer: page.finalUrl, "User-Agent": "Mozilla/5.0 SolsticeShowcase/1.0" } });
				if (!response.ok && preferred !== asset.url) response = await fetch(asset.url, { headers: { Referer: page.finalUrl, "User-Agent": "Mozilla/5.0 SolsticeShowcase/1.0" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const type = response.headers.get('content-type') || '';
				const ext = /png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : /gif/i.test(type) ? '.gif' : '.jpg';
				const file = `asset-${String(i + 1).padStart(2, '0')}${ext}`;
				fs.writeFileSync(path.join(root, file), Buffer.from(await response.arrayBuffer()));
				const ratio = asset.width && asset.height ? asset.width / asset.height : 0;
				const deviceHint = !ratio ? "unknown" : ratio <= 0.72 ? "mobile-candidate" : ratio <= 1.18 ? "tablet-or-presentation-candidate" : "desktop-or-presentation-candidate";
				downloads.push({...asset, file, contentType: type, downloadedUrl: response.url, deviceHint, animated: /gif/i.test(type)});
			} catch (error) {
				downloads.push({...asset, error: error.message});
			}
		}
		const manifest = {...page, images: downloads, capturedAt: new Date().toISOString()};
		const manifestFile = path.join(root, 'showcase-manifest.json');
		fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
		const imageRows = downloads.map((item, index) => `| ${index + 1} | ${item.file ? `![asset ${index + 1}](${item.file})` : "download failed"} | ${item.width}×${item.height} | ${item.deviceHint || "unknown"} | pending vision |`).join("\n");
		const videoEvidence = [...(page.videos || []).map(v => ({kind:"video", url:v.url})), ...(page.iframes || []).map(v => ({kind:"iframe", url:v.url})), ...(page.embedded || []).map(v => ({kind:"embedded", url:v.url}))];
		const videoRows = videoEvidence.length ? videoEvidence.map((item, index) => `| ${index + 1} | ${item.kind} | ${item.url} | pending videoframes |`).join("\n") : "| — | — | none detected after full lazy scroll | n/a |";
		const deconstruct = `# DECONSTRUCT — ${page.title}\n\nSource: ${page.finalUrl}\nCaptured: ${manifest.capturedAt}\n\n> Geometry labels are hints only. Classify every asset by visible content with vision; presentation posters and mockups are not website screens.\n\n## Evidence inventory\n\n| # | evidence | pixels | geometry hint | vision classification |\n|---:|---|---:|---|---|\n${imageRows}\n\n## Video / motion evidence\n\n| # | kind | URL | sampling |\n|---:|---|---|---|\n${videoRows}\n\n## Desktop analysis\n- Pending vision review.\n\n## Mobile analysis\n- Pending vision review.\n\n## Tablet analysis\n- Pending vision review; state explicitly if absent.\n\n## Motion specification\n- Sample every playable candidate with videoframes and record pinning, parallax, reveal order, transitions and pacing.\n- If the host blocks playback, record the attempted URL and exact failure.\n\n## Build decisions\n- Pending evidence review.\n`;
		fs.writeFileSync(path.join(root, 'DECONSTRUCT.md'), deconstruct);
		console.log(manifestFile);
		console.log(path.join(root, 'DECONSTRUCT.md'));
		console.log(`showcase: ${downloads.filter(x => x.file).length}/${downloads.length} images downloaded; ${page.videos.length} video elements; ${page.iframes.length} player iframes; ${page.embedded.length} embedded video URLs`);
	}, { headed: false });
}

// Delivery quality gate: collect deterministic SEO, image, console, and rough
// LCP signals in the same bundled browser used for walkthrough evidence.
// This is intentionally not Lighthouse: it has zero external dependencies and
// remains useful on localhost previews before a production deploy exists.
async function audit(bin, url) {
	await withChrome(bin, async ({ send, evalJs, goto }) => {
		await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
			window.__solsticeQuality = { consoleErrors: [], runtimeErrors: [], lcp: 0 };
			const originalError = console.error.bind(console);
			console.error = (...args) => {
				try { window.__solsticeQuality.consoleErrors.push(args.map(String).join(' ').slice(0, 500)); } catch {}
				originalError(...args);
			};
			addEventListener('error', (event) => {
				const message = event.message || (event.target && (event.target.src || event.target.href)) || 'resource error';
				window.__solsticeQuality.runtimeErrors.push(String(message).slice(0, 500));
			}, true);
			try {
				new PerformanceObserver((list) => {
					const entries = list.getEntries();
					if (entries.length) window.__solsticeQuality.lcp = entries[entries.length - 1].startTime || 0;
				}).observe({ type: 'largest-contentful-paint', buffered: true });
			} catch {}
		})()` });
		await goto(url, 2500);
		await evalJs("window.scrollTo({top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'instant'}); ''");
		await sleep(1200);
		await evalJs("window.scrollTo({top: 0, behavior: 'instant'}); ''");
		await sleep(500);
		const result = await evalJs(`(() => {
			const images = [...document.images].map((img) => {
				const rect = img.getBoundingClientRect();
				const resource = performance.getEntriesByName(img.currentSrc || img.src).slice(-1)[0];
				const renderedWidth = Math.round(rect.width);
				const renderedHeight = Math.round(rect.height);
				const intrinsicRatio = renderedWidth > 0 ? img.naturalWidth / renderedWidth : 0;
				return {
					src: String(img.currentSrc || img.src || '').slice(0, 300), alt: img.getAttribute('alt'),
					naturalWidth: img.naturalWidth || 0, naturalHeight: img.naturalHeight || 0,
					renderedWidth, renderedHeight, bytes: resource ? (resource.transferSize || resource.encodedBodySize || 0) : 0,
					oversized: (intrinsicRatio > 2.5 && img.naturalWidth > 1200) || (resource && (resource.transferSize || resource.encodedBodySize || 0) > 1000000)
				};
			});
			const quality = window.__solsticeQuality || {};
			const consoleErrors = [...new Set([...(quality.consoleErrors || []), ...(quality.runtimeErrors || [])])];
			return {
				url: location.href, title: document.title.trim(),
				metaDescription: document.querySelector('meta[name="description"]')?.content?.trim() || '',
				viewport: document.querySelector('meta[name="viewport"]')?.content?.trim() || '',
				images, missingAlt: images.filter((img) => img.alt === null || !img.alt.trim()).length,
				oversizedImages: images.filter((img) => img.oversized), consoleErrors,
				lcpMs: Math.round(quality.lcp || performance.getEntriesByType('largest-contentful-paint').slice(-1)[0]?.startTime || 0)
			};
		})()`);
		let score = 100;
		const findings = [];
		if (!result.title) { score -= 10; findings.push({ severity: "error", check: "title", message: "Missing document title" }); }
		if (!result.metaDescription) { score -= 15; findings.push({ severity: "error", check: "meta", message: "Missing meta description" }); }
		if (!result.viewport) { score -= 5; findings.push({ severity: "warning", check: "viewport", message: "Missing viewport meta tag" }); }
		if (result.missingAlt) {
			const penalty = Math.min(20, Math.ceil(20 * result.missingAlt / Math.max(1, result.images.length)));
			score -= penalty;
			findings.push({ severity: "error", check: "alt", message: `${result.missingAlt}/${result.images.length} images are missing alt text` });
		}
		if (result.oversizedImages.length) {
			score -= Math.min(15, result.oversizedImages.length * 5);
			findings.push({ severity: "warning", check: "images", message: `${result.oversizedImages.length} image(s) are oversized for their rendered dimensions or exceed 1 MB` });
		}
		if (result.consoleErrors.length) {
			score -= Math.min(20, result.consoleErrors.length * 5);
			findings.push({ severity: "error", check: "console", message: `${result.consoleErrors.length} console/runtime error(s) captured` });
		}
		if (!result.lcpMs) {
			score -= 5;
			findings.push({ severity: "warning", check: "lcp", message: "LCP was not observable in this browser run" });
		} else if (result.lcpMs > 4000) {
			score -= 15;
			findings.push({ severity: "error", check: "lcp", message: `Rough LCP is ${result.lcpMs} ms (> 4000 ms)` });
		} else if (result.lcpMs > 2500) {
			score -= 7;
			findings.push({ severity: "warning", check: "lcp", message: `Rough LCP is ${result.lcpMs} ms (> 2500 ms)` });
		}
		console.log(JSON.stringify({ ...result, score: Math.max(0, score), grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F", findings }, null, 2));
	}, { headed: false });
}

// ---- shared Chrome + CDP session (search / read / crawl / live) ----
// Mirrors the scrollshot/videoframes setup but exposes a tiny {send, evalJs, goto}
// API so the text-oriented modes don't each re-implement the boilerplate.
// opts.headed=true opens a REAL VISIBLE browser window (the "watch Felix browse"
// mode) instead of headless; opts.keepOpen leaves that window open when done.
async function withChrome(bin, fn, opts = {}) {
	if (typeof WebSocket !== "function") {
		console.error("This mode needs Node >= 22 (global WebSocket).");
		process.exit(4);
	}
	const headed = !!opts.headed;
	const keepOpen = !!opts.keepOpen;
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const args = headed
		? [
			// visible window, front and center — the user is meant to WATCH this
			"--no-first-run", "--disable-extensions", "--mute-audio", "--no-default-browser-check",
			`--user-data-dir=${tmpProfile}`, `--window-size=${opts.size || "1600,1000"}`, "--window-position=80,40",
			"--remote-debugging-port=0", "about:blank",
		]
		: [
			"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
			"--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
			`--user-data-dir=${tmpProfile}`, "--window-size=1440,900",
			"--remote-debugging-port=0", "about:blank",
		];
	const chrome = spawn(bin, args, { stdio: "ignore", windowsHide: !headed });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await sleep(100);
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
		const tab = tabs.find((t) => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		if (headed) await send("Page.bringToFront");
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
		const goto = async (u, settleMs = 800) => {
			await send("Page.navigate", { url: u }, 30000);
			if (headed) await send("Page.bringToFront");
			for (let i = 0; i < 40; i++) { if (await evalJs("document.readyState === 'complete'")) break; await sleep(400); }
			await sleep(settleMs);
		};
		return await fn({ send, evalJs, goto });
	} finally {
		if (keepOpen) {
			// leave the visible window for the user; the temp profile stays until
			// the OS cleans the tmp dir — a fair price for "keep browsing yourself"
			try { chrome.unref(); } catch { }
		} else {
			try { chrome.kill(); } catch { }
			try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
		}
	}
}

// LIVE INTERACTION — the step beyond `live`: a VISIBLE browser the agent OPERATES
// while the user watches — clicking, typing, scrolling through real flows
// (menus, forms, checkout…). Actions come as a JSON file:
//   [{"goto":"https://…"}, {"click":"CSS-or-text"}, {"type":["CSS","text"]},
//    {"scroll":900}, {"wait":1500}, {"shot":"out.png"}]
// `click` accepts a CSS selector, or text: prefix to click by visible text.
// After every action the page's readable state is printed so the agent can
// reason about what happened. Ends keeping the window open with "keep": true
// as the LAST array element.
async function act(bin, actionsFile) {
	let actions;
	try { actions = JSON.parse(fs.readFileSync(actionsFile, "utf8")); } catch (e) {
		console.error(`act: cannot read actions file: ${e.message}`); process.exit(2);
	}
	if (!Array.isArray(actions) || !actions.length) { console.error("act: actions must be a non-empty JSON array"); process.exit(2); }
	const keepOpen = actions.length && actions[actions.length - 1] && actions[actions.length - 1].keep === true;
	await withChrome(bin, async ({ send, evalJs, goto }) => {
		const clickTarget = async (spec) => {
			const byText = spec.startsWith("text:");
			const finder = byText
				? `(() => { const t=${JSON.stringify(spec.slice(5))}.trim().toLowerCase();
					const els=[...document.querySelectorAll('a,button,[role=button],input[type=submit],label,summary')];
					const el=els.find(e=>(e.innerText||e.value||'').trim().toLowerCase().includes(t));
					if(!el) return null; el.scrollIntoView({block:'center',behavior:'smooth'});
					const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
				: `(() => { const el=document.querySelector(${JSON.stringify(spec)});
					if(!el) return null; el.scrollIntoView({block:'center',behavior:'smooth'});
					const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;
			const pt = await evalJs(finder);
			if (!pt) { console.log(`[act] click: NOT FOUND: ${spec}`); return false; }
			await sleep(650); // let the smooth scroll land where the user can see it
			for (const type of ["mousePressed", "mouseReleased"]) {
				await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
			}
			console.log(`[act] clicked: ${spec}`);
			return true;
		};
		for (const step of actions) {
			if (step.keep !== undefined && Object.keys(step).length === 1) continue;
			if (step.goto) { await goto(step.goto, 1200); console.log(`[act] goto: ${step.goto}`); }
			else if (step.click) await clickTarget(String(step.click));
			else if (step.type) {
				const [sel, text] = step.type;
				const ok = await evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.focus(); return true; })()`);
				if (ok) { await send("Input.insertText", { text: String(text) }); console.log(`[act] typed into ${sel}`); }
				else console.log(`[act] type: NOT FOUND: ${sel}`);
			}
			else if (step.scroll !== undefined) { await evalJs(`window.scrollBy({ top: ${Number(step.scroll) || 0}, behavior: 'smooth' }); ''`); console.log(`[act] scrolled ${step.scroll}`); }
			else if (step.wait) await sleep(Math.min(15000, Number(step.wait) || 0));
			else if (step.shot) {
				const s = await send("Page.captureScreenshot", { format: "png" });
				const f = path.resolve(String(step.shot));
				fs.writeFileSync(f, Buffer.from(s.data, "base64"));
				console.log(`[act] shot: ${f}`);
			}
			await sleep(450); // human-followable pacing
		}
		const state = (await evalJs(EXTRACT_JS)) || {};
		console.log(`\n[act] final page: ${state.title || ""}`);
		console.log((state.text || "").slice(0, 1200));
	}, { headed: true, keepOpen });
}

// LIVE ANALYSIS — the Antigravity-style "watch the agent browse" mode. Opens a
// REAL, VISIBLE Chrome window on the user's screen and tours a site page by page
// with a slow cinematic scroll, while printing the same readable-content
// extraction as `crawl` to stdout for the agent. The user literally watches the
// analysis happen; the agent gets the text. `keep` leaves the window open at the
// end so the user can continue browsing where the tour stopped.
async function live(bin, startUrl, maxPages, perPageSec, keepOpen) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		const origin = new URL(startUrl).origin;
		const seen = new Set();
		const queue = [startUrl.split("#")[0]];
		let count = 0;
		while (queue.length && count < maxPages) {
			const u = queue.shift();
			if (seen.has(u)) continue;
			seen.add(u);
			try { await goto(u, 1500); } catch { continue; }
			count++;
			console.log(`\n===== [live ${count}/${maxPages}] ${u} =====`);
			// cinematic top-to-bottom scroll the human can follow (also fires the
			// site's reveal animations so the extraction sees everything)
			const steps = Math.max(6, Math.min(28, Math.round(perPageSec * 2)));
			for (let i = 1; i <= steps; i++) {
				await evalJs(`window.scrollTo({ top: Math.floor(Math.max(0, (Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - innerHeight)) * ${i / steps}), behavior: 'smooth' }); ''`);
				await sleep((perPageSec * 1000) / steps);
			}
			await evalJs("window.scrollTo({ top: 0, behavior: 'smooth' }); ''");
			await sleep(700);
			const data = (await evalJs(EXTRACT_JS)) || {};
			console.log(`title: ${data.title || ""}`);
			if (data.headings && data.headings.length) console.log(data.headings.slice(0, 12).join("\n"));
			console.log((data.text || "").slice(0, 1600));
			for (const l of data.links || []) {
				try {
					const lu = new URL(l.u);
					const clean = (lu.origin + lu.pathname).split("#")[0];
					if (lu.origin === origin && !seen.has(clean) && !/\.(png|jpe?g|gif|svg|css|js|pdf|zip|mp4|webp|ico|woff2?|ttf)(\?|$)/i.test(lu.pathname)) {
						queue.push(clean);
					}
				} catch { }
			}
		}
		console.log(`\n[live] toured ${count} page(s) under ${origin} in a VISIBLE browser window${keepOpen ? " (left open for you)" : ""}.`);
	}, { headed: true, keepOpen });
}

// In-page readable-content extractor: strips chrome/boilerplate and returns
// { title, headings[], text, links[] } — far more useful to the model than raw --dump-dom HTML.
const EXTRACT_JS = `(() => {
	const drop = ['script','style','noscript','svg','iframe','nav','footer','header','aside','form','button'];
	const clone = document.body ? document.body.cloneNode(true) : null;
	if (clone) drop.forEach(s => clone.querySelectorAll(s).forEach(n => n.remove()));
	const main = document.querySelector('main, article, [role=main]');
	const text = (((main && main.innerText) || (clone && clone.innerText) || (document.body && document.body.innerText) || '')).replace(/\\n{3,}/g,'\\n\\n').trim();
	const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0,40).map(e => e.tagName.toLowerCase()+': '+(e.innerText||'').trim()).filter(s => s.length>3 && s.length<200);
	const links = [...document.querySelectorAll('a[href]')].map(a => ({ t:(a.innerText||'').trim().slice(0,90), u:a.href })).filter(l => /^https?:/.test(l.u)).slice(0,300);
	return { title: document.title||'', headings, text: text.slice(0,14000), links };
})()`;

// Bing results scraper (no API key) — reliable for headless Chromium. Bing wraps each
// result href in a /ck/a redirect with the real URL base64url-encoded in the ?u= param
// (prefixed "a1"); decode it in-page with atob so the model gets the true destination.
const SEARCH_JS = `(() => {
	const real = (href) => {
		try {
			const u = new URL(href);
			if (u.hostname.includes('bing.com') && u.pathname.startsWith('/ck/')) {
				let b = u.searchParams.get('u') || '';
				if (b.startsWith('a1')) b = b.slice(2);
				b = b.replace(/-/g,'+').replace(/_/g,'/');
				while (b.length % 4) b += '=';
				try { return atob(b); } catch { return href; }
			}
			return href;
		} catch { return href; }
	};
	const out = [];
	document.querySelectorAll('li.b_algo').forEach(li => {
		const a = li.querySelector('h2 a'); if (!a) return;
		const sn = li.querySelector('.b_caption p, .b_algoSlug, p');
		out.push({ title:(a.innerText||'').trim(), url: real(a.href), snippet:(sn ? sn.innerText : '').trim().slice(0,300) });
	});
	return out;
})()`;

async function search(bin, query, n) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		await goto("https://www.bing.com/search?setlang=en&q=" + encodeURIComponent(query), 1500);
		let results = (await evalJs(SEARCH_JS)) || [];
		if (!results.length) { // fallback: DuckDuckGo lite
			await goto("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), 1200);
			results = (await evalJs(`(() => [...document.querySelectorAll('a.result-link')].map(a => ({title:(a.innerText||'').trim(), url:a.href, snippet:''})))()`)) || [];
		}
		results = results.filter((r) => r.url && r.title && /^https?:/.test(r.url)).slice(0, n);
		if (!results.length) { console.log(`No results for: ${query}`); return; }
		console.log(`# Search results for: ${query}\n`);
		results.forEach((r, i) => { console.log(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}\n`); });
	});
}

async function read(bin, url) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		await goto(url, 1500);
		const d = (await evalJs(EXTRACT_JS)) || {};
		console.log(`# ${d.title || url}\nURL: ${url}\n`);
		if (d.headings && d.headings.length) console.log("## Outline\n" + d.headings.join("\n") + "\n");
		console.log("## Content\n" + (d.text || "(no readable text extracted)"));
	});
}

async function crawl(bin, startUrl, depth, maxPages) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		const origin = new URL(startUrl).origin;
		const seen = new Set();
		const queue = [{ u: startUrl.split("#")[0], d: 0 }];
		let count = 0;
		while (queue.length && count < maxPages) {
			const { u, d } = queue.shift();
			if (seen.has(u)) continue;
			seen.add(u);
			try { await goto(u, 700); } catch { continue; }
			const data = (await evalJs(EXTRACT_JS)) || {};
			count++;
			console.log(`\n===== [${count}] ${u} =====`);
			console.log(`title: ${data.title || ""}`);
			if (data.headings && data.headings.length) console.log(data.headings.slice(0, 12).join("\n"));
			console.log((data.text || "").slice(0, 1800));
			if (d < depth) {
				for (const l of data.links || []) {
					try {
						const lu = new URL(l.u);
						const clean = (lu.origin + lu.pathname).split("#")[0];
						if (lu.origin === origin && !seen.has(clean) && !/\.(png|jpe?g|gif|svg|css|js|pdf|zip|mp4|webp|ico|woff2?|ttf)(\?|$)/i.test(lu.pathname)) {
							queue.push({ u: clean, d: d + 1 });
						}
					} catch { }
				}
			}
		}
		console.log(`\n[crawl] visited ${count} page(s) under ${origin}`);
	});
}

// Model-agnostic image viewing. The default chat model (composer-2.5/grok) is
// text-only and cannot see images, so "look at this Behance design" must be routed
// to a vision-capable model. This shells out to codex (native `-i` vision) and
// falls back to claude (Read tool), returning a text description either way — so
// image viewing works regardless of which chat model drives the turn.
function describeImage(imagePath, question) {
	const abs = path.resolve(imagePath);
	if (!fs.existsSync(abs)) { console.error(`describe: file not found: ${abs}`); process.exit(3); }
	const q = question || "Describe this design/screenshot in exhaustive detail: overall layout and every section top-to-bottom, exact colors (hex where possible), typography, imagery style, spacing, components, and the visual mood. If it shows both mobile and desktop views, describe each.";
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.OPENAI_API_KEY; delete env.XAI_API_KEY;
	const opts = { encoding: "utf8", env, timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
	// 1) codex — native image vision
	try {
		const out = execFileSync("codex", ["exec", "--skip-git-repo-check", "--color", "never", "-i", abs, q], opts);
		if (out && out.trim()) { process.stdout.write(out); return; }
	} catch (e) { if (e && e.stdout && String(e.stdout).trim()) { process.stdout.write(String(e.stdout)); return; } }
	// 2) claude — Read tool
	try {
		const out = execFileSync("claude", ["--print", "--allowedTools", "Read", "-p", `Use your Read tool to open the image at ${abs}, then ${q}`], opts);
		if (out && out.trim()) { process.stdout.write(out); return; }
	} catch (e) { if (e && e.stdout && String(e.stdout).trim()) { process.stdout.write(String(e.stdout)); return; } }
	console.error("describe failed: no vision provider (codex or claude) could view the image. Ensure one is installed and signed in.");
	process.exit(1);
}

function main() {
	const [mode, url, out, size, extra] = process.argv.slice(2);
	if (mode === "describe") {
		if (!url) { console.error("usage: browse.js describe <image.png> [question]"); process.exit(2); }
		describeImage(url, process.argv.slice(4).join(" ").trim());
		return;
	}
	if (!mode || !url || ((mode === "shot" || mode === "scrollshot" || mode === "videoframes" || mode === "showcase") && !out)) {
		console.error("usage:\n  browse.js search <query> [count]            web search → ranked title/url/snippet list (no API key)\n  browse.js videosearch <query> [count]       free Pexels/Pixabay videos → structured JSON\n  browse.js read <url>                        page main content as clean readable text/markdown\n  browse.js crawl <url> [depth] [maxPages]    same-site crawl → text of each page\n  browse.js live <url> [maxPages] [secPerPage] [keep]   VISIBLE browser tour the user watches (analysis text to stdout)\n  browse.js shot <url> <out.png> [WxH]        screenshot\n  browse.js scrollshot <url> <outPrefix> [stops]\n  browse.js videoframes <url> <outPrefix> [frames] [referrer]\n  browse.js showcase <url> <outDir> [maxAssets] lazy-load + download case-study media\n  browse.js audit <url>                       zero-dependency delivery quality audit (JSON)\n  browse.js dom <url>                         raw rendered HTML");
		process.exit(2);
	}
	if (mode === "videosearch") {
		const count = /^\d+$/.test(out || "") ? Math.min(20, Math.max(1, parseInt(out, 10))) : 8;
		searchStockVideo(url, count).then((result) => {
			console.log(JSON.stringify(result, null, 2));
		}).catch((err) => {
			console.error(`videosearch failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	const bin = findBrowser();
	if (!bin) {
		console.error("No Chrome/Chromium/Edge found. Install one or set SOLSTICE_BROWSER.");
		process.exit(3);
	}
	if (mode === "videoframes") {
		const frames = /^\d+$/.test(size || "") ? Math.min(24, Math.max(2, parseInt(size, 10))) : 10;
		videoframes(bin, url, out, frames, extra || "").catch((err) => {
			console.error(`videoframes failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	if (mode === "showcase") {
		const maxAssets = /^\d+$/.test(size || "") ? Math.min(80, Math.max(1, parseInt(size, 10))) : 30;
		showcase(bin, url, out, maxAssets).catch((err) => {
			console.error(`showcase failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	if (mode === "audit") {
		audit(bin, url).catch((err) => { console.error(`audit failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "scrollshot") {
		const stops = /^\d+$/.test(size || "") ? Math.min(12, Math.max(2, parseInt(size, 10))) : 5;
		scrollshot(bin, url, out, stops, "1440,900").catch((err) => {
			console.error(`scrollshot failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	if (mode === "search") {
		const n = /^\d+$/.test(out || "") ? Math.min(20, Math.max(1, parseInt(out, 10))) : 8;
		search(bin, url, n).catch((err) => { console.error(`search failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "read") {
		read(bin, url).catch((err) => { console.error(`read failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "crawl") {
		const depth = /^\d+$/.test(out || "") ? Math.min(3, Math.max(0, parseInt(out, 10))) : 1;
		const maxPages = /^\d+$/.test(size || "") ? Math.min(40, Math.max(1, parseInt(size, 10))) : 10;
		crawl(bin, url, depth, maxPages).catch((err) => { console.error(`crawl failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "act") {
		act(bin, url).catch((err) => { console.error(`act failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "live") {
		const maxPages = /^\d+$/.test(out || "") ? Math.min(12, Math.max(1, parseInt(out, 10))) : 4;
		const perPageSec = /^\d+$/.test(size || "") ? Math.min(60, Math.max(4, parseInt(size, 10))) : 12;
		const keepOpen = (extra || "") === "keep";
		live(bin, url, maxPages, perPageSec, keepOpen).catch((err) => { console.error(`live failed: ${err.message}`); process.exit(1); });
		return;
	}
	const dims = /^\d+x\d+$/.test(size || "") ? size.replace("x", ",") : "1440,2200";
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const common = [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		`--user-data-dir=${tmpProfile}`, `--window-size=${dims}`,
		"--virtual-time-budget=9000", "--timeout=25000",
	];
	try {
		if (mode === "shot") {
			execFileSync(bin, [...common, `--screenshot=${path.resolve(out)}`, url], { stdio: ["ignore", "ignore", "inherit"], timeout: 60000 });
			console.log(path.resolve(out));
		} else if (mode === "dom") {
			const html = execFileSync(bin, [...common, "--dump-dom", url], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
			console.log(html);
		} else {
			console.error(`unknown mode: ${mode}`);
			process.exit(2);
		}
	} finally {
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

main();
