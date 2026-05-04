# TODO — wiki-centric restructure

The shell becomes the periphery; the Obsidian-hosted wiki becomes the
centre of gravity. Three Tauri apps + chrome-ext, all writing into one
shared LLM-maintained knowledge base under
`/Users/liyoclaw/Documents/Obsidian Vault/ULMS/`.

## Target architecture

```
                    Obsidian Vault/ULMS/
                    ── humans read here
                    ── claude maintains all of:
                       index.md, log.md, sources/, concepts/,
                       entities/, synthesis/  (per CLAUDE.md schema)
                       ▲
        ┌──────────────┼─────────────────┐
        │ (writes raw) │ (writes raw)    │ (writes raw)
        │              │                 │
   chrome-ext     apps/pdf-reader    apps/quiz
   (web → raw/    (PDF only,         (4-agent pipeline,
    articles,     writes raw/         picks material from
    youtube,      papers/<id>/)      raw/*, writes runs/)
    books)             │                 │
                       │                 │
                       └─────────┬───────┘
                                 │ poll every 30 min
                                 ▼
                       apps/wiki-maintainer
                       ── long-running Tauri app
                       ── claude session w/ CLAUDE.md context
                       ── queue + ingest + lint + log
                       ── 80% context → restart
```

## Decisions locked in

- Stack: Tauri 2 throughout.
- Maintainer poll interval: 30 min (autonomous); manual buttons for instant.
- Context restart threshold: 80% of model context window.
- Window-based imports only in `apps/pdf-reader` (paper PDFs).
- Markdown / image / etc. land in raw/ by user dropping straight into
  Obsidian; no in-app drop zone.
- Maintainer triggers: new file polled + scheduled lint + manual button — all three.
- Mid-ingest collisions: queue (don't interrupt the in-flight ingest).
- App ↔ maintainer coupling: zero. Apps just write raw/, maintainer polls.

## Open questions (answer before the corresponding phase starts)

- **`apps/pdf-reader/` final name?** Bikeshed: `paper`, `pdf-lab`, `lens`, `studio`. Default: `pdf-reader`.
- **Default guidance textarea content for Quiz?** Either I draft a starter and you edit, or you paste your existing prompt-of-record.
- **What does Quiz write back to the wiki?** Run snapshot only (`workspace/runs/<ts>-<slug>/blackboard.json`) and let maintainer ingest? Or also push KUs as candidate concept-page additions and verdicts as a synthesis page?
- **Bare `.md` in `raw/markdown/`** — when Obsidian saves a flat file there, does the maintainer normalise to `<slug>/body.md` + `meta.yaml` on first ingest, or does the schema accept bare `.md` as valid? (Leaning: maintainer normalises.)
- **Reader's local-PDF entry point** — keep just URL download, or also a "Open from filesystem" button for PDFs already on disk?

---

## Phase 1 — Foundation: wiki schema + maintainer

**Goal:** an empty wiki layout following Karpathy's pattern, plus a
running claude session that can ingest a single raw resource end-to-end.

- [ ] **`<vault>/ULMS/CLAUDE.md`** — the schema. Defines:
  - Layout: `index.md`, `log.md`, `sources/`, `concepts/`, `entities/`, `synthesis/`, `raw/`.
  - Conventions: `[[wikilink]]` between pages; YAML frontmatter on every page (`type`, `tags`, `last_synthesized`, `human_edited`, `sources: [<slug>]`); log entry format `## [YYYY-MM-DD] op | desc`.
  - Workflows:
    1. **normalise** — bare `.md` / image in `raw/<type>/` → standard `<slug>/{body.md, meta.yaml}` layout.
    2. **ingest** — given a raw resource: write `sources/<slug>.md` (summary + key takeaways + back-link to raw); update relevant `concepts/` and `entities/` pages (skip those with `human_edited: true`); refresh `index.md`; append `## [date] ingest | <title>` to `log.md`.
    3. **lint** — whole-wiki health check: contradictions, stale claims, orphan pages, missing cross-refs, candidate-but-missing concept pages. Output a report to `synthesis/lint-<date>.md`.
    4. **query** (later) — answer ad-hoc questions, optionally file results into `synthesis/`.
- [ ] Move `<vault>/ULMS/concepts/INDEX.md` → `<vault>/ULMS/index.md`. Adjust `wiki.rs::render_index` path constant.
- [ ] `mkdir <vault>/ULMS/{sources,entities,synthesis}` (empty for now; maintainer fills them).
- [ ] `touch <vault>/ULMS/log.md` with a single seed entry.
- [ ] **`apps/wiki-maintainer/`** — new Tauri app.
  - [ ] Scaffold (`cargo new --bin`, Tauri config, basic shell with single window).
  - [ ] Backend: claude session manager.
    - Spawn `claude --print --output-format stream-json --add-dir <vault>/ULMS/` with `CLAUDE.md` referenced via the prompt.
    - Persistent stdin/stdout, parse stream-json events, track tokens used.
    - Restart when tokens > 80% of context window.
  - [ ] Backend: poll loop (`tokio::time::interval(30 min)`).
    - Scan `<vault>/ULMS/raw/<type>/*/` for resources not in `<vault>/ULMS/.maintainer-state.json`.
    - Queue new resources for ingest.
    - Trigger ingest on each queue item (await turn end before next).
    - Append `## [date] ingest | <title>` to `log.md` after each.
  - [ ] Backend: lint trigger (manual + scheduled).
  - [ ] Renderer: live log pane (tail `log.md`, autoscroll), session status (model / tokens / state), action bar (Ingest now / Lint / Restart session), settings (poll interval, model).
  - [ ] Integrate `@ulms/ui` design tokens for visual consistency.
- [ ] Smoke test: drop a `.md` into `raw/markdown/` → 30 min later (or manual Ingest now) → `sources/<slug>.md` exists, `log.md` has the entry, `index.md` updated.

## Phase 2 — Carve out `apps/pdf-reader/`

**Goal:** standalone paper-reading app; current Learn tab becomes a no-op
in the shell (deleted in Phase 3).

- [ ] Create `apps/pdf-reader/` (Tauri).
- [ ] Copy in: PDF.js viewer + `TranslationPanel` + the `start_paper_session` / `translate_page` / `close_paper_session` / `resume_learn_session` Rust commands.
- [ ] Storage migration: every path that today writes to `workspace/learn/<id>/` rewrites to `<vault>/ULMS/raw/papers/<id>/`:
  - `workspace/learn/<id>/source.pdf` → `<vault>/ULMS/raw/papers/<id>/source.pdf`
  - `workspace/learn/<id>/page-N.png` → `<vault>/ULMS/raw/papers/<id>/pages/N.png`
  - `workspace/learn/<id>/notes.md` → `<vault>/ULMS/raw/papers/<id>/body.md` (already mirrored; drop the workspace copy entirely).
- [ ] Update `meta.yaml` writers so `page_count`, `pages_translated`, etc. are tracked.
- [ ] Strip "import as Quiz material" + `import_translation_as_material` + `import_sessions_as_material` commands.
- [ ] Replace "Recent learn sessions" Home list with a Reader-side "Open recent" pane reading `<vault>/ULMS/raw/papers/*/meta.yaml`.
- [ ] (Optional, decide first) Add "Open local PDF" button for `.pdf` files already on disk.

## Phase 3 — Strip the shell down to Quiz-only

**Goal:** the existing `apps/shell-tauri/` becomes a focused Quiz app.

- [ ] Rename `apps/shell-tauri/` → `apps/quiz/` (update workspace `package.json`, npm script names, README references).
- [ ] Delete `home`, `learn`, `wiki` modes from `App.tsx`. `ModeBar` either removed or becomes a single fixed badge.
- [ ] **Material picker**: replace `pick_material` file dialog with a wiki Raw browser (reuses `RawSidebar` from `@ulms/ui`; lets user select one or more `raw/<type>/<id>/`). The selected resources concatenate into `MaterialInput`.
- [ ] **Dimensions**: remove `pick_dimensions` file dialog. Only `generate_dimensions` remains. Result feeds the existing `DimensionsEditor` so item types + difficulty stay editable.
- [ ] **Guidance**: convert from file-pick to a `<textarea>` with a default template baked in as a string constant. User-edited content stages directly (no file copy).
- [ ] On run completion, `snapshot.rs` keeps writing to `workspace/runs/<ts>-<slug>/`. The maintainer polls a new `<vault>/ULMS/raw/runs/` symlink (or copy) and ingests. Confirm placement before committing.
- [ ] Delete the existing Wiki tab + `WikiSidebar` / `WikiViewer` / `RawSidebar` wiring from the shell (the Raw browser piece survives as a Quiz-side picker; the synthesised concepts UI moves to Obsidian entirely).

## Phase 4 — Cleanup

- [ ] Remove `RawSidebar`'s `onMarkdownDrop` / `onImageDrop` props + `WikiTab.RawPane`'s drop handlers.
- [ ] Delete `import_markdown_file` and `import_image_file` Tauri commands + their bridge methods + their server-side helpers (`raw_bank::write_markdown`, `raw_bank::write_image` stay, just no Tauri command surface).
- [ ] Delete `apps/shell/` legacy Electron tree (12 files of stale state under git tracking).
- [ ] Rewrite top-level README to document the three-app architecture; the existing big README becomes archived under `docs/architecture-v1.md` if useful, or just deleted.
- [ ] Audit env-var docs (`ULMS_WIKI_DIR`, `ULMS_WORKSPACE_DIR`) to make sure new apps respect them.

---

## Order I plan to ship in

1. **Phase 1.1** (`CLAUDE.md` + empty layout) — small, unblocks everything.
2. **Phase 1.2** (`apps/wiki-maintainer/` end-to-end) — biggest single chunk; once this ingests one resource correctly the architecture is proven.
3. **Phase 2** (`apps/pdf-reader/`) — independent, can be done in parallel with the maintainer work if wanted.
4. **Phase 3** — depends on (1) being committed in a way Quiz can read from.
5. **Phase 4** — last; only safe once all consumers of the deleted code paths are migrated.

Stop me at any phase boundary if the plan drifts.
