// Session / stage / density — shared across Ribbon, StatusBar, and later
// the Zustand store (step 6). Kept minimal here; expanded when the state
// shape lands.

export type Stage = 'inputs' | 'running' | 'review';

export type Density = 'compact' | 'standard' | 'focus';

export interface Session {
  /** short id shown in breadcrumb / statusbar, e.g. "7f3a8c2d" */
  id: string;
  /** "rust-book-ch04" — project scope, displayed in breadcrumb */
  project: string;
  /** "rust-book-ch04-ownership.md" — currently active material */
  material: string;
  /** wall-clock elapsed time in seconds */
  elapsed_s: number;
  /** accumulated cost across claude + gemini */
  cost_usd: number;
  /** per-workflow cap (hard invariant per architecture §3.2 I-cost) */
  cost_cap: number;
  /** idle | running | paused | review | failed */
  status: 'idle' | 'running' | 'paused' | 'review' | 'failed';
}

/** Cost chip fill colour state per handoff §4.3.1 */
export function costStateOf(spent: number, cap: number): 'ok' | 'warn' | 'over' {
  if (cap <= 0) return 'ok';
  const ratio = spent / cap;
  if (ratio > 0.95) return 'over';
  if (ratio > 0.7) return 'warn';
  return 'ok';
}
