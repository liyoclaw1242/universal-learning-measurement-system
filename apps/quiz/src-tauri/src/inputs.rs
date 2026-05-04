// Input loaders — Rust port of
// apps/shell/electron/coordinator/inputs.ts.
//
// Each picker shows a native file dialog (via tauri-plugin-dialog),
// reads the file(s), validates, copies into workspace/inputs/, and
// stages the result on the shared AppState.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::fs;

use crate::types::{AssessmentParams, Dimension, MaterialInput, MaterialSource, StagedInputs};

#[derive(Serialize)]
pub struct PickResp {
    pub status: String, // "ok" | "canceled" | "error"
    pub error: Option<String>,
}

impl PickResp {
    fn ok() -> Self {
        Self {
            status: "ok".into(),
            error: None,
        }
    }
    fn canceled() -> Self {
        Self {
            status: "canceled".into(),
            error: None,
        }
    }
    fn error(msg: impl Into<String>) -> Self {
        Self {
            status: "error".into(),
            error: Some(msg.into()),
        }
    }
}

// ─── helpers ────────────────────────────────────────────────

pub async fn copy_to_inputs_dir(
    workspace_dir: &Path,
    src_filename: &str,
    contents: &str,
) -> Result<String, String> {
    let inputs_dir = workspace_dir.join("inputs");
    fs::create_dir_all(&inputs_dir)
        .await
        .map_err(|e| format!("mkdir inputs: {e}"))?;
    let dest = inputs_dir.join(src_filename);
    fs::write(&dest, contents)
        .await
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(src_filename.to_string())
}

fn build_combined_filename(sources: &[MaterialSource]) -> String {
    match sources.len() {
        0 => "—".to_string(),
        1 => sources[0].filename.clone(),
        2 => format!("{} + {}", sources[0].filename, sources[1].filename),
        n => format!("{} + {} others", sources[0].filename, n - 1),
    }
}

fn concatenate_materials(parts: &[(String, String)]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    if parts.len() == 1 {
        return parts[0].1.clone();
    }
    parts
        .iter()
        .map(|(name, content)| {
            format!(
                "<!-- === FILE: {name} === -->\n\n{}\n",
                content.trim_end()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_paths(picked: Option<Vec<FilePath>>) -> Vec<PathBuf> {
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|fp| fp.into_path().ok())
        .collect()
}

fn extract_path(picked: Option<FilePath>) -> Option<PathBuf> {
    picked.and_then(|fp| fp.into_path().ok())
}

fn basename(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn ext_lower(p: &Path) -> String {
    p.extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

// ─── pickers ────────────────────────────────────────────────

pub async fn run_pick_material(
    app: AppHandle,
    workspace_dir: &Path,
    staged: &mut StagedInputs,
) -> PickResp {
    let app_clone = app.clone();
    let picked = match tokio::task::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter("Material", &["md", "txt", "markdown"])
            .blocking_pick_files()
    })
    .await
    {
        Ok(p) => p,
        Err(e) => return PickResp::error(format!("dialog spawn failed: {e}")),
    };

    let paths = extract_paths(picked);
    if paths.is_empty() {
        return PickResp::canceled();
    }

    let mut parts: Vec<(String, String)> = Vec::with_capacity(paths.len());
    let mut sources: Vec<MaterialSource> = Vec::with_capacity(paths.len());
    let mut any_markdown = false;

    for src in &paths {
        let content = match fs::read_to_string(src).await {
            Ok(s) => s,
            Err(e) => return PickResp::error(format!("read {}: {e}", src.display())),
        };
        let filename = basename(src);
        if let Err(e) = copy_to_inputs_dir(workspace_dir, &filename, &content).await {
            return PickResp::error(e);
        }
        let ext = ext_lower(src);
        if ext == "md" || ext == "markdown" {
            any_markdown = true;
        }
        sources.push(MaterialSource {
            filename: filename.clone(),
            char_count: content.chars().count(),
        });
        parts.push((filename, content));
    }

    let joined = concatenate_materials(&parts);
    let combined_name = build_combined_filename(&sources);
    let multi_sources = if sources.len() > 1 {
        Some(sources)
    } else {
        None
    };

    staged.material = Some(MaterialInput {
        filename: combined_name,
        content: joined,
        content_type: if any_markdown { "markdown".into() } else { "text".into() },
        sources: multi_sources,
    });
    PickResp::ok()
}

#[derive(Deserialize)]
struct YamlDoc {
    dimensions: Option<Vec<Dimension>>,
    assessment_params: Option<AssessmentParams>,
}

pub async fn run_pick_dimensions(
    app: AppHandle,
    workspace_dir: &Path,
    staged: &mut StagedInputs,
) -> PickResp {
    let app_clone = app.clone();
    let picked = match tokio::task::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter("Dimensions YAML", &["yaml", "yml"])
            .blocking_pick_file()
    })
    .await
    {
        Ok(p) => p,
        Err(e) => return PickResp::error(format!("dialog spawn failed: {e}")),
    };

    let Some(src) = extract_path(picked) else {
        return PickResp::canceled();
    };

    let text = match fs::read_to_string(&src).await {
        Ok(s) => s,
        Err(e) => return PickResp::error(format!("read {}: {e}", src.display())),
    };

    let parsed: YamlDoc = match serde_yaml::from_str(&text) {
        Ok(p) => p,
        Err(e) => return PickResp::error(format!("YAML parse: {e}")),
    };

    let Some(dims) = parsed.dimensions else {
        return PickResp::error("YAML must have a top-level `dimensions` array");
    };
    if dims.is_empty() {
        return PickResp::error("YAML `dimensions` must not be empty");
    }

    if let Some(ap) = &parsed.assessment_params {
        if let Some(counts) = &ap.item_type_counts {
            let sum: usize = counts.values().sum();
            if sum != ap.target_item_count {
                return PickResp::error(format!(
                    "item_type_counts sums to {sum} but target_item_count is {} — they must match exactly",
                    ap.target_item_count
                ));
            }
        }
    }

    if let Err(e) = copy_to_inputs_dir(workspace_dir, &basename(&src), &text).await {
        return PickResp::error(e);
    }

    staged.dimensions = Some(dims);
    if let Some(ap) = parsed.assessment_params {
        staged.assessment_params = Some(ap);
    }
    PickResp::ok()
}

pub async fn run_pick_guidance(
    app: AppHandle,
    workspace_dir: &Path,
    staged: &mut StagedInputs,
) -> PickResp {
    let app_clone = app.clone();
    let picked = match tokio::task::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter("Guidance", &["md", "markdown", "txt"])
            .blocking_pick_file()
    })
    .await
    {
        Ok(p) => p,
        Err(e) => return PickResp::error(format!("dialog spawn failed: {e}")),
    };

    let Some(src) = extract_path(picked) else {
        return PickResp::canceled();
    };

    let content = match fs::read_to_string(&src).await {
        Ok(s) => s,
        Err(e) => return PickResp::error(format!("read {}: {e}", src.display())),
    };

    if let Err(e) = copy_to_inputs_dir(workspace_dir, &basename(&src), &content).await {
        return PickResp::error(e);
    }

    staged.domain_guidance = Some(content);
    PickResp::ok()
}
