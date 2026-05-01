// ULMS Tauri shell — phase 2 (types + blackboard wired).
//
// All 14 IPC commands are registered. Implementations land in phases:
//   ✓ 2. read_board — real disk read; types ported
//     3. pick_*, inputs_status — file dialog + fs (next)
//     4. start/stop_workflow — claude CLI spawn
//     5. second_opinion / regenerate / overrides / export

mod blackboard;
mod inputs;
mod types;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::inputs::PickResp;
use crate::types::{Blackboard, StagedInputs};

// ─── shared state ───────────────────────────────────────────

/// Resolves the workspace dir (where blackboard.json + .claude/skills/
/// live). Override via ULMS_WORKSPACE_DIR; default points at the
/// existing apps/shell/workspace so the Tauri shell shares state with
/// the Electron shell during the migration.
fn resolve_workspace_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ULMS_WORKSPACE_DIR") {
        return PathBuf::from(d);
    }
    let manifest = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest)
        .join("..")
        .join("..")
        .join("shell")
        .join("workspace")
}

struct AppState {
    workspace_dir: PathBuf,
    staged: Mutex<StagedInputs>,
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
struct ExportResp {
    ok: bool,
    error: Option<String>,
    paths: Option<Vec<String>>,
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
async fn start_workflow(app: AppHandle) -> Result<OkResp, String> {
    let _ = app;
    Err("start_workflow not yet implemented (Phase 4)".into())
}

#[tauri::command]
async fn stop_workflow() -> Result<OkResp, String> {
    Ok(OkResp { ok: true })
}

#[tauri::command]
async fn read_board(state: State<'_, Arc<AppState>>) -> Result<Option<Blackboard>, String> {
    Ok(blackboard::read_blackboard(&state.blackboard_path()).await)
}

// ─── second opinion ─────────────────────────────────────────

#[tauri::command]
async fn start_second_opinion(app: AppHandle) -> Result<OkResp, String> {
    let _ = app;
    Err("start_second_opinion not yet implemented (Phase 5)".into())
}

#[tauri::command]
async fn stop_second_opinion() -> Result<OkResp, String> {
    Ok(OkResp { ok: true })
}

// ─── overrides / export / regenerate ───────────────────────

#[tauri::command]
async fn apply_item_override(
    item_id: String,
    r#override: Option<String>,
) -> Result<OkResp, String> {
    let _ = (item_id, r#override);
    Err("apply_item_override not yet implemented (Phase 5)".into())
}

#[tauri::command]
async fn export_items() -> Result<ExportResp, String> {
    Ok(ExportResp {
        ok: false,
        error: Some("export_items not yet implemented (Phase 5)".into()),
        paths: None,
    })
}

#[tauri::command]
async fn regenerate_item(item_id: String) -> Result<OkResp, String> {
    let _ = item_id;
    Err("regenerate_item not yet implemented (Phase 5)".into())
}

#[tauri::command]
async fn regenerate_rejected() -> Result<OkResp, String> {
    Err("regenerate_rejected not yet implemented (Phase 5)".into())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
