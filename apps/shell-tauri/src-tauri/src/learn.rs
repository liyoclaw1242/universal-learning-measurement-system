// Learning stage — PDF.js-driven per-page translation.
//
// Flow:
//   1. start_paper_session(url): downloads the PDF into
//      workspace/learn/<session>/source.pdf, returns the absolute path
//      so the renderer can feed PDF.js via convertFileSrc.
//   2. translate_page(page_num, image_b64): renderer renders one PDF
//      page to a canvas, base64-encodes it, calls this command. We
//      decode + write to workspace/learn/<session>/page-<n>.png and
//      spawn gemini-cli with `@<png>` to translate just that page.
//   3. import_as_material: stages the accumulated notes.md as
//      MaterialInput so the existing 4-agent pipeline can consume it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

use crate::types::{MaterialInput, StagedInputs};

const TRANSLATION_TIMEOUT: Duration = Duration::from_secs(300);
const PDF_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

// ─── runtime + session state ────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionState {
    pub id: String,
    pub source_url: String,
    /// Absolute path to the downloaded PDF (renderer feeds PDF.js with
    /// this via convertFileSrc).
    pub pdf_path: PathBuf,
    pub session_dir: PathBuf,
    pub notes_path: PathBuf,
    pub capture_count: u32,
}

#[derive(Default)]
pub struct LearnRuntime {
    pub current_session: Mutex<Option<SessionState>>,
    pub current_pid: Mutex<Option<u32>>,
    pub streaming: AtomicBool,
}

impl LearnRuntime {
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

// ─── helpers ────────────────────────────────────────────────

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

fn iso8601_now() -> String {
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

fn derive_material_filename(url: &str) -> String {
    if let Some(after) = url.split("arxiv.org/").nth(1) {
        let id = after
            .trim_start_matches("pdf/")
            .trim_start_matches("abs/")
            .trim_end_matches(".pdf");
        return format!("arxiv-{}-translated.md", id.replace('/', "-"));
    }
    "translated.md".to_string()
}

// ─── start session: download PDF ────────────────────────────

pub async fn start_paper_session(
    workspace_dir: PathBuf,
    runtime: Arc<LearnRuntime>,
    url: String,
) -> Result<SessionState, String> {
    // Replace any existing session: kill in-flight gemini, drop the
    // old SessionState. The renderer's _onPaperSessionStarted resets
    // captures/currentPage/totalPages cleanly, so switching papers is
    // a single click.
    runtime.request_stop().await;
    {
        let mut g = runtime.current_session.lock().await;
        *g = None;
    }

    // Reject obviously non-PDF URLs early. arxiv-style /pdf/ID is fine,
    // bare /abs/ID won't be a PDF.
    let url_l = url.to_lowercase();
    if !(url_l.contains("/pdf/")
        || url_l.ends_with(".pdf")
        || url_l.contains(".pdf?"))
    {
        return Err(format!(
            "expected a PDF URL (got '{url}'). For arxiv use the /pdf/ID link, not /abs/."
        ));
    }

    let session_id: String = Uuid::new_v4().simple().to_string()[..8].to_string();
    let session_dir = workspace_dir.join("learn").join(&session_id);
    tokio::fs::create_dir_all(&session_dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", session_dir.display()))?;

    let pdf_path = session_dir.join("source.pdf");

    // Download with reqwest (streaming, tolerant of slow connections).
    let client = reqwest::Client::builder()
        .timeout(PDF_DOWNLOAD_TIMEOUT)
        .user_agent("ULMS/1.0 (learning shell)")
        .build()
        .map_err(|e| format!("http client init: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("PDF download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("PDF download HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("PDF download read: {e}"))?;
    if bytes.is_empty() {
        return Err("PDF download returned empty body".into());
    }
    // Sanity-check magic header (%PDF).
    if !bytes.starts_with(b"%PDF") {
        return Err(format!(
            "downloaded file is not a PDF (magic header: {:?})",
            &bytes.get(..8).unwrap_or(&[])
        ));
    }
    tokio::fs::write(&pdf_path, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", pdf_path.display()))?;

    let notes_path = session_dir.join("notes.md");
    let header = format!(
        "# Translation notes — {url}\n\nSession `{session_id}` · {}\n\n",
        iso8601_now()
    );
    tokio::fs::write(&notes_path, &header)
        .await
        .map_err(|e| format!("write notes.md: {e}"))?;

    let session = SessionState {
        id: session_id,
        source_url: url,
        pdf_path,
        session_dir,
        notes_path,
        capture_count: 0,
    };

    {
        let mut g = runtime.current_session.lock().await;
        *g = Some(session.clone());
    }

    Ok(session)
}

// ─── translate one page ────────────────────────────────────

pub async fn translate_page(
    app: AppHandle,
    workspace_dir: PathBuf,
    runtime: Arc<LearnRuntime>,
    page_num: u32,
    image_b64: String,
) -> Result<u32, String> {
    if runtime.streaming.swap(true, Ordering::SeqCst) {
        return Err("a translation is already in progress".into());
    }

    let result = translate_page_inner(
        &app,
        &workspace_dir,
        &runtime,
        page_num,
        &image_b64,
    )
    .await;
    runtime.streaming.store(false, Ordering::SeqCst);

    match result {
        Ok(idx) => Ok(idx),
        Err(e) => {
            let _ = app.emit("translation:error", json!({ "error": e.clone() }));
            Err(e)
        }
    }
}

async fn translate_page_inner(
    app: &AppHandle,
    workspace_dir: &Path,
    runtime: &Arc<LearnRuntime>,
    page_num: u32,
    image_b64: &str,
) -> Result<u32, String> {
    let session = {
        let g = runtime.current_session.lock().await;
        g.clone().ok_or_else(|| "no active session".to_string())?
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_b64.trim())
        .map_err(|e| format!("base64 decode: {e}"))?;

    let image_path = session.session_dir.join(format!("page-{page_num}.png"));
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

    // gemini-cli supports `@<path>` references inline in the prompt.
    let prompt = format!(
        "請將下面這張 PDF 頁面截圖中的內容翻譯成繁體中文。\n\
         保留數學公式為 LaTeX (例如 $E=mc^2$ 或 $$ ... $$)。\n\
         圖表、表格只用一句話描述,不要逐行轉述數字。\n\
         輸出乾淨的 markdown,不要包含原文,不要包含任何 meta 說明。\n\
         \n\
         圖片:@{}",
        image_path.to_string_lossy()
    );

    let mut child = Command::new(gemini_bin())
        .args([
            "-y",
            "-o",
            "stream-json",
            "--include-directories",
            workspace_dir.to_str().unwrap_or("."),
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

    if let Some(pid) = child.id() {
        *runtime.current_pid.lock().await = Some(pid);
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
            match serde_json::from_str::<Value>(trimmed) {
                Ok(msg) => {
                    if msg.get("type").and_then(|v| v.as_str()) == Some("message") {
                        if msg.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                            if let Some(text) = msg.get("content").and_then(|v| v.as_str()) {
                                accumulated.push_str(text);
                            }
                        }
                    }
                    let _ = app_for_stdout.emit("translation:stream", json!({ "msg": msg }));
                }
                Err(_) => {
                    let _ = app_for_stdout.emit(
                        "translation:stream",
                        json!({ "msg": { "type": "raw", "line": trimmed } }),
                    );
                }
            }
        }
        accumulated
    });

    let app_for_stderr = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "translation:stream",
                json!({ "msg": { "type": "stderr", "line": line } }),
            );
        }
    });

    let exit_status_res = timeout(TRANSLATION_TIMEOUT, child.wait()).await;
    *runtime.current_pid.lock().await = None;

    let exit_status = match exit_status_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("gemini wait failed: {e}")),
        Err(_) => {
            return Err(format!(
                "translation timeout after {}ms",
                TRANSLATION_TIMEOUT.as_millis()
            ));
        }
    };

    let translation_text = stdout_task.await.unwrap_or_default();
    let _ = stderr_task.await;

    if !exit_status.success() {
        return Err(format!("gemini exited with code {:?}", exit_status.code()));
    }

    let header = format!("\n## Page {page_num} · {}\n\n", iso8601_now());
    let body = format!("{header}{}\n\n", translation_text.trim());
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&session.notes_path)
        .await
        .map_err(|e| format!("open notes.md: {e}"))?;
    file.write_all(body.as_bytes())
        .await
        .map_err(|e| format!("append notes.md: {e}"))?;

    let _ = app.emit(
        "translation:completed",
        json!({
            "capture_index": page_num,
            "image_path": image_path.to_string_lossy(),
            "text": translation_text,
            "notes_path": session.notes_path.to_string_lossy(),
        }),
    );

    Ok(page_num)
}

// ─── close session ─────────────────────────────────────────

pub async fn close_paper_session(
    app: AppHandle,
    runtime: Arc<LearnRuntime>,
) -> Result<(), String> {
    runtime.request_stop().await;
    let mut g = runtime.current_session.lock().await;
    *g = None;
    let _ = app.emit("paper-window:closed", json!({}));
    Ok(())
}

// ─── import accumulated translations as material ──────────

pub async fn import_as_material(
    workspace_dir: PathBuf,
    learn_runtime: Arc<LearnRuntime>,
    staged: &Mutex<StagedInputs>,
) -> Result<MaterialInput, String> {
    let session = {
        let g = learn_runtime.current_session.lock().await;
        g.clone().ok_or_else(|| "no active learning session".to_string())?
    };

    let content = tokio::fs::read_to_string(&session.notes_path)
        .await
        .map_err(|e| format!("read notes.md: {e}"))?;

    if content.trim().is_empty() || session.capture_count == 0 {
        return Err("no pages translated yet — capture something first".into());
    }

    let filename = derive_material_filename(&session.source_url);
    crate::inputs::copy_to_inputs_dir(&workspace_dir, &filename, &content).await?;

    let material = MaterialInput {
        filename: filename.clone(),
        content,
        content_type: "markdown".into(),
        sources: None,
    };

    {
        let mut g = staged.lock().await;
        g.material = Some(material.clone());
    }

    Ok(material)
}
