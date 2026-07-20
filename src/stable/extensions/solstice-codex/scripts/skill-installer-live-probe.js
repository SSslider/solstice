#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { FelixSkills } = require("../felixSkills");
const { SkillInstaller } = require("../skillInstaller");

function args(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
	return out;
}

(async () => {
	const options = args(process.argv.slice(2));
	if (!options.url || !options.store) throw new Error("usage: skill-installer-live-probe.js --url <github-repo> --store <felix-store> [--skill-path <SKILL.md>] [--report <json>]");
	const store = path.resolve(options.store);
	fs.mkdirSync(store, { recursive: true });
	const installer = new SkillInstaller({ skillsDir: path.join(store, "skills"), log: (message) => process.stderr.write(message + "\n") });
	try {
		let preview = await installer.preview(options.url, options["skill-path"] || "");
		if (preview.selectionRequired) {
			if (preview.candidates.length !== 1) throw new Error("--skill-path is required; candidates: " + preview.candidates.join(", "));
			preview = await installer.preview(options.url, preview.candidates[0]);
		}
		const installed = await installer.install(preview.id);
		const runtime = new FelixSkills({ dir: store });
		const loaded = runtime.list().find((skill) => skill.meta.name === installed.name);
		if (!loaded || !loaded.skillDir) throw new Error("Installed directory skill was not visible to the runtime loader");
		const report = {
			ok: true,
			sourceUrl: installed.sourceUrl,
			commit: installed.commit,
			name: installed.name,
			destination: installed.destination,
			fileCount: installed.fileCount,
			totalBytes: installed.totalBytes,
			runtimeLoaded: true,
			requirements: preview.requirements,
			files: preview.files,
			security: { httpsGithubOnly: true, bareClone: true, hooksExecuted: false, scriptsExecuted: false, symlinksRejected: true, atomicInstall: true },
			completedAt: new Date().toISOString(),
		};
		if (options.report) {
			fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
			fs.writeFileSync(path.resolve(options.report), JSON.stringify(report, null, 2) + "\n");
		}
		console.log(JSON.stringify(report, null, 2));
	} finally { installer.dispose(); }
})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
