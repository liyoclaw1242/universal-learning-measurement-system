# ULMS Learn — Chrome extension

Captures the current tab (YouTube watch page or any article) and POSTs
it to the local ULMS Tauri shell as a learning resource.

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → pick this `apps/chrome-ext/` directory
4. The puzzle-piece icon appears in the toolbar; pin it for easy access.

## First-time setup

1. Launch the ULMS Tauri app (`pnpm tauri:dev` from `apps/shell-tauri/`)
2. In the app's Home tab, copy the extension token (see Home → MCP /
   ext settings panel — exposed via the `get_ext_token` Tauri command).
3. Open the extension popup → Settings → paste the token → Save.
4. The connection dot turns green.

## Usage

- Open any YouTube `watch` page or article URL.
- Click the ULMS extension icon → **Send to ULMS**.
- The popup shows `✓ saved as <type>/<id>`; the Tauri Home recents
  refresh automatically.

## What gets captured

- **YouTube**: video id, title, channel, duration, English/first
  available caption track parsed into timestamped markdown, and the
  high-res cover thumbnail.
- **Articles**: minimal markdown extraction (h1-h6, p, ul/ol,
  blockquote, pre) from the dominant content node (`<article>` /
  `<main>` / fallback body), with nav / aside / ads dropped. og:title
  and author meta read where available.

## Limits / TODO

- No STT fallback when a YouTube video has no captions (Phase E in
  the project plan).
- No X (Twitter) thread or 博客來 specific extractor yet (Phase D).
- Token rotation: edit the file at `~/.ulms-config/token` and update
  the popup setting; no UI for it yet.
- Markdown extractor for articles is intentionally minimal; swap to
  Mozilla Readability later if quality matters.
