---
name: scroll-world-gpt-image
tags: animation, scroll-scrub, scrollytelling, gpt-image-2, cinematic, video
version: 1
provenance: adapted-from:github.com/oso95/scroll-world@2912048
verified: true
requirements: ffmpeg; Solstice image bridge; X-Field only for approved video
---

# ScrollWorld — Solstice edition

Build a continuous, scroll-scrubbed world in which the visitor flies through 4–8 connected chapters. Keep the original portable vanilla-JS scrub engine and its seam discipline, but use Solstice's native routes:

- Still images: **agent + GPT-Image-2 through `webtools/image-bridge.js` only**.
- Video: free stock footage first when the user explicitly asks for footage. X-Field/Higgsfield, Seedance or Kling are video-only premium options and always stop at Thomas's approval card, including Autonomous mode.
- Delivery: every generated still must be an exact, bridge-verified file inside the workspace. An exit code alone is never success.

This is an adapted skill, not an unmodified upstream clone. It preserves the scroll mechanic, portable engine and frame-identical seam doctrine from `oso95/scroll-world`, while replacing its still-image provider contract.

## 1. Brief the world

Ask only for missing decisions:

1. Subject, brand and one-line promise.
2. One art direction and a locked palette/light/material/camera language.
3. Four to eight ordered story chapters, each with eyebrow, headline, body and visible scene change.
4. Desktop only or a separately composed mobile chain. Never call a center crop “mobile optimized.”
5. Whether video is actually required. Images and interpolation are the free default; premium video is a proposal, not an automatic action.

Write the accepted brief to `.solstice/scroll-world/brief.json`. Treat the page as one world, never a pile of unrelated sections.

## 2. Generate cohesive GPT-Image-2 stills

Write one prompt file per chapter under `.solstice/scroll-world/prompts/`. Every prompt repeats the same continuity lock verbatim: subject identity, palette, lighting direction, lens, horizon, materials and geometry.

Run the Solstice-owned bridge for each still. The provider preamble contains the exact platform command; its portable form is:

```bash
ELECTRON_RUN_AS_NODE=1 <solstice-node> <extension>/webtools/image-bridge.js generate \
  --workspace <workspace> \
  --output public/scroll-world/stills/chapter-01.png \
  --prompt-file <workspace>/.solstice/scroll-world/prompts/chapter-01.txt
```

The bridge must return `ok:true`, a session id, non-zero dimensions and the exact workspace output. Review every still before moving on. Regenerate an off-style chapter; never mix image providers.

## 3. Choose the motion route

### Free route — default

Use the bundled `animated-assets.js` pipeline. It now calls the same image bridge, creates coherent keyframes, uses ffmpeg interpolation and writes a verified frame manifest plus a ready CanvasScrub scaffold.

### Premium video route — approval required

You may propose X-Field/Higgsfield, Seedance or Kling only for video when it materially improves the result. The proposal must show the exact scene, expected quality delta, time and estimated credits. Do not invoke the provider until Thomas approves its one-time card.

After an approved clip exists locally, non-billable extraction is allowed:

```bash
node <extension>/webtools/animated-assets.js from-video <workspace> <approved-clip> --thomas-approved
```

## 4. Preserve seamless handoffs

Every boundary is pixel evidence, not a prompt promise:

- The next leg starts from the previous leg's **actual last rendered frame**.
- A connector starts from leg A's last frame and ends on leg B's first frame.
- Use one render model for a chain; model changes create visible texture/color pops.
- Verify every seam with extracted boundary frames. No hard blank frame, flash or camera reversal across a seam.
- When using still interpolation, keep identical first/last transition geometry and overlap chapter transitions deliberately.

Read `references/pipeline.md` before asset work and use `references/scrub-engine.js` as the framework-agnostic engine.

## 5. Integrate without framework lock-in

`mountScrollWorld(container, config)` owns its namespaced DOM/CSS and works in plain HTML, React/Next (mount in an effect), Vue or any server-rendered page. Provide:

- section still/clip URLs, chapter copy and accents;
- optional native mobile still/clip variants;
- connectors aligned to `sections.length - 1`;
- reduced-motion stills and full CTA/content parity;
- local media URLs, never provider hotlinks when a local copy is practical.

## 6. Acceptance gate

Before reporting completion:

1. Build and run the landing page.
2. Capture desktop at 0/25/50/75/100% scroll and a full mobile pass.
3. Confirm visible chapter changes, no blank/stuck frame, no copy overlap and no console errors.
4. Validate every raster with the image bridge and every frame/video manifest against files on disk.
5. Verify reduced motion keeps the complete story usable.
6. Record route provenance: `agent+gpt-image-2` for stills; `approved-premium-clip` only when the Thomas approval artifact exists.

## Hard boundaries

- No Higgsfield/X-Field for still images.
- No paid video generation without Thomas's approval card.
- No success without a validated workspace asset.
- No placeholders, fake media, or “will generate later.”
- No copied website source when visual references are used.
