// Per-page translation via gemini CLI. Renderer hands us a base64
// PNG; we write it to <wiki>/raw/papers/<id>/pages/NNN.png, send the
// path to gemini with a 繁中 translation prompt, parse stream-json,
// and append the result to body.md (upsert — re-translation replaces
// the existing section in-place).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::paper::{iso8601_now, upsert_page_section, LearnRuntime, SessionState};

const TRANSLATION_TIMEOUT: Duration = Duration::from_secs(300);

fn gemini_bin() -> PathBuf {
    use std::process::Command as StdCommand;
    if let Ok(out) = StdCommand::new("which").arg("gemini").output() {
        if out.status.success() {
            if let Ok(s) = std::str::from_utf8(&out.stdout) {
                let p = s.trim();
                if !p.is_empty() {
                    return PathBuf::from(p);
                }
            }
        }
    }
    PathBuf::from("/opt/homebrew/bin/gemini")
}

pub async fn translate_page(
    app: AppHandle,
    runtime: Arc<LearnRuntime>,
    page_num: u32,
    image_b64: String,
) -> Result<u32, String> {
    let session = {
        let g = runtime.current_session.lock().await;
        g.clone().ok_or_else(|| "no active paper session".to_string())?
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_b64.trim())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let image_filename = format!("{page_num:03}.png");
    let image_path = session.session_dir.join("pages").join(&image_filename);
    tokio::fs::write(&image_path, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", image_path.display()))?;

    {
        let mut g = runtime.current_session.lock().await;
        if let Some(s) = g.as_mut() {
            s.capture_count = s.capture_count.max(page_num);
        }
    }
    let _ = app.emit(
        "translation:capture-started",
        json!({
            "capture_index": page_num,
            "image_path": image_path.to_string_lossy(),
        }),
    );

    let translation_text = run_gemini(&app, &runtime, &session, &image_path, page_num).await?;

    let header = format!("\n## Page {page_num} · {}\n\n", iso8601_now());
    let body = format!("{header}{}\n\n", translation_text.trim());
    let existing = tokio::fs::read_to_string(&session.body_path)
        .await
        .map_err(|e| format!("read body.md: {e}"))?;
    let updated = upsert_page_section(&existing, page_num, &body);
    tokio::fs::write(&session.body_path, updated)
        .await
        .map_err(|e| format!("write body.md: {e}"))?;

    let _ = app.emit(
        "translation:completed",
        json!({
            "capture_index": page_num,
            "image_path": image_path.to_string_lossy(),
            "text": translation_text,
            "body_path": session.body_path.to_string_lossy(),
        }),
    );
    let _ = app.emit(
        "raw:imported",
        json!({
            "type": "paper",
            "id": session.id,
            "via": "pdf-reader",
        }),
    );

    Ok(page_num)
}

async fn run_gemini(
    app: &AppHandle,
    runtime: &Arc<LearnRuntime>,
    session: &SessionState,
    image_path: &std::path::Path,
    page_num: u32,
) -> Result<String, String> {
    let prompt = format!(
        "請將下面這張 PDF 頁面截圖中的內容翻譯成繁體中文。\n\
         保留數學公式為 LaTeX (例如 $E=mc^2$ 或 $$ ... $$)。\n\
         圖表、表格只用一句話描述,不要逐行轉述數字。\n\
         輸出乾淨的 markdown,不要包含原文,不要包含任何 meta 說明。\n\
         \n\
         圖片:@{}",
        image_path.to_string_lossy()
    );

    let workspace = session.session_dir.parent().and_then(|p| p.parent()).map(|p| p.to_string_lossy().to_string());
    let mut child = Command::new(gemini_bin())
        .args([
            "-y",
            "-o",
            "stream-json",
            "--include-directories",
            workspace.as_deref().unwrap_or("."),
            "-p",
            &prompt,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("gemini spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("gemini stdout missing")?;
    let stderr = child.stderr.take().ok_or("gemini stderr missing")?;

    // Wire kill switch — runtime.request_stop() drops the sender.
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut g = runtime.child_killer.lock().await;
        *g = Some(kill_tx);
    }

    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut accumulated = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                if msg.get("type").and_then(|v| v.as_str()) == Some("message")
                    && msg.get("role").and_then(|v| v.as_str()) == Some("assistant")
                {
                    if let Some(text) = msg.get("content").and_then(|v| v.as_str()) {
                        accumulated.push_str(text);
                    }
                }
                let _ = app_for_stdout.emit("translation:stream", json!({ "msg": msg }));
            }
        }
        accumulated
    });

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(_)) = reader.next_line().await {}
    });

    let exit = tokio::select! {
        r = timeout(TRANSLATION_TIMEOUT, child.wait()) => match r {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                runtime.child_killer.lock().await.take();
                let _ = app.emit("translation:error", json!({ "error": format!("gemini wait failed: {e}"), "page": page_num }));
                return Err(format!("gemini wait: {e}"));
            }
            Err(_) => {
                runtime.child_killer.lock().await.take();
                let _ = app.emit("translation:error", json!({ "error": "translation timeout", "page": page_num }));
                return Err(format!("translation timeout after {}ms", TRANSLATION_TIMEOUT.as_millis()));
            }
        },
        _ = kill_rx => {
            runtime.child_killer.lock().await.take();
            let _ = child.kill().await;
            let _ = app.emit("translation:error", json!({ "error": "user cancelled", "page": page_num }));
            return Err("translation cancelled".into());
        }
    };

    runtime.child_killer.lock().await.take();
    let text = stdout_task.await.unwrap_or_default();
    let _ = stderr_task.await;

    if !exit.success() {
        let err = format!("gemini exited with code {:?}", exit.code());
        let _ = app.emit("translation:error", json!({ "error": err.clone(), "page": page_num }));
        return Err(err);
    }
    Ok(text)
}

pub async fn stop_translation(runtime: Arc<LearnRuntime>) -> Result<(), String> {
    runtime.request_stop().await;
    Ok(())
}
