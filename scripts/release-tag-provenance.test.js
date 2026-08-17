"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-release-provenance-"));

function writeExecutable(file, contents) {
	fs.writeFileSync(file, contents, { mode: 0o755 });
}

function runGit(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
	for (const file of ["release.sh", "release_notes.md", "utils.sh"]) {
		fs.copyFileSync(path.join(root, file), path.join(fixture, file));
	}
	fs.mkdirSync(path.join(fixture, "assets"));
	fs.mkdirSync(path.join(fixture, "fake-bin"));

	runGit(["init", "-q"], fixture);
	runGit(["config", "user.name", "Release Provenance Test"], fixture);
	runGit(["config", "user.email", "release-test@solstice.local"], fixture);
	runGit(["add", "release.sh", "release_notes.md", "utils.sh"], fixture);
	runGit(["commit", "-qm", "fixture"], fixture);
	const sourceSha = runGit(["rev-parse", "HEAD"], fixture);
	const mismatchSha = "0".repeat(40);
	const ghLog = path.join(fixture, "gh-calls.log");

	writeExecutable(path.join(fixture, "fake-bin", "npm"), "#!/usr/bin/env bash\nexit 0\n");
	writeExecutable(path.join(fixture, "fake-bin", "github-release"), "#!/usr/bin/env bash\nexit 0\n");
	writeExecutable(path.join(fixture, "fake-bin", "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
if [[ "$1 $2" == "release view" ]]; then
  if [[ "$*" == *"--json body"* ]]; then
    printf 'fixture release notes\\n'
    exit 0
  fi
  if [[ "\${RELEASE_EXISTS:-0}" == "1" ]]; then
    printf 'existing release\\n'
    exit 0
  fi
  printf 'release not found\\n'
  exit 1
fi
if [[ "$1" == "api" ]]; then
  printf 'commit\\t%s\\n' "\${MOCK_TAG_SHA}"
  exit 0
fi
exit 0
`);

	const baseEnv = {
		...process.env,
		PATH: `${path.join(fixture, "fake-bin")}:${process.env.PATH}`,
		GH_CALL_LOG: ghLog,
		GH_TOKEN: "fixture-token",
		ASSETS_REPOSITORY: "SSslider/solstice",
		RELEASE_VERSION: "1.121.test",
		VSCODE_QUALITY: "stable",
		APP_NAME: "Solstice",
		BINARY_NAME: "solstice",
		MS_TAG: "1.100.0",
		MOCK_TAG_SHA: sourceSha,
	};

	const create = spawnSync("bash", ["release.sh"], {
		cwd: fixture,
		env: baseEnv,
		encoding: "utf8",
	});
	assert.strictEqual(create.status, 0, create.stderr);
	const createCalls = fs.readFileSync(ghLog, "utf8");
	assert.match(createCalls, new RegExp(`release create .*--target ${sourceSha}`));

	fs.writeFileSync(ghLog, "");
	const mismatch = spawnSync("bash", ["release.sh"], {
		cwd: fixture,
		env: {
			...baseEnv,
			RELEASE_EXISTS: "1",
			MOCK_TAG_SHA: mismatchSha,
		},
		encoding: "utf8",
	});
	assert.strictEqual(mismatch.status, 1, "an existing mismatched tag must stop publishing");
	assert.match(mismatch.stderr + mismatch.stdout, /Release provenance mismatch/);
	assert.doesNotMatch(fs.readFileSync(ghLog, "utf8"), /release upload/);

	console.log("release-tag-provenance.test.js: 5/5 checks passed");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
