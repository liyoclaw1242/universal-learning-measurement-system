// Coordinator-internal types — Rust port of
// apps/shell/electron/coordinator/types.ts.
//
// Field names use snake_case to match the JS shape exactly so the
// renderer's loose typing keeps working. Enums for `status` use
// rename_all = "lowercase".
//
// `ResultSnapshot` is only used by the workflow spawn loop (Phase 4).

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub type AgentId = String;

pub type LogEntry = HashMap<String, Value>;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MaterialSource {
    pub filename: String,
    pub char_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MaterialInput {
    pub filename: String,
    pub content: String,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<MaterialSource>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dimension {
    pub dim_id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DifficultyDistribution {
    pub easy: f64,
    pub medium: f64,
    pub hard: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AssessmentParams {
    pub target_item_count: usize,
    pub difficulty_distribution: DifficultyDistribution,
    /// Ratio-based item-type distribution. Optional — YAML configs may
    /// supply only `item_type_counts` (exact integer counts) instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_types: Option<HashMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_type_counts: Option<HashMap<String, usize>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowState {
    pub current_step: usize,
    pub total_steps: usize,
    pub steps: Vec<AgentId>,
    pub status: WorkflowStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInput {
    pub material: Option<MaterialInput>,
    pub competency_dimensions: Vec<Dimension>,
    pub domain_guidance: Option<String>,
    pub assessment_params: AssessmentParams,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DataSlice {
    pub knowledge_units: Option<Vec<Value>>,
    pub mapping: Option<HashMap<String, Value>>,
    pub items: Option<Vec<Value>>,
    pub review: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_claude: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_gemini: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_merged: Option<HashMap<String, Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Costs {
    pub total_usd: f64,
    /// Values are either a number (cost) or a nested object — keep loose.
    pub by_agent: HashMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Blackboard {
    pub workflow: WorkflowState,
    pub user_input: UserInput,
    pub data: DataSlice,
    pub log: Vec<LogEntry>,
    pub costs: Costs,
}

// ─── Staged inputs (held in memory until workflow start) ─────

#[derive(Debug, Default, Clone)]
pub struct StagedInputs {
    pub material: Option<MaterialInput>,
    pub dimensions: Option<Vec<Dimension>>,
    pub assessment_params: Option<AssessmentParams>,
    pub domain_guidance: Option<String>,
}

// ─── Stream-json from `claude --print --output-format stream-json` ─
// We don't fully parse this — just enough to extract result snapshots
// and forward the raw msg to the renderer for display.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResultSnapshot {
    pub total_cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub subtype: Option<String>,
    pub usage: Option<HashMap<String, Value>>,
}
