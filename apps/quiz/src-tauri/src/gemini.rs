// Gemini second-opinion reviewer — Rust port of
// apps/shell/electron/coordinator/gemini.ts.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::blackboard::{read_blackboard, write_blackboard};

const REVIEWER_SKILL_NAME: &str = "agent-4-reviewer";
const GEMINI_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct GeminiRuntime {
    pub running: AtomicBool,
    pub current_pid: Mutex<Option<u32>>,
}

impl GeminiRuntime {
    pub async fn request_stop(&self) {
        let pid = *self.current_pid.lock().await;
        if let Some(p) = pid {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(p.to_string())
                .status();
        }
    }
}

// ─── binary resolution (mirrors workflow::resolve_binary) ──

fn gemini_bin() -> std::path::PathBuf {
    use std::process::Command as StdCommand;
    if let Ok(out) = StdCommand::new("which").arg("gemini").output() {
        if out.status.success() {
            if let Ok(s) = std::str::from_utf8(&out.stdout) {
                let p = s.trim();
                if !p.is_empty() {
                    return std::path::PathBuf::from(p);
                }
            }
        }
    }
    std::path::PathBuf::from("/opt/homebrew/bin/gemini")
}

// ─── prompt construction ────────────────────────────────────

async fn load_reviewer_skill(workspace_dir: &Path) -> Result<String, String> {
    let skill_path = workspace_dir
        .join(".claude")
        .join("skills")
        .join(REVIEWER_SKILL_NAME)
        .join("SKILL.md");
    let raw = tokio::fs::read_to_string(&skill_path)
        .await
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    // Strip YAML frontmatter (--- ... ---) at the start of the file.
    let body = strip_frontmatter(&raw);
    let lines = [
        "你現在要扮演的角色是 agent-4-reviewer。",
        "工作目錄下有 blackboard.json,你有讀寫檔工具可用。",
        "請嚴格按以下 skill 內容完成任務:",
        "",
        "---",
        body.trim(),
        "---",
        "",
        "現在開始執行。完成後必須把結果寫回 blackboard.json。",
    ];
    Ok(lines.join("\n"))
}

fn strip_frontmatter(s: &str) -> String {
    if !s.starts_with("---") {
        return s.to_string();
    }
    let after_first = &s[3..];
    if let Some(end_rel) = after_first.find("\n---") {
        let after_close = &after_first[end_rel + 4..];
        return after_close.trim_start_matches('\n').to_string();
    }
    s.to_string()
}

// ─── result snapshot ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeminiResultSnapshot {
    pub status: Option<String>,
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
}

// ─── spawn the gemini reviewer ──────────────────────────────

async fn spawn_gemini_reviewer(
    app: &AppHandle,
    workspace_dir: &Path,
    runtime: &GeminiRuntime,
) -> Result<Option<GeminiResultSnapshot>, String> {
    let prompt = load_reviewer_skill(workspace_dir).await?;
    let _ = app.emit("gemini:started", json!({}));

    let mut child = Command::new(gemini_bin())
        .args([
            "-y",
            "-o",
            "stream-json",
            "--include-directories",
            workspace_dir.to_str().unwrap_or("."),
        ])
        .current_dir(workspace_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("gemini spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.flush().await;
    }

    let stdout = child.stdout.take().ok_or("gemini stdout missing")?;
    let stderr = child.stderr.take().ok_or("gemini stderr missing")?;

    if let Some(pid) = child.id() {
        let mut g = runtime.current_pid.lock().await;
        *g = Some(pid);
    }

    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut last_result: Option<GeminiResultSnapshot> = None;
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stdout.emit("gemini:pty", json!({ "data": format!("{line}\n") }));
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(msg) => {
                    if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
                        let stats = msg.get("stats");
                        last_result = Some(GeminiResultSnapshot {
                            status: msg
                                .get("status")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            total_tokens: stats.and_then(|s| s.get("total_tokens")).and_then(|v| v.as_u64()),
                            input_tokens: stats.and_then(|s| s.get("input_tokens")).and_then(|v| v.as_u64()),
                            duration_ms: stats.and_then(|s| s.get("duration_ms")).and_then(|v| v.as_u64()),
                        });
                    }
                    let _ = app_for_stdout.emit("gemini:stream", json!({ "msg": msg }));
                }
                Err(_) => {
                    let _ = app_for_stdout.emit("gemini:raw", json!({ "line": trimmed }));
                }
            }
        }
        last_result
    });

    let app_for_stderr = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "gemini:pty",
                json!({ "data": format!("[stderr] {line}\n") }),
            );
        }
    });

    let exit_status_res = timeout(GEMINI_TIMEOUT, child.wait()).await;

    {
        let mut g = runtime.current_pid.lock().await;
        *g = None;
    }

    let exit_status = match exit_status_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("gemini wait failed: {e}")),
        Err(_) => {
            return Err(format!(
                "gemini timeout after {}ms",
                GEMINI_TIMEOUT.as_millis()
            ));
        }
    };

    let last_result = stdout_task.await.unwrap_or(None);
    let _ = stderr_task.await;

    let exit_code = exit_status.code();
    let _ = app.emit(
        "gemini:completed",
        json!({ "exit_code": exit_code, "result": last_result }),
    );

    if exit_status.success() {
        Ok(last_result)
    } else {
        Err(format!("gemini exited with code {:?}", exit_code))
    }
}

// ─── merge rules ────────────────────────────────────────────

const VERDICT_RANKS: &[(&str, u8)] = &[("accept", 0), ("needs_revision", 1), ("reject", 2)];
const VERDICT_BY_RANK: &[&str] = &["accept", "needs_revision", "reject"];
const CHECK_FIELDS: &[&str] = &[
    "answer_uniqueness",
    "construct_validity",
    "ambiguity",
    "bypass_risk",
];

fn rank_of(v: Option<&str>) -> u8 {
    match v {
        Some(s) => VERDICT_RANKS
            .iter()
            .find(|(k, _)| *k == s)
            .map(|(_, r)| *r)
            .unwrap_or(1),
        None => 1,
    }
}

fn merge_verdict(c: Option<&str>, g: Option<&str>) -> &'static str {
    let r = rank_of(c).max(rank_of(g)) as usize;
    VERDICT_BY_RANK.get(r).copied().unwrap_or("needs_revision")
}

fn check_pass(item: &Value, check: &str) -> Option<bool> {
    item.get("checks")
        .and_then(|c| c.get(check))
        .and_then(|c| c.get("pass"))
        .and_then(|v| v.as_bool())
}

fn check_concern<'a>(item: &'a Value, check: &str) -> Option<&'a str> {
    item.get("checks")
        .and_then(|c| c.get(check))
        .and_then(|c| c.get("concern"))
        .and_then(|v| v.as_str())
}

pub fn merge_reviews(rc: Option<&Value>, rg: Option<&Value>) -> Value {
    let ci = rc
        .and_then(|v| v.get("per_item"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let gi_arr = rg
        .and_then(|v| v.get("per_item"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut gemini_by_id: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();
    for g in gi_arr {
        if let Some(id) = g.get("item_id").and_then(|v| v.as_str()) {
            gemini_by_id.insert(id.to_string(), g);
        }
    }

    let mut per_item = Vec::with_capacity(ci.len());
    for c in &ci {
        let id = c.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
        let g = gemini_by_id.get(id);
        let mut checks_agreement = serde_json::Map::new();
        for cf in CHECK_FIELDS {
            let cp = check_pass(c, cf);
            let gp = g.and_then(|gv| check_pass(gv, cf));
            let val: Value = match (cp, gp) {
                (Some(a), Some(b)) => json!(a == b),
                _ => Value::Null,
            };
            checks_agreement.insert((*cf).to_string(), val);
        }
        let claude_concerns: Vec<Value> = CHECK_FIELDS
            .iter()
            .filter_map(|cf| check_concern(c, cf).map(|s| json!(s)))
            .collect();
        let gemini_concerns: Vec<Value> = CHECK_FIELDS
            .iter()
            .filter_map(|cf| g.and_then(|gv| check_concern(gv, cf)).map(|s| json!(s)))
            .collect();
        let cv = c.get("verdict").and_then(|v| v.as_str());
        let gv = g.and_then(|gv| gv.get("verdict")).and_then(|v| v.as_str());
        per_item.push(json!({
            "item_id": id,
            "verdict": merge_verdict(cv, gv),
            "verdict_claude": cv,
            "verdict_gemini": gv,
            "agreement": cv == gv,
            "checks_agreement": checks_agreement,
            "quality_score_claude": c.get("overall_quality_score"),
            "quality_score_gemini": g.and_then(|gv| gv.get("overall_quality_score")),
            "claude_concerns": claude_concerns,
            "gemini_concerns": gemini_concerns,
        }));
    }

    let total = per_item.len();
    let agree_count = per_item
        .iter()
        .filter(|p| p.get("agreement").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();

    let mut per_check_agreement = serde_json::Map::new();
    for cf in CHECK_FIELDS {
        let measurable: Vec<&Value> = per_item
            .iter()
            .filter(|p| {
                p.get("checks_agreement")
                    .and_then(|m| m.get(*cf))
                    .map(|v| !v.is_null())
                    .unwrap_or(false)
            })
            .collect();
        let measurable_count = measurable.len();
        let agree = measurable
            .iter()
            .filter(|p| {
                p.get("checks_agreement")
                    .and_then(|m| m.get(*cf))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
            .count();
        let entry = if measurable_count > 0 {
            json!({
                "rate": agree as f64 / measurable_count as f64,
                "measured_on": measurable_count,
            })
        } else {
            json!({ "rate": Value::Null, "measured_on": 0 })
        };
        per_check_agreement.insert((*cf).to_string(), entry);
    }

    let mut counts = std::collections::HashMap::new();
    for p in &per_item {
        if let Some(v) = p.get("verdict").and_then(|v| v.as_str()) {
            *counts.entry(v.to_string()).or_insert(0u64) += 1;
        }
    }

    let disagreement_ids: Vec<String> = per_item
        .iter()
        .filter(|p| !p.get("agreement").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|p| p.get("item_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    json!({
        "per_item": per_item,
        "summary": {
            "total_items": total,
            "reviewers": ["claude", "gemini"],
            "verdict_agreement_rate": if total > 0 { agree_count as f64 / total as f64 } else { 0.0 },
            "per_check_agreement": per_check_agreement,
            "merged_verdict_counts": {
                "accept": counts.get("accept").copied().unwrap_or(0),
                "needs_revision": counts.get("needs_revision").copied().unwrap_or(0),
                "reject": counts.get("reject").copied().unwrap_or(0),
            },
            "disagreement_item_ids": disagreement_ids,
        }
    })
}

// ─── orchestrator ───────────────────────────────────────────

pub async fn run_second_opinion(
    app: AppHandle,
    workspace_dir: PathBuf,
    runtime: Arc<GeminiRuntime>,
) {
    runtime.running.store(true, Ordering::SeqCst);
    let result = run_inner(&app, &workspace_dir, &runtime).await;
    runtime.running.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        let _ = app.emit("second-opinion:error", json!({ "error": e }));
    }
}

async fn run_inner(
    app: &AppHandle,
    workspace_dir: &Path,
    runtime: &Arc<GeminiRuntime>,
) -> Result<(), String> {
    let blackboard_path = workspace_dir.join("blackboard.json");
    let mut before = read_blackboard(&blackboard_path)
        .await
        .ok_or_else(|| "blackboard.json not readable".to_string())?;
    let item_count = before.data.items.as_ref().map(|v| v.len()).unwrap_or(0);
    if item_count == 0 {
        return Err("no items to review (run the full workflow first)".into());
    }
    if before.data.review_claude.is_none() {
        return Err("data.review_claude missing (did agent-4 complete?)".into());
    }
    // Clear any prior re-run state and DELETE review (not null) to avoid
    // Gemini's surgical-replace creating a sibling.
    before.data.review_gemini = None;
    before.data.review_merged = None;
    before.data.review = None;
    write_blackboard(&blackboard_path, &before).await?;
    let _ = app.emit("board:updated", json!({ "board": &before }));

    let result = spawn_gemini_reviewer(app, workspace_dir, runtime).await?;

    let mut after = read_blackboard(&blackboard_path)
        .await
        .ok_or_else(|| "blackboard.json not readable after gemini".to_string())?;
    let review = after
        .data
        .review
        .take()
        .ok_or_else(|| "Gemini exited but data.review is empty (skill not followed)".to_string())?;
    after.data.review_gemini = Some(review);

    let rc_v = after
        .data
        .review_claude
        .as_ref()
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null));
    let rg_v = after
        .data
        .review_gemini
        .as_ref()
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null));
    let merged = merge_reviews(rc_v.as_ref(), rg_v.as_ref());
    if let Value::Object(map) = &merged {
        let merged_map: std::collections::HashMap<String, Value> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        after.data.review_merged = Some(merged_map);
    }

    after.costs.by_agent.insert(
        "gemini_reviewer".to_string(),
        json!({
            "tokens": result.as_ref().and_then(|r| r.total_tokens).unwrap_or(0),
            "input_tokens": result.as_ref().and_then(|r| r.input_tokens).unwrap_or(0),
            "duration_ms": result.as_ref().and_then(|r| r.duration_ms).unwrap_or(0),
            "cost_usd_note": "not reported by Gemini CLI; compute from token pricing if needed",
        }),
    );

    write_blackboard(&blackboard_path, &after).await?;
    let _ = app.emit("board:updated", json!({ "board": &after }));
    let merged_summary = merged.get("summary").cloned().unwrap_or(Value::Null);
    let _ = app.emit(
        "second-opinion:completed",
        json!({ "board": &after, "merged_summary": merged_summary }),
    );
    Ok(())
}
