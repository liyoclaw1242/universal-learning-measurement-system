// Snapshot a completed Quiz run into workspace/runs/<timestamp>-<slug>/.
// This is the "raw" layer of the knowledge base — append-only, never
// mutated. The wiki layer (Phase 2+) will derive synthesised pages
// from these snapshots.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::fs;

use crate::types::Blackboard;

#[derive(Debug, Clone, Serialize)]
pub struct RunSnapshotMeta {
    pub id: String,
    pub timestamp: String,
    pub material_filename: Option<String>,
    pub material_char_count: Option<usize>,
    pub item_count: usize,
    pub dimension_count: usize,
    pub total_cost_usd: f64,
    pub total_duration_ms: u64,
    pub run_dir: PathBuf,
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for c in s.chars() {
        let mapped = if c.is_ascii_alphanumeric() {
            prev_dash = false;
            Some(c.to_ascii_lowercase())
        } else if c == '-' || c == '_' || c == '.' {
            if prev_dash {
                None
            } else {
                prev_dash = true;
                Some('-')
            }
        } else if c.is_whitespace() {
            if prev_dash {
                None
            } else {
                prev_dash = true;
                Some('-')
            }
        } else {
            // CJK / punctuation — drop
            None
        };
        if let Some(m) = mapped {
            out.push(m);
        }
    }
    let trimmed = out.trim_matches('-');
    let truncated: String = trimmed.chars().take(40).collect();
    if truncated.is_empty() {
        "untitled".to_string()
    } else {
        truncated
    }
}

fn iso8601_compact_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}{mth:02}{d:02}-{h:02}{m:02}{s:02}")
}

fn iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub async fn snapshot_run(
    workspace_dir: &Path,
    board: &Blackboard,
    total_cost_usd: f64,
    total_duration_ms: u64,
    per_agent: &[Value],
) -> Result<RunSnapshotMeta, String> {
    let item_count = board.data.items.as_ref().map(|v| v.len()).unwrap_or(0);
    if item_count == 0 {
        return Err("workflow produced no items; skipping snapshot".into());
    }

    let timestamp = iso8601_now();
    let timestamp_compact = iso8601_compact_now();
    let material_filename = board
        .user_input
        .material
        .as_ref()
        .map(|m| m.filename.clone());
    let slug_source = material_filename
        .clone()
        .unwrap_or_else(|| "untitled".to_string());
    let slug = slugify(&slug_source);
    let id = format!("{timestamp_compact}-{slug}");
    let run_dir = workspace_dir.join("runs").join(&id);

    fs::create_dir_all(&run_dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", run_dir.display()))?;

    // 1. Full blackboard snapshot — single source of truth.
    let board_json = serde_json::to_string_pretty(board).map_err(|e| e.to_string())?;
    fs::write(run_dir.join("blackboard.json"), &board_json)
        .await
        .map_err(|e| format!("write blackboard.json: {e}"))?;

    // 2. Material content as a standalone .md so the wiki layer can
    //    cite it with a simple file path (no JSON pointer needed).
    let mut material_char_count: Option<usize> = None;
    if let Some(m) = &board.user_input.material {
        material_char_count = Some(m.content.chars().count());
        fs::write(run_dir.join("material.md"), &m.content)
            .await
            .map_err(|e| format!("write material.md: {e}"))?;
    }

    // 3. Items broken out separately — easier for grep / filter than
    //    digging into blackboard.json.
    let items_json = serde_json::to_string_pretty(&json!({
        "items": board.data.items,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(run_dir.join("items.json"), items_json)
        .await
        .map_err(|e| format!("write items.json: {e}"))?;

    // 4. Reviews (claude / gemini / merged) — also broken out.
    let reviews_json = serde_json::to_string_pretty(&json!({
        "review_claude": board.data.review_claude,
        "review_gemini": board.data.review_gemini,
        "review_merged": board.data.review_merged,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(run_dir.join("reviews.json"), reviews_json)
        .await
        .map_err(|e| format!("write reviews.json: {e}"))?;

    // 5. Human-friendly meta.yaml — what a wiki synthesiser reads first.
    let dim_count = board.user_input.competency_dimensions.len();
    let dim_lines: Vec<String> = board
        .user_input
        .competency_dimensions
        .iter()
        .map(|d| format!("  - dim_id: {}\n    name: {}", d.dim_id, d.name))
        .collect();
    let by_agent_lines: Vec<String> = per_agent
        .iter()
        .map(|p| {
            let agent = p.get("agent").and_then(|v| v.as_str()).unwrap_or("?");
            let cost = p.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dur = p.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            format!("  {agent}: {{ cost_usd: {cost:.4}, duration_ms: {dur} }}")
        })
        .collect();
    let meta = format!(
        "id: {id}\n\
         timestamp: {timestamp}\n\
         material:\n  filename: {fname}\n  char_count: {chars}\n\
         dimensions:\n  count: {dim_count}\n  list:\n{dims}\n\
         items:\n  count: {item_count}\n\
         costs:\n  total_usd: {total_cost_usd:.4}\n  duration_ms: {total_duration_ms}\n  by_agent:\n{agents}\n",
        fname = material_filename
            .as_deref()
            .map(|s| format!("\"{s}\""))
            .unwrap_or_else(|| "null".into()),
        chars = material_char_count
            .map(|n| n.to_string())
            .unwrap_or_else(|| "null".into()),
        dims = if dim_lines.is_empty() {
            "    []".to_string()
        } else {
            dim_lines.join("\n")
        },
        agents = if by_agent_lines.is_empty() {
            "    {}".to_string()
        } else {
            by_agent_lines.join("\n")
        },
    );
    fs::write(run_dir.join("meta.yaml"), meta)
        .await
        .map_err(|e| format!("write meta.yaml: {e}"))?;

    Ok(RunSnapshotMeta {
        id,
        timestamp,
        material_filename,
        material_char_count,
        item_count,
        dimension_count: dim_count,
        total_cost_usd,
        total_duration_ms,
        run_dir,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct RunMeta {
    pub id: String,
    pub timestamp: String,
    pub material_filename: Option<String>,
    pub item_count: usize,
    pub dimension_count: usize,
    pub total_cost_usd: f64,
}

/// List all snapshots in workspace/runs/ — used by Home's recent runs.
pub async fn list_runs(workspace_dir: &Path) -> Vec<RunMeta> {
    let runs_root = workspace_dir.join("runs");
    let mut entries: Vec<RunMeta> = Vec::new();
    let mut rd = match fs::read_dir(&runs_root).await {
        Ok(r) => r,
        Err(_) => return entries,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Cheap parse: read meta.yaml for human fields. If absent,
        // fall back to reading blackboard.json for item count.
        let meta_path = path.join("meta.yaml");
        let mut timestamp = String::new();
        let mut material_filename: Option<String> = None;
        let mut item_count: usize = 0;
        let mut dimension_count: usize = 0;
        let mut total_cost_usd: f64 = 0.0;
        if let Ok(s) = fs::read_to_string(&meta_path).await {
            for line in s.lines() {
                let trimmed = line.trim_start();
                if let Some(rest) = trimmed.strip_prefix("timestamp: ") {
                    timestamp = rest.trim().to_string();
                } else if let Some(rest) = trimmed.strip_prefix("filename: ") {
                    let v = rest.trim().trim_matches('"').to_string();
                    if v != "null" && !v.is_empty() {
                        material_filename = Some(v);
                    }
                } else if let Some(rest) = trimmed.strip_prefix("count: ") {
                    let n: usize = rest.trim().parse().unwrap_or(0);
                    if line.starts_with("  count:") || line.starts_with("\tcount:") {
                        // First "count:" under dimensions: at indent 2
                        if dimension_count == 0 {
                            dimension_count = n;
                        } else if item_count == 0 {
                            item_count = n;
                        }
                    }
                } else if let Some(rest) = trimmed.strip_prefix("total_usd: ") {
                    total_cost_usd = rest.trim().parse().unwrap_or(0.0);
                }
            }
        }
        entries.push(RunMeta {
            id,
            timestamp,
            material_filename,
            item_count,
            dimension_count,
            total_cost_usd,
        });
    }
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    entries
}

pub async fn delete_run(workspace_dir: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid run id: {id:?}"));
    }
    let dir = workspace_dir.join("runs").join(id);
    if !dir.is_dir() {
        return Err(format!("run '{id}' not found"));
    }
    fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("rm -rf {}: {e}", dir.display()))?;
    Ok(())
}
