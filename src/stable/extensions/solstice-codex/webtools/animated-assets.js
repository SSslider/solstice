#!/usr/bin/env node
"use strict";

// Solstice Animated Website asset pipeline.
// Free route: Codex image generation -> coherent keyframes -> ffmpeg -> WebP frames.
// Premium clips are never generated here. An already-approved clip can only be
// processed with `from-video --thomas-approved` after the IDE credit gate.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
	console.error(`animated-assets: ${message}`);
	process.exit(1);
}

function run(bin, args, options = {}) {
	const result = spawnSync(bin, args, { stdio: "inherit", shell: false, ...options });
	if (result.error) fail(`${bin} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`${bin} exited ${result.status}`);
}

function resolveRoot(value) {
	const root = path.resolve(value || process.cwd());
	if (!fs.existsSync(root)) fail(`workspace does not exist: ${root}`);
	return root;
}

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeNew(file, body) {
	mkdir(path.dirname(file));
	if (!fs.existsSync(file)) fs.writeFileSync(file, body, "utf8");
}

function parsePositive(value, fallback, label) {
	const n = Number(value == null ? fallback : value);
	if (!Number.isFinite(n) || n <= 0) fail(`${label} must be positive`);
	return n;
}

function pathsFor(root) {
	return {
		brief: path.join(root, ".solstice", "animated", "brief.json"),
		prompts: path.join(root, ".solstice", "animated", "prompts"),
		source: path.join(root, "public", "frames-source"),
		frames: path.join(root, "public", "frames"),
		manifest: path.join(root, "public", "frames", "manifest.json"),
		component: path.join(root, "src", "components", "CanvasScrub.jsx"),
		styles: path.join(root, "src", "components", "canvas-scrub.css"),
	};
}

function defaultBrief() {
	return {
		brand: "Example world",
		aspect: "16:9",
		width: 1920,
		height: 1080,
		durationSeconds: 8,
		fps: 10,
		presentation: "vertical-cinematic",
		chapters: [
			{ title: "Arrival", scene: "A wide establishing view that introduces the world and hero subject." },
			{ title: "Discovery", scene: "The camera moves closer; the environment opens and reveals the product story." },
			{ title: "Transformation", scene: "The same world evolves with a clear material, light, or spatial transformation." },
			{ title: "Resolution", scene: "A composed final view with negative space for the closing call to action." },
		],
		continuity: "Keep the same subject identity, lens language, palette, lighting direction, horizon, and world geometry across every frame.",
		avoid: "No text, logos, watermarks, UI chrome, contact sheets, split screens, or unexplained new objects.",
	};
}

const COMPONENT = `import { useEffect, useMemo, useRef, useState } from "react";
import "./canvas-scrub.css";

const pad = (n) => String(n).padStart(3, "0");

export default function CanvasScrub({ frameCount = 80, chapters = [], presentation = "vertical-cinematic", className = "" }) {
  const canvasRef = useRef(null);
  const images = useMemo(() => Array.from({ length: frameCount }, () => new Image()), [frameCount]);
  const [ready, setReady] = useState(false);
  const [activeChapter, setActiveChapter] = useState(0);

  useEffect(() => {
    let loaded = 0;
    images.forEach((image, index) => {
      image.onload = () => { loaded += 1; if (loaded === images.length) setReady(true); };
      image.src = "/frames/frame_" + pad(index + 1) + ".webp";
    });
  }, [images]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const section = canvas && canvas.closest("[data-canvas-story]");
    if (!canvas || !section || !images.length) return;
    const context = canvas.getContext("2d");
    let raf = 0;
    const draw = (index) => {
      const image = images[Math.max(0, Math.min(images.length - 1, index))];
      if (!image || !image.complete) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio; canvas.height = height * ratio;
      }
      const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
      const w = image.naturalWidth * scale; const h = image.naturalHeight * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    const update = () => {
      const rect = section.getBoundingClientRect();
      const distance = Math.max(1, section.offsetHeight - innerHeight);
		const progress = Math.max(0, Math.min(1, -rect.top / distance));
		const chapterIndex = Math.min(Math.max(0, chapters.length - 1), Math.floor(progress * chapters.length));
		section.style.setProperty("--story-progress", String(progress));
		section.style.setProperty("--story-index", String(chapterIndex));
		draw(Math.round(progress * (images.length - 1)));
      setActiveChapter(chapterIndex);
    };
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    addEventListener("scroll", onScroll, { passive: true }); addEventListener("resize", onScroll);
    update();
    return () => { cancelAnimationFrame(raf); removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll); };
  }, [images, ready]);

  return <section data-canvas-story data-presentation={presentation} className={"canvasStory canvasStory--" + presentation + " " + className}>
	<div className="canvasStory__stage">
	  <canvas ref={canvasRef} aria-label="Scroll-controlled visual story" />
	  <div className="canvasStory__depth" aria-hidden="true"><i /><i /><i /></div>
      <div className="canvasStory__chapters">{chapters.map((chapter, index) =>
        <article className={index === activeChapter ? "is-active" : ""} key={chapter.title || index}>
          <p>{String(index + 1).padStart(2, "0")}</p><h2>{chapter.title}</h2><span>{chapter.copy}</span>
        </article>)}</div>
      {!ready && <div className="canvasStory__loading">Loading story…</div>}
    </div>
  </section>;
}
`;

const STYLES = `.canvasStory{position:relative;min-height:500vh;background:#07090d;color:#fff}
.canvasStory__stage{position:sticky;top:0;height:100svh;overflow:hidden}
.canvasStory canvas{width:100%;height:100%;display:block;background:#07090d}
.canvasStory__depth{position:absolute;inset:0;pointer-events:none;display:none}.canvasStory__depth i{position:absolute;border:1px solid rgba(255,255,255,.12);border-radius:999px;transform:translate3d(0,calc(var(--story-progress,0) * -8vh),0)}
.canvasStory--parallax-r3f .canvasStory__depth{display:block;perspective:900px}.canvasStory--parallax-r3f .canvasStory__depth i:nth-child(1){width:42vw;height:42vw;inset:12% auto auto 8%;transform:translate3d(0,calc(var(--story-progress,0) * -14vh),120px)}.canvasStory--parallax-r3f .canvasStory__depth i:nth-child(2){width:25vw;height:25vw;inset:auto 10% 6% auto;transform:translate3d(0,calc(var(--story-progress,0) * 18vh),240px)}.canvasStory--parallax-r3f .canvasStory__depth i:nth-child(3){width:62vw;height:62vw;inset:20% auto auto 48%;transform:translate3d(0,calc(var(--story-progress,0) * -24vh),360px)}
.canvasStory__chapters article{position:absolute;inset-inline:clamp(24px,7vw,110px);bottom:clamp(28px,9vh,96px);max-width:38rem;opacity:0;transform:translateY(24px);transition:opacity .45s ease,transform .45s ease;pointer-events:none}
.canvasStory__chapters article.is-active{opacity:1;transform:none}
.canvasStory--horizontal-commerce .canvasStory__chapters{position:absolute;inset:0}.canvasStory--horizontal-commerce .canvasStory__chapters article{inset:auto auto 0 0;display:flex;flex-direction:column;justify-content:flex-end;width:75vw;min-height:38svh;padding:clamp(24px,5vw,72px);opacity:0;visibility:hidden;transform:translateX(12vw);box-sizing:border-box}.canvasStory--horizontal-commerce .canvasStory__chapters article.is-active{opacity:1;visibility:visible;transform:translateX(0)}
.canvasStory__chapters p{font:600 12px/1 system-ui;letter-spacing:.18em;opacity:.65}.canvasStory__chapters h2{font:600 clamp(42px,7vw,96px)/.92 system-ui;margin:.16em 0}.canvasStory__chapters span{font:400 clamp(16px,1.5vw,22px)/1.5 system-ui;color:#d7dce5}
.canvasStory__loading{position:absolute;inset:0;display:grid;place-items:center;background:#07090d}
@media(prefers-reduced-motion:reduce){.canvasStory{min-height:auto}.canvasStory__stage{position:relative;height:min(80svh,800px)}.canvasStory__chapters{display:none}}
`;

function init(root) {
	const p = pathsFor(root);
	[p.prompts, p.source, p.frames, path.dirname(p.component)].forEach(mkdir);
	writeNew(p.brief, JSON.stringify(defaultBrief(), null, 2) + "\n");
	writeNew(p.component, COMPONENT);
	writeNew(p.styles, STYLES);
	console.log(JSON.stringify({ ok: true, command: "init", ...p }, null, 2));
	return p;
}

function loadBrief(root) {
	const p = init(root);
	let brief;
	try { brief = JSON.parse(fs.readFileSync(p.brief, "utf8")); } catch (error) { fail(`invalid brief: ${error.message}`); }
	if (!Array.isArray(brief.chapters) || brief.chapters.length < 2) fail("brief needs at least two chapters");
	const presentations = new Set(["vertical-cinematic", "parallax-r3f", "horizontal-commerce"]);
	if (!presentations.has(brief.presentation || "vertical-cinematic")) fail(`unsupported presentation: ${brief.presentation}`);
	return { p, brief };
}

function codexBinary() {
	const name = process.platform === "win32" ? "codex.exe" : "codex";
	const candidates = [
		process.env.CODEX_BIN,
		path.join(__dirname, "..", "bin", name),
		process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "codex.cmd") : "",
		process.env.HOME ? path.join(process.env.HOME, ".npm-global", "bin", process.platform === "win32" ? "codex.cmd" : "codex") : "",
	].filter(Boolean);
	return candidates.find((candidate) => fs.existsSync(candidate)) || (process.platform === "win32" ? "codex.cmd" : "codex");
}

function generateKeyframes(root) {
	const { p, brief } = loadBrief(root);
	brief.chapters.forEach((chapter, index) => {
		const number = String(index + 1).padStart(3, "0");
		const output = path.join(p.source, `frame_${number}.png`);
		if (fs.existsSync(output)) return;
		const previous = index ? path.join(p.source, `frame_${String(index).padStart(3, "0")}.png`) : "none";
		const spec = [
			"Use your built-in image generation tool to create exactly one cinematic website animation keyframe.",
			`Brand/world: ${brief.brand}. Chapter ${index + 1}/${brief.chapters.length}: ${chapter.title}.`,
			`Scene: ${chapter.scene}`,
			`Motion/presentation language: ${brief.presentation || "vertical-cinematic"}.`,
			`Continuity lock: ${brief.continuity}`,
			previous !== "none" ? `First inspect ${previous} and use it as the continuity reference. This is the next moment in the same camera move, not a redesign.` : "Establish the visual identity that all later frames must preserve.",
			`Composition: ${brief.aspect || "16:9"}, edge-to-edge cinematic frame, safe negative space for HTML copy.`,
			`Avoid: ${brief.avoid}`,
			`Copy the exact generated image into ${output}. Do not merely describe it. Verify that exact file exists before finishing.`,
		].join("\n");
		fs.writeFileSync(path.join(p.prompts, `frame_${number}.txt`), spec + "\n", "utf8");
		run(codexBinary(), ["exec", "--skip-git-repo-check", "--full-auto", spec], { cwd: root });
		if (!fs.existsSync(output)) fail(`Codex did not create ${output}`);
	});
	return { p, brief };
}

function ffmpeg() { return process.env.FFMPEG_BIN || "ffmpeg"; }

function extractFrames(input, outputDir, total, fps, width, height, interpolation) {
	mkdir(outputDir);
	for (const file of fs.readdirSync(outputDir)) if (/^frame_\d+\.webp$/i.test(file)) fs.unlinkSync(path.join(outputDir, file));
	const filters = [`scale=${Math.round(width)}:${Math.round(height)}:force_original_aspect_ratio=increase`, `crop=${Math.round(width)}:${Math.round(height)}`];
	if (interpolation) filters.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir`);
	else filters.push(`fps=${fps}`);
	run(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", filters.join(","), "-frames:v", String(total), "-c:v", "libwebp", "-quality", "82", path.join(outputDir, "frame_%03d.webp")]);
}

function prepare(root) {
	const { p, brief } = loadBrief(root);
	const sources = fs.readdirSync(p.source).filter((name) => /^frame_\d+\.(png|jpe?g|webp)$/i.test(name)).sort();
	if (sources.length < 2) fail(`need at least two keyframes in ${p.source}`);
	const fps = parsePositive(brief.fps, 10, "fps");
	const duration = parsePositive(brief.durationSeconds, 8, "durationSeconds");
	const total = Math.max(2, Math.round(fps * duration));
	const keyframeRate = (sources.length - 1) / duration;
	const concat = path.join(root, ".solstice", "animated", "keyframes.ffconcat");
	const perFrame = duration / (sources.length - 1);
	const lines = ["ffconcat version 1.0"];
	for (const source of sources) {
		lines.push(`file '${path.join(p.source, source).replace(/'/g, "'\\''")}'`);
		lines.push(`duration ${perFrame}`);
	}
	lines.push(`file '${path.join(p.source, sources[sources.length - 1]).replace(/'/g, "'\\''")}'`);
	fs.writeFileSync(concat, lines.join("\n") + "\n", "utf8");
	const tempVideo = path.join(root, ".solstice", "animated", "interpolated.mp4");
	run(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-safe", "0", "-f", "concat", "-i", concat, "-vf", `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,scale=${brief.width || 1920}:${brief.height || 1080}:force_original_aspect_ratio=increase,crop=${brief.width || 1920}:${brief.height || 1080}`, "-frames:v", String(total), "-pix_fmt", "yuv420p", tempVideo]);
	extractFrames(tempVideo, p.frames, total, fps, brief.width || 1920, brief.height || 1080, false);
	fs.writeFileSync(p.manifest, JSON.stringify({ route: "gpt-image-free", presentation: brief.presentation || "vertical-cinematic", frameCount: total, fps, durationSeconds: duration, keyframeCount: sources.length, keyframeRate, chapters: brief.chapters }, null, 2) + "\n", "utf8");
	console.log(JSON.stringify({ ok: true, route: "gpt-image-free", frameCount: total, frames: p.frames, component: p.component }, null, 2));
}

function fromVideo(root, input, approved) {
	if (!approved) fail("from-video requires --thomas-approved; provider generation must pass the Solstice credit gate first");
	const { p, brief } = loadBrief(root);
	const clip = path.resolve(input || "");
	if (!fs.existsSync(clip)) fail(`approved clip not found: ${clip}`);
	const fps = parsePositive(brief.fps, 10, "fps");
	const duration = parsePositive(brief.durationSeconds, 8, "durationSeconds");
	extractFrames(clip, p.frames, Math.round(fps * duration), fps, brief.width || 1920, brief.height || 1080, false);
	fs.writeFileSync(p.manifest, JSON.stringify({ route: "approved-premium-clip", source: path.basename(clip), presentation: brief.presentation || "vertical-cinematic", frameCount: Math.round(fps * duration), fps, durationSeconds: duration, chapters: brief.chapters }, null, 2) + "\n", "utf8");
	console.log(JSON.stringify({ ok: true, route: "approved-premium-clip", frames: p.frames }, null, 2));
}

function usage() {
	console.log(`Usage:
  animated-assets.js init <workspace>
  animated-assets.js generate <workspace>   # gpt-image keyframes via Codex
  animated-assets.js prepare <workspace>    # ffmpeg interpolation -> public/frames
  animated-assets.js free <workspace>       # init + generate + prepare
  animated-assets.js from-video <workspace> <approved-clip> --thomas-approved`);
}

const [command, rootArg, inputArg, ...flags] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") { usage(); process.exit(0); }
const root = resolveRoot(rootArg);
if (command === "init") init(root);
else if (command === "generate") generateKeyframes(root);
else if (command === "prepare") prepare(root);
else if (command === "free") { generateKeyframes(root); prepare(root); }
else if (command === "from-video") fromVideo(root, inputArg, flags.includes("--thomas-approved"));
else fail(`unknown command: ${command}`);
