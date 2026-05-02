// ULMS Tauri shell — phase 2 (types + blackboard wired).
//
// All 14 IPC commands are registered. Implementations land in phases:
//   ✓ 2. read_board — real disk read; types ported
//     3. pick_*, inputs_status — file dialog + fs (next)
//     4. start/stop_workflow — claude CLI spawn
//     5. second_opinion / regenerate / overrides / export

mod blackboard;
mod export;
mod gemini;
mod inputs;
mod learn;
mod overrides;
mod regenerate;
mod types;
mod workflow;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::export::ExportResp;
use crate::gemini::GeminiRuntime;
use crate::inputs::PickResp;
use crate::learn::{LearnRuntime, SessionState};
use crate::overrides::OverrideResp;
use crate::regenerate::RegenerateRuntime;
use crate::types::{Blackboard, MaterialInput, StagedInputs};
use crate::workflow::WorkflowRuntime;

// ─── shared state ───────────────────────────────────────────

/// Resolves the workspace dir (where blackboard.json + .claude/skills/
/// live). Override via ULMS_WORKSPACE_DIR; default points at the
/// existing apps/shell/workspace so the Tauri shell shares state with
/// the Electron shell during the migration.
fn resolve_workspace_dir() -> PathBuf {
    let raw = if let Ok(d) = std::env::var("ULMS_WORKSPACE_DIR") {
        PathBuf::from(d)
    } else {
        let manifest = env!("CARGO_MANIFEST_DIR");
        PathBuf::from(manifest)
            .join("..")
            .join("..")
            .join("shell")
            .join("workspace")
    };
    // Canonicalize so downstream paths don't contain `..` segments —
    // the Tauri asset protocol scope matcher rejects URLs with `..`.
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

struct AppState {
    workspace_dir: PathBuf,
    staged: Mutex<StagedInputs>,
    workflow: Arc<WorkflowRuntime>,
    gemini: Arc<GeminiRuntime>,
    regen: Arc<RegenerateRuntime>,
    learn: Arc<LearnRuntime>,
}

impl AppState {
    fn blackboard_path(&self) -> PathBuf {
        self.workspace_dir.join("blackboard.json")
    }
}

// ─── shared response shapes ─────────────────────────────────

#[derive(Serialize)]
struct OkResp {
    ok: bool,
}

#[derive(Serialize)]
struct MaterialStatus {
    filename: String,
    char_count: usize,
    source_count: usize,
    sources: Vec<Value>,
}

#[derive(Serialize)]
struct DimensionsStatus {
    count: usize,
    ids: Vec<String>,
}

#[derive(Serialize)]
struct GuidanceStatus {
    char_count: usize,
}

#[derive(Serialize)]
struct InputsStatusResp {
    material: Option<MaterialStatus>,
    dimensions: Option<DimensionsStatus>,
    guidance: Option<GuidanceStatus>,
    assessment_params: Option<Value>,
    ready: bool,
}

// ─── inputs ─────────────────────────────────────────────────

#[tauri::command]
async fn inputs_status(state: State<'_, Arc<AppState>>) -> Result<InputsStatusResp, String> {
    let staged = state.staged.lock().await;
    let material = staged.material.as_ref().map(|m| MaterialStatus {
        filename: m.filename.clone(),
        char_count: m.content.chars().count(),
        source_count: m.sources.as_ref().map(|s| s.len()).unwrap_or(1),
        sources: m
            .sources
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
            .collect(),
    });
    let dimensions = staged.dimensions.as_ref().map(|d| DimensionsStatus {
        count: d.len(),
        ids: d.iter().map(|x| x.dim_id.clone()).collect(),
    });
    let guidance = staged.domain_guidance.as_ref().map(|g| GuidanceStatus {
        char_count: g.chars().count(),
    });
    let ready = material.is_some() && dimensions.as_ref().map(|d| d.count > 0).unwrap_or(false);
    let assessment_params = staged
        .assessment_params
        .as_ref()
        .map(|p| serde_json::to_value(p).unwrap_or(Value::Null));
    Ok(InputsStatusResp {
        material,
        dimensions,
        guidance,
        assessment_params,
        ready,
    })
}

#[tauri::command]
async fn pick_material(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PickResp, String> {
    let workspace = state.workspace_dir.clone();
    let mut staged = state.staged.lock().await;
    Ok(inputs::run_pick_material(app, &workspace, &mut staged).await)
}

#[tauri::command]
async fn pick_dimensions(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PickResp, String> {
    let workspace = state.workspace_dir.clone();
    let mut staged = state.staged.lock().await;
    Ok(inputs::run_pick_dimensions(app, &workspace, &mut staged).await)
}

#[tauri::command]
async fn pick_guidance(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PickResp, String> {
    let workspace = state.workspace_dir.clone();
    let mut staged = state.staged.lock().await;
    Ok(inputs::run_pick_guidance(app, &workspace, &mut staged).await)
}

#[tauri::command]
async fn clear_guidance(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    let mut staged = state.staged.lock().await;
    staged.domain_guidance = None;
    Ok(OkResp { ok: true })
}

// ─── workflow ───────────────────────────────────────────────

#[tauri::command]
async fn start_workflow(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OkResp, String> {
    if state.workflow.running.load(Ordering::SeqCst) {
        return Err("workflow already running".into());
    }
    let workspace = state.workspace_dir.clone();
    let runtime = Arc::clone(&state.workflow);
    // Snapshot staged inputs so the spawned task doesn't need to hold
    // the lock for the entire run.
    let staged_snapshot = state.staged.lock().await.clone();
    tokio::spawn(workflow::run_workflow(
        app,
        workspace,
        runtime,
        staged_snapshot,
    ));
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn stop_workflow(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    state.workflow.request_stop().await;
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn read_board(state: State<'_, Arc<AppState>>) -> Result<Option<Blackboard>, String> {
    Ok(blackboard::read_blackboard(&state.blackboard_path()).await)
}

// ─── second opinion ─────────────────────────────────────────

#[tauri::command]
async fn start_second_opinion(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OkResp, String> {
    if state.gemini.running.load(Ordering::SeqCst) {
        return Err("already running".into());
    }
    let workspace = state.workspace_dir.clone();
    let runtime = Arc::clone(&state.gemini);
    tokio::spawn(gemini::run_second_opinion(app, workspace, runtime));
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn stop_second_opinion(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    state.gemini.request_stop().await;
    Ok(OkResp { ok: true })
}

// ─── overrides / export / regenerate ───────────────────────

#[tauri::command]
async fn apply_item_override(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] itemId: String,
    r#override: Option<String>,
) -> Result<OverrideResp, String> {
    Ok(overrides::apply_item_override(
        &app,
        &state.workspace_dir,
        &itemId,
        r#override.as_deref(),
    )
    .await)
}

#[tauri::command]
async fn export_items(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<ExportResp, String> {
    Ok(export::run_export(app, &state.workspace_dir).await)
}

#[tauri::command]
async fn regenerate_item(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] itemId: String,
) -> Result<OkResp, String> {
    if state.regen.is_busy().await {
        return Err("another regeneration in progress".into());
    }
    let workspace = state.workspace_dir.clone();
    let workflow_runtime = Arc::clone(&state.workflow);
    let regen_runtime = Arc::clone(&state.regen);
    tokio::spawn(regenerate::regenerate_item(
        app,
        workspace,
        itemId,
        workflow_runtime,
        regen_runtime,
    ));
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn regenerate_rejected(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OkResp, String> {
    if state.regen.is_busy().await {
        return Err("another regeneration in progress".into());
    }
    let workspace = state.workspace_dir.clone();
    let workflow_runtime = Arc::clone(&state.workflow);
    let regen_runtime = Arc::clone(&state.regen);
    tokio::spawn(regenerate::regenerate_rejected(
        app,
        workspace,
        workflow_runtime,
        regen_runtime,
    ));
    Ok(OkResp { ok: true })
}

// ─── learn (PDF + per-page translation) ────────────────────

#[tauri::command]
async fn start_paper_session(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<SessionState, String> {
    let workspace = state.workspace_dir.clone();
    let runtime = Arc::clone(&state.learn);
    learn::start_paper_session(workspace, runtime, url).await
}

#[tauri::command]
async fn translate_page(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] pageNum: u32,
    #[allow(non_snake_case)] imageB64: String,
) -> Result<u32, String> {
    let workspace = state.workspace_dir.clone();
    let runtime = Arc::clone(&state.learn);
    learn::translate_page(app, workspace, runtime, pageNum, imageB64).await
}

#[tauri::command]
async fn stop_translation(state: State<'_, Arc<AppState>>) -> Result<OkResp, String> {
    state.learn.request_stop().await;
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn close_paper_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OkResp, String> {
    let runtime = Arc::clone(&state.learn);
    learn::close_paper_session(app, runtime).await?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn import_translation_as_material(
    state: State<'_, Arc<AppState>>,
) -> Result<MaterialInput, String> {
    let workspace = state.workspace_dir.clone();
    let runtime = Arc::clone(&state.learn);
    learn::import_as_material(workspace, runtime, &state.staged).await
}

// ─── entry point ────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let workspace_dir = resolve_workspace_dir();
            eprintln!("[ulms] workspace_dir = {}", workspace_dir.display());
            app.manage(Arc::new(AppState {
                workspace_dir,
                staged: Mutex::new(StagedInputs::default()),
                workflow: Arc::new(WorkflowRuntime::default()),
                gemini: Arc::new(GeminiRuntime::default()),
                regen: Arc::new(RegenerateRuntime::default()),
                learn: Arc::new(LearnRuntime::default()),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inputs_status,
            pick_material,
            pick_dimensions,
            pick_guidance,
            clear_guidance,
            start_workflow,
            stop_workflow,
            read_board,
            start_second_opinion,
            stop_second_opinion,
            apply_item_override,
            export_items,
            regenerate_item,
            regenerate_rejected,
            start_paper_session,
            translate_page,
            stop_translation,
            close_paper_session,
            import_translation_as_material,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
