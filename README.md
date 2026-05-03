# ULMS — Universal Learning Measurement System

Local desktop toolchain for personal learning that turns reading material into
graded competency assessments and a durable knowledge base.

```
                        capture                    grade                 distil
   raw web / PDF / video ───────► quiz pipeline ────────► run snapshots ────────► wiki concepts
        (chrome-ext,            (4-agent claude CLI)     (workspace/runs/)        (~/.ulms-wiki/concepts/)
         PDF Learn,                                                                    │
         file upload)                                                                  ▼
                                                                              MCP server (apps/mcp/)
                                                                              ⇅ external Claude Desktop
```

The shell is a Tauri 2 desktop app. Heavy work is delegated to the local
`claude` CLI (the four assessment agents) and `gemini` CLI (PDF translation,
second-opinion review, wiki synthesis); both shell out to Anthropic /
Google APIs on each call. State lives on disk as plain JSON / YAML /
Markdown — no database, no cloud-hosted state, nothing remote that we
run. Two local-only servers do exist: an axum HTTP bridge on
`127.0.0.1:9527` for the chrome extension, and a stdio MCP server for
external Claude Desktop integration.

---

## Mental model — three storage tiers

| Tier | What | Where | Owner |
|---|---|---|---|
| **raw** | Source material as captured | `~/.ulms-wiki/raw/<type>/<id>/` | chrome-ext, PDF Learn, manual upload |
| **runs** | Frozen output of one quiz pipeline run | `apps/shell-tauri/src-tauri/workspace/runs/<ts>-<slug>/` | `workflow.rs` snapshot at completion |
| **wiki concepts** | Gemini-synthesised topic pages spanning many runs | `~/.ulms-wiki/concepts/<slug>.md` | `wiki::synthesize_wiki` |

The **wiki repo at `~/.ulms-wiki/`** is intended to be a separate git repo
(human-editable). The **workspace at `apps/shell-tauri/src-tauri/workspace/`**
is local mutable state (live blackboard, staged inputs, archived runs).

Path overrides: `ULMS_WIKI_DIR`, `ULMS_WORKSPACE_DIR`.

---

## Four modes (top-bar `ModeBar`)

- **Home** — landing view: recent learn sessions, recent quiz runs, recent raw imports, MCP setup, "Synthesize wiki" CTA. `apps/shell-tauri/src/App.tsx:147` → `apps/shell-tauri/src/App.tsx:316–491`.
- **Learn** — focused 1-vs-1 reader for a single raw resource. Intended to be the type-aware reader for everything in `~/.ulms-wiki/raw/`: paper (PDF.js viewer), youtube (embedded player + transcript), article / markdown (markdown reader), image (image viewer + OCR). Right-pane `TranslationPanel` produces a per-page artefact in one of two modes — **translate to 繁中** (current) or **extract to markdown** (TODO). Currently only arxiv PDFs are wired (auto-switches in when a paper session starts); other raw types still flow through the Wiki **Raw materials** browser, whose `Go to Learn` button is a stub until phase 2.
- **Quiz** — IDE-style workspace for the 4-agent assessment pipeline. `Ribbon` (top: pickers + Start) + `NavRail` + `TabBar` (`OverviewTab` / `ItemDetailTab` / `TerminalTab` / `DimensionsEditor`).
- **Wiki** — local KB browser with two sub-modes: **Concepts** (synthesised pages, `WikiSidebar` + `WikiViewer`) and **Raw materials** (`RawSidebar` + `RawViewer` over `~/.ulms-wiki/raw/`).

---

## Repo layout

```
apps/
  shell-tauri/          ← active Tauri 2 desktop app
    src/                  React renderer (Vite, TypeScript)
      App.tsx               top-level routing + mode shells
      state/
        shellStore.ts       Zustand store (UI + pipeline + learn slices)
        ipcBridge.ts        invoke + listen wrapper, single bridge.* surface
      components/
        WikiTab.tsx         Concepts / Raw materials toggle
    src-tauri/            Rust backend
      src/
        lib.rs              AppState + 40 #[tauri::command]s + invoke_handler!
        workflow.rs         spawn 4 claude agents sequentially, stream blackboard updates
        gemini.rs           gemini second-opinion reviewer (繁中)
        learn.rs            PDF download, page → PNG → gemini translation, notes.md
        inputs.rs           file dialogs + workspace/inputs/ staging
        blackboard.rs       blackboard.json IO
        snapshot.rs         workspace/runs/<ts>-<slug>/ archive
        regenerate.rs       per-item agent-3 rerun, batch reject
        wiki.rs             concepts CRUD + synthesize_wiki + MCP setup info
        raw_bank.rs         ~/.ulms-wiki/raw/<type>/<id>/ writers + reader
        ext_server.rs       axum HTTP server (127.0.0.1:9527, bearer-token auth)
        overrides.rs        user verdict overrides on items
        types.rs            Blackboard / MaterialInput / Dimension / etc.
  shell/                ← legacy Electron shell (frozen, kept for reference)
  chrome-ext/           ← MV3 extension — single mandate: web tab → raw bank
    manifest.json         MV3 manifest (background SW, broad host_permissions)
    popup.{html,css,js}   mode tabs (Single page / Book session) + book session UI
    background.js         service worker; owns book session in chrome.storage,
                          re-injects floater on tab navigation, uploads to /import
    floater.js            page-side overlay during book sessions
                          (Capture / Finish / hide buttons; persists across flips)
    content/article.js    article extractor + 博客來 epub.js iframe reach-in
    content/youtube.js    SPA-aware player-data probe + caption multi-format parser
  mcp/                  ← Rust MCP server, exposes wiki to external LLM clients
  spike/                ← throwaway experiments

packages/
  ui/                   ← @ulms/ui — pure presentational React components
    src/
      components/         HomeView, ModeBar, NavRail, Ribbon, TabBar, OverviewTab,
                          ItemDetailTab, TerminalTab, DimensionsEditor, PdfReader,
                          TranslationPanel, WikiSidebar, WikiViewer, RawSidebar,
                          RawViewer, McpSetupPanel, RecentSessionRow, StatusBar,
                          WarningsTray
      types/              shared DTO interfaces consumed by both renderer + components
      styles/
        primitives.css      raw colour scales + opacity ramp (Quiet Tech navy palette)
        tokens.css          semantic --ulms-* tokens (canvas / ink / line / blue / …)
        shell.css           component CSS using semantic tokens

docs/
  ulms_architecture.md, v1_ux_backlog.md
```

---

## End-to-end data flows

### 1. Chrome extension → raw bank

```
YouTube watch / article URL
  └─► popup.js onSend()                    apps/chrome-ext/popup.js:97
        └─► chrome.scripting.executeScript({world:'MAIN', func: extract*})
              └─► content/youtube.js  or  content/article.js
                    extracts player data / Readability-style markdown
        └─► fetch('http://127.0.0.1:9527/import', Bearer <token>)
              ext_server.rs:165          axum POST /import handler
                check_auth()                  ext_server.rs:115
                raw_bank::write_article()  or  write_youtube()
                  raw_bank.rs:146 / 195       writes meta.yaml + content.md /
                                              transcript.md (+ thumbnails/cover.jpg)
                app.emit('raw:imported', …)   ext_server.rs:206
  └─► Home & WikiTab(Raw) listeners → list refresh
        App.tsx:325 (Home), WikiTab.tsx:231
```

YouTube extractor falls through 4 player-data sources (window global → inline
`<script>` regex → `<ytd-watch-flexy>` → URL refetch) for SPA navigations, and
4 caption formats (URL as-is → `&fmt=json3/srv1/srv3`) plus a final DOM scrape
of `ytd-transcript-segment-renderer`. See `apps/chrome-ext/content/youtube.js`.

### 2. PDF Learn → translation → import as Quiz material

```
arxiv URL pasted in Learn tab
  └─► bridge.startPaperSession(url)        ipcBridge.ts:440
        invoke('start_paper_session')      lib.rs:316
          learn.rs:121                     reqwest download → magic-byte check
            workspace/learn/<id>/source.pdf
            notes.md (header)
  └─► PdfReader renders page N (PDF.js, asset:// protocol)
  └─► canvas.toBlob → base64
  └─► bridge.translatePage(N, b64)         ipcBridge.ts:454
        invoke('translate_page')           lib.rs:326
          learn.rs:263                     write page-N.png
          spawn gemini -y -o stream-json @page-N.png
            stream → translation:capture-started, :stream
            on completion: append section to notes.md
            emit translation:completed
  └─► bridge.importTranslationAsMaterial() ipcBridge.ts:463
        invoke('import_translation_as_material')   lib.rs:356
          read notes.md → MaterialInput → workspace/inputs/<derived>.md
          stage into AppState.staged.material
  └─► user switches to Quiz tab; inputsReady flips when dimensions also staged
```

### 3. Quiz 4-agent workflow

```
Stage material + dimensions → click Start
  └─► bridge.startWorkflow()               ipcBridge.ts:411
        invoke('start_workflow')           lib.rs:190
          workflow::run_workflow()         workflow.rs
            for each agent in [extract, map, design, review]:
              spawn_agent()                workflow.rs:125
                claude --print --output-format stream-json --verbose
                       --permission-mode bypassPermissions
                       --no-session-persistence --max-budget-usd 3.00
                       --model {ULMS_MODEL:-sonnet}
                       --add-dir <workspace>
                stdin: /agent-N-<slug>     workflow.rs:141
              parse stream events
                emit agent:started / :stream / :pty / :raw / :completed
              merge result → blackboard.json → emit board:updated
            on completion:
              snapshot.rs writes workspace/runs/<ts>-<slug>/blackboard.json
              emit kb:snapshot-saved + workflow:completed

(optional) Click "Second opinion"
  └─► bridge.startSecondOpinion()          ipcBridge.ts:417
        invoke('start_second_opinion')     lib.rs:226
          gemini.rs                        gemini -y -o stream-json
                                           --include-directories <workspace>
                                           prompt: agent-4-reviewer skill (繁中)
          merge verdicts back into blackboard
          emit second-opinion:completed (verdict_agreement_rate, disagreements)

(optional) Per-item regenerate
  └─► bridge.regenerateItem(id)            ipcBridge.ts:432
        invoke('regenerate_item')          lib.rs:280
          regenerate.rs                    re-run agent-3 for one slot, splice back
```

### 4. Wiki synthesis

```
Click "Synthesize wiki" (Home or Wiki tab)
  └─► bridge.synthesizeWiki()              ipcBridge.ts:561
        invoke('synthesize_wiki')          lib.rs:445
          wiki::synthesize_wiki()          wiki.rs:604
            collect_kus()                  wiki.rs:289     reads all workspace/runs/*/blackboard.json
            spawn gemini -y --include-directories <workspace>
              prompt: KU grouping → JSON of {slug, title, body, tag[]}
            for each concept:
              render_concept_md()          wiki.rs:472     frontmatter human_edited=false + body
              skip if existing concept has frontmatter human_edited=true
              write ~/.ulms-wiki/concepts/<slug>.md
            render_index()                 wiki.rs:529     ~/.ulms-wiki/concepts/INDEX.md
            emit wiki:synthesize-completed
```

### 5. MCP server (external Claude Desktop)

```
apps/mcp/                                  Rust binary, JSON-RPC over stdio
  src/main.rs:42                           handles initialize / tools/list / tools/call
  tools exposed:                           list_concepts, read_concept(slug),
                                           search_wiki(query), list_runs,
                                           get_run(run_id, file)
  reads:                                   $ULMS_WIKI_DIR/concepts/
                                           $ULMS_WORKSPACE_DIR/runs/

Tauri side:
  bridge.getMcpSetup()                     ipcBridge.ts:602
    invoke('get_mcp_setup')                lib.rs:455
      wiki::mcp_setup_info()               wiki.rs:202
        returns McpSetup { mcpBinaryPath, binaryExists, wikiDir, workspaceDir,
                           claudeDesktopConfigPath, configSnippet }
  HomeView's McpSetupPanel renders the snippet + copy button.
```

---

## IPC surface (41 commands)

Grouped — see `apps/shell-tauri/src-tauri/src/lib.rs` `invoke_handler!` for the
authoritative list.

| Area | Commands |
|---|---|
| Inputs | `inputs_status`, `pick_material`, `pick_dimensions`, `pick_guidance`, `clear_guidance` |
| Workflow | `start_workflow`, `stop_workflow`, `read_board` |
| Second opinion | `start_second_opinion`, `stop_second_opinion` |
| Item edits | `apply_item_override`, `export_items`, `regenerate_item`, `regenerate_rejected` |
| Learn | `start_paper_session`, `translate_page`, `stop_translation`, `close_paper_session`, `import_translation_as_material`, `import_sessions_as_material`, `list_learn_sessions`, `resume_learn_session`, `delete_learn_session` |
| Dimensions | `generate_dimensions`, `get_dimensions`, `update_dimensions` |
| Runs | `list_runs`, `delete_run` |
| Wiki | `synthesize_wiki`, `get_wiki_dir`, `list_wiki_concepts`, `read_wiki_concept`, `write_wiki_concept` |
| Raw bank | `list_raw_resources`, `read_raw_resource`, `delete_raw_resource`, `open_raw_dir`, `import_markdown_file`, `import_image_file` |
| Chrome ext | `get_ext_token` |
| MCP | `get_mcp_setup` |

## Event surface (32 events)

| Channel | Events |
|---|---|
| Workflow | `workflow:started`, `workflow:completed`, `workflow:error` |
| Agent | `agent:started`, `agent:stream`, `agent:pty`, `agent:raw`, `agent:completed`, `schema:warn` |
| Board | `board:updated` |
| Snapshot | `kb:snapshot-saved`, `kb:snapshot-error` |
| Gemini | `gemini:started`, `gemini:stream`, `gemini:pty`, `gemini:raw`, `gemini:completed`, `second-opinion:completed`, `second-opinion:error` |
| Translation | `translation:capture-started`, `translation:stream`, `translation:pty`, `translation:completed`, `translation:error`, `paper-window:closed` |
| Dimensions | `dimensions:generating`, `dimensions:generated` |
| Regenerate | `regenerate:started`, `regenerate:completed`, `regenerate:error`, `regenerate-batch:started`, `regenerate-batch:item-done`, `regenerate-batch:completed` |
| Raw bank | `raw:imported` |
| Wiki | `wiki:synthesize-started`, `wiki:synthesize-completed` |

Listener wiring lives in `apps/shell-tauri/src/state/ipcBridge.ts`
`setupIpcBridge()` (single place to grep when adding a new event).

---

## External CLIs

The shell shells out to two binaries; both must be on `$PATH` (or at the
hardcoded fallback path).

**`claude`** — agent runner. Resolved via `which claude` then `~/.local/bin/claude` (`workflow.rs:77`).
```
claude --print --output-format stream-json --verbose \
       --permission-mode bypassPermissions \
       --no-session-persistence --max-budget-usd 3.00 \
       --model ${ULMS_MODEL:-sonnet} \
       --add-dir <workspace>
```
Stdin is `/<agent-skill-slug>` (e.g. `/agent-1-extractor`). Skills live in
`apps/shell/workspace/.claude/skills/agent-{1,2,3,4}-{extractor,mapper,designer,reviewer}/SKILL.md`.

**`gemini`** — translation, second-opinion, wiki synthesis. Resolved via
`which gemini` then `/opt/homebrew/bin/gemini` (`gemini.rs:43`, `learn.rs:70`).
```
gemini -y -o stream-json [--include-directories <workspace>] [@<image-path>]
```

Per-call timeouts: 900 s for agents and wiki synthesis, 300 s for second
opinion and per-page translation.

---

## Storage layout

```
~/.ulms-config/
  token                              chrome-ext bearer token (UUID, ext_server.rs:41)

~/.ulms-wiki/                        separate repo, ULMS_WIKI_DIR overrideable
  raw/                               see "Raw format" section below
    articles/<slug>/                 chrome-ext: web articles (Readability extract)
    youtube/<videoId>/               chrome-ext: transcript + thumbnail
    papers/arxiv-<id>/               PDF Learn: per-page translations
    books/<slug>/                    chrome-ext: multi-page reader (博客來, etc.)
    images/<slug>/                   manual upload: screenshot + gemini OCR
    markdown/<slug>/                 manual upload: drag-drop .md
  concepts/
    <slug>.md                        gemini-synthesised, frontmatter: human_edited
    INDEX.md                         flat list, regenerated by render_index

apps/shell-tauri/src-tauri/workspace/    ULMS_WORKSPACE_DIR overrideable
  blackboard.json                    live workflow state
  inputs/                            staged material/dimensions copies
  runs/<ts>-<slug>/blackboard.json   archived run snapshots
  learn/<sessionId>/                 source.pdf, page-<n>.png, notes.md
                                       (notes.md mirrors raw/papers/<id>/body.md)
  .claude/skills/                    agent skill markdown (read by claude CLI)
```

The default workspace path is `apps/shell/workspace/` — held over from the
Electron era, shared during the migration. Override via `ULMS_WORKSPACE_DIR`.

---

## Raw format

Each raw resource lives at `~/.ulms-wiki/raw/<type>/<id>/`. The schema is
six folders worth of layouts that share one `meta.yaml` shape, with body
filename and side artefacts varying by source. Reader (`raw_bank::read_resource`)
falls through `transcript.md` → `content.md` → `body.md` → `notes.md` so
the inconsistency is invisible at the read boundary.

### `meta.yaml` (`RawMeta`, `raw_bank.rs:17`)

```yaml
id: <stable-id>                  # videoId / arxiv-<id> / slug(title)
type: article|youtube|paper|book|image|markdown
source_url: <url>                # canonical URL of the source (or "local")
title: <string>
captured_at: <ISO8601 UTC>
captured_via: chrome-ext|pdf-learn|manual-upload

verified: false                  # human review flag (default false)
quizzed_in: []                   # back-references to runs that used this resource
verdict_summary: null            # populated by verdict reverse-write (TODO)

# type-specific — each field omitted from disk when null
char_count: <int>                # any text body
duration_s: <int>                # youtube
channel: <string>                # youtube
caption_lang: <string>           # youtube
page_count: <int>                # book
author: <string>                 # article, paper, book
```

### Per-type layout

| type | id source | body file | extra artefacts |
|---|---|---|---|
| `article` | `slug(title)` | `content.md` | — |
| `youtube` | 11-char videoId | `transcript.md` (timestamped) | `thumbnails/cover.jpg` |
| `paper` | `arxiv-<id>` or `slug(filename)` | `body.md` (繁中 translation) | — (PDF lives in `workspace/learn/<session>/`) |
| `book` | `slug(title)` — user-entered at Start | `body.md` (regenerated concat) | `pages/001.md`, `002.md`, … (each with its own frontmatter) |
| `image` | `slug(title)` | `body.md` (gemini OCR) | `assets/image.<png\|jpg\|webp>` |
| `markdown` | `slug(title)` | `body.md` (verbatim) | — |

### Generators (one per lane)

| Source | Writer (Rust) | Trigger |
|---|---|---|
| chrome-ext / Article | `raw_bank::write_article` | `popup.js` Single mode → `/import` (`type:"article"`) |
| chrome-ext / YouTube | `raw_bank::write_youtube` | `popup.js` Single mode → `/import` (`type:"youtube"`) |
| chrome-ext / Book | `raw_bank::write_book` | `popup.js` Book mode + `floater.js` → `/import` (`type:"book"`) |
| PDF Learn | `raw_bank::init_paper_resource` + per-page mirror | `start_paper_session` + `translate_page` |
| Manual upload (md) | `raw_bank::write_markdown` | drop `.md` on Wiki Raw sidebar |
| Manual upload (img) | `raw_bank::write_image` + background gemini OCR | drop image on Wiki Raw sidebar |

### Quirks worth knowing

- **Body filename inconsistency** is legacy — `content.md` (article) and
  `transcript.md` (youtube) predate the unification. Newer types
  (paper, book, image, markdown) all use `body.md`. The reader's
  fallback list handles both. New writers should use `body.md`.
- **Append-on-existing only for books** — `write_book` counts existing
  files in `pages/` and appends from `N+1`, regenerates `body.md` from
  the full set, and preserves the original `captured_at`. Re-using the
  same book title resumes the same folder. All other writers
  overwrite (re-importing the same arxiv id reseeds; re-importing the
  same article slug clobbers).
- **`paper` type's body.md mirrors `notes.md`** — `start_paper_session`
  seeds `body.md` with a header; each `translate_page` upserts the
  `## Page N · <ts>` block in **both** files. Re-translation replaces
  the prior block in-place (drops legacy duplicates of the same N too).
- **Image type's body.md is async** — write returns immediately with a
  `_(OCR pending…)_` placeholder; gemini runs in a
  `tauri::async_runtime::spawn` task and rewrites body.md when done,
  re-emitting `raw:imported` for the wiki to refresh.
- **Book pages have per-page frontmatter** — `pages/NNN.md` starts with
  `---\npage: N\nsource_url: <captured-at-time URL>\n---` so the
  origin URL of each captured page survives the body.md regeneration.
- **博客來 is special** — `content/article.js` dispatches by host;
  `viewer-ebook.books.com.tw` reaches into `#UiObj-book-container`'s
  epub.js iframe (handles single + double-page modes, skips the
  hidden offscreen iframe), uses `#UiObj-header-title` +
  `#UiObj-footer-title` as the title, and synthesises a per-page
  `source_url` fragment (`#chapter·progress`) since the actual URL
  is constant across page-flips.

---

## Renderer state shape

`apps/shell-tauri/src/state/shellStore.ts` (Zustand):

| Slice | Keys |
|---|---|
| UI chrome | `mode`, `stage`, `density`, `activeRibbonTab`, `activeCenterTab`, `openTabIds`, `selectedItemId`, `activeAgentId` |
| Live pipeline | `session`, `items`, `agents`, `streamLog`, `dimensions`, `itemChecks`, `itemCode`, `itemOptions`, `sourceExcerpt` |
| Inputs status | `inputsReady`, `loadedMaterialFilename`, `loadedMaterialSourceCount`, `loadedDimensionCount`, `loadedGuidance` |
| Workflow progress | `geminiRunning`, `geminiStartedAt`, `regeneratingItemId`, `regenerateBatchRemaining`, `reviewSummary` |
| Warnings | `warnings` (capped at 40, dedup) |
| Learn (PDF) | `learn.{sessionId, sourceUrl, pdfPath, notesPath, currentPage, totalPages, streaming, captures, imported}` |

The renderer only touches state via store actions (the `_on*` mutators
called from `ipcBridge.ts`) — components are pure consumers.

---

## Visual design

Quiet Tech aesthetic — deep navy ground, cool-white text via opacity layers,
hairline borders, monospace for chrome (labels/badges/buttons), sans for
prose. No bright accents; functional colours are desaturated (verdict
stripes, green-ink for success, red for errors).

Two-tier tokens:

- `packages/ui/src/styles/primitives.css` — raw scales (navy 1000–600, cool-white RGB, opacity 04–92, blue/green/yellow/red mids).
- `packages/ui/src/styles/tokens.css` — semantic `--ulms-*` (canvas / canvas-2 / surface / ink / ink-2 / muted / faint / line / line-soft / line-strong / hover-bg / active-bg / blue / green / yellow / red and `-ink` / `-bg` variants).

All component CSS in `shell.css` references the semantic layer only.

---

## Dev commands

```sh
# install deps
npm install

# run Tauri shell (vite + cargo)
npm -w @ulms/shell-tauri run tauri:dev

# typecheck
npm -w @ulms/shell-tauri run typecheck
npm -w @ulms/ui run typecheck

# rust check
cd apps/shell-tauri/src-tauri && cargo check

# build MCP server
cd apps/mcp && cargo build --release

# storybook for @ulms/ui
npm -w @ulms/ui run storybook
```

First run creates `~/.ulms-config/token`. Spawn the local axum server with
`tauri::async_runtime::spawn` (called from `setup()` in `lib.rs:516`).

---

## Chrome extension wiring

1. Launch Tauri shell once → `~/.ulms-config/token` is populated.
2. `chrome://extensions/` → enable Developer mode → **Load unpacked** → pick `apps/chrome-ext/`.
3. Click ULMS icon → Settings → paste the token (`cat ~/.ulms-config/token`) → Save.
4. The connection dot turns green when `GET /health` succeeds against `http://127.0.0.1:9527`.

Endpoints (`apps/shell-tauri/src-tauri/src/ext_server.rs`):

- `GET /health` → `{ok, version}`
- `POST /import` (Bearer token) → routes by `type: "article" | "youtube"` to `raw_bank::write_*`, emits `raw:imported`.

Cookies (`credentials: 'include'`) are forwarded so YouTube caption fetches
hit on the user's session. CORS allows any origin (chrome-extension://… is
cross-origin to 127.0.0.1).

---

## Open work / phase-2 items

**Chrome extension polish**

- **YouTube frame snapshots** — pressing a button while the player is at time `t` should grab the current frame as a JPEG, append it to `~/.ulms-wiki/raw/youtube/<videoId>/snapshots/<HHMMSS>.jpg`, and add a reference line in `transcript.md`. Schema-wise this means promoting youtube from `thumbnails/cover.jpg` to a fuller `assets/` lane.
- **X (Twitter) thread extractor** — currently uses the generic article fallback, which captures only the visible OP tweet. Needs a dedicated walker over `[data-testid="tweet"]` that follows replies in the thread.
- **Medium paywall-aware fallback** — minimal extractor returns the teaser; could detect the paywall sentinel and surface a clearer error.
- **Auto page-turn detection (book lane)** — explored, dropped (per-site DOM detection too fragile to ship). If 博客來 + Readmoo + Hyread account for most use, hardcoded next-button click + MutationObserver could be revisited.

**Learn mode — become the unified reader**

Today only handles arxiv PDFs. Wiki RawViewer's *Go to Learn* button is a stub (`alert("coming next phase")`) until this lands. Intended scope:

- **Type-aware viewers** for every raw type — paper (PDF.js, in place), youtube (embedded player + transcript-side scroll), article / markdown / book (markdown reader), image (image viewer + OCR text).
- **Per-page output mode toggle** — for paper/image, the `TranslationPanel` should accept either **translate to 繁中** (current behaviour) or **extract to markdown** (gemini prompt change, no translation step). Output upserts into the raw resource's `body.md`.
- **Resume** — opening a raw resource that already has captures should rehydrate the panel from disk, mirroring the existing `resume_learn_session` flow.

**Quality + cross-cutting**

- **STT fallback** for YouTube videos without captions (yt-dlp + ffmpeg + Whisper).
- **Verdict reverse-write** — when a quiz run completes, push `quizzed_in` + `verdict_summary` back to the source raw resource's `meta.yaml` so the Wiki sidebar can show "used 3× in quizzes".
- **Body filename unification** — sweep `content.md` (article) and `transcript.md` (youtube) over to `body.md` so the reader doesn't need a fallback list. Backwards-compat read still has to keep the legacy names recognised.
- Remove the legacy `apps/shell/` Electron tree once the Tauri port is fully validated. Currently retained, frozen — no commits should touch it.
