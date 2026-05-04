// Wiki dir resolution. Mirrors the shell-tauri's logic: ULMS_WIKI_DIR
// env var wins, else default to ~/.ulms-wiki/. The maintainer refuses
// to start if the resolved dir doesn't have a CLAUDE.md — that's how
// it knows the wiki is bootstrapped.

use std::path::PathBuf;

pub fn resolve() -> Result<PathBuf, String> {
    let dir = if let Ok(s) = std::env::var("ULMS_WIKI_DIR") {
        PathBuf::from(s)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".ulms-wiki")
    } else {
        return Err("HOME unset and ULMS_WIKI_DIR not provided".into());
    };

    if !dir.is_dir() {
        return Err(format!("wiki dir does not exist: {}", dir.display()));
    }
    if !dir.join("CLAUDE.md").is_file() {
        return Err(format!(
            "{} has no CLAUDE.md — bootstrap the wiki first",
            dir.display()
        ));
    }
    Ok(dir)
}
