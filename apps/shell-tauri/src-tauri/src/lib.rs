// ULMS Tauri spike — minimal port of Electron coordinator/workflow.ts.
// Spawns a stand-in subprocess (bash loop) instead of the real claude
// CLI; the goal is to prove the spawn → line-stream → emit → renderer
// path works end-to-end.

use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default)]
struct WorkflowState {
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Serialize)]
struct AgentStream {
    agent: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct AgentCompleted {
    agent: String,
    exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct WorkflowError {
    error: String,
}

const SPIKE_AGENT: &str = "agent_spike";

// Stand-in for the real claude CLI: prints 5 lines with a half-second
// delay between each, then exits 0. Demonstrates async line streaming.
const SPIKE_SCRIPT: &str = r#"
for i in 1 2 3 4 5; do
  echo "[$(date +%H:%M:%S)] hello from spike line $i"
  sleep 0.4
done
echo "spike done"
"#;

#[tauri::command]
async fn start_workflow(
    app: AppHandle,
    state: State<'_, Arc<WorkflowState>>,
) -> Result<(), String> {
    {
        let guard = state.child.lock().await;
        if guard.is_some() {
            return Err("workflow already running".into());
        }
    }

    let mut child = Command::new("bash")
        .arg("-c")
        .arg(SPIKE_SCRIPT)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("stderr pipe missing")?;

    {
        let mut guard = state.child.lock().await;
        *guard = Some(child);
    }

    let app_for_stdout = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stdout.emit(
                "agent:stream",
                AgentStream {
                    agent: SPIKE_AGENT.into(),
                    line,
                },
            );
        }
    });

    let app_for_stderr = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "agent:stream",
                AgentStream {
                    agent: SPIKE_AGENT.into(),
                    line: format!("[stderr] {line}"),
                },
            );
        }
    });

    let state_for_wait = state.inner().clone();
    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let exit_code = {
            let mut guard = state_for_wait.child.lock().await;
            if let Some(mut c) = guard.take() {
                match c.wait().await {
                    Ok(status) => status.code(),
                    Err(e) => {
                        let _ = app_for_wait.emit(
                            "workflow:error",
                            WorkflowError {
                                error: format!("wait failed: {e}"),
                            },
                        );
                        return;
                    }
                }
            } else {
                None
            }
        };
        let _ = app_for_wait.emit(
            "agent:completed",
            AgentCompleted {
                agent: SPIKE_AGENT.into(),
                exit_code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
async fn stop_workflow(state: State<'_, Arc<WorkflowState>>) -> Result<(), String> {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_mut() {
        let _ = child.start_kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Arc::new(WorkflowState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_workflow, stop_workflow])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
