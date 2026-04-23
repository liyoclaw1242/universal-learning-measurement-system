// Coordinator-internal types. Blackboard v2 schema (ported from spike)
// + stream-json message envelopes emitted by claude --print.
// Kept intentionally loose (`unknown`/broad shape) for agent-produced
// sub-objects — the coordinator doesn't enforce the inner schema;
// schema-check runs at the coordinator boundary and emits warnings.

export type AgentId = 'agent_1' | 'agent_2' | 'agent_3' | 'agent_4';

export interface MaterialSource {
  filename: string;
  char_count: number;
}

export interface MaterialInput {
  /** display label: single filename, or "a.md + b.md" / "a.md + N others" */
  filename: string;
  /** concatenated content, with HTML-comment separators between sources
   *  when `sources.length > 1` */
  content: string;
  content_type: 'text' | 'markdown';
  /** Optional audit trail of which files were concatenated. Absent for
   *  single-file upload (back-compat). */
  sources?: MaterialSource[];
}

export interface Dimension {
  dim_id: string;
  name: string;
  description: string;
}

export interface AssessmentParams {
  target_item_count: number;
  difficulty_distribution: { easy: number; medium: number; hard: number };
  item_types: Record<string, number>;
}

export interface LogEntry {
  agent?: string;
  action?: string;
  at?: string;
  [key: string]: unknown;
}

export interface Blackboard {
  workflow: {
    current_step: number;
    total_steps: number;
    steps: AgentId[];
    status: 'pending' | 'running' | 'completed' | 'failed';
  };
  user_input: {
    material: MaterialInput | null;
    competency_dimensions: Dimension[];
    domain_guidance: string | null;
    assessment_params: AssessmentParams;
  };
  data: {
    knowledge_units: unknown[] | null;
    mapping: Record<string, unknown> | null;
    items: unknown[] | null;
    review: Record<string, unknown> | null;
    // Post-agent-4 rename landing pad (spike v3)
    review_claude?: Record<string, unknown> | null;
    review_gemini?: Record<string, unknown> | null;
    review_merged?: Record<string, unknown> | null;
  };
  log: LogEntry[];
  costs: {
    total_usd: number;
    by_agent: Record<string, number | Record<string, unknown>>;
  };
}

// ─── Staged inputs (held in memory until workflow start) ─────

export interface StagedInputs {
  material: MaterialInput | null;
  dimensions: Dimension[] | null;
  assessment_params: AssessmentParams | null;
  domain_guidance: string | null;
}

// ─── Stream-json from `claude --print --output-format stream-json` ─

export type ClaudeStreamMsg =
  | { type: 'system'; subtype?: string; session_id?: string; [key: string]: unknown }
  | { type: 'assistant'; message?: { content?: ClaudeBlock[] }; [key: string]: unknown }
  | { type: 'user'; message?: { content?: ClaudeBlock[] }; [key: string]: unknown }
  | {
      type: 'result';
      subtype?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      usage?: { cache_read_input_tokens?: number; [k: string]: unknown };
      [key: string]: unknown;
    }
  | { type: string; [key: string]: unknown };

export interface ClaudeBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

export interface ResultSnapshot {
  total_cost_usd?: number;
  duration_ms?: number;
  subtype?: string;
  usage?: { cache_read_input_tokens?: number } & Record<string, unknown>;
}
