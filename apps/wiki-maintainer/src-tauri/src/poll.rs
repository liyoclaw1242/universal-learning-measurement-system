// Poll loop. Every POLL_INTERVAL, scan <wiki>/raw/* for new
// resources, queue them, and dispatch one ingest per loop tick (so
// we don't blast claude with parallel requests).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio::time::interval;

use crate::claude::{self, ClaudeSession};
use crate::log_writer;
use crate::state::{MaintainerState, QueuedResource};

const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60); // 30 min
/// Tighter loop check so manual `Ingest now` button is responsive
/// (the inner tokio::select still respects the 30 min cadence for
/// autonomous scans — this is just the debounce on manual triggers).
const TICK: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct PollerHandle {
    trigger_now: AtomicBool,
}

impl PollerHandle {
    pub fn trigger_scan_now(&self) {
        self.trigger_now.store(true, Ordering::SeqCst);
    }

    fn consume_trigger(&self) -> bool {
        self.trigger_now.swap(false, Ordering::SeqCst)
    }
}

pub async fn run_poll_loop(
    app: AppHandle,
    state: Arc<Mutex<MaintainerState>>,
    claude: Arc<Mutex<ClaudeSession>>,
    poller: Arc<PollerHandle>,
) {
    // Seed seen-state from disk + initial scan.
    {
        let mut s = state.lock().await;
        s.load_seen_state().await;
    }

    let mut autonomous = interval(POLL_INTERVAL);
    autonomous.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Fire once immediately so a freshly-launched maintainer notices
    // any pre-existing un-ingested resources.
    autonomous.tick().await;

    let mut tick = interval(TICK);

    log_writer::log(
        &app,
        &state,
        "info",
        "maintainer started",
        Some("poll interval: 30 min · context restart at 80%"),
    )
    .await;

    // Initial scan to populate the queue.
    scan_and_enqueue(&app, &state).await;
    drain_queue(&app, &claude, &state).await;

    loop {
        tokio::select! {
            _ = autonomous.tick() => {
                scan_and_enqueue(&app, &state).await;
                drain_queue(&app, &claude, &state).await;
            }
            _ = tick.tick() => {
                if poller.consume_trigger() {
                    scan_and_enqueue(&app, &state).await;
                    drain_queue(&app, &claude, &state).await;
                }
            }
        }
    }
}

async fn scan_and_enqueue(app: &AppHandle, state: &Arc<Mutex<MaintainerState>>) {
    let wiki_dir = {
        let s = state.lock().await;
        s.wiki_dir.clone()
    };
    let keys = claude::list_raw_keys(&wiki_dir).await;

    let mut new_keys: Vec<String> = Vec::new();
    {
        let mut s = state.lock().await;
        for k in keys {
            if !s.seen.contains(&k) {
                new_keys.push(k.clone());
            }
        }
        for k in &new_keys {
            s.queue.push_back(QueuedResource { key: k.clone() });
        }
    }
    if !new_keys.is_empty() {
        log_writer::log(
            app,
            state,
            "info",
            &format!("queued {} new resource(s)", new_keys.len()),
            Some(&new_keys.join("\n")),
        )
        .await;
    }
}

async fn drain_queue(
    app: &AppHandle,
    claude: &Arc<Mutex<ClaudeSession>>,
    state: &Arc<Mutex<MaintainerState>>,
) {
    loop {
        let next = {
            let mut s = state.lock().await;
            s.queue.pop_front()
        };
        let Some(item) = next else { break };

        match crate::claude::run_ingest(app, claude, state, &item.key).await {
            Ok(()) => {
                let mut s = state.lock().await;
                s.seen.insert(item.key.clone());
                s.persist_seen().await;
            }
            Err(_e) => {
                // run_ingest already logged the error. Don't re-queue
                // — a second pass with the same broken state will
                // probably fail the same way.
                let mut s = state.lock().await;
                s.seen.insert(item.key.clone());
                s.persist_seen().await;
            }
        }
    }
}
