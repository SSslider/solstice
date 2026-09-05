# Hebrew-first RTL Site Playbook

This contract applies to every new website build, regardless of the language used in the request. The output must feel designed for the Israeli market, not mirrored from an English template.

## Before code

1. Use the bundled browser research route to inspect 3–5 live, current references from the exact vertical. Record URLs and concrete decisions in `DECONSTRUCT.md`; do not copy source code or protected brand assets.
2. Define a type scale before components: one Hebrew-capable display face, one highly legible Hebrew text face, responsive sizes, line heights and maximum text widths. Prefer locally available or properly loaded families such as Heebo, Assistant, Rubik, Frank Ruhl Libre or Noto Sans Hebrew when they fit the brand.
3. Define a semantic palette with full ramps: canvas, surface, text, muted text, border, primary, primary-hover, accent, success and error. Verify contrast for text and controls.
4. Define an 8px-based spacing rhythm, content width, section padding, radii, shadows and responsive breakpoints. Reuse tokens; do not sprinkle unrelated values.
5. Choose the component grammar before implementation: navigation, hero, proof, service cards, media, CTA, form, FAQ and footer. Every component must serve the approved brief.

## RTL requirements

- Set `dir="rtl"` and `lang="he"` at the document root for Hebrew-first pages.
- Use logical CSS properties (`margin-inline`, `padding-inline`, `inset-inline`, `text-align:start`) so layouts remain correct in mixed Hebrew/English content.
- Keep phone numbers, prices, URLs, email addresses and code fragments readable with local `dir="ltr"` wrappers where needed.
- Icons that imply direction must mirror; neutral icons and logos must not.
- Validate real Hebrew wrapping on mobile. Orphaned one-word lines, clipped niqqud, reversed punctuation and centered long paragraphs are defects.

## Motion boundary

- Static means no material motion system.
- Subtle means restrained hover, focus, reveal or smooth-scroll details; it does not authorize scrollytelling, sticky chapters, canvas sequences or WebGL.
- Cinematic authorizes the Animated Website Kit.
- ScrollWorld is selected only when the user names ScrollWorld explicitly.

## Delivery bar

Build from reusable components and real content hierarchy. Verify desktop and mobile, keyboard focus, forms, image relevance, console errors and all primary CTAs. The final result must preserve the approved audience, sections, tone, references and motion level.
