// ULMS_WIKI_DIR resolution + papers/ accessor.

use std::path::PathBuf;

pub fn resolve() -> PathBuf {
    if let Ok(s) = std::env::var("ULMS_WIKI_DIR") {
        return PathBuf::from(s);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".ulms-wiki");
    }
    PathBuf::from(".ulms-wiki")
}

pub fn papers_dir() -> PathBuf {
    resolve().join("raw").join("papers")
}
