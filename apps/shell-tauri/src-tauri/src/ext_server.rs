// Local HTTP server for the Chrome extension to ingest learning
// resources into the wiki/raw bank. Listens on 127.0.0.1:9527 only;
// auth is a bearer token shared between the Tauri app and the ext.
//
// Endpoints:
//   GET  /health            → {ok: true, version}
//   POST /import            → {type, ...payload}; writes raw/<type>/<id>/

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::raw_bank::{
    self, ArticleIngest, BookIngest, BookPage, RawMeta, YoutubeIngest,
};

const DEFAULT_PORT: u16 = 9527;

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    token: String,
}

// ─── token persistence ─────────────────────────────────────

pub fn token_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".ulms-config").join("token")
}

pub fn load_or_create_token() -> Result<String, String> {
    let path = token_path();
    if path.is_file() {
        return std::fs::read_to_string(&path)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("read token: {e}"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let token = Uuid::new_v4().to_string().replace('-', "");
    std::fs::write(&path, &token).map_err(|e| format!("write token: {e}"))?;
    Ok(token)
}

// ─── server bootstrap ──────────────────────────────────────

pub async fn run_server(app: AppHandle, token: String, port: u16) -> Result<(), String> {
    let state = ServerState { app, token };

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let router = Router::new()
        .route("/health", get(health))
        .route("/import", post(import))
        .layer(cors)
        .with_state(Arc::new(state));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    eprintln!("[ulms] ext server listening on http://127.0.0.1:{port}");

    axum::serve(listener, router)
        .await
        .map_err(|e| format!("serve: {e}"))?;
    Ok(())
}

pub fn spawn_server(app: AppHandle, token: String) {
    let port = std::env::var("ULMS_EXT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    // setup() runs before tokio is the current thread's reactor, so
    // tokio::spawn would panic. Tauri's async_runtime is a tokio
    // runtime owned by the framework — futures spawned onto it have
    // a live reactor for axum / tokio::net.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_server(app, token, port).await {
            eprintln!("[ulms] ext server exited: {e}");
        }
    });
}

// ─── handlers ──────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "ulms-ext",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, String)> {
    let header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing Authorization header".into()))?;
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "expected Bearer token".into()))?;
    if token != expected {
        return Err((StatusCode::UNAUTHORIZED, "token mismatch".into()));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ImportRequest {
    Article(ArticlePayload),
    Youtube(YoutubePayload),
    Book(BookPayload),
}

#[derive(Debug, Deserialize)]
struct ArticlePayload {
    source_url: String,
    title: String,
    #[serde(default)]
    author: Option<String>,
    /// Markdown extracted from the page (Readability output).
    content: String,
}

#[derive(Debug, Deserialize)]
struct BookPagePayload {
    source_url: String,
    /// Markdown extracted from this single page (Readability output).
    content: String,
}

#[derive(Debug, Deserialize)]
struct BookPayload {
    /// First-page URL — becomes the canonical source_url.
    source_url: String,
    title: String,
    #[serde(default)]
    author: Option<String>,
    pages: Vec<BookPagePayload>,
}

#[derive(Debug, Deserialize)]
struct YoutubePayload {
    video_id: String,
    source_url: String,
    title: String,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    duration_s: Option<u64>,
    #[serde(default)]
    caption_lang: Option<String>,
    /// Timestamped transcript markdown.
    transcript: String,
    /// Optional cover thumbnail as base64 (jpeg/png).
    #[serde(default)]
    thumbnail_b64: Option<String>,
}

async fn import(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<RawMeta>, (StatusCode, String)> {
    check_auth(&headers, &state.token)?;

    let req: ImportRequest = serde_json::from_value(payload)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("parse body: {e}")))?;

    let meta = match req {
        ImportRequest::Article(p) => raw_bank::write_article(ArticleIngest {
            source_url: p.source_url,
            title: p.title,
            author: p.author,
            content_markdown: p.content,
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
        ImportRequest::Book(p) => raw_bank::write_book(BookIngest {
            source_url: p.source_url,
            title: p.title,
            author: p.author,
            pages: p
                .pages
                .into_iter()
                .map(|pp| BookPage {
                    source_url: pp.source_url,
                    content_markdown: pp.content,
                })
                .collect(),
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
        ImportRequest::Youtube(p) => {
            let thumbnail_bytes = p
                .thumbnail_b64
                .as_deref()
                .map(|b| base64::engine::general_purpose::STANDARD.decode(b))
                .transpose()
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("base64 thumbnail: {e}")))?;
            raw_bank::write_youtube(YoutubeIngest {
                video_id: p.video_id,
                source_url: p.source_url,
                title: p.title,
                channel: p.channel,
                duration_s: p.duration_s,
                caption_lang: p.caption_lang,
                transcript_markdown: p.transcript,
                thumbnail_bytes,
            })
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
    };

    let _ = state.app.emit("raw:imported", json!({
        "id": meta.id,
        "type": meta.resource_type,
        "title": meta.title,
    }));

    Ok(Json(meta))
}
