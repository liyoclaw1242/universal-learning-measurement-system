// Per-item regeneration — Rust port of
// apps/shell/electron/coordinator/regenerate.ts.
//
// User rejects an item → re-run agent-3 for ONE slot only, then splice
// the new item back into the original blackboard. Reviewers don't re-run
// here; user re-triggers Gemini second-opinion separately.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::blackboard::{read_blackboard, write_blackboard};
use crate::types::Blackboard;
use crate::workflow::{spawn_agent, WorkflowRuntime};

#[derive(Default)]
pub struct RegenerateRuntime {
    pub current_item_id: Mutex<Option<String>>,
    pub batch_running: AtomicBool,
}

impl RegenerateRuntime {
    pub async fn is_busy(&self) -> bool {
        self.current_item_id.lock().await.is_some()
            || self.batch_running.load(Ordering::SeqCst)
    }
}

// ─── single-item regeneration ───────────────────────────────

pub async fn regenerate_item(
    app: AppHandle,
    workspace_dir: PathBuf,
    item_id: String,
    workflow_runtime: Arc<WorkflowRuntime>,
    regen_runtime: Arc<RegenerateRuntime>,
) {
    let result = regenerate_item_inner(
        &app,
        &workspace_dir,
        &item_id,
        &workflow_runtime,
        &regen_runtime,
    )
    .await;
    if let Err(e) = result {
        let _ = app.emit(
            "regenerate:error",
            json!({ "item_id": item_id, "error": e }),
        );
    }
}

async fn regenerate_item_inner(
    app: &AppHandle,
    workspace_dir: &Path,
    item_id: &str,
    workflow_runtime: &Arc<WorkflowRuntime>,
    regen_runtime: &Arc<RegenerateRuntime>,
) -> Result<(), String> {
    {
        let mut g = regen_runtime.current_item_id.lock().await;
        if g.is_some() {
            return Err("another item is already being regenerated".into());
        }
        *g = Some(item_id.to_string());
    }
    let blackboard_path = workspace_dir.join("blackboard.json");

    let result = run_regenerate(
        app,
        &blackboard_path,
        workspace_dir,
        item_id,
        workflow_runtime,
    )
    .await;

    {
        let mut g = regen_runtime.current_item_id.lock().await;
        *g = None;
    }
    result
}

async fn run_regenerate(
    app: &AppHandle,
    blackboard_path: &Path,
    workspace_dir: &Path,
    item_id: &str,
    workflow_runtime: &Arc<WorkflowRuntime>,
) -> Result<(), String> {
    let original = read_blackboard(blackboard_path)
        .await
        .ok_or_else(|| "blackboard.json not readable".to_string())?;
    let original_items = original
        .data
        .items
        .clone()
        .ok_or_else(|| "no items present".to_string())?;
    let item_idx = original_items
        .iter()
        .position(|it| it.get("item_id").and_then(|v| v.as_str()) == Some(item_id))
        .ok_or_else(|| format!("item {item_id} not found"))?;
    let target_slot_index = original_items[item_idx]
        .get("slot_index")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("item {item_id} has no slot_index"))?;

    let original_mapping = original.data.mapping.clone().unwrap_or_default();
    let original_blueprint = original_mapping
        .get("blueprint")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let slot_spec = original_blueprint
        .get("slot_specs")
        .and_then(|v| v.as_array())
        .and_then(|specs| {
            specs.iter().find(|s| {
                s.get("slot_index").and_then(|v| v.as_i64()) == Some(target_slot_index)
            })
        })
        .cloned()
        .ok_or_else(|| format!("slot_spec for slot_index {target_slot_index} not found"))?;

    let _ = app.emit("regenerate:started", json!({ "item_id": item_id }));

    // Build reduced blackboard: same user_input + KUs but only ONE slot.
    let mut reduced: Blackboard = original.clone();
    reduced.workflow.current_step = 2;
    reduced.workflow.status = crate::types::WorkflowStatus::Pending;
    reduced.data.items = None;
    reduced.data.review = None;

    let mut reduced_blueprint = original_blueprint.clone();
    if let Value::Object(map) = &mut reduced_blueprint {
        map.insert("total_slots".into(), json!(1));
        map.insert("slot_specs".into(), json!([slot_spec]));
    }
    let mut reduced_mapping = original_mapping.clone();
    reduced_mapping.insert("blueprint".into(), reduced_blueprint);
    reduced.data.mapping = Some(reduced_mapping);

    write_blackboard(blackboard_path, &reduced).await?;

    let result = spawn_agent(app, "agent_3", workspace_dir, workflow_runtime).await?;

    // Read back; expect exactly one new item.
    let post = read_blackboard(blackboard_path)
        .await
        .ok_or_else(|| "blackboard missing after agent-3".to_string())?;
    let new_items = post.data.items.unwrap_or_default();
    if new_items.is_empty() {
        return Err("agent-3 produced no item".into());
    }
    let mut new_item = new_items.into_iter().next().unwrap();
    if let Value::Object(map) = &mut new_item {
        map.insert("item_id".into(), json!(item_id));
        map.insert("slot_index".into(), json!(target_slot_index));
        map.remove("user_override");
    }

    // Restore original blackboard with the new item swapped in.
    let mut restored: Blackboard = original.clone();
    let mut items: Vec<Value> = original_items.clone();
    items[item_idx] = new_item;
    restored.data.items = Some(items);
    restored.data.mapping = original.data.mapping.clone();
    restored.data.review = None;

    // Drop stale review entries for the regenerated item.
    drop_review_entry(&mut restored.data.review_claude, item_id);
    drop_review_entry(&mut restored.data.review_gemini, item_id);
    drop_review_entry(&mut restored.data.review_merged, item_id);

    // Cost: accrue into a dedicated "regenerate" bucket.
    let prior = restored
        .costs
        .by_agent
        .get("regenerate")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let added = result.as_ref().and_then(|r| r.total_cost_usd).unwrap_or(0.0);
    restored
        .costs
        .by_agent
        .insert("regenerate".to_string(), json!(prior + added));
    restored.costs.total_usd = restored
        .costs
        .by_agent
        .values()
        .filter_map(|v| v.as_f64())
        .sum();

    write_blackboard(blackboard_path, &restored).await?;
    let _ = app.emit("board:updated", json!({ "board": &restored }));
    let _ = app.emit(
        "regenerate:completed",
        json!({
            "item_id": item_id,
            "cost_usd": added,
            "duration_ms": result.as_ref().and_then(|r| r.duration_ms).unwrap_or(0),
        }),
    );
    Ok(())
}

fn drop_review_entry(
    block: &mut Option<std::collections::HashMap<String, Value>>,
    item_id: &str,
) {
    let Some(map) = block else { return };
    if let Some(per_item) = map.get_mut("per_item") {
        if let Some(arr) = per_item.as_array_mut() {
            arr.retain(|x| x.get("item_id").and_then(|v| v.as_str()) != Some(item_id));
        }
    }
}

// ─── batch regeneration of all rejected items ──────────────

pub async fn regenerate_rejected(
    app: AppHandle,
    workspace_dir: PathBuf,
    workflow_runtime: Arc<WorkflowRuntime>,
    regen_runtime: Arc<RegenerateRuntime>,
) {
    if regen_runtime.batch_running.swap(true, Ordering::SeqCst) {
        let _ = app.emit(
            "regenerate:error",
            json!({ "item_id": "", "error": "batch already running" }),
        );
        return;
    }
    let result = run_batch(&app, &workspace_dir, &workflow_runtime, &regen_runtime).await;
    regen_runtime.batch_running.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        let _ = app.emit(
            "regenerate:error",
            json!({ "item_id": "", "error": e }),
        );
    }
}

async fn run_batch(
    app: &AppHandle,
    workspace_dir: &Path,
    workflow_runtime: &Arc<WorkflowRuntime>,
    regen_runtime: &Arc<RegenerateRuntime>,
) -> Result<(), String> {
    let blackboard_path = workspace_dir.join("blackboard.json");
    let snap = read_blackboard(&blackboard_path)
        .await
        .ok_or_else(|| "blackboard.json not readable".to_string())?;
    let items = snap.data.items.unwrap_or_default();
    let rejected_ids: Vec<String> = items
        .iter()
        .filter(|it| {
            it.get("user_override").and_then(|v| v.as_str()) == Some("reject")
        })
        .filter_map(|it| {
            it.get("item_id").and_then(|v| v.as_str()).map(|s| s.to_string())
        })
        .collect();

    if rejected_ids.is_empty() {
        let _ = app.emit(
            "regenerate-batch:completed",
            json!({ "count": 0, "regenerated": [] }),
        );
        return Ok(());
    }

    let _ = app.emit(
        "regenerate-batch:started",
        json!({ "item_ids": &rejected_ids }),
    );

    let mut completed: Vec<String> = Vec::new();
    let total = rejected_ids.len();
    for id in rejected_ids {
        match regenerate_item_inner(
            app,
            workspace_dir,
            &id,
            workflow_runtime,
            regen_runtime,
        )
        .await
        {
            Ok(()) => {
                completed.push(id.clone());
                let _ = app.emit(
                    "regenerate-batch:item-done",
                    json!({
                        "item_id": id,
                        "remaining": total - completed.len(),
                    }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "regenerate:error",
                    json!({ "item_id": id, "error": e }),
                );
            }
        }
    }

    let _ = app.emit(
        "regenerate-batch:completed",
        json!({
            "count": completed.len(),
            "regenerated": completed,
        }),
    );
    Ok(())
}
