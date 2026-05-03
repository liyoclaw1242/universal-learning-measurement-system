// Raw KB bank — durable, cross-project storage of learning resources
// imported via Chrome extension or PDF Learn. Lives under
// ~/.ulms-wiki/raw/<type>/<id>/.
//
// Each resource has a meta.yaml + a body file (content.md or
// transcript.md, plus optional thumbnails/images). The wiki concepts
// layer (synthesised by gemini) references these via run_id + ku_id
// today; future: also reference raw/<id>/ directly for provenance.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::wiki::resolve_wiki_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMeta {
    pub id: String,
    /// "article" | "youtube" | "paper" | "image" | "markdown"
    #[serde(rename = "type")]
    pub resource_type: String,
    pub source_url: String,
    pub title: String,
    pub captured_at: String,
    /// "chrome-ext" | "manual-upload" | "pdf-learn"
    pub captured_via: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quizzed_in: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_summary: Option<String>,
    #[serde(default)]
    pub verified: bool,
    // type-specific (skip when None)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

pub fn raw_root() -> PathBuf {
    resolve_wiki_dir().join("raw")
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains(' ')
    {
        return Err(format!("invalid id: {id:?}"));
    }
    Ok(())
}

pub async fn ensure_raw_root() -> Result<(), String> {
    let root = raw_root();
    for sub in ["articles", "youtube", "papers", "images", "markdown"] {
        let dir = root.join(sub);
        fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    Ok(())
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
    let truncated: String = trimmed.chars().take(60).collect();
    if truncated.is_empty() {
        format!("untitled-{}", &iso8601_now()[..10])
    } else {
        truncated
    }
}

// ─── article ingest ─────────────────────────────────────────

pub struct ArticleIngest {
    pub source_url: String,
    pub title: String,
    pub author: Option<String>,
    pub content_markdown: String,
}

pub async fn write_article(input: ArticleIngest) -> Result<RawMeta, String> {
    ensure_raw_root().await?;
    let id = slugify(&input.title);
    validate_id(&id)?;

    let dir = raw_root().join("articles").join(&id);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let char_count = input.content_markdown.chars().count();
    let meta = RawMeta {
        id: id.clone(),
        resource_type: "article".into(),
        source_url: input.source_url,
        title: input.title,
        captured_at: iso8601_now(),
        captured_via: "chrome-ext".into(),
        quizzed_in: vec![],
        verdict_summary: None,
        verified: false,
        char_count: Some(char_count),
        duration_s: None,
        channel: None,
        caption_lang: None,
        page_count: None,
        author: input.author,
    };
    write_meta(&dir, &meta).await?;
    fs::write(dir.join("content.md"), &input.content_markdown)
        .await
        .map_err(|e| format!("write content.md: {e}"))?;
    Ok(meta)
}

// ─── youtube ingest ─────────────────────────────────────────

pub struct YoutubeIngest {
    pub video_id: String,
    pub source_url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration_s: Option<u64>,
    pub caption_lang: Option<String>,
    pub transcript_markdown: String,
    /// optional cover thumbnail bytes (jpeg/png)
    pub thumbnail_bytes: Option<Vec<u8>>,
}

pub async fn write_youtube(input: YoutubeIngest) -> Result<RawMeta, String> {
    ensure_raw_root().await?;
    validate_id(&input.video_id)?;

    let dir = raw_root().join("youtube").join(&input.video_id);
    fs::create_dir_all(dir.join("thumbnails"))
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let char_count = input.transcript_markdown.chars().count();
    let meta = RawMeta {
        id: input.video_id.clone(),
        resource_type: "youtube".into(),
        source_url: input.source_url,
        title: input.title,
        captured_at: iso8601_now(),
        captured_via: "chrome-ext".into(),
        quizzed_in: vec![],
        verdict_summary: None,
        verified: false,
        char_count: Some(char_count),
        duration_s: input.duration_s,
        channel: input.channel,
        caption_lang: input.caption_lang,
        page_count: None,
        author: None,
    };
    write_meta(&dir, &meta).await?;
    fs::write(dir.join("transcript.md"), &input.transcript_markdown)
        .await
        .map_err(|e| format!("write transcript.md: {e}"))?;
    if let Some(bytes) = input.thumbnail_bytes {
        fs::write(dir.join("thumbnails").join("cover.jpg"), bytes)
            .await
            .map_err(|e| format!("write thumbnails/cover.jpg: {e}"))?;
    }
    Ok(meta)
}

// ─── markdown manual upload ────────────────────────────────

pub struct MarkdownIngest {
    pub source_url: String,
    pub title: String,
    pub content: String,
}

pub async fn write_markdown(input: MarkdownIngest) -> Result<RawMeta, String> {
    ensure_raw_root().await?;
    let id = slugify(&input.title);
    validate_id(&id)?;

    let dir = raw_root().join("markdown").join(&id);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let char_count = input.content.chars().count();
    let meta = RawMeta {
        id: id.clone(),
        resource_type: "markdown".into(),
        source_url: input.source_url,
        title: input.title,
        captured_at: iso8601_now(),
        captured_via: "manual-upload".into(),
        quizzed_in: vec![],
        verdict_summary: None,
        verified: false,
        char_count: Some(char_count),
        duration_s: None,
        channel: None,
        caption_lang: None,
        page_count: None,
        author: None,
    };
    write_meta(&dir, &meta).await?;
    fs::write(dir.join("body.md"), &input.content)
        .await
        .map_err(|e| format!("write body.md: {e}"))?;
    Ok(meta)
}

// ─── paper init (PDF Learn) ────────────────────────────────

pub struct PaperIngest {
    pub id: String,
    pub source_url: String,
    pub title: String,
}

/// Seed `~/.ulms-wiki/raw/papers/<id>/` with `meta.yaml` + an empty
/// `body.md`. Idempotent on the body — re-imports don't clobber an
/// in-progress translation. Returns the body path so the caller can
/// append per-page output as gemini produces it.
pub async fn init_paper_resource(
    input: PaperIngest,
) -> Result<(std::path::PathBuf, RawMeta), String> {
    ensure_raw_root().await?;
    validate_id(&input.id)?;

    let dir = raw_root().join("papers").join(&input.id);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let meta = RawMeta {
        id: input.id.clone(),
        resource_type: "paper".into(),
        source_url: input.source_url.clone(),
        title: input.title,
        captured_at: iso8601_now(),
        captured_via: "pdf-learn".into(),
        quizzed_in: vec![],
        verdict_summary: None,
        verified: false,
        char_count: None,
        duration_s: None,
        channel: None,
        caption_lang: None,
        page_count: None,
        author: None,
    };
    write_meta(&dir, &meta).await?;

    let body_path = dir.join("body.md");
    if !body_path.exists() {
        let header = format!(
            "# {}\n\nSource: {}\n\nCaptured: {}\n",
            meta.title, meta.source_url, meta.captured_at
        );
        fs::write(&body_path, &header)
            .await
            .map_err(|e| format!("write body.md: {e}"))?;
    }

    Ok((body_path, meta))
}

// ─── meta i/o ──────────────────────────────────────────────

async fn write_meta(dir: &std::path::Path, meta: &RawMeta) -> Result<(), String> {
    let yaml = serde_yaml::to_string(meta).map_err(|e| format!("serialize meta: {e}"))?;
    fs::write(dir.join("meta.yaml"), yaml)
        .await
        .map_err(|e| format!("write meta.yaml: {e}"))?;
    Ok(())
}

// ─── list resources ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RawResourceSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    pub source_url: String,
    pub title: String,
    pub captured_at: String,
    pub verified: bool,
    pub quizzed_count: usize,
}

pub async fn list_resources() -> Vec<RawResourceSummary> {
    let mut out = Vec::new();
    let root = raw_root();
    for sub in ["articles", "youtube", "papers", "images", "markdown"] {
        let dir = root.join(sub);
        let mut rd = match fs::read_dir(&dir).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let meta_path = p.join("meta.yaml");
            let Ok(yaml) = fs::read_to_string(&meta_path).await else {
                continue;
            };
            let Ok(meta) = serde_yaml::from_str::<RawMeta>(&yaml) else {
                continue;
            };
            out.push(RawResourceSummary {
                id: meta.id,
                resource_type: meta.resource_type,
                source_url: meta.source_url,
                title: meta.title,
                captured_at: meta.captured_at,
                verified: meta.verified,
                quizzed_count: meta.quizzed_in.len(),
            });
        }
    }
    out.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    out
}

// ─── read single resource ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RawResourceDetail {
    pub meta: RawMeta,
    /// Body file content — content.md for article/paper/markdown,
    /// transcript.md for youtube, may be empty for image-only entries.
    pub body: String,
    /// data: URL for the cover thumbnail (youtube) or the captured
    /// image (image type). None when no asset is on disk.
    pub thumbnail_data_url: Option<String>,
}

pub async fn read_resource(
    resource_type: &str,
    id: &str,
) -> Result<RawResourceDetail, String> {
    validate_id(id)?;
    let allowed = ["articles", "youtube", "papers", "images", "markdown"];
    if !allowed.contains(&resource_type) {
        return Err(format!("invalid type: {resource_type:?}"));
    }
    let dir = raw_root().join(resource_type).join(id);
    if !dir.is_dir() {
        return Err(format!("resource not found: {resource_type}/{id}"));
    }

    let yaml = fs::read_to_string(dir.join("meta.yaml"))
        .await
        .map_err(|e| format!("read meta.yaml: {e}"))?;
    let meta: RawMeta =
        serde_yaml::from_str(&yaml).map_err(|e| format!("parse meta.yaml: {e}"))?;

    // Body file location is type-dependent.
    let body_candidates: &[&str] = match resource_type {
        "youtube" => &["transcript.md"],
        _ => &["content.md", "body.md", "notes.md"],
    };
    let mut body = String::new();
    for name in body_candidates {
        if let Ok(s) = fs::read_to_string(dir.join(name)).await {
            body = s;
            break;
        }
    }

    // Cover thumbnail: youtube/<id>/thumbnails/cover.jpg, or for an
    // image resource the captured file itself (image.png / cover.jpg).
    let thumbnail_data_url = read_first_data_url(&[
        dir.join("thumbnails").join("cover.jpg"),
        dir.join("thumbnails").join("cover.png"),
        dir.join("image.png"),
        dir.join("image.jpg"),
        dir.join("cover.jpg"),
    ])
    .await;

    Ok(RawResourceDetail {
        meta,
        body,
        thumbnail_data_url,
    })
}

async fn read_first_data_url(paths: &[PathBuf]) -> Option<String> {
    use base64::Engine;
    for p in paths {
        if let Ok(bytes) = fs::read(p).await {
            let mime = match p.extension().and_then(|e| e.to_str()) {
                Some("png") => "image/png",
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                _ => "application/octet-stream",
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Some(format!("data:{mime};base64,{b64}"));
        }
    }
    None
}

pub async fn delete_resource(resource_type: &str, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let allowed = ["articles", "youtube", "papers", "images", "markdown"];
    if !allowed.contains(&resource_type) {
        return Err(format!("invalid type: {resource_type:?}"));
    }
    let dir = raw_root().join(resource_type).join(id);
    if !dir.is_dir() {
        return Err(format!("resource not found: {resource_type}/{id}"));
    }
    fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("rm -rf {}: {e}", dir.display()))?;
    Ok(())
}
