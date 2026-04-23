# ADR 001 · ULMS Formal v1 Tech Stack

**Status:** Accepted
**Date:** 2026-04-23
**Decision-makers:** liyoclaw1242 (product), Claude Code (implementation pair)

---

## Context

After three feasibility / methodology / dual-reviewer spikes (`docs/spike_learnings.md`, `docs/spike_v2_learnings.md`, `docs/spike_v3_learnings.md`) and the 5-layer architecture writeup (`docs/ulms_architecture.md`), we now have:

- Proven engine path: `claude --print --output-format stream-json` + stdin prompt + skill discovery via `.claude/skills/<name>/SKILL.md`
- Proven second-reviewer path: Gemini CLI with `-p` / stdin + `-o stream-json` + `read_file`/`write_file` tools
- Design handoff at `/Users/liyoclaw/Downloads/design_handoff_ulms_shell/` specifying Word-like IDE chrome with 5-region CSS grid, token-driven styling, and React component structure
- Clear scope for v1: Input Loading + Workflow Execution + Results Review with dual-reviewer agreement UI

Spike code lives in `spike/` — deliberately utilitarian, vanilla JS, no build step. Handoff implementation guidance (§11) says: if no frontend framework exists, use **Vite + React + TypeScript + CSS Modules or Tailwind**.

## Decision

**Formal v1 lives in new `app/` directory.** Spike stays under `spike/` as frozen historical reference (regression fixtures, Grok-generated materials, run archives).

### Stack

| Layer | Choice | Why |
|---|---|---|
| Desktop runtime | **Electron** | Spike v1 validated this path; need local file IO + spawn access that browsers don't give |
| Renderer build | **Vite** | Handoff recommendation; fast HMR beats esbuild-alone for React UI iteration |
| Language | **TypeScript** | Blackboard schema + dual-reviewer state shape warrant type safety (see architecture §5) |
| UI library | **React 18** | Handoff's hi-fi is React; direct port possible |
| Styling | **Global CSS** initially (copy `colors_and_type.css` + `shell.css` verbatim), migrate to **CSS Modules** component-by-component when patterns stabilize | Handoff's CSS is already global/BEM-style; premature scoping adds friction |
| State | **Zustand** | Handoff §6 shows a flat state shape with coordinated updates; Zustand is the simplest TS-friendly store that covers this, no Redux boilerplate |
| Icons | **lucide-react** | Handoff §8 explicitly specifies Lucide stroke icons (16px / 1.5px stroke) as the only allowed icon library |
| Fonts | **System fonts only** (no webfont loader) | Actual `colors_and_type.css` puts `-apple-system` first; Noto Sans TC / JetBrains Mono are fallbacks. `design_system.md` "VISUAL FOUNDATIONS · Type" explicitly rejects webfont loading. If users have the fonts locally they kick in; otherwise OS fonts take over, matching the "feels like part of the OS" intent. |
| Electron IPC | **contextBridge + preload** | Closes the `nodeIntegration: true` anti-pattern the spike has; needed before shipping outside dev |
| Testing | **Vitest** for unit/integration | Native Vite integration, TS support, fast. Playwright for e2e deferred until flows stabilize (handoff §11.10). |
| Lint / format | **Prettier** only (no ESLint initially) | Spike has neither; Prettier enforces minimal consistency without config churn |
| Package manager | **npm** | Consistency with spike; no pnpm/yarn migration now |

### Structure

```
app/
  package.json
  tsconfig.json                    TS compiler config
  tsconfig.node.json               TS config for Vite/Electron config files
  vite.config.ts                   Vite + Electron plugin config
  index.html                       Renderer entry
  electron/
    main.ts                        Electron main process (BrowserWindow, IPC)
    preload.ts                     contextBridge exposing minimal IPC surface
    tsconfig.json                  TS config targeting Node/Electron
  src/
    main.tsx                       React root
    App.tsx                        Shell layout (5-region grid)
    styles/
      tokens.css                   copy of handoff's colors_and_type.css
      shell.css                    copy of handoff's hi-fi/shell.css
    components/                    React components, populated in step 5+
    state/                         Zustand stores
    types/                         Shared TS types
    fixtures/                      Typed port of handoff fixtures.js
```

## What we explicitly reject

- **No Tailwind.** Handoff's design tokens are CSS variables; Tailwind would force a translation layer. Copying the CSS verbatim is faster and more faithful to pixel-perfect design intent.
- **No node-pty.** Spike v1 decisively proved this is wrong for `--print` workloads — PTY makes `isatty(stdin)` true which confuses non-interactive mode. Use `child_process.spawn` with pipes.
- **No Redux / MobX.** Zustand is sufficient for the flat state shape in handoff §6. Save complexity for when it's actually needed.
- **No CSS-in-JS library (Emotion / styled-components).** Handoff style is explicitly "cold, dense, reading-first, no runtime style gymnastics". Vanilla CSS matches this aesthetic.
- **No ESLint initially.** Prettier for formatting; type errors caught by `tsc`. ESLint config is a time sink with marginal payoff at this scale.

## Migration strategy from spike

Nothing gets wholesale-copied from `spike/`. Port discretely as needed:

| From spike | To app | When |
|---|---|---|
| `spike/workspace/.claude/skills/agent-*-*.SKILL.md` | `app/resources/skills/` (or left at workspace-level so Claude CLI discovers them the same way) | After scaffold, when wiring agent spawn |
| Coordinator logic (`main.js`: `spawnAgent` / `runWorkflow` / `runSecondOpinion` / `mergeReviews`) | `app/electron/coordinator.ts` | Steps 5+ of handoff implementation plan |
| Blackboard schema | `app/src/types/blackboard.ts` (typed), with fixes from spike v3 (no `review_claude/gemini/merged` in initial schema; use `delete` not `null` before Gemini spawn) | Step 5+ |
| Fixtures under `spike/fixtures/` (rust, econ, astrology, iching, taiwan-history) | Stay in place as regression test corpus | Never migrated; spike/ is the archive |
| UI (`spike/renderer.html` + `renderer.js`) | Completely replaced by handoff design | Not migrated |

## Consequences

**Positive:**
- Clean break between spike experiment grade code and production v1
- Type safety surfaces contract violations (e.g., the iching bug would have been caught at compile time with proper blackboard types)
- Handoff design can be implemented pixel-faithful; no aesthetic drift from spike
- Vite HMR speeds up UI iteration during handoff implementation

**Negative / accepted:**
- Electron + Vite + TypeScript requires more dependencies and config than the spike's single-file approach
- Spike/ directory stays present but dormant; some duplication of concepts (e.g. blackboard helpers) until app/ fully replicates them
- TypeScript adds 1–2 days upfront setup that we didn't need in the spike (type definitions for Electron IPC, stream-json messages, blackboard schema)

**Open decisions (deferred until implementation step they become relevant):**
- Whether to keep skills at `app/workspace/.claude/skills/` or `app/resources/skills/` — depends on Claude CLI discovery semantics in packaged Electron app (step 5)
- Whether to use `electron-builder` or `electron-forge` for packaging — not relevant until ship prep (step 9)
- State persistence layer (localStorage for UI state per handoff §6; SQLite if we end up persisting run history) — deferred to step 6 when we wire state

## References

- Handoff: `/Users/liyoclaw/Downloads/design_handoff_ulms_shell/README.md` §11 Implementation Plan
- `docs/ulms_architecture.md` — 5-layer model, iron laws, context-isolation design
- `docs/spike_v3_learnings.md` §「對 ULMS 正式版 Phase 1 的結論」 — the 5 architectural implications this stack must support
