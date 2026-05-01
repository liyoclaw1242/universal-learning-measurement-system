// Export finalised review as Markdown + JSON — Rust port of
// apps/shell/electron/coordinator/export.ts.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::fs;

use crate::blackboard::read_blackboard;
use crate::types::Blackboard;

#[derive(Serialize)]
pub struct ExportResp {
    pub ok: bool,
    pub error: Option<String>,
    pub paths: Option<Vec<String>>,
}

fn index_review(r: Option<&Value>) -> std::collections::HashMap<String, &Value> {
    let mut out = std::collections::HashMap::new();
    if let Some(per_item) = r.and_then(|v| v.get("per_item")).and_then(|v| v.as_array()) {
        for it in per_item {
            if let Some(id) = it.get("item_id").and_then(|v| v.as_str()) {
                out.insert(id.to_string(), it);
            }
        }
    }
    out
}

fn render_markdown(board: &Blackboard) -> String {
    let mut lines: Vec<String> = Vec::new();
    let empty: Vec<Value> = Vec::new();
    let items: &Vec<Value> = board.data.items.as_ref().unwrap_or(&empty);
    let rc_v = board.data.review_claude.as_ref().map(|m| serde_json::to_value(m).unwrap_or(Value::Null));
    let rg_v = board.data.review_gemini.as_ref().map(|m| serde_json::to_value(m).unwrap_or(Value::Null));
    let merged = board.data.review_merged.as_ref();
    let rc = index_review(rc_v.as_ref());
    let rg = index_review(rg_v.as_ref());

    let material_filename = board
        .user_input
        .material
        .as_ref()
        .map(|m| m.filename.clone())
        .unwrap_or_else(|| "—".into());
    lines.push(format!("# ULMS Exam · {material_filename}"));
    lines.push(String::new());
    lines.push(format!(
        "- Generated: {}",
        chrono_iso8601(std::time::SystemTime::now())
    ));
    lines.push(format!("- Items: {}", items.len()));
    lines.push(format!("- Cost: ${:.4}", board.costs.total_usd));

    if let Some(merged_map) = merged {
        if let Some(summary) = merged_map.get("summary") {
            let agree_rate = summary
                .get("verdict_agreement_rate")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            lines.push(format!(
                "- Dual-reviewer agreement: {}%",
                (agree_rate * 100.0).round() as i64
            ));
            let counts = summary
                .get("merged_verdict_counts")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            let accept = counts.get("accept").and_then(|v| v.as_i64()).unwrap_or(0);
            let needs = counts
                .get("needs_revision")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let reject = counts.get("reject").and_then(|v| v.as_i64()).unwrap_or(0);
            lines.push(format!(
                "- Merged verdicts: accept {accept} · needs_revision {needs} · reject {reject}"
            ));
        }
    }
    lines.push(String::new());

    for it in items.iter() {
        let id = it.get("item_id").and_then(|v| v.as_str()).unwrap_or("?");
        let merged_per_item = merged
            .and_then(|m| m.get("per_item"))
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|x| x.get("item_id").and_then(|v| v.as_str()) == Some(id))
            });
        let final_verdict = merged_per_item
            .and_then(|x| x.get("verdict").and_then(|v| v.as_str()))
            .or_else(|| rc.get(id).and_then(|x| x.get("verdict").and_then(|v| v.as_str())))
            .unwrap_or("—");
        let user_override = it.get("user_override").and_then(|v| v.as_str());
        let override_part = user_override
            .map(|o| format!(" · user: {o}"))
            .unwrap_or_default();
        lines.push(format!("## {id} · {final_verdict}{override_part}"));
        lines.push(String::new());
        if let Some(t) = it.get("core").and_then(|v| v.get("item_type")).and_then(|v| v.as_str()) {
            lines.push(format!("_type_: `{t}`"));
        }
        if let Some(d) = it
            .get("measurement")
            .and_then(|v| v.get("difficulty_estimate"))
            .and_then(|v| v.as_f64())
        {
            lines.push(format!("_difficulty_: {d:.2}"));
        }
        lines.push(String::new());
        if let Some(s) = it.get("core").and_then(|v| v.get("stem")).and_then(|v| v.as_str()) {
            lines.push(s.to_string());
            lines.push(String::new());
        }
        if let Some(opts) = it
            .get("core")
            .and_then(|v| v.get("options"))
            .and_then(|v| v.as_array())
        {
            for o in opts {
                if let Some(s) = o.as_str() {
                    lines.push(format!("- {s}"));
                }
            }
            if !opts.is_empty() {
                lines.push(String::new());
            }
        }
        if let Some(ans) = it.get("core").and_then(|v| v.get("answer")) {
            if !ans.is_null() {
                lines.push(format!("**Answer:** `{}`", ans));
                lines.push(String::new());
            }
        }
        if let Some(exp) = it
            .get("core")
            .and_then(|v| v.get("explanation"))
            .and_then(|v| v.as_str())
        {
            lines.push(format!("**Explanation:** {exp}"));
            lines.push(String::new());
        }
        let cqs = rc
            .get(id)
            .and_then(|x| x.get("overall_quality_score"))
            .and_then(|v| v.as_f64());
        let gqs = rg
            .get(id)
            .and_then(|x| x.get("overall_quality_score"))
            .and_then(|v| v.as_f64());
        if cqs.is_some() || gqs.is_some() {
            let c_str = cqs
                .map(|v| format!("{v}"))
                .unwrap_or_else(|| "—".to_string());
            let g_str = gqs
                .map(|v| format!("{v}"))
                .unwrap_or_else(|| "—".to_string());
            lines.push(format!("Reviewer quality — C: {c_str} · G: {g_str}"));
            lines.push(String::new());
        }
        lines.push("---".into());
        lines.push(String::new());
    }
    lines.join("\n")
}

fn chrono_iso8601(t: std::time::SystemTime) -> String {
    // Avoid pulling in chrono just for this — emit naive UTC ISO-8601
    // by hand using SystemTime epoch seconds.
    let dur = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    // days since epoch + remainder
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    // y/m/d via the algorithm from "Astronomical Algorithms"
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mth, d, h, m, s)
}

pub async fn run_export(app: AppHandle, workspace_dir: &Path) -> ExportResp {
    let blackboard_path = workspace_dir.join("blackboard.json");
    let Some(board) = read_blackboard(&blackboard_path).await else {
        return ExportResp {
            ok: false,
            error: Some("blackboard.json not readable".into()),
            paths: None,
        };
    };
    let item_count = board.data.items.as_ref().map(|v| v.len()).unwrap_or(0);
    if item_count == 0 {
        return ExportResp {
            ok: false,
            error: Some("no items to export".into()),
            paths: None,
        };
    }

    let default_name = format!(
        "ulms-export-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let app_clone = app.clone();
    let picked: Option<FilePath> = match tokio::task::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .set_file_name(&default_name)
            .set_title("Export items (base filename; .md + .json will be written)")
            .blocking_save_file()
    })
    .await
    {
        Ok(p) => p,
        Err(e) => {
            return ExportResp {
                ok: false,
                error: Some(format!("dialog spawn failed: {e}")),
                paths: None,
            };
        }
    };

    let Some(file_path) = picked.and_then(|fp| fp.into_path().ok()) else {
        return ExportResp {
            ok: false,
            error: Some("canceled".into()),
            paths: None,
        };
    };

    let base = strip_export_ext(&file_path);
    let md_path = with_extension(&base, "md");
    let json_path = with_extension(&base, "json");

    let md = render_markdown(&board);
    if let Err(e) = fs::write(&md_path, &md).await {
        return ExportResp {
            ok: false,
            error: Some(format!("write {}: {e}", md_path.display())),
            paths: None,
        };
    }
    let json_str = match serde_json::to_string_pretty(&board) {
        Ok(s) => s,
        Err(e) => {
            return ExportResp {
                ok: false,
                error: Some(format!("serialize: {e}")),
                paths: None,
            };
        }
    };
    if let Err(e) = fs::write(&json_path, &json_str).await {
        return ExportResp {
            ok: false,
            error: Some(format!("write {}: {e}", json_path.display())),
            paths: None,
        };
    }

    ExportResp {
        ok: true,
        error: None,
        paths: Some(vec![
            md_path.to_string_lossy().into_owned(),
            json_path.to_string_lossy().into_owned(),
        ]),
    }
}

fn strip_export_ext(p: &Path) -> std::path::PathBuf {
    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if lower == "md" || lower == "json" {
            return p.with_extension("");
        }
    }
    p.to_path_buf()
}

fn with_extension(p: &Path, ext: &str) -> std::path::PathBuf {
    let mut s = p.to_path_buf();
    s.set_extension(ext);
    s
}
