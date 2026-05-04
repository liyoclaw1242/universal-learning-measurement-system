// translateBoard — pure functions mapping blackboard shape (produced
// by the ULMS pipeline) → @ulms/ui component shapes (Item / ItemOption
// / ItemChecks / etc.).
//
// Called by ipcBridge on board:updated and second-opinion:completed.

import type {
  Agreement,
  CheckKey,
  Difficulty,
  DualCheck,
  Item,
  ItemChecks,
  ItemOption,
  ItemType,
  UserOverride,
  Verdict,
} from '@ulms/ui';
import { agreementOf } from '@ulms/ui';

// ─── blackboard-side shapes (loose; we only need what we map) ──

interface BBItem {
  item_id: string;
  slot_index?: number;
  core?: {
    item_type?: string;
    stem?: string;
    stem_assets?: Array<{ type?: string; content?: string }>;
    options?: string[]; // strings like "A. text" or raw text
    answer?: unknown;
    explanation?: string;
  };
  measurement?: {
    knowledge_units?: string[];
    competency_dimensions?: Array<{ dim_id?: string; weight?: number }>;
    difficulty_estimate?: number;
  };
  diagnostics?: unknown;
  designer_notes?: string;
  user_override?: UserOverride;
}

interface BBReviewItem {
  item_id: string;
  verdict?: string;
  checks?: Record<string, { pass?: boolean; concern?: string }>;
  overall_quality_score?: number;
}

interface BBReview {
  per_item?: BBReviewItem[];
}

interface BBDimension {
  dim_id: string;
  name: string;
}

interface BBUserInput {
  competency_dimensions?: BBDimension[];
}

// The subset of Blackboard we consume. Keep wide-open on untyped bits.
export interface TranslateInput {
  data: {
    items?: BBItem[] | null;
    review_claude?: BBReview | null;
    review_gemini?: BBReview | null;
  };
  user_input: BBUserInput;
}

// ─── derived output ────────────────────────────────────────

export interface TranslatedItems {
  items: Item[];
  itemOptions: Record<string, ItemOption[]>;
  itemChecks: Record<string, ItemChecks>;
  itemCode: Record<string, string>;
}

// ─── helpers ───────────────────────────────────────────────

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

function bucketDifficulty(estimate: number | undefined): Difficulty {
  if (estimate === undefined || estimate === null) return 'med';
  if (estimate < 0.34) return 'low';
  if (estimate > 0.66) return 'high';
  return 'med';
}

function toItemType(raw: string | undefined): ItemType {
  const valid: ItemType[] = [
    'mc_single',
    'mc_multi',
    'true_false',
    'fill',
    'ordering',
    'short_answer',
  ];
  if (raw && (valid as string[]).includes(raw)) return raw as ItemType;
  return 'mc_single';
}

function toVerdict(raw: string | undefined): Verdict {
  if (raw === 'accept' || raw === 'needs_revision' || raw === 'reject') return raw;
  return 'needs_revision';
}

function indexByItemId(review: BBReview | null | undefined): Record<string, BBReviewItem> {
  const out: Record<string, BBReviewItem> = {};
  if (!review?.per_item) return out;
  for (const r of review.per_item) out[r.item_id] = r;
  return out;
}

/** Parse "B" / 1 / "B. text" into the letter key. Returns null if not
 *  extractable. */
function answerKeyOf(answer: unknown, options: string[] | undefined): string | null {
  if (typeof answer === 'string') {
    const m = answer.match(/^([A-Z])\b/);
    if (m) return m[1];
    if (options) {
      const idx = options.findIndex((o) => o === answer || o.endsWith(answer));
      if (idx >= 0) return String.fromCharCode(65 + idx);
    }
    return null;
  }
  if (typeof answer === 'number') {
    return String.fromCharCode(65 + answer);
  }
  return null;
}

/** Strip "A. " prefix from an option string. */
function stripOptionPrefix(raw: string): { key: string | null; text: string } {
  const m = raw.match(/^([A-Z])[.、)]\s*(.*)$/);
  if (m) return { key: m[1], text: m[2] };
  return { key: null, text: raw };
}

// Map blackboard check key names → UI check key names.
const CHECK_KEY_MAP: Record<string, CheckKey> = {
  answer_uniqueness: 'uniqueness',
  construct_validity: 'construct',
  bypass_risk: 'workaround',
  ambiguity: 'ambiguity',
};

function pass(raw: { pass?: boolean } | undefined): 'pass' | 'fail' {
  if (raw?.pass === false) return 'fail';
  return 'pass';
}

function buildDualChecks(
  fromClaude: Record<string, { pass?: boolean; concern?: string }> | undefined,
  fromGemini: Record<string, { pass?: boolean; concern?: string }> | undefined,
): ItemChecks | null {
  if (!fromClaude) return null;
  const out = {} as ItemChecks;
  for (const [bbKey, uiKey] of Object.entries(CHECK_KEY_MAP) as Array<[string, CheckKey]>) {
    const c = fromClaude[bbKey];
    const g = fromGemini?.[bbKey];
    const dc: DualCheck = {
      claude: pass(c),
      gemini: g ? pass(g) : pass(c),
      claude_note: c?.concern ?? '',
      gemini_note: g?.concern ?? '',
    };
    out[uiKey] = dc;
  }
  return out;
}

function dimDisplay(
  bbDim: string | undefined,
  bbDimensions: BBDimension[] | undefined,
): string {
  if (!bbDim || !bbDimensions || bbDimensions.length === 0) return bbDim ?? '—';
  const idx = bbDimensions.findIndex((d) => d.dim_id === bbDim);
  if (idx < 0) return bbDim;
  const prefix = CIRCLED[idx] ?? `[${idx + 1}]`;
  return `${prefix}${bbDimensions[idx].name}`;
}

// ─── main entry ────────────────────────────────────────────

export function translateBoard(board: TranslateInput | null | undefined): TranslatedItems {
  const empty: TranslatedItems = { items: [], itemOptions: {}, itemChecks: {}, itemCode: {} };
  if (!board) return empty;
  const bbItems = board.data?.items;
  if (!Array.isArray(bbItems) || bbItems.length === 0) return empty;

  const claudeByItem = indexByItemId(board.data.review_claude);
  const geminiByItem = indexByItemId(board.data.review_gemini);
  const bbDims = board.user_input?.competency_dimensions;

  const items: Item[] = [];
  const itemOptions: Record<string, ItemOption[]> = {};
  const itemChecks: Record<string, ItemChecks> = {};
  const itemCode: Record<string, string> = {};

  for (const bb of bbItems) {
    const id = bb.item_id;
    if (!id) continue;
    const bbClaude = claudeByItem[id];
    const bbGemini = geminiByItem[id];

    const firstDim = bb.measurement?.competency_dimensions?.[0]?.dim_id;
    const claude = toVerdict(bbClaude?.verdict);
    const gemini = toVerdict(bbGemini?.verdict ?? bbClaude?.verdict);

    const uiItem: Item = {
      id,
      stem: bb.core?.stem ?? '',
      dim: dimDisplay(firstDim, bbDims),
      difficulty: bucketDifficulty(bb.measurement?.difficulty_estimate),
      construct: firstDim ?? (bb.measurement?.knowledge_units?.[0] ?? '—'),
      bloom: 'understand',
      type: toItemType(bb.core?.item_type),
      source: bb.measurement?.knowledge_units?.join(', ') ?? '',
      claude,
      gemini,
      user: bb.user_override ?? null,
      agreement: agreementOf({ claude, gemini }) as Agreement,
    };
    items.push(uiItem);

    // options + answer
    const answerKey = answerKeyOf(bb.core?.answer, bb.core?.options);
    if (Array.isArray(bb.core?.options) && bb.core.options.length > 0) {
      itemOptions[id] = bb.core.options.map((raw, i) => {
        const stripped = stripOptionPrefix(raw);
        const key = stripped.key ?? String.fromCharCode(65 + i);
        return {
          key,
          text: stripped.text,
          correct: answerKey === key,
        };
      });
    }

    // checks
    if (bbClaude?.checks) {
      const dual = buildDualChecks(bbClaude.checks, bbGemini?.checks);
      if (dual) itemChecks[id] = dual;
    }

    // code asset
    const firstCode = bb.core?.stem_assets?.find((a) => a.type === 'code' && a.content);
    if (firstCode?.content) itemCode[id] = firstCode.content;
  }

  return { items, itemOptions, itemChecks, itemCode };
}
