// Blackboard file management — port of
// apps/shell/electron/coordinator/blackboard.ts.
// `default_params` / `build_empty_blackboard` / `write_blackboard` /
// `reset_blackboard` are only called from the workflow port (Phase 4).

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use tokio::fs;

use crate::types::{
    AssessmentParams, Blackboard, Costs, DataSlice, DifficultyDistribution, StagedInputs,
    UserInput, WorkflowState, WorkflowStatus,
};

pub const AGENTS: [&str; 4] = ["agent_1", "agent_2", "agent_3", "agent_4"];

pub fn default_params() -> AssessmentParams {
    AssessmentParams {
        target_item_count: 6,
        difficulty_distribution: DifficultyDistribution {
            easy: 0.34,
            medium: 0.5,
            hard: 0.16,
        },
        item_types: Some(HashMap::from([
            ("mc_single".to_string(), 0.5),
            ("fill".to_string(), 0.3),
            ("ordering".to_string(), 0.2),
        ])),
        item_type_counts: None,
    }
}

pub fn build_empty_blackboard(staged: &StagedInputs) -> Blackboard {
    Blackboard {
        workflow: WorkflowState {
            current_step: 0,
            total_steps: 4,
            steps: AGENTS.iter().map(|s| s.to_string()).collect(),
            status: WorkflowStatus::Pending,
        },
        user_input: UserInput {
            material: staged.material.clone(),
            competency_dimensions: staged.dimensions.clone().unwrap_or_default(),
            domain_guidance: staged.domain_guidance.clone(),
            assessment_params: staged
                .assessment_params
                .clone()
                .unwrap_or_else(default_params),
        },
        data: DataSlice::default(),
        log: vec![],
        costs: Costs::default(),
    }
}

pub async fn write_blackboard(path: &Path, board: &Blackboard) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(board).map_err(|e| e.to_string())?;
    fs::write(path, json)
        .await
        .map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(())
}

pub async fn read_blackboard(path: &Path) -> Option<Blackboard> {
    let raw = fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<Blackboard>(&raw).ok()
}

pub async fn reset_blackboard(
    path: &Path,
    staged: &StagedInputs,
) -> Result<Blackboard, String> {
    let b = build_empty_blackboard(staged);
    write_blackboard(path, &b).await?;
    Ok(b)
}
