// Mutable maintainer state — single Mutex'd struct, kept small so the
// renderer can pull a full snapshot per status emit.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

const RECENT_LOG_CAP: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub ts: String,
    pub op: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCounts {
    pub sources: u32,
    pub concepts: u32,
    pub entities: u32,
    pub synthesis: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintainerStatus {
    pub wiki_dir: String,
    pub session_state: SessionState,
    pub model: Option<String>,
    pub tokens_used: u64,
    pub context_budget: u64,
    pub last_activity: Option<String>,
    pub queue_depth: u32,
    pub counts_by_category: PageCounts,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Idle,
    Spawning,
    Ingesting,
    Linting,
    Restarting,
    Error,
}

pub struct MaintainerState {
    pub wiki_dir: PathBuf,
    pub session_state: SessionState,
    pub model: Option<String>,
    pub tokens_used: u64,
    pub context_budget: u64,
    pub last_activity: Option<String>,
    pub queue: VecDeque<QueuedResource>,
    pub seen: std::collections::HashSet<String>,
    pub counts: PageCounts,
    pub last_error: Option<String>,
    pub recent_log: Vec<LogEntry>,
}

#[derive(Debug, Clone)]
pub struct QueuedResource {
    /// "<type>/<id>" — e.g. "papers/arxiv-2401-12345"
    pub key: String,
}

impl MaintainerState {
    pub fn new(wiki_dir: PathBuf) -> Self {
        Self {
            wiki_dir,
            session_state: SessionState::Idle,
            model: None,
            tokens_used: 0,
            context_budget: 200_000,
            last_activity: None,
            queue: VecDeque::new(),
            seen: std::collections::HashSet::new(),
            counts: PageCounts {
                sources: 0,
                concepts: 0,
                entities: 0,
                synthesis: 0,
            },
            last_error: None,
            recent_log: Vec::with_capacity(RECENT_LOG_CAP),
        }
    }

    pub fn snapshot(&self) -> MaintainerStatus {
        MaintainerStatus {
            wiki_dir: self.wiki_dir.to_string_lossy().to_string(),
            session_state: self.session_state,
            model: self.model.clone(),
            tokens_used: self.tokens_used,
            context_budget: self.context_budget,
            last_activity: self.last_activity.clone(),
            queue_depth: self.queue.len() as u32,
            counts_by_category: self.counts.clone(),
            last_error: self.last_error.clone(),
        }
    }

    pub fn push_log(&mut self, entry: LogEntry) {
        self.recent_log.push(entry);
        if self.recent_log.len() > RECENT_LOG_CAP {
            let drop = self.recent_log.len() - RECENT_LOG_CAP;
            self.recent_log.drain(0..drop);
        }
    }

    pub async fn load_seen_state(&mut self) {
        let path = self.wiki_dir.join(".maintainer-state.json");
        if let Ok(s) = fs::read_to_string(&path).await {
            if let Ok(seen) = serde_json::from_str::<Vec<String>>(&s) {
                self.seen = seen.into_iter().collect();
            }
        }
    }

    pub async fn persist_seen(&self) {
        let path = self.wiki_dir.join(".maintainer-state.json");
        let mut v: Vec<&String> = self.seen.iter().collect();
        v.sort();
        if let Ok(json) = serde_json::to_string_pretty(&v) {
            let _ = fs::write(path, json).await;
        }
    }

    pub async fn refresh_counts(&mut self) {
        self.counts = PageCounts {
            sources: count_md_files(&self.wiki_dir.join("sources")).await,
            concepts: count_md_files(&self.wiki_dir.join("concepts")).await,
            entities: count_md_files(&self.wiki_dir.join("entities")).await,
            synthesis: count_md_files(&self.wiki_dir.join("synthesis")).await,
        };
    }
}

async fn count_md_files(dir: &Path) -> u32 {
    let mut rd = match fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let mut n: u32 = 0;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if s.ends_with(".md") && !s.starts_with('.') {
            n += 1;
        }
    }
    n
}
