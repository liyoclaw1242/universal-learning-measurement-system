// Item domain types — assessment items, their reviewer verdicts and
// per-check detail.

export type Verdict = 'accept' | 'needs_revision' | 'reject';
export type UserOverride = 'flag' | 'reject' | 'promote' | 'ship' | null;
export type Agreement = 'accept' | 'reject' | 'revise' | 'disagree';
export type Difficulty = 'low' | 'med' | 'high';
export type Bloom = 'recall' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';
export type ItemType = 'mc_single' | 'mc_multi' | 'fill' | 'ordering' | 'short_answer';

export interface Item {
  id: string;
  stem: string;
  dim: string; // e.g. "①記憶"
  difficulty: Difficulty;
  construct: string;
  bloom: Bloom;
  type: ItemType;
  source: string;
  claude: Verdict;
  gemini: Verdict;
  user: UserOverride;
  /** derived from claude + gemini, populated at fixture-read time */
  agreement: Agreement;
}

// ─── option + check detail ───────────────────────────────────

export interface ItemOption {
  key: string; // "A" / "B" / ...
  text: string;
  correct: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface DualCheck {
  claude: CheckStatus;
  gemini: CheckStatus;
  claude_note: string;
  gemini_note: string;
}

export type CheckKey = 'uniqueness' | 'construct' | 'workaround' | 'ambiguity';

/** per-item map of check → DualCheck */
export type ItemChecks = Record<CheckKey, DualCheck>;

// ─── dimension target ────────────────────────────────────────

export interface Dimension {
  id: string; // "①" / "②" / ...
  name: string;
  weight: number;
  target: number;
}

// ─── derived agreement helper ────────────────────────────────

export function agreementOf(it: Pick<Item, 'claude' | 'gemini'>): Agreement {
  if (it.claude === 'needs_revision' && it.gemini === 'needs_revision') return 'revise';
  if (it.claude === 'reject' && it.gemini === 'reject') return 'reject';
  if (it.claude === 'accept' && it.gemini === 'accept') return 'accept';
  return 'disagree';
}
