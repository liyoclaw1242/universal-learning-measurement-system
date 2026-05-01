// User-override persistence — Rust port of
// apps/shell/electron/coordinator/overrides.ts.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::blackboard::{read_blackboard, write_blackboard};

#[derive(Serialize)]
pub struct OverrideResp {
    pub ok: bool,
    pub error: Option<String>,
}

pub async fn apply_item_override(
    app: &AppHandle,
    workspace_dir: &Path,
    item_id: &str,
    override_value: Option<&str>,
) -> OverrideResp {
    let blackboard_path = workspace_dir.join("blackboard.json");
    let Some(mut board) = read_blackboard(&blackboard_path).await else {
        return OverrideResp {
            ok: false,
            error: Some("blackboard.json not readable".into()),
        };
    };
    let Some(items) = board.data.items.as_mut() else {
        return OverrideResp {
            ok: false,
            error: Some("no items to override".into()),
        };
    };

    let mut found = false;
    let new_value: Value = match override_value {
        Some(v) => json!(v),
        None => Value::Null,
    };
    for raw in items.iter_mut() {
        if raw
            .get("item_id")
            .and_then(|v| v.as_str())
            .map(|s| s == item_id)
            .unwrap_or(false)
        {
            if let Value::Object(map) = raw {
                map.insert("user_override".into(), new_value.clone());
                found = true;
            }
        }
    }
    if !found {
        return OverrideResp {
            ok: false,
            error: Some(format!("item {item_id} not found")),
        };
    }
    if let Err(e) = write_blackboard(&blackboard_path, &board).await {
        return OverrideResp {
            ok: false,
            error: Some(e),
        };
    }
    let _ = app.emit("board:updated", json!({ "board": &board }));
    OverrideResp {
        ok: true,
        error: None,
    }
}
