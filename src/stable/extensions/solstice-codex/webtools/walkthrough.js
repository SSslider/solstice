#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { registerReview } = require("../reviewShare");
const { auditSecurity } = require("../securityAudit");
const { safeTaskId, latestGreenSelfCheck, registerArtifact } = require("../artifactStore");

function fail(message) { console.error("walkthrough: " + message); process.exit(1); }
function run(args) {
	const browse = path.join(__dirname, "browse.js");
	const result = spawnSync(process.execPath, [browse, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
	if (result.error || result.status !== 0) fail((result.error && result.error.message) || result.stderr || `browse exited ${result.status}`);
	return String(result.stdout || "").trim();
}
function files(dir, re) { try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return []; } }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

async function main() {
const [rootArg, previewUrl, liveUrlArg, taskIdArg] = process.argv.slice(2);
if (!rootArg || !previewUrl) fail("usage: walkthrough.js <workspace> <preview-url> [live-url] [task-id]");
const root = path.resolve(rootArg);
try { if (!fs.statSync(root).isDirectory()) fail("workspace is not a directory"); } catch { fail("workspace does not exist"); }
try { new URL(previewUrl); } catch { fail("invalid preview URL"); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const taskId = safeTaskId(taskIdArg || `interactive-${stamp}`);
const selfCheck = latestGreenSelfCheck(root, taskId);
if (!selfCheck) fail(`no green browser self-check evidence exists for taskId ${taskId}`);
const out = path.join(root, ".solstice", "walkthrough", taskId, stamp);
fs.mkdirSync(out, { recursive: true });
const desktopPrefix = path.join(out, "desktop");
const mobile = path.join(out, "mobile.png");
const gateDesktop = path.join(out, "gate-desktop.png");
const recording = path.join(out, "walkthrough.mp4");
fs.copyFileSync(selfCheck.desktop, gateDesktop);
fs.copyFileSync(selfCheck.mobile, mobile);
run(["scrollshot", previewUrl, desktopPrefix, "5"]);
run(["record", previewUrl, recording, "8"]);
const desktop = files(out, /^desktop_s\d+\.png$/);
if (desktop.length !== 5) fail(`expected 5 desktop scrollshots, found ${desktop.length}`);
if (!fs.existsSync(mobile) || fs.statSync(mobile).size === 0) fail("mobile screenshot was not created");
if (!fs.existsSync(recording) || fs.statSync(recording).size < 4096) fail("walkthrough recording was not created");
let replicaEvidence = null;
if (selfCheck.report.replica && selfCheck.report.replica.evidenceDir) {
	const source = path.resolve(root, selfCheck.report.replica.evidenceDir);
	if (source !== root && !source.startsWith(root + path.sep)) fail("replica evidence escaped workspace");
	if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) fail("replica evidence directory is missing");
	const target = path.join(out, "replica-comparison");
	fs.mkdirSync(target, { recursive: true });
	const names = files(source, /^(?:source-(?:desktop|tablet|mobile)|desktop|tablet|mobile|(?:desktop|tablet|mobile)-diff)\.png$|^(?:source-manifest\.json|visual-diff\.json|SOURCE_DECONSTRUCT\.md|VISUAL_DIFF\.md)$/);
	for (const name of names) fs.copyFileSync(path.join(source, name), path.join(target, name));
	if (!names.includes("visual-diff.json") || !names.includes("VISUAL_DIFF.md")) fail("replica evidence package is incomplete");
	replicaEvidence = { dir: "replica-comparison", files: names, score: selfCheck.report.replica.score, targetScore: selfCheck.report.replica.targetScore, sourceUrl: selfCheck.report.replica.sourceUrl || null };
}
const fidelityFile = path.join(root, ".solstice", "FIDELITY.md");
let fidelity = "No FIDELITY.md was present for this build.";
try { fidelity = fs.readFileSync(fidelityFile, "utf8").slice(0, 12000); } catch { }
let deploy = {};
try { deploy = JSON.parse(fs.readFileSync(path.join(root, ".solstice", "deploy.json"), "utf8")); } catch { }
const liveUrl = liveUrlArg || deploy.liveUrl || "";
const evidenceFiles = [...desktop, "gate-desktop.png", "mobile.png", "walkthrough.mp4", ...(replicaEvidence ? replicaEvidence.files.map((file) => `replica-comparison/${file}`) : [])];
const evidence = Object.fromEntries(evidenceFiles.map((file) => [file, { bytes: fs.statSync(path.join(out, file)).size, sha256: sha256(path.join(out, file)) }]));
let quality;
try { quality = JSON.parse(run(["audit", previewUrl])); }
catch (error) { fail(`delivery quality gate failed: ${error.message}`); }
fs.writeFileSync(path.join(out, "quality-audit.json"), JSON.stringify(quality, null, 2) + "\n");
let security;
try { security = await auditSecurity(root, previewUrl); }
catch (error) { fail(`security gate failed: ${error.message}`); }
fs.writeFileSync(path.join(out, "security-audit.json"), JSON.stringify(security, null, 2) + "\n");
const manifest = {
	createdAt: new Date().toISOString(),
	taskId,
	previewUrl,
	liveUrl: liveUrl || null,
	desktopScrollshots: desktop,
	gateDesktopScreenshot: "gate-desktop.png",
	mobileScreenshot: "mobile.png",
	recording: "walkthrough.mp4",
	selfCheck: {
		round: selfCheck.round,
		report: path.relative(root, path.join(selfCheck.dir, "report.json")).split(path.sep).join("/"),
		summary: selfCheck.report.summary || {},
	},
	replica: replicaEvidence,
	fidelityFile: fs.existsSync(fidelityFile) ? ".solstice/FIDELITY.md" : null,
	evidence,
	quality: { score: quality.score, grade: quality.grade, lcpMs: quality.lcpMs, findings: quality.findings.length },
	security: { score: security.score, grade: security.grade, findings: security.findings.length },
};
const review = registerReview(root, out, manifest, quality, security);
manifest.review = { shareId: review.shareId, path: review.path };
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(out, "SHA256SUMS"), evidenceFiles.map((file) => `${evidence[file].sha256}  ${file}`).join("\n") + "\n");
const summary = selfCheck.report.summary || {};
const md = [
	"# Solstice Build Walkthrough", "", `Generated: ${manifest.createdAt}`, `Task ID: \`${taskId}\``, "",
	"## Links", "", `- Preview: ${previewUrl}`, `- Live production: ${liveUrl || "not deployed"}`, "",
	"## Visual evidence", "", "- [Desktop gate evidence](./gate-desktop.png)", ...desktop.map((f, i) => `- [Desktop scroll depth ${i * 25}%](./${f})`), "- [Mobile gate evidence 390×844](./mobile.png)", "- [Real-browser walkthrough recording](./walkthrough.mp4)", "",
	"## ככה בודקים", "",
	`1. פתחו את ה-preview: ${previewUrl}`,
	`2. עברו על ${summary.linksChecked || 0} ניווטים, ${summary.buttonsChecked || 0} כפתורים ו-${summary.formsChecked || 0} טפסים שנבדקו בשער הדפדפן הירוק.`,
	"3. נגנו את `walkthrough.mp4` והשוו את המסכים ל-`gate-desktop.png` ול-`mobile.png`.",
	"4. ודאו שאין 404, שגיאות console, תמונות שבורות, overflow במובייל או controls מתים.",
	`5. לשחזור אוטומטי: \`node webtools/browse.js check ${previewUrl} .solstice/self-check/${taskId}/manual\``, "",
	"## Browser gate provenance", "", `- taskId: \`${taskId}\``, `- green round: ${selfCheck.round}`, `- report: \`${manifest.selfCheck.report}\``, "- התמונות הראשיות הועתקו ישירות מראיות השער הירוק; ההקלטה וה-scrollshots נלכדו מה-preview האמיתי לאחר מעבר השער.", "",
	...(replicaEvidence ? ["## Replica comparison", "", `- Visual score: **${replicaEvidence.score}/100** · target **${replicaEvidence.targetScore}**`, `- [Desktop/tablet/mobile source, replica and heatmap evidence](./${replicaEvidence.dir}/VISUAL_DIFF.md)`, "- הראיות נלכדו מהמקור המורשה ומה-build המרונדר באותם breakpoints; לא נעשה שימוש בתמונות מפוברקות.", ""] : []),
	"## Fidelity", "", fidelity.trim(), "",
	"## Delivery quality gate", "", `**${quality.score}/100 · Grade ${quality.grade}**`, "",
	`- Meta: title ${quality.title ? "present" : "missing"}; description ${quality.metaDescription ? "present" : "missing"}; viewport ${quality.viewport ? "present" : "missing"}`,
	`- Image accessibility: ${quality.missingAlt}/${quality.images.length} missing alt text`,
	`- Image sizing: ${quality.oversizedImages.length} oversized image(s)`,
	`- Console/runtime errors: ${quality.consoleErrors.length}`,
	`- Rough LCP: ${quality.lcpMs ? `${quality.lcpMs} ms` : "not observed"}`, "",
	...(quality.findings.length ? ["### Findings", "", ...quality.findings.map((finding) => `- **${finding.severity.toUpperCase()} · ${finding.check}:** ${finding.message}`), ""] : ["No quality findings in this run.", ""]),
	"Raw audit: `quality-audit.json`", "",
	"## Security gate", "", `**${security.score}/100 · Grade ${security.grade}**`, "",
	`- npm audit: ${security.npm.status}${security.npm.status === "complete" ? ` · critical ${security.npm.vulnerabilities.critical || 0} · high ${security.npm.vulnerabilities.high || 0}` : ` · ${security.npm.reason || "not run"}`}`,
	`- Secret scan: ${security.source.secrets.length} suspected secret(s)`,
	`- Input safety: ${security.source.riskyInputs.length} risky sink(s)`,
	`- Security headers: ${security.headers.status}${security.headers.missing.length ? ` · missing ${security.headers.missing.join(", ")}` : " · complete"}`, "",
	...(security.findings.length ? ["### Security findings", "", ...security.findings.map((finding) => `- **${finding.severity.toUpperCase()} · ${finding.check}:** ${finding.message}`), ""] : ["No security findings in this run.", ""]),
	"Raw audit: `security-audit.json`", "",
	"## Client review", "", `- Shared review path: \`${review.path}\``, "- Read-only delivery page with comments routed to `.solstice/ANNOTATIONS.md`.", "",
	"## Integrity", "", `- ${evidenceFiles.length} visual files captured`, "- SHA-256 checksums: `SHA256SUMS`", "- Machine-readable manifest: `manifest.json`", "",
].join("\n");
fs.writeFileSync(path.join(out, "WALKTHROUGH.md"), md);
const artifactRecord = registerArtifact(root, {
	taskId,
	path: out,
	createdAt: manifest.createdAt,
	type: "build-walkthrough",
	status: "ready",
	previewUrl,
	liveUrl: liveUrl || null,
	manifest: "manifest.json",
	markdown: "WALKTHROUGH.md",
	recording: "walkthrough.mp4",
	thumbnail: "gate-desktop.png",
	selfCheckRound: selfCheck.round,
	replica: manifest.replica,
	quality: manifest.quality,
	security: manifest.security,
});
console.log(JSON.stringify({ ok: true, artifact: out, artifactRecord, manifest }, null, 2));
}

main().catch((error) => fail(error && error.message || String(error)));
