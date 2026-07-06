# Animated Website Kit

Use this kit when the user asks for an animated website, scrollytelling, a cinematic landing page, an Apple-style product story, scroll-scrubbed video, WebGL, three.js, or react-three-fiber. The goal is a real animated site, not static sections with decorative fade-ins.

## Stack Defaults

- React/Vite or Next.js site: install `gsap` and use `ScrollTrigger` for scroll-scrubbed timelines.
- 3D/WebGL request: install `three`, `@react-three/fiber`, and `@react-three/drei`; use local WebGL scenes or provided/generated assets. Do not call paid/external 3D or video providers unless the Solstice credit gate receives Thomas approval.
- Plain HTML request: use GSAP from a package build when possible; if CDN is required, pin versions and still provide a no-motion fallback.
- Always respect `prefers-reduced-motion` with a static, well-composed fallback.

## Required Motion Architecture

Every animated site must include at least one substantial motion system:

1. Sticky scrollytelling stage: a 300-500vh wrapper with a sticky 100vh stage. Use scroll progress to scrub a GSAP timeline.
2. Section reveal system: masked headline reveals, staggered content, and parallax media driven by `ScrollTrigger`, not only CSS opacity fades.
3. Optional 3D scene: pointer-parallax, scroll-linked camera movement, product viewer, exploded view, shader background, or particle field using three.js/R3F.
4. Optional video/canvas sequence: a sticky canvas or video stage where scroll progress maps to frame/time. Use real local frames/video assets or generated bitmap frames; no placeholder rectangles.

## GSAP Scrollytelling Template

```js
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export function initScrollytelling() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: "[data-story]",
      start: "top top",
      end: "bottom bottom",
      scrub: 1,
      pin: "[data-story-stage]",
      anticipatePin: 1,
    },
  });

  tl.fromTo("[data-hero-title]", { yPercent: 35, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.18 })
    .to("[data-product]", { rotate: 8, scale: 1.08, duration: 0.22 }, 0.16)
    .to("[data-layer='one']", { xPercent: -18, yPercent: -8, duration: 0.25 }, 0.34)
    .to("[data-layer='two']", { xPercent: 20, yPercent: 10, duration: 0.25 }, 0.34)
    .fromTo("[data-proof]", { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.18 }, 0.62)
    .to("[data-stage-copy]", { yPercent: -22, opacity: 0, duration: 0.16 }, 0.82);
}
```

```css
[data-story] { min-height: 420vh; position: relative; }
[data-story-stage] { min-height: 100vh; display: grid; place-items: center; overflow: clip; }
[data-stage-copy] { position: absolute; inset-inline: clamp(20px, 6vw, 80px); bottom: clamp(28px, 8vh, 92px); z-index: 2; }
[data-product] { will-change: transform; transform-style: preserve-3d; }
@media (prefers-reduced-motion: reduce) {
  [data-story] { min-height: auto; }
  [data-story-stage] { position: relative; min-height: 80vh; }
}
```

## React Three Fiber Scroll Template

```jsx
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, ScrollControls, useScroll } from "@react-three/drei";
import { useRef } from "react";

function ProductScene() {
  const group = useRef();
  const scroll = useScroll();

  useFrame(() => {
    const p = scroll.offset;
    group.current.rotation.y = p * Math.PI * 1.4;
    group.current.position.z = -p * 1.8;
    group.current.children.forEach((part, i) => {
      const spread = Math.max(0, (p - 0.35) * 2.2);
      part.position.x = (i - 1) * spread;
      part.position.y = Math.sin(i + p * 4) * spread * 0.22;
    });
  });

  return (
    <group ref={group}>
      <mesh><boxGeometry args={[1.5, 0.22, 1]} /><meshStandardMaterial color="#dfe7ff" metalness={0.55} roughness={0.28} /></mesh>
      <mesh position={[0, 0.34, 0]}><boxGeometry args={[1.2, 0.18, 0.82]} /><meshStandardMaterial color="#7dd3fc" metalness={0.35} roughness={0.2} /></mesh>
      <mesh position={[0, -0.34, 0]}><boxGeometry args={[1.1, 0.16, 0.72]} /><meshStandardMaterial color="#111827" metalness={0.7} roughness={0.18} /></mesh>
    </group>
  );
}

export function ScrollScene() {
  return (
    <Canvas camera={{ position: [0, 0.4, 4.2], fov: 38 }}>
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 4, 5]} intensity={1.6} />
      <ScrollControls pages={4} damping={0.18}>
        <ProductScene />
      </ScrollControls>
      <Environment preset="city" />
    </Canvas>
  );
}
```

## Canvas / Video Sequence Pattern

- Put frames in `public/frames/frame_001.webp` ... `frame_080.webp`.
- Preload frames in chunks; on mobile, use fewer/lower-resolution frames.
- Use a sticky canvas stage and map scroll progress to frame index.
- If using a video, keep it muted/inline and drive `video.currentTime` from scroll progress after metadata loads.

## Verification Gate

Before saying the animated site is done:

1. Run the dev server and capture desktop scroll evidence with `browse.js scrollshot <url> .solstice/verify/f4-desktop 6`.
2. Capture a mobile pass with `browse.js shot <url> .solstice/verify/f4-mobile.png 390x3000`.
3. For canvas/video/3D sections, capture at least five scroll depths: 0%, 25%, 50%, 75%, 100%. Record the filenames and what changed at each depth in `DECONSTRUCT.md` or `.solstice/VERIFY.md`.
4. Open the screenshots/frames with vision (`view_image`, Claude Read, or `browse.js describe`) and verify the page is not blank, not stuck on the first animation frame, and not overlapping text.
5. Check the console/build output. Fix errors, layout overlap, motion jank, and mobile breakage before final response.

If a verification tool is blocked by the environment, write the exact failure into the report and use the closest local proof available. Do not hide the limitation.
