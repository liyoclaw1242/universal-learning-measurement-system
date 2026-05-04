// ULMS wiki maintainer — Tauri backend.
//
// Three concurrent pieces, all coordinating through MaintainerState
// behind a Mutex:
//
//   1. claude session manager — spawns `claude --print
//      --output-format stream-json --add-dir <wiki>` with CLAUDE.md
//      on the prompt, parses stream-json, tracks tokens, restarts at
//      80% of the context budget.
//
//   2. poll loop — every POLL_INTERVAL, scans <wiki>/raw/<type>/*/
//      for resources not in <wiki>/.maintainer-state.json. New ones
//      are appended to a queue and dispatched to the claude session
//      one at a time.
//
//   3. log writer — appends `## [date] op | desc` lines to
//      <wiki>/log.md and emits maintainer:log events for the
//      renderer's live tail.

mod claude;
mod log_writer;
mod poll;
mod state;
mod wiki_dir;

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::claude::ClaudeSession;
use crate::poll::PollerHandle;
use crate::state::{LogEntry, MaintainerState, MaintainerStatus};

pub struct AppState {
    pub state: Arc<Mutex<MaintainerState>>,
    pub claude: Arc<Mutex<ClaudeSession>>,
    pub poller: Arc<PollerHandle>,
    pub app: AppHandle,
}

#[derive(Serialize)]
struct OkResp {
    ok: bool,
}

// ─── tauri commands ────────────────────────────────────────

#[tauri::command]
async fn maintainer_status(state: State<'_, Arc<AppState>>) -> Result<MaintainerStatus, String> {
    let s = state.state.lock().await;
    Ok(s.snapshot())
}

#[tauri::command]
async fn maintainer_recent_log(
    state: State<'_, Arc<AppState>>,
    limit: usize,
) -> Result<Vec<LogEntry>, String> {
    let s = state.state.lock().await;
    let n = s.recent_log.len();
    let take = limit.min(n);
    Ok(s.recent_log[n - take..].to_vec())
}

#[tauri::command]
async fn maintainer_ingest_now(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    state.poller.trigger_scan_now();
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn maintainer_lint_now(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    let app = state.app.clone();
    let st = Arc::clone(&state.state);
    let claude = Arc::clone(&state.claude);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = claude::run_lint(&app, &claude, &st).await {
            log_writer::log_error(&app, &st, "lint", &e).await;
        }
    });
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn maintainer_restart_session(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    let app = state.app.clone();
    let st = Arc::clone(&state.state);
    let claude = Arc::clone(&state.claude);
    tauri::async_runtime::spawn(async move {
        let mut g = claude.lock().await;
        if let Err(e) = g.restart(&app, &st, "manual restart").await {
            log_writer::log_error(&app, &st, "restart", &e).await;
        }
    });
    Ok(OkResp { ok: true })
}

// ─── entrypoint ────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let wiki_dir = match wiki_dir::resolve() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[maintainer] wiki dir resolve failed: {e}");
                    return Ok(()); // window still opens; UI shows the error
                }
            };
            eprintln!("[maintainer] wiki_dir = {}", wiki_dir.display());

            let state = Arc::new(Mutex::new(MaintainerState::new(wiki_dir.clone())));
            let claude = Arc::new(Mutex::new(ClaudeSession::new(wiki_dir.clone())));
            let poller = Arc::new(PollerHandle::default());

            let app_state = Arc::new(AppState {
                state: Arc::clone(&state),
                claude: Arc::clone(&claude),
                poller: Arc::clone(&poller),
                app: app.handle().clone(),
            });
            app.manage(Arc::clone(&app_state));

            // Seed page counts on startup.
            {
                let app_handle = app.handle().clone();
                let st_for_seed = Arc::clone(&state);
                tauri::async_runtime::spawn(async move {
                    {
                        let mut s = st_for_seed.lock().await;
                        s.refresh_counts().await;
                    }
                    let snap = st_for_seed.lock().await.snapshot();
                    let _ = app_handle.emit("maintainer:status", &snap);
                });
            }

            // Spawn poll loop.
            {
                let app_handle = app.handle().clone();
                let st = Arc::clone(&state);
                let cl = Arc::clone(&claude);
                let pl = Arc::clone(&poller);
                tauri::async_runtime::spawn(async move {
                    poll::run_poll_loop(app_handle, st, cl, pl).await;
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            maintainer_status,
            maintainer_recent_log,
            maintainer_ingest_now,
            maintainer_lint_now,
            maintainer_restart_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
