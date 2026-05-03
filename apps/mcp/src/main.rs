// ULMS MCP server — exposes the wiki + raw runs to MCP clients.
//
// Protocol: JSON-RPC 2.0 over stdio (line-delimited, MCP 2025-03-26).
// Hand-rolled to avoid dragging in the rmcp crate; the surface is small.
//
// Tools:
//   list_concepts          — wiki/concepts/*.md as {slug, title, tags}
//   read_concept(slug)     — full markdown body
//   search_wiki(query)     — substring search across concept titles + bodies
//   list_runs              — workspace/runs/* metadata
//   get_run(run_id, file?) — read raw run file (default: meta.yaml)
//
// Config via env:
//   ULMS_WIKI_DIR       (default: $HOME/.ulms-wiki)
//   ULMS_WORKSPACE_DIR  (default: cwd)

use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-03-26";
const SERVER_NAME: &str = "ulms-mcp";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn wiki_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ULMS_WIKI_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".ulms-wiki")
}

fn workspace_dir() -> PathBuf {
    std::env::var("ULMS_WORKSPACE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    out,
                    "{}",
                    error_response(Value::Null, -32700, &format!("parse error: {e}"))
                );
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);

        // Notifications have no id and need no response.
        let is_notification = req.get("id").is_none();

        let response_str = match method {
            "initialize" => Some(initialize_response(id)),
            "notifications/initialized" => None,
            "tools/list" => Some(tools_list_response(id)),
            "tools/call" => Some(tools_call_response(id, &params)),
            "ping" => Some(ok_response(id, json!({}))),
            other => {
                if is_notification {
                    None
                } else {
                    Some(error_response(
                        id,
                        -32601,
                        &format!("method not found: {other}"),
                    ))
                }
            }
        };
        if let Some(s) = response_str {
            let _ = writeln!(out, "{s}");
            let _ = out.flush();
        }
    }
}

// ─── JSON-RPC envelopes ─────────────────────────────────────

fn ok_response(id: Value, result: Value) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .unwrap_or_else(|_| String::new())
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))
    .unwrap_or_else(|_| String::new())
}

fn text_content(text: impl Into<String>) -> Value {
    json!({ "type": "text", "text": text.into() })
}

fn tool_result(content: Vec<Value>, is_error: bool) -> Value {
    json!({ "content": content, "isError": is_error })
}

// ─── handshake / list ──────────────────────────────────────

fn initialize_response(id: Value) -> String {
    ok_response(
        id,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
            "instructions": "ULMS knowledge base. Use list_concepts to browse, search_wiki for keyword search, read_concept(slug) for full content. Raw runs (per Quiz session) are accessible via list_runs / get_run.",
        }),
    )
}

fn tools_list_response(id: Value) -> String {
    let tools = json!([
        {
            "name": "list_concepts",
            "description": "List all wiki concept pages with their slug, title, and tags. Returns a markdown bullet list.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "read_concept",
            "description": "Read the full markdown body of a wiki concept page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "concept slug (e.g. 'backpropagation')" }
                },
                "required": ["slug"]
            }
        },
        {
            "name": "search_wiki",
            "description": "Substring search across all wiki concept page titles and bodies. Case-insensitive.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "default": 20 }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_runs",
            "description": "List Quiz run snapshots from the workspace (raw KB layer). Each run has id, timestamp, material filename, item count.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_run",
            "description": "Read a file from a specific run snapshot. file defaults to meta.yaml. Other valid files: blackboard.json, items.json, reviews.json, material.md.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "file": { "type": "string", "default": "meta.yaml" }
                },
                "required": ["run_id"]
            }
        }
    ]);
    ok_response(id, json!({ "tools": tools }))
}

// ─── tool dispatch ─────────────────────────────────────────

fn tools_call_response(id: Value, params: &Value) -> String {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(json!({}));

    let result = match name {
        "list_concepts" => list_concepts(),
        "read_concept" => {
            let slug = args.get("slug").and_then(|v| v.as_str()).unwrap_or("");
            read_concept(slug)
        }
        "search_wiki" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(20) as usize;
            search_wiki(query, limit)
        }
        "list_runs" => list_runs(),
        "get_run" => {
            let run_id = args.get("run_id").and_then(|v| v.as_str()).unwrap_or("");
            let file = args
                .get("file")
                .and_then(|v| v.as_str())
                .unwrap_or("meta.yaml");
            get_run(run_id, file)
        }
        other => Err(format!("unknown tool: {other}")),
    };

    match result {
        Ok(text) => ok_response(id, tool_result(vec![text_content(text)], false)),
        Err(msg) => ok_response(id, tool_result(vec![text_content(msg)], true)),
    }
}

// ─── tool implementations ──────────────────────────────────

#[derive(Serialize)]
struct ConceptMeta {
    slug: String,
    title: String,
    tags: Vec<String>,
}

fn read_concept_meta(path: &Path) -> Option<ConceptMeta> {
    let content = fs::read_to_string(path).ok()?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(String::from)
        .unwrap_or_default();
    let mut title = stem.clone();
    let mut tags: Vec<String> = Vec::new();
    let mut in_frontmatter = false;
    for line in content.lines() {
        if line.starts_with("---") {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(rest) = line.strip_prefix("title: ") {
            title = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("tags: ") {
            // tags: [a, b, c]
            let raw = rest.trim();
            if let Some(inner) = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                tags = inner
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }
    Some(ConceptMeta { slug: stem, title, tags })
}

fn list_concepts() -> Result<String, String> {
    let dir = wiki_dir().join("concepts");
    let mut metas: Vec<ConceptMeta> = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|_| {
        format!(
            "wiki concepts dir not found at {}; run synthesize_wiki first",
            dir.display()
        )
    })?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(m) = read_concept_meta(&p) {
            metas.push(m);
        }
    }
    metas.sort_by(|a, b| a.title.cmp(&b.title));
    if metas.is_empty() {
        return Ok("(no concepts yet — run synthesize_wiki from the ULMS shell)".into());
    }
    let lines: Vec<String> = metas
        .iter()
        .map(|m| {
            let tags = if m.tags.is_empty() {
                String::new()
            } else {
                format!(" · `{}`", m.tags.join("`, `"))
            };
            format!("- **{}** (`{}`){tags}", m.title, m.slug)
        })
        .collect();
    Ok(format!(
        "{} concept{}:\n\n{}",
        metas.len(),
        if metas.len() == 1 { "" } else { "s" },
        lines.join("\n")
    ))
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(format!("invalid slug: {slug:?}"));
    }
    Ok(())
}

fn read_concept(slug: &str) -> Result<String, String> {
    validate_slug(slug)?;
    let path = wiki_dir().join("concepts").join(format!("{slug}.md"));
    fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))
}

fn search_wiki(query: &str, limit: usize) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("query is empty".into());
    }
    let needle = query.to_lowercase();
    let dir = wiki_dir().join("concepts");
    let mut hits: Vec<(String, String, String)> = Vec::new(); // (slug, title, snippet)
    let rd = fs::read_dir(&dir)
        .map_err(|e| format!("read concepts dir: {e}"))?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&p) else {
            continue;
        };
        let haystack = content.to_lowercase();
        if let Some(idx) = haystack.find(&needle) {
            let meta = read_concept_meta(&p).unwrap_or(ConceptMeta {
                slug: p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(String::from)
                    .unwrap_or_default(),
                title: String::new(),
                tags: vec![],
            });
            // ±60 char snippet around the match (using char indices via slicing
            // at byte offset approximated; safe-ish for ASCII queries).
            let start = idx.saturating_sub(60);
            let end = (idx + needle.len() + 60).min(content.len());
            let snippet = content
                .get(start..end)
                .unwrap_or("")
                .replace('\n', " ");
            hits.push((meta.slug, meta.title, snippet));
        }
    }
    if hits.is_empty() {
        return Ok(format!("no matches for {query:?}"));
    }
    hits.truncate(limit);
    let lines: Vec<String> = hits
        .iter()
        .map(|(slug, title, snippet)| {
            format!("- **{title}** (`{slug}`)\n  …{snippet}…")
        })
        .collect();
    Ok(format!(
        "{} hit{} for {query:?}:\n\n{}",
        hits.len(),
        if hits.len() == 1 { "" } else { "s" },
        lines.join("\n\n")
    ))
}

fn list_runs() -> Result<String, String> {
    let runs_root = workspace_dir().join("runs");
    let mut entries: Vec<(String, String, usize, Option<String>)> = Vec::new();
    let rd = fs::read_dir(&runs_root).map_err(|_| {
        format!(
            "runs dir not found at {}; complete a Quiz workflow first",
            runs_root.display()
        )
    })?;
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let id = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let meta_path = p.join("meta.yaml");
        let meta = fs::read_to_string(&meta_path).unwrap_or_default();
        let mut timestamp = String::new();
        let mut material: Option<String> = None;
        let mut item_count: usize = 0;
        let mut dim_seen = false;
        for line in meta.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("timestamp: ") {
                timestamp = rest.trim().to_string();
            } else if let Some(rest) = trimmed.strip_prefix("filename: ") {
                let v = rest.trim().trim_matches('"').to_string();
                if v != "null" && !v.is_empty() {
                    material = Some(v);
                }
            } else if let Some(rest) = trimmed.strip_prefix("count: ") {
                let n: usize = rest.trim().parse().unwrap_or(0);
                if !dim_seen {
                    dim_seen = true; // first count is dimensions.count
                } else if item_count == 0 {
                    item_count = n;
                }
            }
        }
        entries.push((id, timestamp, item_count, material));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    if entries.is_empty() {
        return Ok("(no runs yet)".into());
    }
    let lines: Vec<String> = entries
        .iter()
        .map(|(id, ts, items, mat)| {
            format!(
                "- `{id}` · {ts} · {items} item{} · {}",
                if *items == 1 { "" } else { "s" },
                mat.as_deref().unwrap_or("(no material)"),
            )
        })
        .collect();
    Ok(format!(
        "{} run{}:\n\n{}",
        entries.len(),
        if entries.len() == 1 { "" } else { "s" },
        lines.join("\n")
    ))
}

fn get_run(run_id: &str, file: &str) -> Result<String, String> {
    if run_id.is_empty()
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains("..")
    {
        return Err(format!("invalid run_id: {run_id:?}"));
    }
    let allowed = ["meta.yaml", "blackboard.json", "items.json", "reviews.json", "material.md"];
    if !allowed.contains(&file) {
        return Err(format!(
            "invalid file: {file:?}; allowed = {}",
            allowed.join(", ")
        ));
    }
    let path = workspace_dir().join("runs").join(run_id).join(file);
    fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}
