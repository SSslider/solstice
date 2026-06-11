# Solstice — Antigravity-class AI IDE (build repo)

Downstream of the VSCodium patch-pipeline (this repo IS VSCodium's scripts repo,
branch `solstice-main`, with our changes layered on top). It builds a branded
Code-OSS fork installable on Windows (Inno UserSetup) and macOS Apple Silicon
(ad-hoc-signed zip+dmg).

Research + master plan: `Julius-cc-x/agents/orion/research/antigravity-clone/`
and `Julius-cc-x/agents/orion/deliverables/antigravity_clone_master_plan_2026-06-11.md`.

## What we changed vs upstream VSCodium

- `product.json` (root, deep-merged LAST by `prepare_vscode.sh` → wins): Solstice
  brand keys — names, `.solstice` data folder, `solstice://` protocol,
  `com.thomas.solstice`, fresh win32 installer GUIDs. Open VSX gallery inherited.
- `brand.env` — env for local script runs (APP_NAME/BINARY_NAME/...).
- `.github/workflows/build-solstice.yml` — manual-dispatch matrix: windows-2022
  (win32-x64) + macos-14 (darwin-arm64), with the **blocking native-modules
  verify gate** and mac ad-hoc codesign.
- `scripts/verify-build-target-natives.sh` — the gate (from Orion's toolkit).
- `patches/user/` — reserved for our feature patches (applied after VSCodium's).

## Iron rules

1. **Never build installers on the Linux server** — CI matrix only.
2. `verify-build-target-natives.sh` must pass in CI before any artifact upload.
3. A build is "done" only after install + launch + screenshot on the real
   target machine (Thomas's PC / MacBook).
4. Commit per phase; report + screenshots to Thomas each phase.

## Roadmap (phases)

0. ✅ Repo scaffold — no builds yet.
1. ✅ First installable (11-12/06): all 3 platforms green in CI, Release v0.1.0,
   verified running on Thomas's Windows PC (gate passed 12/06).
2. ✅ Codex/GPT-5.5 inside (12/06): built-in extension `solstice-codex`
   (src/stable/extensions/solstice-codex — plain JS, zero deps, packaged by the
   local-extensions stream). `codex app-server` JSON-RPC 2.0 over JSONL stdio:
   threads/turns, item streaming (agentMessage/reasoning/commandExecution/
   fileChange deltas), approval cards (execCommand/applyPatch/requestApproval →
   approved/approved_for_session/denied), turn/diff/updated → diff editor,
   rate-limit meter from account/rateLimits, ChatGPT OAuth via
   account/login/start (browser flow). Binary resolution: setting →
   bundled bin/ → PATH; CI bundles pinned codex per platform
   (scripts/bundle-codex-binary.sh, rust-v0.137.0). Verified live on the
   server build under Xvfb: prompt → file created + approval flow + quota bar.
3. ✅ Agent Manager surface (12/06): editor-area panel (Solstice: Open Agent
   Manager / view-title button) with 3 columns — thread inbox (thread/list +
   live thread/status/changed badges, archive) | work area (history via
   thread/read includeTurns, live streaming, approvals) | Artifacts (plan from
   turn/plan/updated w/ step status, diff stat from turn/diff/updated +
   open-in-editor). Annotate-don't-reprompt: composer steers the active turn
   via turn/steer {expectedTurnId} instead of waiting. Multi-thread controller:
   all notifications routed by threadId (sidebar = its thread only, manager =
   all). User messages render from server item replay (no local echo).
   Verified under Xvfb: dental landing page built end-to-end in the manager.
4. Browser computer-use sub-agent + self-verify loop (port from Forge) +
   visual polish beyond Antigravity.
5. Fleet agents bridge (web-building agents first) + Atrium per-client
   integration (Falcon audit cards).
