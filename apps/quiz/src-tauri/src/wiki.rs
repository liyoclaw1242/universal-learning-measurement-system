// Wiki synthesis — Phase 2 v0.
//
// Reads workspace/runs/*/blackboard.json (the raw KB layer), groups
// KUs across runs into concepts via a single gemini call, writes one
// markdown page per concept into ~/.ulms-wiki/concepts/. Updates
// INDEX.md. Uses git for the wiki repo so the user can audit / share.
//
// Phase 3 will add local embedding-driven clustering for incremental
// updates; for now we re-synthesise from all runs each call.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

const SYNTH_TIMEOUT: Duration = Duration::from_secs(900);

// ─── path resolution ────────────────────────────────────────

pub fn resolve_wiki_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ULMS_WIKI_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".ulms-wiki")
}

#[derive(Debug, Clone, Serialize)]
pub struct McpSetup {
    pub mcp_binary_path: String,
    pub binary_exists: bool,
    pub wiki_dir: String,
    pub workspace_dir: String,
    pub claude_desktop_config_path: String,
    pub config_snippet: String,
}

// ─── wiki browse / read / write (for the in-app Wiki tab) ──

#[derive(Debug, Clone, Serialize)]
pub struct WikiConceptMeta {
    pub slug: String,
    pub title: String,
    pub tags: Vec<String>,
    pub human_edited: bool,
    pub last_synthesized: String,
}

fn parse_concept_meta(path: &Path) -> Option<WikiConceptMeta> {
    let content = std::fs::read_to_string(path).ok()?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(String::from)
        .unwrap_or_default();
    let mut title = stem.clone();
    let mut tags: Vec<String> = Vec::new();
    let mut human_edited = false;
    let mut last_synthesized = String::new();
    let mut in_fm = false;
    for line in content.lines() {
        if line.starts_with("---") {
            if in_fm {
                break;
            }
            in_fm = true;
            continue;
        }
        if !in_fm {
            continue;
        }
        if let Some(rest) = line.strip_prefix("title: ") {
            title = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("tags: ") {
            let raw = rest.trim();
            if let Some(inner) = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                tags = inner
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        } else if let Some(rest) = line.strip_prefix("human_edited: ") {
            human_edited = rest.trim() == "true";
        } else if let Some(rest) = line.strip_prefix("last_synthesized: ") {
            last_synthesized = rest.trim().to_string();
        }
    }
    Some(WikiConceptMeta {
        slug: stem,
        title,
        tags,
        human_edited,
        last_synthesized,
    })
}

pub async fn list_wiki_concepts() -> Result<Vec<WikiConceptMeta>, String> {
    let dir = resolve_wiki_dir().join("concepts");
    let mut metas: Vec<WikiConceptMeta> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return Ok(metas),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(m) = parse_concept_meta(&p) {
            metas.push(m);
        }
    }
    metas.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(metas)
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(format!("invalid slug: {slug:?}"));
    }
    Ok(())
}

pub async fn read_wiki_concept(slug: &str) -> Result<String, String> {
    validate_slug(slug)?;
    let path = resolve_wiki_dir().join("concepts").join(format!("{slug}.md"));
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))
}

/// Writes the user's edited content for a concept. Always forces
/// `human_edited: true` in the frontmatter so future re-synthesise
/// passes leave it alone.
pub async fn write_wiki_concept(slug: &str, body: &str) -> Result<(), String> {
    validate_slug(slug)?;
    let dir = resolve_wiki_dir().join("concepts");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{slug}.md"));

    let final_body = ensure_human_edited_flag(body);
    tokio::fs::write(&path, final_body)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn ensure_human_edited_flag(content: &str) -> String {
    // Find frontmatter block.
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        // No frontmatter; prepend a minimal one.
        return format!("---\nhuman_edited: true\n---\n\n{content}");
    }
    // Walk lines: copy frontmatter with human_edited: true forced;
    // copy body verbatim afterwards.
    let mut out = String::with_capacity(content.len() + 32);
    let mut in_fm = false;
    let mut fm_done = false;
    let mut saw_flag = false;
    for line in content.lines() {
        if !fm_done && line.starts_with("---") {
            if !in_fm {
                in_fm = true;
                out.push_str("---\n");
                continue;
            } else {
                if !saw_flag {
                    out.push_str("human_edited: true\n");
                }
                out.push_str("---\n");
                fm_done = true;
                continue;
            }
        }
        if in_fm && !fm_done {
            if line.starts_with("human_edited:") {
                out.push_str("human_edited: true\n");
                saw_flag = true;
            } else {
                out.push_str(line);
                out.push('\n');
            }
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

pub fn mcp_setup_info(workspace_dir: &Path) -> McpSetup {
    let wiki_dir = resolve_wiki_dir();
    // workspace_dir is canonicalized at startup → e.g. apps/shell/workspace.
    // mcp binary lives at apps/mcp/target/release/ulms-mcp (sibling app).
    let mcp_path = workspace_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("mcp").join("target").join("release").join("ulms-mcp"))
        .unwrap_or_else(|| PathBuf::from("ulms-mcp"));

    let home = std::env::var("HOME").unwrap_or_default();
    let claude_cfg = format!(
        "{home}/Library/Application Support/Claude/claude_desktop_config.json"
    );

    let snippet = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "ulms": {
                "command": mcp_path.to_string_lossy(),
                "env": {
                    "ULMS_WIKI_DIR": wiki_dir.to_string_lossy(),
                    "ULMS_WORKSPACE_DIR": workspace_dir.to_string_lossy(),
                }
            }
        }
    }))
    .unwrap_or_default();

    McpSetup {
        mcp_binary_path: mcp_path.to_string_lossy().into_owned(),
        binary_exists: mcp_path.is_file(),
        wiki_dir: wiki_dir.to_string_lossy().into_owned(),
        workspace_dir: workspace_dir.to_string_lossy().into_owned(),
        claude_desktop_config_path: claude_cfg,
        config_snippet: snippet,
    }
}

async fn ensure_wiki_repo(wiki_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(wiki_dir.join("concepts"))
        .await
        .map_err(|e| format!("mkdir concepts: {e}"))?;

    if !wiki_dir.join(".git").is_dir() {
        // Best-effort git init — wiki still works without git, but
        // version control is the whole point.
        let _ = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(wiki_dir)
            .status();
    }

    let readme = wiki_dir.join("README.md");
    if !readme.exists() {
        let body = "# ULMS Wiki\n\n\
                    這是由 ULMS Quiz 累積的 raw runs 自動合成的知識庫。\n\n\
                    結構:\n\
                    - `concepts/` — 跨 run 合併同概念的規範頁\n\
                    - `INDEX.md` — 全部頁面索引\n\n\
                    每個 concept 頁的 frontmatter 內 `sources` 欄位指回 raw runs。\n\
                    人類編輯後請把 `human_edited` 設為 `true`,re-synth 不會覆蓋。\n";
        fs::write(&readme, body)
            .await
            .map_err(|e| format!("write README.md: {e}"))?;
    }
    Ok(())
}

// ─── KU collection ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct KuRef {
    run_id: String,
    ku_id: String,
    /// Best-effort short descriptor — pulled from the KU's `concept`
    /// or `summary` if present, else the first ~80 chars of source_excerpt.
    descriptor: String,
    source_excerpt: String,
    dimension_ids: Vec<String>,
}

async fn read_blackboard_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

async fn collect_kus(workspace_dir: &Path) -> Result<Vec<KuRef>, String> {
    let runs_root = workspace_dir.join("runs");
    let mut out: Vec<KuRef> = Vec::new();

    let mut rd = match fs::read_dir(&runs_root).await {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let run_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let bb_path = path.join("blackboard.json");
        let Some(bb) = read_blackboard_json(&bb_path).await else {
            continue;
        };

        // ku_to_dimensions is { ku_id: [dim_id, ...] }
        let ku_to_dim: std::collections::HashMap<String, Vec<String>> = bb
            .get("data")
            .and_then(|d| d.get("mapping"))
            .and_then(|m| m.get("ku_to_dimensions"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| {
                        let dims: Vec<String> = v
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        (k.clone(), dims)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let kus = bb
            .get("data")
            .and_then(|d| d.get("knowledge_units"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for ku in kus {
            let ku_id = ku
                .get("ku_id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("anon-{}", out.len()));
            let source_excerpt = ku
                .get("source_excerpt")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_default();
            let descriptor = ku
                .get("concept")
                .or_else(|| ku.get("summary"))
                .or_else(|| ku.get("name"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| {
                    source_excerpt.chars().take(80).collect::<String>()
                });
            let dim_ids = ku_to_dim.get(&ku_id).cloned().unwrap_or_default();

            out.push(KuRef {
                run_id: run_id.clone(),
                ku_id,
                descriptor,
                source_excerpt,
                dimension_ids: dim_ids,
            });
        }
    }
    Ok(out)
}

// ─── synthesis ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LlmSourceRef {
    run: String,
    ku: String,
}

#[derive(Debug, Deserialize)]
struct LlmConcept {
    slug: String,
    title: String,
    body: String,
    #[serde(default)]
    sources: Vec<LlmSourceRef>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LlmConceptsResp {
    concepts: Vec<LlmConcept>,
}

fn build_synthesis_prompt(kus: &[KuRef]) -> String {
    let kus_json = serde_json::to_string_pretty(kus).unwrap_or_default();
    format!(
        "你是知識庫整理員。下面是多個 quiz run 累積出的知識單元 (KU) 列表。\n\
         請將它們聚合成 5-20 個核心概念 (concept),每個 concept 對應一個明確、可學習的單元。\n\
         \n\
         要求:\n\
         1. 跨 run 重複出現的 KU 必須合併到同一 concept\n\
         2. 每個 concept 用繁體中文撰寫 wiki 內文,200-400 字\n\
         3. body 結構建議: 「定義 / 機制或原理 / 可觀察行為 / 常見誤解」\n\
         4. slug 用 snake_case 英文 (例:backpropagation, attention_softmax)\n\
         5. 在 sources 欄位列出貢獻此 concept 的 KU(以 run_id + ku_id 為單位)\n\
         6. tags 用 snake_case 英文,給 2-5 個\n\
         \n\
         輸入 KUs (每筆有 run_id, ku_id, descriptor, source_excerpt, dimension_ids):\n\
         ```json\n\
         {kus_json}\n\
         ```\n\
         \n\
         輸出格式必須是純 JSON,絕對不要 markdown code fence,不要任何說明文字。\n\
         範例 (僅供格式參考,實際內容請依輸入產生):\n\
         {{\n\
         \"concepts\": [\n\
         {{\n\
         \"slug\": \"backpropagation\",\n\
         \"title\": \"反向傳播\",\n\
         \"body\": \"反向傳播 (backpropagation) 是訓練神經網路時計算梯度的演算法...\",\n\
         \"sources\": [\n\
         {{\"run\": \"20260503-143052-paper-a\", \"ku\": \"ku_001\"}},\n\
         {{\"run\": \"20260502-101230-paper-b\", \"ku\": \"ku_003\"}}\n\
         ],\n\
         \"tags\": [\"neural_networks\", \"optimization\", \"calculus\"]\n\
         }}\n\
         ]\n\
         }}\n"
    )
}

fn strip_json_fences(s: &str) -> &str {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    trimmed
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

fn render_concept_md(c: &LlmConcept) -> String {
    let mut sources_yaml = String::new();
    // Group sources by run for readable yaml.
    let mut by_run: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    for s in &c.sources {
        by_run.entry(s.run.as_str()).or_default().push(s.ku.as_str());
    }
    for (run, kus) in &by_run {
        sources_yaml.push_str(&format!(
            "  - run: {run}\n    kus: [{}]\n",
            kus.join(", ")
        ));
    }
    if sources_yaml.is_empty() {
        sources_yaml = "  []\n".into();
    }

    let tags_yaml = if c.tags.is_empty() {
        "[]".into()
    } else {
        format!("[{}]", c.tags.join(", "))
    };

    format!(
        "---\n\
         title: {title}\n\
         slug: {slug}\n\
         type: concept\n\
         sources:\n{sources}\
         last_synthesized: {ts}\n\
         synthesizer: gemini\n\
         human_edited: false\n\
         tags: {tags}\n\
         ---\n\n\
         # {title}\n\n\
         {body}\n\n\
         ## Sources\n\n\
         {sources_md}\n",
        title = c.title,
        slug = c.slug,
        sources = sources_yaml,
        ts = iso8601_now(),
        tags = tags_yaml,
        body = c.body.trim(),
        sources_md = if by_run.is_empty() {
            "_(no sources)_".to_string()
        } else {
            by_run
                .iter()
                .map(|(run, kus)| format!("- `{run}` · {} KU{}", kus.len(), if kus.len() == 1 { "" } else { "s" }))
                .collect::<Vec<_>>()
                .join("\n")
        }
    )
}

async fn render_index(wiki_dir: &Path) -> Result<(), String> {
    let concepts_dir = wiki_dir.join("concepts");
    let mut entries: Vec<(String, String)> = Vec::new(); // (slug, title)
    if let Ok(mut rd) = fs::read_dir(&concepts_dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(String::from)
                .unwrap_or_default();
            // Pull title from frontmatter if available.
            let title = if let Ok(content) = fs::read_to_string(&path).await {
                content
                    .lines()
                    .skip_while(|l| !l.starts_with("---"))
                    .skip(1)
                    .take_while(|l| !l.starts_with("---"))
                    .find_map(|l| l.strip_prefix("title: "))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| stem.clone())
            } else {
                stem.clone()
            };
            entries.push((stem, title));
        }
    }
    entries.sort_by(|a, b| a.1.cmp(&b.1));

    let body = format!(
        "# Index\n\nLast updated: {ts}\n\n## Concepts\n\n{list}\n",
        ts = iso8601_now(),
        list = if entries.is_empty() {
            "_(no concepts yet — run synthesise from a populated workspace)_".into()
        } else {
            entries
                .iter()
                .map(|(slug, title)| format!("- [{title}](concepts/{slug}.md)"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    );
    fs::write(wiki_dir.join("INDEX.md"), body)
        .await
        .map_err(|e| format!("write INDEX.md: {e}"))?;
    Ok(())
}

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

#[derive(Debug, Clone, Serialize)]
pub struct SynthesizeReport {
    pub wiki_dir: PathBuf,
    pub run_count: usize,
    pub ku_count: usize,
    pub concepts_written: usize,
    pub skipped_human_edited: Vec<String>,
}

pub async fn synthesize_wiki(
    app: AppHandle,
    workspace_dir: PathBuf,
) -> Result<SynthesizeReport, String> {
    let wiki_dir = resolve_wiki_dir();
    ensure_wiki_repo(&wiki_dir).await?;

    let kus = collect_kus(&workspace_dir).await?;
    if kus.is_empty() {
        return Err("no KUs found in any run snapshot — run a quiz first".into());
    }
    let run_ids: std::collections::HashSet<&str> =
        kus.iter().map(|k| k.run_id.as_str()).collect();

    let _ = app.emit(
        "wiki:synthesize-started",
        json!({ "ku_count": kus.len(), "run_count": run_ids.len() }),
    );

    let prompt = build_synthesis_prompt(&kus);

    // Pass via stdin so we don't blow argv length on big run sets.
    let mut child = Command::new(gemini_bin())
        .args(["-y", "--include-directories", workspace_dir.to_str().unwrap_or(".")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("gemini spawn: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.flush().await;
    }

    let output = match timeout(SYNTH_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("gemini wait: {e}")),
        Err(_) => return Err(format!("synthesis timeout after {}s", SYNTH_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        return Err(format!(
            "gemini exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let cleaned = strip_json_fences(&raw);
    let parsed: LlmConceptsResp = serde_json::from_str(cleaned).map_err(|e| {
        let preview: String = raw.chars().take(800).collect();
        format!("parse JSON: {e}\nLLM output:\n{preview}")
    })?;

    if parsed.concepts.is_empty() {
        return Err("LLM returned no concepts".into());
    }

    // Write each concept; skip files where human_edited: true.
    let concepts_dir = wiki_dir.join("concepts");
    let mut written = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    for c in &parsed.concepts {
        if c.slug.is_empty()
            || c.slug.contains('/')
            || c.slug.contains('\\')
            || c.slug.contains("..")
        {
            continue;
        }
        let path = concepts_dir.join(format!("{}.md", c.slug));
        if let Ok(existing) = fs::read_to_string(&path).await {
            if existing.contains("human_edited: true") {
                skipped.push(c.slug.clone());
                continue;
            }
        }
        let body = render_concept_md(c);
        if let Err(e) = fs::write(&path, body).await {
            return Err(format!("write {}: {e}", path.display()));
        }
        written += 1;
    }

    render_index(&wiki_dir).await?;

    let report = SynthesizeReport {
        wiki_dir: wiki_dir.clone(),
        run_count: run_ids.len(),
        ku_count: kus.len(),
        concepts_written: written,
        skipped_human_edited: skipped,
    };
    let _ = app.emit("wiki:synthesize-completed", json!(&report));
    Ok(report)
}
