// ULMS PDF reader — Tauri backend.
//
// Single-purpose: download an arxiv (or other) PDF, render pages in
// the renderer via PDF.js, hand each page back to gemini for 繁中
// translation. All storage lives in <wiki>/raw/papers/<paper-id>/.

mod paper;
mod translate;
mod wiki_dir;

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::paper::{LearnRuntime, PaperSummary, ResumeResp, SessionState};

pub struct AppState {
    pub runtime: Arc<LearnRuntime>,
}

#[derive(serde::Serialize)]
struct OkResp {
    ok: bool,
}

#[tauri::command]
async fn start_paper_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<SessionState, String> {
    let runtime = Arc::clone(&state.runtime);
    paper::start_paper_session(app, runtime, url).await
}

#[tauri::command]
async fn translate_page(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] pageNum: u32,
    #[allow(non_snake_case)] imageB64: String,
) -> Result<u32, String> {
    let runtime = Arc::clone(&state.runtime);
    translate::translate_page(app, runtime, pageNum, imageB64).await
}

#[tauri::command]
async fn stop_translation(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    translate::stop_translation(Arc::clone(&state.runtime)).await?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn close_paper_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OkResp, String> {
    paper::close_paper_session(app, Arc::clone(&state.runtime)).await?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn resume_paper_session(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] paperId: String,
) -> Result<ResumeResp, String> {
    paper::resume_paper_session(Arc::clone(&state.runtime), paperId).await
}

#[tauri::command]
async fn list_papers() -> Result<Vec<PaperSummary>, String> {
    Ok(paper::list_papers().await)
}

#[tauri::command]
async fn delete_paper(
    #[allow(non_snake_case)] paperId: String,
) -> Result<OkResp, String> {
    paper::delete_paper(paperId).await?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
fn get_wiki_dir() -> String {
    wiki_dir::resolve().to_string_lossy().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let runtime = Arc::new(LearnRuntime::default());
            app.manage(Arc::new(AppState { runtime }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_paper_session,
            translate_page,
            stop_translation,
            close_paper_session,
            resume_paper_session,
            list_papers,
            delete_paper,
            get_wiki_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
