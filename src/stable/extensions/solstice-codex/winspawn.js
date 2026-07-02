"use strict";
// Windows cannot CreateProcess a .cmd/.bat/.ps1 batch shim directly — attempting
// it throws `spawn <name> EPERM`. npm installs CLIs (grok, codex, claude) as such
// shims on Windows, so a bare `spawn("grok", args)` fails on the desktop while the
// IDENTICAL code works on Linux/macOS (where the bin is a real binary or a shell
// script with a shebang). That is the entire "works on the server, EPERM on
// Thomas's PC" mystery.
//
// We cannot fix this by routing through cmd.exe / { shell: true }, because our
// args carry newlines (grok's `--system-prompt-override <PROMPT>` is the whole
// multi-line system prompt) and a Windows command line would mangle them. The
// correct fix: find the JS entry the npm shim wraps and run it with Node directly,
// which preserves argv verbatim and never hits a batch file.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ── The user's REAL PATH, from the Windows registry ─────────────────────────
// Every "grok works in the terminal but EPERMs in Solstice" incident shares one
// root: the terminal builds PATH from the registry (HKCU\Environment + the
// machine-wide Session Manager\Environment), while a GUI-launched Electron can
// inherit a stale/stripped snapshot. Guessing install dirs one by one
// (extraWinDirs) plays whack-a-mole with every package manager on earth; the
// registry ends the game — whatever dir makes `grok` resolvable in the user's
// terminal is BY DEFINITION in there. Read once, expand %VARS%, cache.
let _regPathCache = null;
function registryPathDirs() {
	if (process.platform !== "win32") return [];
	if (_regPathCache) return _regPathCache;
	const dirs = [];
	const queries = [
		["HKCU\\Environment", "Path"],
		["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path"],
	];
	for (const [key, value] of queries) {
		try {
			const out = spawnSync("reg.exe", ["query", key, "/v", value], {
				encoding: "utf8", timeout: 5000, windowsHide: true,
			});
			const m = (out.stdout || "").match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
			if (!m) continue;
			// Expand %VAR% references the way the shell would.
			const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
			for (const d of expanded.split(";")) if (d && !d.includes("%")) dirs.push(d.trim());
		} catch { /* reg.exe missing/timeout — fall through to the static list */ }
	}
	_regPathCache = [...new Set(dirs.filter(Boolean))];
	return _regPathCache;
}

// npm can be configured with a CUSTOM global prefix (`prefix=` in ~/.npmrc) —
// then the global bin dir is neither %APPDATA%\npm nor anything we can guess.
// npm itself reads .npmrc, so we do too.
function npmrcPrefixDirs() {
	if (process.platform !== "win32") return [];
	const out = [];
	const rcs = [
		process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".npmrc"),
		process.env.NPM_CONFIG_USERCONFIG,
	].filter(Boolean);
	for (const rc of rcs) {
		try {
			const text = fs.readFileSync(rc, "utf8");
			const m = text.match(/^\s*prefix\s*=\s*(.+)\s*$/mi);
			if (m) {
				const prefix = m[1].trim().replace(/%([^%]+)%/g, (_, n) => process.env[n] || "");
				if (prefix) { out.push(prefix); out.push(path.join(prefix, "bin")); }
			}
		} catch { /* no .npmrc — fine */ }
	}
	return out;
}

// Dirs a Windows GUI process (Electron launched from the Start Menu / desktop)
// commonly MISSES from PATH, but where npm/node actually install. THE recurring
// Composer EPERM lived here: grok is an npm global, so its shim is `%APPDATA%\npm\
// grok.cmd`; node is in `Program Files\nodejs`. A GUI child process often inherits
// a stripped PATH WITHOUT these dirs — so whichFull("grok")/whichFull("node")
// returned null INSIDE Solstice even though both run fine in the user's terminal.
// The resolver then fell back to the freshly-written, UNSIGNED bundled engine,
// which Windows Defender blocks → bare `spawn EPERM` + Defender alert. Searching
// these known locations makes Solstice find the user's REAL, Defender-trusted
// grok/node, so the bundled binary is never spawned on a machine that has them.
function extraWinDirs() {
	if (process.platform !== "win32") return [];
	const env = process.env;
	const candidates = [
		env.APPDATA && path.join(env.APPDATA, "npm"),                       // npm global bin → grok.cmd
		env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Roaming", "npm"),
		env.ProgramFiles && path.join(env.ProgramFiles, "nodejs"),
		env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "nodejs"),
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "nodejs"),
		env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims"),    // scoop installs
		// Node version managers — each puts the ACTIVE node + npm globals in its
		// own dir that a GUI PATH misses just like %APPDATA%\npm:
		env.NVM_SYMLINK,                                                    // nvm-windows active version
		env.NVM_HOME,
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "nvm"),
		env.VOLTA_HOME && path.join(env.VOLTA_HOME, "bin"),                 // volta
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Volta", "bin"),
		env.FNM_MULTISHELL_PATH,                                            // fnm active shell
		env.PNPM_HOME,                                                      // pnpm global bin
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "pnpm"),
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Yarn", "bin"),     // yarn global
		env.USERPROFILE && path.join(env.USERPROFILE, ".bun", "bin"),       // bun global
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"), // winget shims
		env.ChocolateyInstall && path.join(env.ChocolateyInstall, "bin"),   // chocolatey
	].filter(Boolean);
	// The registry PATH (what the user's terminal actually uses) + custom npm
	// prefix go FIRST — they are ground truth; the static guesses are backup.
	// De-dup while preserving order.
	return [...new Set([...registryPathDirs(), ...npmrcPrefixDirs(), ...candidates])];
}

// Search PATH (+ PATHEXT on Windows) for a bare command name. Returns the full
// path of the first match, or null. On Windows also searches the known npm/node
// install dirs that a GUI process's PATH frequently omits (see extraWinDirs).
function whichFull(bin) {
	if (!bin) return null;
	if (bin.includes("/") || bin.includes("\\")) {
		try { return fs.existsSync(bin) ? bin : null; } catch { return null; }
	}
	const isWin = process.platform === "win32";
	// PATHEXT can arrive stripped/mangled in a GUI-launched process — without .CMD
	// in the list grok.cmd is invisible and we EPERM on the bare name. Always
	// search the standard extensions IN ADDITION to whatever the env carries.
	const exts = isWin
		? [...new Set(["", ...(process.env.PATHEXT || "").split(";"), ".COM", ".EXE", ".BAT", ".CMD"])]
		: [""];
	const dirs = (process.env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
	if (isWin) dirs.push(...extraWinDirs());
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = path.join(dir, bin + ext);
			try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
		}
	}
	return null;
}

// Extract the JS file an npm shim (.cmd / .ps1 / extension-less bash) delegates
// to. npm shims reference the target relative to the shim dir, e.g.
//   "%~dp0\node.exe"  "%dp0%\node_modules\@scope\pkg\bin\cli.js" %*
//   node  "$basedir/node_modules/@scope/pkg/bin/cli.js" "$@"
// We pull the node_modules/<...>.js path and resolve it next to the shim.
function jsEntryFromShim(shimPath) {
	let text;
	try { text = fs.readFileSync(shimPath, "utf8"); } catch { return null; }
	const dir = path.dirname(shimPath);
	const m = text.match(/((?:node_modules[\\/]).+?\.[cm]?js)\b/i);
	if (!m) return null;
	const rel = m[1].split(/[\\/]/).join(path.sep);
	const full = path.join(dir, rel);
	try { return fs.existsSync(full) ? full : null; } catch { return null; }
}

// Fallback when the shim text doesn't match the regex (npm changes its shim
// format across versions): the npm-global layout is deterministic — the shim
// lives NEXT TO node_modules, and the wrapped package declares the bin in its
// package.json `bin` field. Walk node_modules (incl. @scoped) and resolve the
// entry for `binName` directly from package.json.
function jsEntryFromNodeModules(shimPath, binName) {
	const nm = path.join(path.dirname(shimPath), "node_modules");
	let top;
	try { top = fs.readdirSync(nm); } catch { return null; }
	const pkgDirs = [];
	for (const name of top) {
		if (name.startsWith(".")) continue;
		const d = path.join(nm, name);
		if (name.startsWith("@")) {
			try { for (const sub of fs.readdirSync(d)) pkgDirs.push(path.join(d, sub)); } catch { /* ignore */ }
		} else {
			pkgDirs.push(d);
		}
	}
	for (const d of pkgDirs) {
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); } catch { continue; }
		let entry = null;
		if (typeof pkg.bin === "string" && (pkg.name === binName || path.basename(d) === binName)) entry = pkg.bin;
		else if (pkg.bin && typeof pkg.bin === "object" && pkg.bin[binName]) entry = pkg.bin[binName];
		if (!entry) continue;
		const full = path.join(d, entry.split(/[\\/]/).join(path.sep));
		try { if (fs.existsSync(full)) return full; } catch { /* ignore */ }
	}
	return null;
}

// Given (bin, args) decide what to actually spawn. No-op everywhere except
// Windows, so Linux/macOS (server + fleet) behaviour is byte-identical to before.
// Returns { cmd, args, env } — env is null when nothing extra is needed.
function resolveWinSpawn(bin, args) {
	const passthrough = { cmd: bin, args: args.slice(), env: null };
	if (process.platform !== "win32") return passthrough;

	const full = whichFull(bin) || bin;
	const ext = path.extname(full).toLowerCase();

	// A real executable — spawn it directly, that always works.
	if (ext === ".exe" || ext === ".com") return { cmd: full, args: args.slice(), env: null };

	// A batch/PowerShell/bash npm shim — run the JS it wraps with Node, verbatim.
	const binName = path.basename(bin, path.extname(bin));
	const js = jsEntryFromShim(full) || jsEntryFromNodeModules(full, binName);
	if (js) {
		// Pass a PATH that includes the npm/node dirs a GUI process omits, so the
		// grok child (and anything it spawns) can find node/its tools too — same
		// root cause as the resolver miss above.
		const augPath = [process.env.PATH || "", ...extraWinDirs()].filter(Boolean).join(";");
		const augEnv = { ...process.env, PATH: augPath };
		// 1) Prefer a node the USER already has (now also found in the npm/node
		//    install dirs, not just the stripped GUI PATH). A user-installed node
		//    is Defender-trusted and launches with no EPERM. (Regression: a build
		//    that preferred a freshly written BUNDLED node.exe ahead of this one
		//    re-introduced `spawn EPERM` + the Defender alert, because the
		//    unsigned bundled binary is exactly what Defender blocks.)
		const node = whichFull("node");
		if (node && path.extname(node).toLowerCase() === ".exe") {
			return { cmd: node, args: [js, ...args], env: augEnv };
		}
		// 2) No user node anywhere — fall back to the bundled node.exe if present.
		const bundledNode = path.join(__dirname, "bin", "node.exe");
		try { if (fs.existsSync(bundledNode)) return { cmd: bundledNode, args: [js, ...args], env: augEnv }; } catch { /* ignore */ }
		// 3) Last resort — drive Electron's own binary as Node. May be blocked by
		//    Defender on an unsigned build.
		return { cmd: process.execPath, args: [js, ...args], env: { ...augEnv, ELECTRON_RUN_AS_NODE: "1" } };
	}

	// Couldn't crack the shim — last resort through cmd.exe (may mangle newline
	// args, but strictly better than a hard EPERM that builds nothing).
	if (ext === ".cmd" || ext === ".bat") {
		return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", full, ...args], env: null };
	}
	return { cmd: full, args: args.slice(), env: null };
}

module.exports = { resolveWinSpawn, whichFull, jsEntryFromShim, jsEntryFromNodeModules, extraWinDirs, registryPathDirs, npmrcPrefixDirs };
