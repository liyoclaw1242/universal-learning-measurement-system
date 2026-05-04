# ULMS — Universal Learning Measurement System

Personal learning toolchain organised around an LLM-maintained wiki.
The user produces raw source material; the wiki maintainer ingests it
into a Karpathy-style compounding knowledge base; Obsidian is the
read interface; assessments cycle the same wiki back into quizzes.

```
                       ~/Documents/Obsidian Vault/ULMS/
                       (the wiki — humans read, claude writes)
                              ▲
       ┌──────────────────────┼──────────────────────┐
       │ writes raw           │ writes raw            │ reads raw
       │                      │                       │
  apps/pdf-reader        chrome-ext             apps/quiz
  ── arxiv-style PDFs    ── articles            ── 4-agent claude
     → raw/papers/          → raw/articles/        pipeline
  ── per-page 繁中       ── youtube transcripts  ── material from
     gemini translate      → raw/youtube/          raw/<type>/<id>/
                        ── multi-page books     ── runs/ → ingested
                          → raw/books/            by maintainer
                              ▼
                      apps/wiki-maintainer
                      ── long-running Tauri app
                      ── 30-min poll on raw/
                      ── claude session + 80% restart
                      ── writes sources/, concepts/,
                         entities/, synthesis/, log.md, index.md
                      ── per CLAUDE.md schema
```

State lives on disk as plain markdown / YAML / JSON. No remote server
we run, no database, no cloud-hosted state. Two local-only servers
exist: the chrome-ext bridge on `127.0.0.1:9527` (axum, in `apps/quiz`),
and a stdio MCP server (`apps/mcp/`) for external Claude Desktop.

---

## Repo layout

```
apps/
  pdf-reader/        Tauri 2 app — arxiv PDF download + per-page 繁中 translation
                     storage: <wiki>/raw/papers/<paper-id>/{meta.yaml, body.md,
                                                            source.pdf, pages/NNN.png}
  quiz/              Tauri 2 app — 4-agent assessment pipeline (claude CLI)
                     workspace at apps/quiz/workspace/ holds blackboard.json,
                     runs/, .claude/skills/, inputs/.
  wiki-maintainer/   Tauri 2 app — long-running, polls <wiki>/raw/ every 30 min,
                     spawns claude with CLAUDE.md as context to ingest new
                     resources. Auto-restarts at 80% of context budget.
  chrome-ext/        MV3 — converts active browser tab to a raw resource
                     (article / youtube / multi-page book session).
  mcp/               Rust binary — JSON-RPC over stdio. Exposes wiki concepts
                     and runs to external Claude Desktop.

packages/
  ui/                @ulms/ui — pure presentational React components, two-tier
                     design tokens (primitives.css → tokens.css → shell.css)
                     consumed by every Tauri app.

docs/                ulms_architecture.md, v1_ux_backlog.md
TODO.md              wiki-centric restructure plan + open questions
```

The wiki itself is a separate git repo at
`/Users/liyoclaw/Documents/Obsidian Vault/ULMS/` (override via
`ULMS_WIKI_DIR`). See its `CLAUDE.md` for the maintainer's contract.

---

## Three storage tiers

| tier | what | where |
|---|---|---|
| **raw** | source material as captured | `<wiki>/raw/<type>/<id>/` |
| **wiki** | LLM-synthesised pages (sources, concepts, entities, synthesis) | `<wiki>/sources/<slug>.md` etc. |
| **runs** | one frozen quiz pipeline output | `apps/quiz/workspace/runs/<ts>-<slug>/` |

The wiki is the read surface (in Obsidian). The maintainer owns
`sources/concepts/entities/synthesis/`; humans can take ownership of
any page by setting `human_edited: true` in its frontmatter — the
maintainer skips it on subsequent ingests.

---

## End-to-end data flows

### 1. Chrome extension → raw bank

```
YouTube watch / article URL
  └─► popup.js → chrome.scripting.executeScript({world:'MAIN'})
        → content/youtube.js  or  content/article.js
        → fetch http://127.0.0.1:9527/import (Bearer <token>)
              apps/quiz/src-tauri/src/ext_server.rs:165
                check_auth + raw_bank::write_{article,youtube,book}
                → <wiki>/raw/<type>/<id>/{meta.yaml, body, ...}
                → emit raw:imported
  └─► next 30-min maintainer poll picks it up
```

YouTube extractor falls through 4 player-data sources (window global →
inline `<script>` regex → `<ytd-watch-flexy>` Polymer element → URL
refetch) for SPA navigations, and 4 caption formats (URL as-is +
`fmt=json3/srv1/srv3`) plus a final DOM scrape of
`ytd-transcript-segment-renderer`.

Book mode is a manual multi-page session: the popup's "Book session"
tab, plus a page-side floater that re-injects on every navigation,
calls `book.add` per page; on Finish the accumulated pages POST to
`/import` as `type:"book"`.

### 2. PDF reader → raw/papers/ → wiki

```
arxiv URL pasted into apps/pdf-reader
  └─► invoke('start_paper_session')          paper.rs:start_paper_session
        derive_paper_id (arxiv → arxiv-<id>)
        download PDF (reqwest, %PDF magic check)
        → <wiki>/raw/papers/<id>/source.pdf
        → meta.yaml + body.md (header)
        emit raw:imported
  └─► PdfReader renders page N (PDF.js, asset:// protocol)
  └─► canvas.toBlob → base64
  └─► invoke('translate_page')               translate.rs:translate_page
        write pages/NNN.png
        spawn `gemini -y -o stream-json -p "@<png>"`
        upsert ## Page N · <ts> block in body.md
        emit raw:imported again
  └─► next 30-min maintainer poll ingests the new sources/<slug>.md +
      updates concepts/entities as needed
```

Re-translation replaces the prior section in-place (drops legacy
duplicates of the same N).

### 3. Quiz 4-agent workflow

```
Stage material + dimensions → click Start
  └─► invoke('start_workflow')               apps/quiz/.../workflow.rs
        for each agent in [extract, map, design, review]:
          spawn `claude --print --output-format stream-json
                 --permission-mode bypassPermissions
                 --model {ULMS_MODEL:-sonnet}
                 --add-dir <workspace> /agent-N-<slug>`
          stream events → emit agent:* events
          merge result → blackboard.json → emit board:updated
        on completion:
          snapshot.rs writes apps/quiz/workspace/runs/<ts>-<slug>/
          emit kb:snapshot-saved + workflow:completed

(optional) Click "Second opinion"
  └─► gemini reviewer (繁中, agent-4-reviewer skill)
       merges verdicts back into blackboard

(optional) Per-item regenerate
  └─► re-runs agent-3 for one slot, splices back
```

The next maintainer tick will treat each new `runs/<ts>-<slug>/` as a
raw resource (pending wiring) and write a synthesis page summarising
the run's KUs and verdicts.

### 4. Wiki ingest (maintainer)

```
Tauri app boots in apps/wiki-maintainer
  ── claude session manager: spawn claude --print --add-dir <wiki>
                              with CLAUDE.md prompt
  ── poll loop: every 30 min, scan <wiki>/raw/<type>/*/
                                compare to .maintainer-state.json
                                queue new keys
  ── ingest dispatch (one at a time):
       prompt claude with "ingest raw/<type>/<id>/ per CLAUDE.md"
       claude follows the schema's ingest workflow:
         - read raw/<type>/<id>/{meta.yaml, body}
         - read index.md
         - write sources/<slug>.md (frontmatter + summary)
         - update concepts/, entities/ (skip human_edited:true)
         - refresh index.md
         - append `## [date] ingest | <title>` to log.md
  ── token tracker: when usage >= 80% of context budget,
                    log restart entry, reset cumulative counter
  ── manual triggers: Ingest now, Lint wiki, Restart session
```

### 5. MCP server (external Claude Desktop)

```
apps/mcp/                                  Rust binary, JSON-RPC over stdio
  Tools: list_concepts, read_concept(slug), search_wiki(query),
         list_runs, get_run(run_id, file)
  Reads: $ULMS_WIKI_DIR/concepts/  and  $ULMS_WORKSPACE_DIR/runs/

External Claude Desktop config snippet is generated by
apps/quiz's `get_mcp_setup` command (visible in the Quiz's MCP setup
panel — currently part of the now-deleted Home tab; will move).
```

---

## External CLIs

Both must be on `$PATH` (or the hardcoded fallback path).

**`claude`** — agent runner + wiki maintainer. Resolved via `which claude` then `~/.local/bin/claude`.
```
claude --print --output-format stream-json --verbose \
       --permission-mode bypassPermissions \
       --no-session-persistence --max-budget-usd 3.00 \
       --model ${ULMS_MODEL:-sonnet} \
       --add-dir <workspace>
```

**`gemini`** — translation, second-opinion, image OCR. Resolved via `which gemini` then `/opt/homebrew/bin/gemini`.
```
gemini -y -o stream-json [--include-directories <dir>] [@<image-path>]
```

---

## Storage layout

```
~/.ulms-config/
  token                               chrome-ext bearer token (UUID)

~/Documents/Obsidian Vault/ULMS/      ULMS_WIKI_DIR (separate git repo)
  CLAUDE.md                           the schema (maintainer's contract)
  index.md, log.md
  raw/                                immutable source layer
    articles/<slug>/                  meta.yaml + content.md
    youtube/<videoId>/                meta.yaml + transcript.md + thumbnails/cover.jpg
    papers/arxiv-<id>/                meta.yaml + body.md + source.pdf + pages/NNN.png
    books/<slug>/                     meta.yaml + body.md + pages/NNN.md
    images/<slug>/                    meta.yaml + body.md + assets/image.<ext>
    markdown/<slug>/                  meta.yaml + body.md
  sources/<slug>.md                   maintainer-written summaries
  concepts/<slug>.md                  topic / framework pages
  entities/<slug>.md                  people / orgs / products
  synthesis/<slug>.md                 cross-cutting analyses, lint reports

apps/quiz/workspace/                  ULMS_WORKSPACE_DIR (per-machine)
  blackboard.json                     live workflow state
  inputs/                             staged material/dimensions copies
  runs/<ts>-<slug>/blackboard.json    archived run snapshots
  .claude/skills/                     agent skill markdown read by claude CLI

apps/quiz/workspace/.maintainer-state.json   ← actually under <wiki>/.maintainer-state.json
                                              tracks seen raw keys
```

---

## Dev commands

```sh
# install deps (npm workspaces)
npm install

# run a Tauri app
npm -w @ulms/wiki-maintainer run tauri:dev
npm -w @ulms/pdf-reader run tauri:dev
npm -w @ulms/quiz run tauri:dev

# typecheck individual apps
npm -w @ulms/quiz run typecheck
npm -w @ulms/pdf-reader run typecheck
npm -w @ulms/wiki-maintainer run typecheck
npm -w @ulms/ui run typecheck      # known pdfjs-suffix warning, harmless

# rust check
cd apps/<app>/src-tauri && cargo check

# build MCP server
cd apps/mcp && cargo build --release
```

First boot of the Quiz creates `~/.ulms-config/token`. Maintainer
refuses to start if `<wiki>/CLAUDE.md` is missing.

---

## Chrome extension wiring

1. Run the Quiz app once → token populates `~/.ulms-config/token`.
2. `chrome://extensions/` → Developer mode → **Load unpacked** → pick `apps/chrome-ext/`.
3. Click ULMS icon → Settings → paste `cat ~/.ulms-config/token` → Save.
4. The dot turns green when `GET /health` succeeds against `http://127.0.0.1:9527`.

Endpoints (`apps/quiz/src-tauri/src/ext_server.rs`):
- `GET /health` → `{ok, version}`
- `POST /import` (Bearer token) → `type: "article" | "youtube" | "book"` → `raw_bank::write_*`, emits `raw:imported`.

---

## Open work

See `TODO.md` for the full backlog. The biggest outstanding items:

- **Quiz: material picker → wiki Raw browser** — currently still uses a file dialog; intended to read from `<wiki>/raw/<type>/<id>/`.
- **Quiz: dimensions auto-only** — drop the file picker, keep only the auto-generate path + dimensions editor.
- **Quiz: guidance textarea** — replace the file picker with a `<textarea>` pre-filled with a default template.
- **Quiz: run snapshot → wiki ingest** — wire `runs/<ts>-<slug>/` so the maintainer's polling picks up completed runs as a sixth raw lane.
- **Maintainer: lint trigger schedule** — currently manual-only.
- **Body-filename unification** — `content.md` (article) and `transcript.md` (youtube) are still legacy; `body.md` everywhere else.
- **YouTube frame snapshots** — user-triggered video frame grab into `raw/youtube/<id>/snapshots/<HHMMSS>.jpg`.
- **STT fallback** for YouTube videos without captions.
- **Verdict reverse-write** — quiz runs push back into source raw resource's `meta.yaml` (`quizzed_in`, `verdict_summary`).
- **Obsidian CLI integration** — "Open in Obsidian" button + `obsidian://` URI launcher per app.
