# ScrollWorld asset and seam pipeline

## Free GPT-Image-2 route

1. Create `.solstice/scroll-world/brief.json` and one prompt file per chapter.
2. Generate all stills through `webtools/image-bridge.js`; never invoke a bare `codex` command.
3. Require one validated raster per bridge session. Preserve the returned session id, dimensions and relative output in `.solstice/scroll-world/assets.json`.
4. For a still-driven canvas sequence, configure `.solstice/animated/brief.json` and run:

   ```bash
   node <extension>/webtools/animated-assets.js free <workspace>
   ```

5. Keep DOM text above the canvas. Images carry atmosphere; they do not carry essential copy.

## Frame-identical seams

For each rendered leg:

```bash
ffmpeg -sseof -0.12 -i leg-a.mp4 -frames:v 1 -q:v 2 leg-a-last.png
ffmpeg -ss 0 -i leg-b.mp4 -frames:v 1 -q:v 2 leg-b-first.png
```

A connector, if approved and generated, must start from the previous leg's actual last rendered frame and end on the next leg's actual first rendered frame. Compare the adjacent extracted frames byte-wise when the provider promises exact endpoints; otherwise calculate SSIM and visually inspect the boundary. Reject a flash, blank frame, palette jump or camera-direction reversal.

## Web encodes

- Strip audio from decorative scrub clips.
- Keep native resolution; never upscale a 720p render and call it 1080p.
- Desktop baseline: H.264, `-movflags +faststart`, CRF around 20, GOP around 8.
- Native mobile chain: portrait composition, lighter dimensions and GOP around 4.
- Retain a matching still poster until the first decoded frame paints.

## Premium video boundary

X-Field/Higgsfield, Seedance and Kling are video-only. Before any provider call, stop for the IDE's Thomas approval card and record provider, model, scene, duration, estimated credits and approval id. `animated-assets.js from-video ... --thomas-approved` only proves that the local extraction step was authorized; it does not authorize or perform provider generation.
