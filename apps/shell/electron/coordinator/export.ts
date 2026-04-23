// Export finalised review as Markdown + JSON.
// Generates a human-readable MD digest alongside the full blackboard
// JSON snapshot. `dialog.showSaveDialog` prompts for a base path; we
// write `<base>.md` and `<base>.json` side by side.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { readBlackboard } from './blackboard';

interface BBItem {
  item_id: string;
  core?: {
    item_type?: string;
    stem?: string;
    options?: string[];
    answer?: unknown;
    explanation?: string;
  };
  measurement?: {
    difficulty_estimate?: number;
    competency_dimensions?: Array<{ dim_id?: string }>;
  };
  user_override?: string | null;
}

interface BBReviewItem {
  item_id: string;
  verdict?: string;
  overall_quality_score?: number;
}

interface BBReview {
  per_item?: BBReviewItem[];
}

function indexReview(r: BBReview | null | undefined): Record<string, BBReviewItem> {
  const out: Record<string, BBReviewItem> = {};
  if (!r?.per_item) return out;
  for (const it of r.per_item) out[it.item_id] = it;
  return out;
}

function renderMarkdown(board: NonNullable<Awaited<ReturnType<typeof readBlackboard>>>): string {
  const items = (board.data.items ?? []) as BBItem[];
  const rc = indexReview(board.data.review_claude as BBReview | null);
  const rg = indexReview(board.data.review_gemini as BBReview | null);
  const merged = board.data.review_merged as {
    per_item?: Array<{ item_id: string; verdict?: string; agreement?: boolean }>;
    summary?: {
      verdict_agreement_rate?: number;
      merged_verdict_counts?: Record<string, number>;
    };
  } | null;

  const lines: string[] = [];
  lines.push(`# ULMS Exam · ${board.user_input?.material?.filename ?? '—'}`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Items: ${items.length}`);
  lines.push(`- Cost: $${(board.costs?.total_usd ?? 0).toFixed(4)}`);
  if (merged?.summary) {
    lines.push(
      `- Dual-reviewer agreement: ${((merged.summary.verdict_agreement_rate ?? 0) * 100).toFixed(0)}%`,
    );
    const c = merged.summary.merged_verdict_counts ?? {};
    lines.push(`- Merged verdicts: accept ${c.accept ?? 0} · needs_revision ${c.needs_revision ?? 0} · reject ${c.reject ?? 0}`);
  }
  lines.push('');

  for (const it of items) {
    const id = it.item_id;
    const mergedRow = merged?.per_item?.find((x) => x.item_id === id);
    const finalVerdict = mergedRow?.verdict ?? rc[id]?.verdict ?? '—';
    const override = it.user_override ? ` · user: ${it.user_override}` : '';
    lines.push(`## ${id} · ${finalVerdict}${override}`);
    lines.push('');
    if (it.core?.item_type) lines.push(`_type_: \`${it.core.item_type}\``);
    if (typeof it.measurement?.difficulty_estimate === 'number') {
      lines.push(`_difficulty_: ${it.measurement.difficulty_estimate.toFixed(2)}`);
    }
    lines.push('');
    if (it.core?.stem) {
      lines.push(it.core.stem);
      lines.push('');
    }
    if (Array.isArray(it.core?.options) && it.core.options.length > 0) {
      for (const o of it.core.options) {
        lines.push(`- ${o}`);
      }
      lines.push('');
    }
    if (it.core?.answer !== undefined && it.core.answer !== null) {
      lines.push(`**Answer:** \`${JSON.stringify(it.core.answer)}\``);
      lines.push('');
    }
    if (it.core?.explanation) {
      lines.push(`**Explanation:** ${it.core.explanation}`);
      lines.push('');
    }
    // reviewer note
    const cqs = rc[id]?.overall_quality_score;
    const gqs = rg[id]?.overall_quality_score;
    if (cqs !== undefined || gqs !== undefined) {
      lines.push(`Reviewer quality — C: ${cqs ?? '—'} · G: ${gqs ?? '—'}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

export async function exportItems(
  win: BrowserWindow | null,
  workspaceDir: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');
  const board = await readBlackboard(blackboardPath);
  if (!board) return { ok: false, error: 'blackboard.json not readable' };
  if (!Array.isArray(board.data.items) || board.data.items.length === 0) {
    return { ok: false, error: 'no items to export' };
  }

  const defaultName = `ulms-export-${Date.now()}`;
  const res = await dialog.showSaveDialog(win ?? (undefined as unknown as BrowserWindow), {
    defaultPath: defaultName,
    filters: [{ name: 'Markdown + JSON base name', extensions: [] }],
    title: 'Export items (base filename; .md + .json will be written)',
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' };

  // Strip any extension the user typed so we can write both files
  const base = res.filePath.replace(/\.(md|json)$/i, '');
  const mdPath = base + '.md';
  const jsonPath = base + '.json';

  try {
    const md = renderMarkdown(board);
    await fs.writeFile(mdPath, md, 'utf-8');
    await fs.writeFile(jsonPath, JSON.stringify(board, null, 2), 'utf-8');
    return { ok: true, paths: [mdPath, jsonPath] };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
