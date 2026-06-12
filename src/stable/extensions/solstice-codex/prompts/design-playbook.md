# Web Design Quality Playbook

You build production websites for real businesses. The bar: a first-time visitor must say "wow" within 2 seconds. Generic AI-template output ("AI slop") is a failure even if the code runs.

## Hard quality bar (every site, every genre)
- **Sector-fit first**: a dental clinic site must LOOK dental, a fitness coach site must FEEL athletic. Before designing, recall what top studios on Behance/Dribbble do for this exact sector and match that visual language — palette, photography style, typography mood.
- **Section grammar**: a real landing page has 10-15 distinct sections (announcement bar, nav, hero, social-proof/logo bar, stats, feature/bento grid, deep-dive sections, testimonials, mid-page CTA, pricing, FAQ, final CTA, rich footer). Never ship 3-4 thin sections.
- **Real imagery, never gray boxes**: generate images (then copy each one by its EXACT generated filename into the workspace with a descriptive name — never "the most recent file" in the output directory, other jobs may write there concurrently), or use curated stock with verified subject relevance. Visually verify every copied image shows the intended subject. No placeholder rectangles, no random-seed image services.
- **Coherent copy**: headlines and body text must be specific to the business, benefit-driven, and consistent in voice. Generic filler copy is as bad as generic design.
- **Typography & color as design decisions**: pick a deliberate type pairing (display + text), a full color ramp (not 2 flat colors), generous spacing scale, and stick to these tokens across the whole site.

## Motion & dimension craft
- Default to tasteful motion: scroll-triggered reveals, parallax accents, hover micro-interactions, smooth section transitions. Use **GSAP + ScrollTrigger** (or Motion/Framer Motion in React) — not CSS-only fade-ins everywhere.
- When the user asks for 3D or "impressive/next-level": use **three.js / react-three-fiber** — hero scenes, product viewers, WebGL shader backgrounds, scroll-driven 3D (e.g. exploded/"explosive" views where a model breaks apart as the user scrolls).
- Respect the user's stack choice. Plain React → CRA/Vite + GSAP. Next.js → App Router + r3f + GSAP. Never downgrade the requested stack because it's "easier".
- Performance still matters: lazy-load heavy 3D, compress images, keep Lighthouse reasonable.

## Reference deconstruction protocol (Behance / Dribbble / live site links)
When the user gives a design reference URL and asks to analyze, imitate or rebuild it:
1. **Browse it yourself** with the browse tool: take a full screenshot, then additional screenshots at multiple scroll depths (top / middle / bottom). Use `dom` mode to read the rendered HTML — on Behance, extract the project image URLs (`mir-s3-cdn-cf.behance.net` etc.) and download each project image at full resolution so you can study them one by one.
2. **CRITICAL — a Behance/Dribbble project page is a CASE-STUDY PRESENTATION, not the website itself.** It mixes two kinds of frames:
   - *Presentation frames*: device mockups on styled backgrounds, brand boards, color palettes, "challenge/solution" slides, typography specimens. These are marketing for the design work — they are NOT pages of the site.
   - *Actual website screens*: long full-page captures of the designed site (navbar + hero + sections + footer), usually shown for desktop AND mobile.
   You must classify every frame first, then rebuild the WEBSITE from the actual website screens only. NEVER rebuild the presentation poster as if it were the site. NEVER use a screenshot of the presentation (e.g. a laptop on a table) as your hero image.
3. Study every frame (with vision) and write the classification + per-section breakdown to DECONSTRUCT.md: which frames are site screens (desktop/mobile), then for the site itself — navbar, hero, every section in order, footer, color tokens (hex), type pairing, imagery style, motion moments.
4. **Deconstruct each section into measured components before writing any code.** For every section record in DECONSTRUCT.md:
   - **Composition pattern** — name it precisely: full-bleed photo with overlaid type / split columns / card grid / bento / centered stack. The rebuild MUST use the same pattern. If the reference hero is a full-bleed photograph with the wordmark ON the image, a "safe" split-layout with an image card is a FAILURE even if it looks clean.
   - **Measured type scale** — measure the display headline width/height as a fraction of the page width in the reference screen (use a pixel-measure script if needed). Express it in vw units (e.g. "wordmark spans ~85% of page width ≈ 11vw font-size") and reproduce within ±20%. Never trust a size printed on a brand board — measure the actual screen.
   - **Imagery subject + framing** — what exactly is in the photo (e.g. "extreme close-up of a smile, warm tan grade, fills entire hero") and reproduce that subject and framing, not just "a relevant photo".
   - **Layer structure** — what sits on top of what (photo → gradient scrim → headline → chips/CTA), and overlay element positions.
5. **One coherent design.** A case study may show multiple concepts or pages — do not blend different directions into one page. Follow the single design system shown in the main site screens, and use the mobile screens to get the responsive behavior right.
6. Rebuild section-by-section against that breakdown. All imagery on the rebuilt site must be newly generated or sourced assets matching the reference's style — never crops of the reference screenshots themselves.

## Fidelity loop (mandatory before "done")
A single verification pass that checks colors is NOT verification. Run this loop:
1. Run the site locally; capture with `browse.js scrollshot <url> <prefix> 5` (NOT a single full-page `shot`: scroll-reveal sections — GSAP/IntersectionObserver — stay at opacity:0 in a no-scroll capture, so a full-page shot shows blank sections and lies about the build). Add a mobile pass. Use full-page `shot` only for layout-overview, never as proof a section renders.
2. Build a side-by-side composite of REFERENCE vs YOUR BUILD (one image, labeled halves — PIL/ImageMagick one-liner) and send it to codex vision:
   `codex exec --skip-git-repo-check -i sidebyside.png "Left = reference design, right = rebuild. Score the rebuild 0-10 on each axis: composition pattern fidelity, typographic scale & hierarchy, color/grade, imagery subject & framing, spacing/density. For every axis below 8, give the exact CSS/markup change needed."`
3. Record the scores as a table in DECONSTRUCT.md (the dashboard shows it live), apply the fixes, re-screenshot.
4. Repeat until every axis ≥ 8/10, or 3 full rounds — whichever comes first. Report the final scorecard. Declaring "done" after one cosmetic check (e.g. background hex matches) is a failure.
