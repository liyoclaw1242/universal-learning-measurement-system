// Paper session lifecycle.
//
// Storage diverges from the old shell-tauri's learn.rs in one
// important way: there is no workspace/learn/<uuid>/ scratch dir.
// Everything writes directly into <wiki>/raw/papers/<paper-id>/:
//
//   raw/papers/arxiv-<id>/
//     meta.yaml
//     body.md                    ← per-page translation appends here
//     source.pdf                 ← downloaded PDF
//     pages/NNN.png              ← rendered page screenshots (gemini input)
//
// Session id == paper id (arxiv-<id> or slug from URL); re-opening
// the same arxiv URL resumes the existing folder rather than
// creating a new one.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::wiki_dir;

const PDF_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
pub struct SessionState {
    pub id: String,
    pub source_url: String,
    pub pdf_path: PathBuf,
    pub session_dir: PathBuf,
    pub body_path: PathBuf,
    pub capture_count: u32,
}

#[derive(Default)]
pub struct LearnRuntime {
    pub current_session: Mutex<Option<SessionState>>,
    pub child_killer: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl LearnRuntime {
    pub async fn request_stop(&self) {
        let mut g = self.child_killer.lock().await;
        if let Some(tx) = g.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ResumeResp {
    pub session: SessionState,
    pub captures: Vec<CaptureMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureMeta {
    pub index: u32,
    pub image_path: String,
    pub text: String,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaperSummary {
    pub id: String,
    pub title: String,
    pub source_url: String,
    pub captured_at: String,
    pub page_count: u32,
}

pub fn iso8601_now() -> String {
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

pub fn derive_paper_id(url: &str) -> String {
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
    let slug = slugify(tail);
    if slug.is_empty() {
        format!("paper-{}", &iso8601_now()[..10])
    } else {
        slug
    }
}

pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for c in s.chars() {
        let mapped = if c.is_ascii_alphanumeric() {
            prev_dash = false;
            Some(c.to_ascii_lowercase())
        } else if c == '-' || c == '_' {
            if prev_dash {
                None
            } else {
                prev_dash = true;
                Some('-')
            }
        } else if c.is_whitespace() || c == '/' || c == '.' || c == ':' {
            if prev_dash {
                None
            } else {
                prev_dash = true;
                Some('-')
            }
        } else {
            None
        };
        if let Some(m) = mapped {
            out.push(m);
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed.chars().take(60).collect()
}

pub async fn start_paper_session(
    app: AppHandle,
    runtime: Arc<LearnRuntime>,
    url: String,
) -> Result<SessionState, String> {
    runtime.request_stop().await;
    {
        let mut g = runtime.current_session.lock().await;
        *g = None;
    }

    let url_l = url.to_lowercase();
    if !(url_l.contains("/pdf/") || url_l.ends_with(".pdf") || url_l.contains(".pdf?")) {
        return Err(format!(
            "expected a PDF URL (got '{url}'). For arxiv use the /pdf/ID link, not /abs/."
        ));
    }

    let paper_id = derive_paper_id(&url);
    if paper_id.is_empty() {
        return Err(format!("could not derive paper id from {url}"));
    }

    let session_dir = wiki_dir::papers_dir().join(&paper_id);
    tokio::fs::create_dir_all(session_dir.join("pages"))
        .await
        .map_err(|e| format!("mkdir {}/pages: {e}", session_dir.display()))?;

    let pdf_path = session_dir.join("source.pdf");
    if !pdf_path.is_file() {
        let client = reqwest::Client::builder()
            .timeout(PDF_DOWNLOAD_TIMEOUT)
            .user_agent("ULMS-pdf-reader/1.0")
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
        if !bytes.starts_with(b"%PDF") {
            return Err(format!(
                "downloaded file is not a PDF (magic header: {:?})",
                &bytes.get(..8).unwrap_or(&[])
            ));
        }
        tokio::fs::write(&pdf_path, &bytes)
            .await
            .map_err(|e| format!("write {}: {e}", pdf_path.display()))?;
    }

    let body_path = session_dir.join("body.md");
    if !body_path.is_file() {
        let header = format!(
            "# {paper_id}\n\nSource: {url}\n\nCaptured: {}\n",
            iso8601_now()
        );
        tokio::fs::write(&body_path, &header)
            .await
            .map_err(|e| format!("write body.md: {e}"))?;
    }

    write_meta_yaml(&session_dir, &paper_id, &url).await?;

    let capture_count = count_existing_pages(&session_dir.join("pages")).await as u32;

    let session = SessionState {
        id: paper_id.clone(),
        source_url: url,
        pdf_path,
        session_dir,
        body_path,
        capture_count,
    };

    {
        let mut g = runtime.current_session.lock().await;
        *g = Some(session.clone());
    }

    let _ = app.emit(
        "raw:imported",
        serde_json::json!({
            "type": "paper",
            "id": session.id,
            "via": "pdf-reader",
        }),
    );

    Ok(session)
}

pub async fn close_paper_session(
    app: AppHandle,
    runtime: Arc<LearnRuntime>,
) -> Result<(), String> {
    runtime.request_stop().await;
    let mut g = runtime.current_session.lock().await;
    *g = None;
    let _ = app.emit("paper-window:closed", serde_json::json!({}));
    Ok(())
}

pub async fn resume_paper_session(
    runtime: Arc<LearnRuntime>,
    paper_id: String,
) -> Result<ResumeResp, String> {
    runtime.request_stop().await;
    {
        let mut g = runtime.current_session.lock().await;
        *g = None;
    }

    let session_dir = wiki_dir::papers_dir().join(&paper_id);
    if !session_dir.is_dir() {
        return Err(format!("paper '{paper_id}' not found in raw/papers/"));
    }
    let pdf_path = session_dir.join("source.pdf");
    if !pdf_path.is_file() {
        return Err(format!("paper '{paper_id}' has no source.pdf"));
    }
    let body_path = session_dir.join("body.md");
    let body = tokio::fs::read_to_string(&body_path).await.unwrap_or_default();
    let source_url = parse_source_url_from_body(&body).unwrap_or_default();
    let captures = parse_body_into_captures(&body, &session_dir);
    let capture_count = captures.iter().map(|c| c.index).max().unwrap_or(0);

    let session = SessionState {
        id: paper_id,
        source_url,
        pdf_path,
        session_dir,
        body_path,
        capture_count,
    };
    {
        let mut g = runtime.current_session.lock().await;
        *g = Some(session.clone());
    }
    Ok(ResumeResp { session, captures })
}

pub async fn list_papers() -> Vec<PaperSummary> {
    let papers = wiki_dir::papers_dir();
    let mut rd = match tokio::fs::read_dir(&papers).await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        let meta = read_meta_yaml(&p).await;
        let page_count = count_existing_pages(&p.join("pages")).await as u32;
        out.push(PaperSummary {
            id: id.clone(),
            title: meta.title.unwrap_or_else(|| id.clone()),
            source_url: meta.source_url.unwrap_or_default(),
            captured_at: meta.captured_at.unwrap_or_default(),
            page_count,
        });
    }
    out.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    out
}

pub async fn delete_paper(paper_id: String) -> Result<(), String> {
    if paper_id.is_empty() || paper_id.contains('/') || paper_id.contains("..") {
        return Err(format!("invalid paper id: {paper_id:?}"));
    }
    let dir = wiki_dir::papers_dir().join(&paper_id);
    if !dir.is_dir() {
        return Err(format!("paper '{paper_id}' not found"));
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("rm -rf {}: {e}", dir.display()))?;
    Ok(())
}

// ─── helpers ────────────────────────────────────────────────

pub async fn count_existing_pages(pages_dir: &std::path::Path) -> usize {
    let mut rd = match tokio::fs::read_dir(pages_dir).await {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let mut n: usize = 0;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".png") {
            n += 1;
        }
    }
    n
}

#[derive(Default)]
struct PaperMeta {
    title: Option<String>,
    source_url: Option<String>,
    captured_at: Option<String>,
}

async fn read_meta_yaml(dir: &std::path::Path) -> PaperMeta {
    let yaml = match tokio::fs::read_to_string(dir.join("meta.yaml")).await {
        Ok(s) => s,
        Err(_) => return PaperMeta::default(),
    };
    let v: serde_yaml::Value = match serde_yaml::from_str(&yaml) {
        Ok(v) => v,
        Err(_) => return PaperMeta::default(),
    };
    PaperMeta {
        title: v.get("title").and_then(|x| x.as_str()).map(|s| s.to_string()),
        source_url: v
            .get("source_url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        captured_at: v
            .get("captured_at")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    }
}

async fn write_meta_yaml(
    dir: &std::path::Path,
    id: &str,
    source_url: &str,
) -> Result<(), String> {
    let path = dir.join("meta.yaml");
    if path.is_file() {
        return Ok(()); // preserve existing meta on resume
    }
    let yaml = format!(
        "id: {id}\n\
         type: paper\n\
         source_url: {source_url}\n\
         title: {id}\n\
         captured_at: {ts}\n\
         captured_via: pdf-reader\n\
         verified: false\n",
        ts = iso8601_now(),
    );
    tokio::fs::write(&path, yaml)
        .await
        .map_err(|e| format!("write meta.yaml: {e}"))?;
    Ok(())
}

fn parse_source_url_from_body(body: &str) -> Option<String> {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("Source: ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

pub fn parse_body_into_captures(
    body: &str,
    session_dir: &std::path::Path,
) -> Vec<CaptureMeta> {
    let mut out: Vec<CaptureMeta> = Vec::new();
    let mut current_index: Option<u32> = None;
    let mut current_ts = String::new();
    let mut current_lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("## Page ") {
            if let Some(idx) = current_index.take() {
                let text = current_lines.join("\n").trim().to_string();
                let image_path = session_dir
                    .join("pages")
                    .join(format!("{idx:03}.png"))
                    .to_string_lossy()
                    .to_string();
                out.push(CaptureMeta {
                    index: idx,
                    image_path,
                    text,
                    ts: std::mem::take(&mut current_ts),
                });
                current_lines.clear();
            }
            let mut parts = rest.splitn(2, " · ");
            let num = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
            let ts = parts.next().unwrap_or("").trim().to_string();
            if let Some(n) = num {
                current_index = Some(n);
                current_ts = ts;
            }
        } else if current_index.is_some() {
            current_lines.push(line);
        }
    }
    if let Some(idx) = current_index.take() {
        let text = current_lines.join("\n").trim().to_string();
        let image_path = session_dir
            .join("pages")
            .join(format!("{idx:03}.png"))
            .to_string_lossy()
            .to_string();
        out.push(CaptureMeta {
            index: idx,
            image_path,
            text,
            ts: current_ts,
        });
    }
    out
}

/// Replace (or append) the section for `page_num` in `existing`.
/// Same upsert helper from the old learn.rs — drops legacy duplicates
/// of the same page so re-translation never stacks.
pub fn upsert_page_section(existing: &str, page_num: u32, new_section: &str) -> String {
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
