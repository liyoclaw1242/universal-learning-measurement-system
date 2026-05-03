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
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

use crate::types::{Dimension, MaterialInput, MaterialSource, StagedInputs};

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
    /// Stable id for the corresponding `~/.ulms-wiki/raw/papers/<id>/`
    /// resource (e.g. `arxiv-2401.12345`). Lets the Wiki Raw view see
    /// the paper as soon as the session starts.
    pub raw_paper_id: String,
    /// Mirror path for body.md inside the raw bank — every page
    /// translation appends here in addition to `notes_path` so the
    /// wiki body stays current without a separate import step.
    pub raw_body_path: PathBuf,
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

/// Stable id for the raw/papers/<id>/ folder. arxiv URLs collapse to
/// `arxiv-<id>` (so re-imports of the same paper merge into the same
/// resource); other PDF URLs slug the trailing filename. `slugify`
/// already enforces the validator's no-slash / no-space invariants.
fn derive_paper_id(url: &str) -> String {
    if let Some(after) = url.split("arxiv.org/").nth(1) {
        let id = after
            .trim_start_matches("pdf/")
            .trim_start_matches("abs/")
            .split('?')
            .next()
            .unwrap_or("")
            .trim_end_matches(".pdf");
        if !id.is_empty() {
            return format!("arxiv-{}", id.replace('/', "-"));
        }
    }
    let tail = url
        .rsplit('/')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or("")
        .trim_end_matches(".pdf");
    let slug = crate::raw_bank::slugify(tail);
    if slug.starts_with("untitled-") {
        format!("paper-{}", &slug[9..])
    } else {
        slug
    }
}

// ─── start session: download PDF ────────────────────────────

pub async fn start_paper_session(
    app: AppHandle,
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

    // Mirror into ~/.ulms-wiki/raw/papers/<id>/ so the resource is
    // visible in the Wiki Raw view from the moment the session starts.
    // Re-imports of the same arxiv id merge into the existing folder
    // (init_paper_resource skips body.md when present).
    let raw_paper_id = derive_paper_id(&url);
    let raw_title = derive_paper_id(&url).replacen("arxiv-", "arXiv ", 1);
    let (raw_body_path, _raw_meta) =
        crate::raw_bank::init_paper_resource(crate::raw_bank::PaperIngest {
            id: raw_paper_id.clone(),
            source_url: url.clone(),
            title: raw_title,
        })
        .await?;

    let session = SessionState {
        id: session_id,
        source_url: url,
        pdf_path,
        session_dir,
        notes_path,
        capture_count: 0,
        raw_paper_id,
        raw_body_path,
    };

    {
        let mut g = runtime.current_session.lock().await;
        *g = Some(session.clone());
    }

    let _ = app.emit(
        "raw:imported",
        json!({
            "type": "paper",
            "id": session.raw_paper_id,
            "via": "pdf-learn",
        }),
    );

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

    // Re-translation replaces the prior section instead of stacking.
    let existing_notes = tokio::fs::read_to_string(&session.notes_path)
        .await
        .map_err(|e| format!("read notes.md: {e}"))?;
    let updated_notes = upsert_page_section(&existing_notes, page_num, &body);
    tokio::fs::write(&session.notes_path, updated_notes)
        .await
        .map_err(|e| format!("write notes.md: {e}"))?;

    // Mirror into ~/.ulms-wiki/raw/papers/<id>/body.md with the same
    // upsert semantics so the wiki body matches notes.md exactly.
    // Failures here are non-fatal — workspace notes.md is the source
    // of truth for resume.
    if let Ok(existing_raw) = tokio::fs::read_to_string(&session.raw_body_path).await {
        let updated_raw = upsert_page_section(&existing_raw, page_num, &body);
        if tokio::fs::write(&session.raw_body_path, updated_raw)
            .await
            .is_ok()
        {
            let _ = app.emit(
                "raw:imported",
                json!({
                    "type": "paper",
                    "id": session.raw_paper_id,
                    "via": "pdf-learn",
                }),
            );
        }
    }

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

// ─── dimension CRUD (for the inline editor) ────────────────

pub async fn get_staged_dimensions(staged: &Mutex<StagedInputs>) -> Vec<Dimension> {
    let g = staged.lock().await;
    g.dimensions.clone().unwrap_or_default()
}

pub async fn update_staged_dimensions(
    workspace_dir: &Path,
    staged: &Mutex<StagedInputs>,
    dimensions: Vec<Dimension>,
) -> Result<usize, String> {
    if dimensions.is_empty() {
        return Err("dimensions list is empty".into());
    }
    // Validate unique dim_id and non-empty fields.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (i, d) in dimensions.iter().enumerate() {
        if d.dim_id.trim().is_empty() {
            return Err(format!("row {}: dim_id is empty", i + 1));
        }
        if d.name.trim().is_empty() {
            return Err(format!("row {} ({}): name is empty", i + 1, d.dim_id));
        }
        if !seen.insert(d.dim_id.as_str()) {
            return Err(format!("duplicate dim_id: {}", d.dim_id));
        }
    }

    {
        let mut g = staged.lock().await;
        g.dimensions = Some(dimensions.clone());
    }

    let yaml_dump = serde_yaml::to_string(&serde_json::json!({
        "dimensions": dimensions,
    }))
    .unwrap_or_default();
    let _ =
        crate::inputs::copy_to_inputs_dir(workspace_dir, "edited-dimensions.yaml", &yaml_dump)
            .await;
    Ok(dimensions.len())
}

// ─── auto-generate competency dimensions ───────────────────

const DIMENSIONS_PROMPT: &str = r#"你的任務:從以下教材內容,抽出 5-7 個能力維度 (competency dimensions),用於後續評量設計。

每個維度需有三個欄位:
- dim_id: snake_case 識別碼,英文 (例: spatial_reasoning, gradient_descent_intuition)
- name: 簡短中文名稱 (5-15 字)
- description: 該維度具體描述 (30-80 字),說明學習者應達成的理解程度與可觀察行為

維度間應彼此正交、覆蓋教材的不同層面 (概念辨識 / 因果推理 / 應用遷移 / 計算操作 等)。

輸出必須是純 YAML,絕對不要任何說明文字、不要 markdown code fence 例如 ```yaml。

範例輸出格式:

dimensions:
  - dim_id: example_one
    name: 範例維度一
    description: 學習者應能...
  - dim_id: example_two
    name: 範例維度二
    description: 學習者應能...

教材內容如下:
---
"#;

#[derive(serde::Deserialize)]
struct DimensionsYaml {
    dimensions: Vec<Dimension>,
}

fn strip_markdown_fences(s: &str) -> &str {
    let trimmed = s.trim();
    // Strip ```yaml ... ``` or ``` ... ``` if present
    if let Some(rest) = trimmed.strip_prefix("```yaml") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    trimmed
}

pub async fn generate_dimensions(
    app: AppHandle,
    workspace_dir: PathBuf,
    staged: &Mutex<StagedInputs>,
) -> Result<Vec<Dimension>, String> {
    let material_content = {
        let g = staged.lock().await;
        g.material
            .as_ref()
            .ok_or_else(|| "no material staged — load or import material first".to_string())?
            .content
            .clone()
    };

    if material_content.trim().is_empty() {
        return Err("staged material is empty".into());
    }

    // Cap absurdly large papers so the prompt fits within reasonable
    // gemini context. 200k chars (~50k tokens) is plenty for a paper.
    let truncated = if material_content.chars().count() > 200_000 {
        material_content.chars().take(200_000).collect::<String>()
    } else {
        material_content.clone()
    };

    let prompt = format!("{DIMENSIONS_PROMPT}{truncated}\n---\n");

    let _ = app.emit("dimensions:generating", json!({}));

    // Plain text output (no stream-json) — we just need the final YAML.
    let output = Command::new(gemini_bin())
        .args(["-y", "-p", &prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("gemini spawn: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "gemini exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let yaml_str = strip_markdown_fences(&raw);
    let parsed: DimensionsYaml = serde_yaml::from_str(yaml_str).map_err(|e| {
        format!("parse YAML: {e}\nLLM output was:\n{}\n", raw.chars().take(500).collect::<String>())
    })?;

    if parsed.dimensions.is_empty() {
        return Err("LLM returned no dimensions".into());
    }

    // Stage them.
    {
        let mut g = staged.lock().await;
        g.dimensions = Some(parsed.dimensions.clone());
    }

    // Persist a copy to workspace/inputs/auto-dimensions.yaml so the
    // user can edit/version-control it later.
    let yaml_dump = serde_yaml::to_string(&serde_json::json!({
        "dimensions": parsed.dimensions,
    }))
    .unwrap_or_else(|_| String::new());
    let _ = crate::inputs::copy_to_inputs_dir(&workspace_dir, "auto-dimensions.yaml", &yaml_dump)
        .await;

    let _ = app.emit("dimensions:generated", json!({ "count": parsed.dimensions.len() }));

    Ok(parsed.dimensions)
}

// ─── list / resume past sessions ───────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LearnSessionMeta {
    pub id: String,
    pub source_url: Option<String>,
    pub capture_count: u32,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranslationCaptureMeta {
    pub index: u32,
    pub image_path: String,
    pub text: String,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResumeResp {
    pub session: SessionState,
    pub captures: Vec<TranslationCaptureMeta>,
}

fn parse_source_url_from_notes(notes: &str) -> Option<String> {
    // First line is "# Translation notes — <url>".
    let first = notes.lines().next()?;
    let prefix = "# Translation notes — ";
    first.strip_prefix(prefix).map(|s| s.trim().to_string())
}

/// Replace (or append) the section for `page_num` in `existing`.
/// Sections are delimited by `## Page <N> ·` headers. Re-translation
/// must not stack — the new content fully supplants the prior one,
/// and any legacy duplicates of the same page are also dropped.
fn upsert_page_section(existing: &str, page_num: u32, new_section: &str) -> String {
    let target_prefix = format!("## Page {page_num} ·");
    let mut out = String::with_capacity(existing.len() + new_section.len());
    let mut skip = false;
    let mut replaced = false;
    for line in existing.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let is_section_header = trimmed.starts_with("## Page ");
        let is_target_header = trimmed.starts_with(&target_prefix);
        if is_section_header {
            if is_target_header {
                if !replaced {
                    out.push_str(new_section);
                    replaced = true;
                }
                skip = true;
                continue;
            }
            skip = false;
        }
        if !skip {
            out.push_str(line);
        }
    }
    if !replaced {
        out.push_str(new_section);
    }
    out
}

/// Parse notes.md into per-page sections. Sections start with
/// "## Page N · timestamp" and the body is everything until the next
/// such header. Pages without a header are ignored.
fn parse_notes_into_captures(notes: &str, session_dir: &Path) -> Vec<TranslationCaptureMeta> {
    let mut out: Vec<TranslationCaptureMeta> = Vec::new();
    let mut current_index: Option<u32> = None;
    let mut current_ts = String::new();
    let mut current_body: Vec<&str> = Vec::new();
    for line in notes.lines() {
        if let Some(rest) = line.strip_prefix("## Page ") {
            // Flush previous section
            if let Some(idx) = current_index.take() {
                let text = current_body.join("\n").trim().to_string();
                let image_path = session_dir
                    .join(format!("page-{idx}.png"))
                    .to_string_lossy()
                    .into_owned();
                out.push(TranslationCaptureMeta {
                    index: idx,
                    image_path,
                    text,
                    ts: std::mem::take(&mut current_ts),
                });
                current_body.clear();
            }
            // Parse "N · timestamp"
            let mut parts = rest.splitn(2, " · ");
            let num = parts
                .next()
                .and_then(|s| s.trim().parse::<u32>().ok());
            let ts = parts.next().unwrap_or("").trim().to_string();
            if let Some(n) = num {
                current_index = Some(n);
                current_ts = ts;
            }
        } else if current_index.is_some() {
            current_body.push(line);
        }
    }
    if let Some(idx) = current_index.take() {
        let text = current_body.join("\n").trim().to_string();
        let image_path = session_dir
            .join(format!("page-{idx}.png"))
            .to_string_lossy()
            .into_owned();
        out.push(TranslationCaptureMeta {
            index: idx,
            image_path,
            text,
            ts: current_ts,
        });
    }
    out
}

fn iso8601_from_systemtime(t: SystemTime) -> String {
    let dur = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
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

pub async fn list_learn_sessions(workspace_dir: &Path) -> Vec<LearnSessionMeta> {
    let learn_root = workspace_dir.join("learn");
    let mut entries: Vec<LearnSessionMeta> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&learn_root).await {
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
        let notes_path = path.join("notes.md");
        let notes = match tokio::fs::read_to_string(&notes_path).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let source_url = parse_source_url_from_notes(&notes);
        let mut capture_count: u32 = 0;
        if let Ok(mut rd2) = tokio::fs::read_dir(&path).await {
            while let Ok(Some(file)) = rd2.next_entry().await {
                let n = file
                    .file_name()
                    .to_string_lossy()
                    .into_owned();
                if n.starts_with("page-") && n.ends_with(".png") {
                    capture_count += 1;
                }
            }
        }
        let modified_at = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .map(iso8601_from_systemtime)
            .unwrap_or_default();
        entries.push(LearnSessionMeta {
            id,
            source_url,
            capture_count,
            modified_at,
        });
    }
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    entries
}

pub async fn delete_learn_session(
    app: AppHandle,
    workspace_dir: PathBuf,
    runtime: Arc<LearnRuntime>,
    session_id: String,
) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(format!("invalid session id: {session_id:?}"));
    }
    let session_dir = workspace_dir.join("learn").join(&session_id);
    if !session_dir.is_dir() {
        return Err(format!("session '{session_id}' not found"));
    }

    // If we're deleting the active session, kill any in-flight gemini
    // and clear runtime so the renderer state stays consistent.
    let is_active = {
        let g = runtime.current_session.lock().await;
        g.as_ref().map(|s| s.id == session_id).unwrap_or(false)
    };
    if is_active {
        runtime.request_stop().await;
        let mut g = runtime.current_session.lock().await;
        *g = None;
        let _ = app.emit("paper-window:closed", json!({}));
    }

    tokio::fs::remove_dir_all(&session_dir)
        .await
        .map_err(|e| format!("rm -rf {}: {e}", session_dir.display()))?;
    Ok(())
}

pub async fn resume_learn_session(
    workspace_dir: PathBuf,
    runtime: Arc<LearnRuntime>,
    session_id: String,
) -> Result<ResumeResp, String> {
    // Cancel any in-flight gemini, drop existing session.
    runtime.request_stop().await;
    {
        let mut g = runtime.current_session.lock().await;
        *g = None;
    }

    let session_dir = workspace_dir.join("learn").join(&session_id);
    if !session_dir.is_dir() {
        return Err(format!("session '{session_id}' not found"));
    }
    let pdf_path = session_dir.join("source.pdf");
    if !pdf_path.is_file() {
        return Err(format!("session '{session_id}' has no source.pdf"));
    }
    let notes_path = session_dir.join("notes.md");
    let notes = tokio::fs::read_to_string(&notes_path)
        .await
        .map_err(|e| format!("read notes.md: {e}"))?;
    let source_url = parse_source_url_from_notes(&notes).unwrap_or_default();
    let captures = parse_notes_into_captures(&notes, &session_dir);
    let capture_count = captures.iter().map(|c| c.index).max().unwrap_or(0);

    // Resume — re-init the raw resource (idempotent) so Wiki Raw stays
    // consistent even for sessions started before this lane existed.
    let raw_paper_id = derive_paper_id(&source_url);
    let raw_title = raw_paper_id.replacen("arxiv-", "arXiv ", 1);
    let (raw_body_path, _) =
        crate::raw_bank::init_paper_resource(crate::raw_bank::PaperIngest {
            id: raw_paper_id.clone(),
            source_url: source_url.clone(),
            title: raw_title,
        })
        .await?;

    let session = SessionState {
        id: session_id,
        source_url,
        pdf_path,
        session_dir,
        notes_path,
        capture_count,
        raw_paper_id,
        raw_body_path,
    };
    {
        let mut g = runtime.current_session.lock().await;
        *g = Some(session.clone());
    }
    Ok(ResumeResp { session, captures })
}

// ─── import accumulated translations as material ──────────

/// Bulk import: take a set of session ids, concatenate their notes.md
/// with HTML-comment file separators (mirrors the multi-file material
/// upload format), stage as a single MaterialInput.sources entry list.
pub async fn import_sessions_as_material(
    workspace_dir: PathBuf,
    staged: &Mutex<StagedInputs>,
    session_ids: Vec<String>,
) -> Result<MaterialInput, String> {
    if session_ids.is_empty() {
        return Err("no sessions selected".into());
    }
    let mut sources: Vec<MaterialSource> = Vec::with_capacity(session_ids.len());
    let mut parts: Vec<(String, String)> = Vec::with_capacity(session_ids.len());

    for id in &session_ids {
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(format!("invalid session id: {id:?}"));
        }
        let notes_path = workspace_dir.join("learn").join(id).join("notes.md");
        let content = tokio::fs::read_to_string(&notes_path)
            .await
            .map_err(|e| format!("read {id}/notes.md: {e}"))?;
        if content.trim().is_empty() {
            // Skip empty sessions silently.
            continue;
        }
        let url = parse_source_url_from_notes(&content).unwrap_or_default();
        let filename = if url.is_empty() {
            format!("{id}-translated.md")
        } else {
            derive_material_filename(&url)
        };
        sources.push(MaterialSource {
            filename: filename.clone(),
            char_count: content.chars().count(),
        });
        parts.push((filename, content));
    }

    if sources.is_empty() {
        return Err("all selected sessions are empty (no translations yet)".into());
    }

    let joined = if parts.len() == 1 {
        parts[0].1.clone()
    } else {
        parts
            .iter()
            .map(|(name, content)| {
                format!("<!-- === FILE: {name} === -->\n\n{}\n", content.trim_end())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Combined filename for the inputs/ copy: short label for single,
    // generic bundle name for multi.
    let combined_filename = if sources.len() == 1 {
        sources[0].filename.clone()
    } else {
        format!("learn-bundle-{}-papers.md", sources.len())
    };
    crate::inputs::copy_to_inputs_dir(&workspace_dir, &combined_filename, &joined).await?;

    // UI display label (matches inputs::build_combined_filename style)
    let display_filename = match sources.len() {
        1 => sources[0].filename.clone(),
        2 => format!("{} + {}", sources[0].filename, sources[1].filename),
        n => format!("{} + {} others", sources[0].filename, n - 1),
    };

    let material = MaterialInput {
        filename: display_filename,
        content: joined,
        content_type: "markdown".into(),
        sources: if sources.len() > 1 { Some(sources) } else { None },
    };
    {
        let mut g = staged.lock().await;
        g.material = Some(material.clone());
    }
    Ok(material)
}

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
