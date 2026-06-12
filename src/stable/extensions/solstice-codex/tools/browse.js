#!/usr/bin/env node
"use strict";
// Headless-browser helper for the Solstice agent.
//   node browse.js shot <url> <out.png> [widthxheight]
//   node browse.js dom  <url>
// Uses an installed Chrome/Chromium/Edge in headless mode.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function main() {
	const [mode, url, out, size] = process.argv.slice(2);
	if (!mode || !url || (mode === "shot" && !out)) {
		console.error("usage: browse.js shot <url> <out.png> [WxH] | browse.js dom <url>");
		process.exit(2);
	}
	const bin = findBrowser();
	if (!bin) {
		console.error("No Chrome/Chromium/Edge found. Install one or set SOLSTICE_BROWSER.");
		process.exit(3);
	}
	const dims = /^\d+x\d+$/.test(size || "") ? size.replace("x", ",") : "1440,2200";
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const common = [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
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
