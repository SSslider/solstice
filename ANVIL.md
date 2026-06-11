# Anvil — Antigravity-class AI IDE (build repo)

Downstream of the VSCodium patch-pipeline (this repo IS VSCodium's scripts repo,
branch `anvil-main`, with our changes layered on top). It builds a branded
Code-OSS fork installable on Windows (Inno UserSetup) and macOS Apple Silicon
(ad-hoc-signed zip+dmg).

Research + master plan: `Julius-cc-x/agents/orion/research/antigravity-clone/`
and `Julius-cc-x/agents/orion/deliverables/antigravity_clone_master_plan_2026-06-11.md`.

## What we changed vs upstream VSCodium

- `product.json` (root, deep-merged LAST by `prepare_vscode.sh` → wins): Anvil
  brand keys — names, `.anvil` data folder, `anvil://` protocol,
  `com.thomas.anvil`, fresh win32 installer GUIDs. Open VSX gallery inherited.
- `brand.env` — env for local script runs (APP_NAME/BINARY_NAME/...).
- `.github/workflows/build-anvil.yml` — manual-dispatch matrix: windows-2022
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

0. ✅ Repo scaffold (this commit) — no builds yet.
1. First installable: run `build-anvil.yml` → UserSetup.exe + .dmg → install on
   Thomas's machines. Needs: GitHub repo created (private recommended) + final
   product name from Thomas.
2. Codex/GPT-5.5 inside: bundle pinned `codex` binary per platform, own
   CODEX_HOME, `codex app-server` JSON-RPC (threads/turns/items, approvals,
   rate-limit meter), ChatGPT OAuth via `account/login/start`. Agent panel as a
   built-in webview extension. `AgentRunner` abstraction from day 1.
3. Agent Manager surface: 3-column mission control (workspaces | thread inbox
   w/ status | work area), Artifacts (plan/diffs/walkthrough+screenshots),
   annotate-don't-reprompt comments.
4. Browser computer-use sub-agent + self-verify loop (port from Forge) +
   visual polish beyond Antigravity.
5. Fleet agents bridge (web-building agents first) + Atrium per-client
   integration (Falcon audit cards).
