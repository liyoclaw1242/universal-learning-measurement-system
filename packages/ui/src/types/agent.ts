// Agent domain types — the four-agent pipeline (extractor → mapper →
// designer → reviewer) plus its stream log and tool-call traces.

export type AgentId = 'agent-1' | 'agent-2' | 'agent-3' | 'agent-4';
export type AgentRole = 'extractor' | 'mapper' | 'designer' | 'reviewer';
export type AgentStatus = 'pending' | 'active' | 'done' | 'failed';

export interface ToolCall {
  /** single-char visual prefix: 🔧 💬 ✔ ⚠ ⤷ */
  glyph: string;
  /** human-readable label */
  text: string;
}

export interface Agent {
  id: AgentId;
  name: AgentRole;
  model: string;
  status: AgentStatus;
  cost: number;
  duration_s: number;
  /** short summary of what the agent produced, e.g. "32 KU" / "10 slots" */
  emit: string;
  tools: ToolCall[];
}

// ─── stream log ───────────────────────────────────────────────

export type LogKind = 'thought' | 'tool' | 'result' | 'summary' | 'done' | 'warn' | 'error';

export interface LogLine {
  ts: string;
  kind: LogKind;
  text: string;
}

/** Streams keyed by source id. "unified" is a synthetic merged view
 *  of the four claude agents. "gemini" is the independent second-
 *  opinion reviewer's log (step 7c). */
export type StreamSourceId = AgentId | 'unified' | 'gemini';
export type StreamLog = Record<StreamSourceId, LogLine[] | 'merge'>;
