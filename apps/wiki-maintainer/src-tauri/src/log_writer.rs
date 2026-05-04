// Log writer — appends `## [date] op | desc` to <wiki>/log.md and
// emits maintainer:log events for the renderer.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::state::{LogEntry, MaintainerState};

/// Append a log entry to log.md AND emit it to the renderer in one call.
pub async fn log(
    app: &AppHandle,
    state: &Arc<Mutex<MaintainerState>>,
    op: &str,
    message: &str,
    detail: Option<&str>,
) {
    let utc_full = iso8601_now();
    let display_ts = local_hms();

    let mut md = format!("\n## [{utc_full}] {op} | {message}\n");
    if let Some(d) = detail {
        for line in d.lines() {
            if line.trim().is_empty() {
                continue;
            }
            md.push_str(&format!("- {line}\n"));
        }
    }

    let wiki_dir = {
        let s = state.lock().await;
        s.wiki_dir.clone()
    };
    if let Ok(mut f) = OpenOptions::new()
        .append(true)
        .open(wiki_dir.join("log.md"))
        .await
    {
        let _ = f.write_all(md.as_bytes()).await;
    }

    let entry = LogEntry {
        ts: display_ts,
        op: op.into(),
        message: message.into(),
        detail: detail.map(|s| s.to_string()),
    };

    {
        let mut s = state.lock().await;
        s.last_activity = Some(utc_full);
        s.push_log(entry.clone());
    }
    let _ = app.emit("maintainer:log", &entry);

    // Push status snapshot too so the renderer's session summary updates.
    let snap = state.lock().await.snapshot();
    let _ = app.emit("maintainer:status", &snap);
}

pub async fn log_error(
    app: &AppHandle,
    state: &Arc<Mutex<MaintainerState>>,
    op: &str,
    err: &str,
) {
    {
        let mut s = state.lock().await;
        s.last_error = Some(err.to_string());
    }
    log(app, state, "error", &format!("{op}: {err}"), None).await;
}

pub fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
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
    format!("{y:04}-{mth:02}-{d:02} {h:02}:{m:02} UTC")
}

fn local_hms() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let rem = secs.rem_euclid(86_400);
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    format!("{h:02}:{m:02}:{s:02}")
}
