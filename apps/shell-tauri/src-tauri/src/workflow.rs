// Workflow runner — Rust port of
// apps/shell/electron/coordinator/workflow.ts.
//
// Spawns the four agents sequentially via the local `claude` CLI with
// `--output-format stream-json`. Stream events forward to the renderer
// as agent:started / agent:stream / agent:pty / agent:raw / agent:completed.
//
// Cancellation: stop_workflow flips an AtomicBool and SIGKILLs the
// currently-tracked pid. Each agent's wait() resolves with a non-zero
// exit and the loop checks the cancel flag between agents.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::blackboard::{read_blackboard, reset_blackboard, write_blackboard, AGENTS};
use crate::types::{Blackboard, ResultSnapshot, StagedInputs};

const AGENT_TIMEOUT: Duration = Duration::from_secs(900);
const MAX_BUDGET_USD: &str = "3.00";

// ─── shared workflow state (lives on AppState) ──────────────

#[derive(Default)]
pub struct WorkflowRuntime {
    /// Set while a run is in flight; prevents concurrent starts.
    pub running: AtomicBool,
    /// Latched cancel flag — checked between agents.
    pub cancel: AtomicBool,
    /// PID of the currently-running claude child (None when idle).
    pub current_pid: Mutex<Option<u32>>,
}

impl WorkflowRuntime {
    pub async fn request_stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let pid = *self.current_pid.lock().await;
        if let Some(p) = pid {
            // Use shell `kill -9` to avoid pulling in libc as a dep just
            // for one syscall. SIGKILL is async-signal-safe.
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(p.to_string())
                .status();
        }
    }
}

// ─── binary + model resolution ──────────────────────────────

fn resolve_binary(name: &str, fallback: &str) -> PathBuf {
    use std::process::Command as StdCommand;
    if let Ok(out) = StdCommand::new("which").arg(name).output() {
        if out.status.success() {
            if let Ok(s) = std::str::from_utf8(&out.stdout) {
                let path = s.trim();
                if !path.is_empty() {
                    return PathBuf::from(path);
                }
            }
        }
    }
    PathBuf::from(fallback)
}

fn claude_bin() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let fallback = format!("{home}/.local/bin/claude");
    resolve_binary("claude", &fallback)
}

fn model() -> String {
    std::env::var("ULMS_MODEL").unwrap_or_else(|_| "sonnet".to_string())
}

fn agent_slug(agent: &str) -> Option<&'static str> {
    match agent {
        "agent_1" => Some("agent-1-extractor"),
        "agent_2" => Some("agent-2-mapper"),
        "agent_3" => Some("agent-3-designer"),
        "agent_4" => Some("agent-4-reviewer"),
        _ => None,
    }
}

// ─── event payload shapes ───────────────────────────────────

#[derive(Serialize, Clone)]
struct AgentStarted {
    agent: String,
}

#[derive(Serialize, Clone)]
struct AgentPty {
    agent: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct AgentRaw {
    agent: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct AgentCompleted {
    agent: String,
    exit_code: Option<i32>,
    result: Option<ResultSnapshot>,
}

// ─── spawn one agent ────────────────────────────────────────

pub async fn spawn_agent(
    app: &AppHandle,
    agent: &str,
    workspace_dir: &Path,
    runtime: &WorkflowRuntime,
) -> Result<Option<ResultSnapshot>, String> {
    let _ = app.emit(
        "agent:started",
        AgentStarted {
            agent: agent.to_string(),
        },
    );

    let slug = agent_slug(agent).ok_or_else(|| format!("unknown agent {agent}"))?;
    let prompt = format!("/{slug}");

    let mut child = Command::new(claude_bin())
        .args([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
            "--no-session-persistence",
            "--max-budget-usd",
            MAX_BUDGET_USD,
            "--model",
            &model(),
            "--add-dir",
            workspace_dir.to_str().unwrap_or("."),
        ])
        .current_dir(workspace_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{agent} spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.flush().await;
        // dropping closes stdin, signalling EOF to claude --print
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{agent} stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{agent} stderr pipe missing"))?;

    // Track pid so stop_workflow can SIGKILL it.
    if let Some(pid) = child.id() {
        let mut g = runtime.current_pid.lock().await;
        *g = Some(pid);
    }

    let app_for_stdout = app.clone();
    let agent_for_stdout = agent.to_string();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut last_result: Option<ResultSnapshot> = None;
        while let Ok(Some(line)) = reader.next_line().await {
            // Mirror Electron: emit raw chunk as agent:pty so the
            // terminal-tab gets the actual bytes too.
            let _ = app_for_stdout.emit(
                "agent:pty",
                AgentPty {
                    agent: agent_for_stdout.clone(),
                    data: format!("{line}\n"),
                },
            );
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(msg) => {
                    if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
                        last_result = serde_json::from_value::<ResultSnapshot>(msg.clone()).ok();
                    }
                    let _ = app_for_stdout.emit(
                        "agent:stream",
                        json!({ "agent": agent_for_stdout, "msg": msg }),
                    );
                }
                Err(_) => {
                    let _ = app_for_stdout.emit(
                        "agent:raw",
                        AgentRaw {
                            agent: agent_for_stdout.clone(),
                            line: trimmed.to_string(),
                        },
                    );
                }
            }
        }
        last_result
    });

    let app_for_stderr = app.clone();
    let agent_for_stderr = agent.to_string();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "agent:pty",
                AgentPty {
                    agent: agent_for_stderr.clone(),
                    data: format!("[stderr] {line}\n"),
                },
            );
        }
    });

    let exit_status_res = timeout(AGENT_TIMEOUT, child.wait()).await;

    // Clear pid regardless of outcome.
    {
        let mut g = runtime.current_pid.lock().await;
        *g = None;
    }

    let exit_status = match exit_status_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return Err(format!("{agent} wait failed: {e}"));
        }
        Err(_) => {
            return Err(format!(
                "{agent} timeout after {}ms",
                AGENT_TIMEOUT.as_millis()
            ));
        }
    };

    let last_result = stdout_task.await.unwrap_or(None);
    let _ = stderr_task.await;

    let exit_code = exit_status.code();
    let _ = app.emit(
        "agent:completed",
        AgentCompleted {
            agent: agent.to_string(),
            exit_code,
            result: last_result.clone(),
        },
    );

    if exit_status.success() {
        Ok(last_result)
    } else {
        Err(format!("{agent} exited with code {:?}", exit_code))
    }
}

// ─── schema sanity check ────────────────────────────────────

fn schema_check(agent: &str, board: &Blackboard) -> Vec<String> {
    let mut warns = Vec::new();
    let data = &board.data;
    match agent {
        "agent_1" => match data.knowledge_units.as_ref() {
            Some(kus) if !kus.is_empty() => {
                for (i, ku) in kus.iter().enumerate() {
                    if ku.get("ku_id").is_none() {
                        warns.push(format!("ku[{i}] missing ku_id"));
                    }
                    if ku.get("source_excerpt").is_none() {
                        warns.push(format!(
                            "ku[{i}] missing source_excerpt (Iron Law B risk)"
                        ));
                    }
                }
            }
            _ => warns.push("data.knowledge_units missing or empty".into()),
        },
        "agent_2" => match data.mapping.as_ref() {
            None => warns.push("data.mapping missing".into()),
            Some(m) => {
                let blueprint_specs_ok = m
                    .get("blueprint")
                    .and_then(|b| b.get("slot_specs"))
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if !blueprint_specs_ok {
                    warns.push("mapping.blueprint.slot_specs missing".into());
                }
                if m.get("ku_to_dimensions").is_none() {
                    warns.push("mapping.ku_to_dimensions missing".into());
                }
            }
        },
        "agent_3" => match data.items.as_ref() {
            Some(items) if !items.is_empty() => {
                for (i, item) in items.iter().enumerate() {
                    if item.get("item_id").is_none() {
                        warns.push(format!("item[{i}] missing item_id"));
                    }
                    let has_answer = item
                        .get("core")
                        .and_then(|c| c.get("answer"))
                        .is_some();
                    if !has_answer {
                        warns.push(format!("item[{i}] missing core.answer"));
                    }
                }
            }
            _ => warns.push("data.items missing or empty".into()),
        },
        "agent_4" => match data.review.as_ref() {
            None => warns.push("data.review missing".into()),
            Some(r) => {
                let per_item_ok = r.get("per_item").and_then(|v| v.as_array()).is_some();
                if !per_item_ok {
                    warns.push("review.per_item missing".into());
                }
                if r.get("summary").is_none() {
                    warns.push("review.summary missing".into());
                }
            }
        },
        _ => {}
    }
    warns
}

// ─── resume detection ───────────────────────────────────────

#[derive(Debug)]
struct ResumePoint {
    start_idx: usize,
    is_resume: bool,
    existing_costs: HashMap<String, f64>,
}

async fn detect_resume_point(blackboard_path: &Path) -> ResumePoint {
    let mut existing_costs: HashMap<String, f64> = AGENTS
        .iter()
        .map(|a| (a.to_string(), 0.0_f64))
        .collect();
    let Some(board) = read_blackboard(blackboard_path).await else {
        return ResumePoint {
            start_idx: 0,
            is_resume: false,
            existing_costs,
        };
    };
    for agent in AGENTS {
        let v = board
            .costs
            .by_agent
            .get(agent)
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        existing_costs.insert(agent.to_string(), v);
    }
    let mut start_idx = 0;
    if let Some(kus) = &board.data.knowledge_units {
        if !kus.is_empty() {
            start_idx = 1;
        }
    }
    if let Some(m) = &board.data.mapping {
        let specs_nonempty = m
            .get("blueprint")
            .and_then(|b| b.get("slot_specs"))
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if specs_nonempty {
            start_idx = 2;
        }
    }
    let target = board.user_input.assessment_params.target_item_count;
    if let Some(items) = &board.data.items {
        if target > 0 && items.len() >= target {
            start_idx = 3;
        }
    }
    if board.data.review.is_some() || board.data.review_claude.is_some() {
        start_idx = 4;
    }
    ResumePoint {
        start_idx,
        is_resume: start_idx > 0,
        existing_costs,
    }
}

// ─── run the full workflow ──────────────────────────────────

pub async fn run_workflow(
    app: AppHandle,
    workspace_dir: PathBuf,
    runtime: Arc<WorkflowRuntime>,
    initial_staged: StagedInputs,
) {
    runtime.running.store(true, Ordering::SeqCst);
    runtime.cancel.store(false, Ordering::SeqCst);

    let blackboard_path = workspace_dir.join("blackboard.json");

    let result = run_workflow_inner(&app, &workspace_dir, &runtime, initial_staged).await;
    if let Err(err) = result {
        let _ = app.emit("workflow:error", json!({ "error": err }));
    }

    runtime.running.store(false, Ordering::SeqCst);
    let _ = blackboard_path; // silences if not used in error path
}

async fn run_workflow_inner(
    app: &AppHandle,
    workspace_dir: &Path,
    runtime: &Arc<WorkflowRuntime>,
    initial_staged: StagedInputs,
) -> Result<(), String> {
    let blackboard_path = workspace_dir.join("blackboard.json");
    let resume = detect_resume_point(&blackboard_path).await;

    if resume.start_idx >= AGENTS.len() {
        return Err("workflow already complete; delete blackboard.json to start fresh".into());
    }

    if !resume.is_resume {
        // Fresh run requires staged inputs.
        let inputs_ok = initial_staged.material.is_some()
            && initial_staged
                .dimensions
                .as_ref()
                .map(|d| !d.is_empty())
                .unwrap_or(false);
        if !inputs_ok {
            return Err("material and dimensions must be loaded first".into());
        }
        reset_blackboard(&blackboard_path, &initial_staged).await?;
    }

    let _ = app.emit(
        "workflow:started",
        json!({
            "isResume": resume.is_resume,
            "startFromAgent": AGENTS[resume.start_idx],
        }),
    );

    if let Some(initial) = read_blackboard(&blackboard_path).await {
        let _ = app.emit("board:updated", json!({ "board": initial }));
    }

    // Synthesise started+completed for already-finished agents.
    for i in 0..resume.start_idx {
        let aid = AGENTS[i];
        let _ = app.emit(
            "agent:started",
            AgentStarted {
                agent: aid.into(),
            },
        );
        let _ = app.emit(
            "agent:completed",
            json!({
                "agent": aid,
                "exit_code": 0,
                "result": {
                    "total_cost_usd": resume.existing_costs.get(aid).copied().unwrap_or(0.0),
                    "duration_ms": 0,
                    "subtype": "resumed",
                }
            }),
        );
    }

    // Per-agent results so we can report totals at the end.
    let mut results: Vec<Option<ResultSnapshot>> = (0..resume.start_idx)
        .map(|i| {
            Some(ResultSnapshot {
                total_cost_usd: resume.existing_costs.get(AGENTS[i]).copied(),
                duration_ms: Some(0),
                subtype: Some("resumed".into()),
                usage: None,
            })
        })
        .collect();

    for i in resume.start_idx..AGENTS.len() {
        if runtime.cancel.load(Ordering::SeqCst) {
            return Err("workflow canceled".into());
        }
        let agent = AGENTS[i];
        let result = spawn_agent(app, agent, workspace_dir, runtime).await?;
        results.push(result.clone());

        let mut board = read_blackboard(&blackboard_path)
            .await
            .ok_or_else(|| format!("blackboard.json not readable after {agent}"))?;

        let cost = result.as_ref().and_then(|r| r.total_cost_usd).unwrap_or(0.0);
        board
            .costs
            .by_agent
            .insert(agent.to_string(), json!(cost));
        board.costs.total_usd = board
            .costs
            .by_agent
            .values()
            .filter_map(|v| v.as_f64())
            .sum();
        write_blackboard(&blackboard_path, &board).await?;
        let _ = app.emit("board:updated", json!({ "board": &board }));

        let warns = schema_check(agent, &board);
        if !warns.is_empty() {
            let _ = app.emit(
                "schema:warn",
                json!({ "agent": agent, "warnings": warns }),
            );
        }

        let expected_step = (i as u64) + 1;
        if (board.workflow.current_step as u64) < expected_step {
            return Err(format!(
                "{agent} exited but workflow.current_step is {}, expected >= {expected_step}",
                board.workflow.current_step
            ));
        }
    }

    // Post-loop fixup: rename data.review → data.review_claude (spike v3).
    if let Some(mut post) = read_blackboard(&blackboard_path).await {
        if let Some(r) = post.data.review.take() {
            post.data.review_claude = Some(r);
            write_blackboard(&blackboard_path, &post).await?;
            let _ = app.emit("board:updated", json!({ "board": &post }));
        }
    }

    let total_cost: f64 = results
        .iter()
        .filter_map(|r| r.as_ref().and_then(|x| x.total_cost_usd))
        .sum();
    let total_duration: u64 = results
        .iter()
        .filter_map(|r| r.as_ref().and_then(|x| x.duration_ms))
        .sum();
    let final_board = read_blackboard(&blackboard_path).await;
    let per_agent: Vec<Value> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({
                "agent": AGENTS[i],
                "cost_usd": r.as_ref().and_then(|x| x.total_cost_usd).unwrap_or(0.0),
                "duration_ms": r.as_ref().and_then(|x| x.duration_ms).unwrap_or(0),
                "subtype": r.as_ref().and_then(|x| x.subtype.clone()).unwrap_or_else(|| "unknown".into()),
            })
        })
        .collect();

    let _ = app.emit(
        "workflow:completed",
        json!({
            "board": final_board,
            "total_cost_usd": total_cost,
            "total_duration_ms": total_duration,
            "per_agent": per_agent,
        }),
    );

    Ok(())
}
