// ULMS Tauri shell — Phase 1 stubs.
//
// All 14 IPC commands are registered so the renderer can boot without
// "command not found" errors. Return shapes match the Electron
// coordinator's contracts (see apps/shell/electron/coordinator/) so the
// UI translates correctly even with empty / placeholder data.
//
// Phases 2–5 will replace each stub with the real implementation:
//   2. inputs_status / read_board    (types + blackboard)
//   3. pick_*                        (tauri-plugin-dialog + fs)
//   4. start/stop_workflow           (claude CLI spawn)
//   5. second_opinion / regenerate / overrides / export

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

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
async fn inputs_status() -> Result<InputsStatusResp, String> {
    Ok(InputsStatusResp {
        material: None,
        dimensions: None,
        guidance: None,
        assessment_params: None,
        ready: false,
    })
}

#[tauri::command]
async fn pick_material() -> Result<OkResp, String> {
    Err("pick_material not yet implemented (Phase 3)".into())
}

#[tauri::command]
async fn pick_dimensions() -> Result<OkResp, String> {
    Err("pick_dimensions not yet implemented (Phase 3)".into())
}

#[tauri::command]
async fn pick_guidance() -> Result<OkResp, String> {
    Err("pick_guidance not yet implemented (Phase 3)".into())
}

#[tauri::command]
async fn clear_guidance() -> Result<OkResp, String> {
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
async fn read_board() -> Result<Option<Value>, String> {
    Ok(None)
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
    #[allow(non_snake_case)] r#override: Option<String>,
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
        .setup(|app| {
            let _ = app;
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
