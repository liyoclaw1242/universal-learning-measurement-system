// Claude session manager.
//
// Intentionally simple v1: each ingest spawns a fresh `claude
// --print` invocation with the relevant prompt; the long-running
// "session" is virtual — context is not preserved across ingests.
// Tracking tokens lets us know when the cumulative budget hits 80%
// of the configured window and trigger a "restart" log entry (which
// in this v1 just resets the cumulative counter).
//
// Why this isn't a true persistent stdin/stdout session yet: claude
// CLI's `--print` mode exits after each prompt, and interactive mode
// has no deterministic turn boundary parser. v1 trades persistence
// for simplicity; v2 can swap in a long-lived session once we have
// the right protocol bits in place.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::log_writer;
use crate::state::{MaintainerState, SessionState};

const TURN_TIMEOUT: Duration = Duration::from_secs(900); // 15 min
const RESTART_THRESHOLD_PCT: u64 = 80;

pub struct ClaudeSession {
    pub wiki_dir: PathBuf,
    pub model: String,
}

impl ClaudeSession {
    pub fn new(wiki_dir: PathBuf) -> Self {
        let model = std::env::var("ULMS_MODEL").unwrap_or_else(|_| "sonnet".to_string());
        Self { wiki_dir, model }
    }

    pub async fn restart(
        &mut self,
        app: &AppHandle,
        state: &Arc<Mutex<MaintainerState>>,
        reason: &str,
    ) -> Result<(), String> {
        {
            let mut s = state.lock().await;
            s.session_state = SessionState::Restarting;
            s.tokens_used = 0;
        }
        log_writer::log(app, state, "restart", reason, None).await;
        {
            let mut s = state.lock().await;
            s.session_state = SessionState::Idle;
        }
        Ok(())
    }
}

fn claude_bin() -> PathBuf {
    use std::process::Command as StdCommand;
    if let Ok(out) = StdCommand::new("which").arg("claude").output() {
        if out.status.success() {
            if let Ok(s) = std::str::from_utf8(&out.stdout) {
                let p = s.trim();
                if !p.is_empty() {
                    return PathBuf::from(p);
                }
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".local/bin/claude");
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("claude")
}

/// Run a single ingest pass for one resource. Spawns claude with the
/// wiki dir mounted, sends a `/maintain ingest <key>` prompt, parses
/// stream-json, accumulates tokens, and lets `log_writer` record the
/// outcome.
pub async fn run_ingest(
    app: &AppHandle,
    claude: &Arc<Mutex<ClaudeSession>>,
    state: &Arc<Mutex<MaintainerState>>,
    key: &str,
) -> Result<(), String> {
    {
        let mut s = state.lock().await;
        s.session_state = SessionState::Ingesting;
    }

    let prompt = build_ingest_prompt(key);
    let result = run_claude_turn(app, claude, state, &prompt).await;

    {
        let mut s = state.lock().await;
        s.session_state = SessionState::Idle;
        if let Err(ref e) = result {
            s.last_error = Some(e.clone());
        }
    }

    let detail = match &result {
        Ok(text) => Some(format!(
            "key: {key}\noutput: {}",
            text.chars().take(280).collect::<String>()
        )),
        Err(e) => Some(format!("key: {key}\nerror: {e}")),
    };

    let op = if result.is_ok() { "ingest" } else { "error" };
    let msg = if result.is_ok() {
        format!("ingested {key}")
    } else {
        format!("failed to ingest {key}")
    };
    log_writer::log(app, state, op, &msg, detail.as_deref()).await;

    // Counts may have changed.
    {
        let mut s = state.lock().await;
        s.refresh_counts().await;
    }

    // Maybe restart at threshold.
    let (used, budget) = {
        let s = state.lock().await;
        (s.tokens_used, s.context_budget)
    };
    if budget > 0 && used * 100 >= budget * RESTART_THRESHOLD_PCT {
        let mut g = claude.lock().await;
        let _ = g
            .restart(
                app,
                state,
                &format!("auto: {used}/{budget} tokens >= {RESTART_THRESHOLD_PCT}%"),
            )
            .await;
    }

    result.map(|_| ())
}

/// Whole-wiki lint pass.
pub async fn run_lint(
    app: &AppHandle,
    claude: &Arc<Mutex<ClaudeSession>>,
    state: &Arc<Mutex<MaintainerState>>,
) -> Result<(), String> {
    {
        let mut s = state.lock().await;
        s.session_state = SessionState::Linting;
    }
    let prompt = build_lint_prompt();
    let result = run_claude_turn(app, claude, state, &prompt).await;
    {
        let mut s = state.lock().await;
        s.session_state = SessionState::Idle;
        if let Err(ref e) = result {
            s.last_error = Some(e.clone());
        }
    }
    let op = if result.is_ok() { "lint" } else { "error" };
    let msg = if result.is_ok() {
        "wiki lint pass complete".to_string()
    } else {
        "lint failed".to_string()
    };
    log_writer::log(app, state, op, &msg, None).await;
    result.map(|_| ())
}

fn build_ingest_prompt(key: &str) -> String {
    format!(
        "Follow CLAUDE.md.\n\
         \n\
         A new raw resource has appeared at `raw/{key}/`. Run the\n\
         `ingest` workflow as defined in CLAUDE.md:\n\
         \n\
         1. Read raw/{key}/meta.yaml and the body file.\n\
         2. Read index.md to know what's already there.\n\
         3. Write sources/<slug>.md with frontmatter + summary.\n\
         4. Update affected concepts/ and entities/ pages\n\
            (skip any with human_edited: true; surface them as needs-review).\n\
         5. Refresh index.md.\n\
         6. Append a properly-formatted entry to log.md.\n\
         \n\
         At the end of your turn, list in plain text:\n\
         - files created\n\
         - files modified\n\
         - files skipped due to human_edited\n\
         - any open questions for the human\n"
    )
}

fn build_lint_prompt() -> String {
    "Follow CLAUDE.md.\n\
     \n\
     Run the `lint` workflow as defined in CLAUDE.md. Walk index.md,\n\
     check every page for orphans, stale claims, missing concepts,\n\
     broken wikilinks, and frontmatter drift. Cross-reference for\n\
     missing links between pages. Output a report at\n\
     synthesis/lint-<YYYY-MM-DD>.md (no fixes in this pass; just\n\
     findings). Append the lint log entry.\n"
        .to_string()
}

async fn run_claude_turn(
    app: &AppHandle,
    claude: &Arc<Mutex<ClaudeSession>>,
    state: &Arc<Mutex<MaintainerState>>,
    prompt: &str,
) -> Result<String, String> {
    let (wiki_dir, model) = {
        let g = claude.lock().await;
        (g.wiki_dir.clone(), g.model.clone())
    };

    {
        let mut s = state.lock().await;
        if s.model.is_none() {
            s.model = Some(model.clone());
        }
    }

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
            "3.00",
            "--model",
            &model,
            "--add-dir",
            wiki_dir.to_str().unwrap_or("."),
        ])
        .current_dir(&wiki_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("claude spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let stdout = child.stdout.take().ok_or("claude stdout missing")?;

    let app_for_stream = app.clone();
    let state_for_stream = Arc::clone(state);
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut accumulated = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                track_tokens(&state_for_stream, &msg).await;
                if let Some(text) = extract_assistant_text(&msg) {
                    accumulated.push_str(&text);
                }
                if let Some(short) = brief_event(&msg) {
                    let _ = app_for_stream.emit_short(&short);
                }
            }
        }
        accumulated
    });

    let exit = match timeout(TURN_TIMEOUT, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("claude wait failed: {e}")),
        Err(_) => return Err(format!("claude turn timeout after {}s", TURN_TIMEOUT.as_secs())),
    };

    let text = stdout_task.await.unwrap_or_default();

    if !exit.success() {
        return Err(format!("claude exited with code {:?}", exit.code()));
    }
    Ok(text)
}

async fn track_tokens(state: &Arc<Mutex<MaintainerState>>, msg: &Value) {
    // result events carry usage totals at end of turn
    if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
        if let Some(usage) = msg.get("usage") {
            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let mut s = state.lock().await;
            s.tokens_used = s.tokens_used.saturating_add(input).saturating_add(output);
        }
    }
}

fn extract_assistant_text(msg: &Value) -> Option<String> {
    if msg.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }
    let content = msg.get("message").and_then(|m| m.get("content"))?;
    let arr = content.as_array()?;
    let mut out = String::new();
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                out.push_str(t);
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn brief_event(msg: &Value) -> Option<String> {
    let ty = msg.get("type").and_then(|v| v.as_str())?;
    match ty {
        "system" => msg
            .get("subtype")
            .and_then(|v| v.as_str())
            .map(|s| format!("system:{s}")),
        "assistant" => Some("assistant turn".to_string()),
        "result" => msg
            .get("subtype")
            .and_then(|v| v.as_str())
            .map(|s| format!("result:{s}")),
        _ => None,
    }
}

// Tiny wrapper around AppHandle so we can later swap to a richer
// stream channel without touching the parser site.
trait AppEmit {
    fn emit_short(&self, msg: &str) -> Result<(), tauri::Error>;
}
impl AppEmit for AppHandle {
    fn emit_short(&self, msg: &str) -> Result<(), tauri::Error> {
        use tauri::Emitter;
        self.emit("maintainer:tick", msg)
    }
}

/// Helper for callers that want to walk the wiki without spawning
/// claude (e.g. seeding initial seen-state).
pub async fn list_raw_keys(wiki_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let raw = wiki_dir.join("raw");
    let types = ["articles", "youtube", "papers", "books", "images", "markdown"];
    for t in types {
        let mut rd = match tokio::fs::read_dir(raw.join(t)).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(ty) = entry.file_type().await {
                if !ty.is_dir() {
                    continue;
                }
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                continue;
            }
            out.push(format!("{t}/{id}"));
        }
    }
    out
}
