// Gemini independent second-opinion reviewer.
// Port of spike v3's spawnGeminiReviewer + runSecondOpinion + mergeReviews,
// carrying forward the two bug fixes:
//   1. initial blackboard schema does NOT pre-seed review_claude/gemini/
//      merged (so agent-4 can't leak metadata into review_claude) — done
//      in blackboard.ts
//   2. before spawning Gemini, DELETE data.review instead of setting to
//      null (Gemini's surgical `replace` tool would otherwise create a
//      duplicate key in the JSON)

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readBlackboard, writeBlackboard } from './blackboard';
import { coordinatorEvents, GEMINI_BIN } from './workflow';
import type { Blackboard } from './types';

// ─── types for Gemini's stream-json shape ──────────────────

export type GeminiStreamMsg =
  | { type: 'init'; session_id?: string; model?: string; timestamp?: string }
  | { type: 'message'; role: 'user' | 'assistant'; content?: string; delta?: boolean; timestamp?: string }
  | { type: 'result'; status?: string; stats?: GeminiStats; timestamp?: string }
  | { type: string; [key: string]: unknown };

interface GeminiStats {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  tool_calls?: number;
  models?: Record<string, unknown>;
}

interface GeminiResultSnapshot {
  status?: string;
  total_tokens?: number;
  input_tokens?: number;
  duration_ms?: number;
}

// ─── spawn state ───────────────────────────────────────────

let currentGeminiProc: ChildProcess | null = null;
let geminiRunning = false;

const REVIEWER_SKILL_NAME = 'agent-4-reviewer';
const GEMINI_TIMEOUT_MS = 300_000;

export function stopSecondOpinion(): void {
  if (currentGeminiProc) {
    try { currentGeminiProc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

export function isSecondOpinionRunning(): boolean {
  return geminiRunning;
}

// ─── prompt construction ────────────────────────────────────

/** Load agent-4-reviewer's SKILL.md body (strip frontmatter) and wrap
 *  with a short instruction telling Gemini to follow it verbatim. */
function loadReviewerSkillForGemini(workspaceDir: string): string {
  const skillPath = path.join(workspaceDir, '.claude', 'skills', REVIEWER_SKILL_NAME, 'SKILL.md');
  const raw = readFileSync(skillPath, 'utf-8');
  const bodyOnly = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  return [
    '你現在要扮演的角色是 agent-4-reviewer。',
    '工作目錄下有 blackboard.json，你有讀寫檔工具可用。',
    '請嚴格按以下 skill 內容完成任務：',
    '',
    '---',
    bodyOnly,
    '---',
    '',
    '現在開始執行。完成後必須把結果寫回 blackboard.json。',
  ].join('\n');
}

// ─── gemini spawn (stdin-only, -o stream-json triggers headless) ─

function spawnGeminiReviewer(workspaceDir: string): Promise<GeminiResultSnapshot | null> {
  return new Promise((resolve, reject) => {
    const prompt = loadReviewerSkillForGemini(workspaceDir);
    coordinatorEvents.emit('gemini:started', {});

    // `gemini -y -o stream-json` + stdin prompt → headless mode. No
    // `-p` flag needed; the stream-json output format implicitly sets
    // non-interactive. (Documented in apps/spike/main.js comment.)
    const args = [
      '-y',                               // YOLO: auto-approve tools
      '-o', 'stream-json',
      '--include-directories', workspaceDir,
    ];

    const proc = spawn(GEMINI_BIN, args, {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentGeminiProc = proc;

    let lineBuf = '';
    let lastResult: GeminiResultSnapshot | null = null;

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`gemini reviewer timeout after ${GEMINI_TIMEOUT_MS}ms`));
    }, GEMINI_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      coordinatorEvents.emit('gemini:pty', { data });

      lineBuf += data;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '').trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as GeminiStreamMsg;
          if (msg.type === 'result') {
            const r = msg as { status?: string; stats?: GeminiStats };
            lastResult = {
              status: r.status,
              total_tokens: r.stats?.total_tokens,
              input_tokens: r.stats?.input_tokens,
              duration_ms: r.stats?.duration_ms,
            };
          }
          coordinatorEvents.emit('gemini:stream', { msg });
        } catch {
          coordinatorEvents.emit('gemini:raw', { line });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      coordinatorEvents.emit('gemini:pty', { data: `[stderr] ${chunk.toString()}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (currentGeminiProc === proc) currentGeminiProc = null;
      reject(new Error(`gemini spawn error: ${err.message}`));
    });

    proc.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (currentGeminiProc === proc) currentGeminiProc = null;
      coordinatorEvents.emit('gemini:completed', { exit_code: exitCode, result: lastResult });
      if (exitCode === 0) resolve(lastResult);
      else reject(new Error(`gemini exited with code ${exitCode}`));
    });
  });
}

// ─── merge rules (D4: strictest verdict + check agreement) ──

type Verdict = 'accept' | 'needs_revision' | 'reject';
const VERDICT_RANK: Record<Verdict, number> = { accept: 0, needs_revision: 1, reject: 2 };
const VERDICT_BY_RANK: Verdict[] = ['accept', 'needs_revision', 'reject'];

function mergeVerdict(cv: string | undefined, gv: string | undefined): Verdict {
  const cr = VERDICT_RANK[cv as Verdict] ?? 1;
  const gr = VERDICT_RANK[gv as Verdict] ?? 1;
  return VERDICT_BY_RANK[Math.max(cr, gr)];
}

const CHECK_FIELDS = ['answer_uniqueness', 'construct_validity', 'ambiguity', 'bypass_risk'] as const;

interface ReviewPerItem {
  item_id: string;
  verdict?: Verdict;
  checks?: Record<string, { pass?: boolean; concern?: string }>;
  overall_quality_score?: number;
  notes?: string;
}

interface ReviewBlock {
  per_item?: ReviewPerItem[];
  summary?: { total_items?: number; [k: string]: unknown };
}

export function mergeReviews(rc: ReviewBlock | null | undefined, rg: ReviewBlock | null | undefined) {
  const ci = rc?.per_item ?? [];
  const gi = rg?.per_item ?? [];
  const geminiById: Record<string, ReviewPerItem> = {};
  for (const g of gi) geminiById[g.item_id] = g;

  const perItem = ci.map((c) => {
    const g = geminiById[c.item_id];
    const checksAgreement: Record<string, boolean | null> = {};
    for (const cf of CHECK_FIELDS) {
      const cp = c.checks?.[cf]?.pass;
      const gp = g?.checks?.[cf]?.pass;
      checksAgreement[cf] = cp !== undefined && gp !== undefined ? cp === gp : null;
    }
    const claudeConcerns = CHECK_FIELDS.map((cf) => c.checks?.[cf]?.concern).filter(Boolean);
    const geminiConcerns = CHECK_FIELDS.map((cf) => g?.checks?.[cf]?.concern).filter(Boolean);
    return {
      item_id: c.item_id,
      verdict: mergeVerdict(c.verdict, g?.verdict),
      verdict_claude: c.verdict,
      verdict_gemini: g?.verdict,
      agreement: c.verdict === g?.verdict,
      checks_agreement: checksAgreement,
      quality_score_claude: c.overall_quality_score,
      quality_score_gemini: g?.overall_quality_score,
      claude_concerns: claudeConcerns,
      gemini_concerns: geminiConcerns,
    };
  });

  const total = perItem.length;
  const agreeCount = perItem.filter((p) => p.agreement).length;
  const perCheckAgreement: Record<string, { rate: number | null; measured_on: number }> = {};
  for (const cf of CHECK_FIELDS) {
    const measurable = perItem.filter((p) => p.checks_agreement[cf] !== null);
    const agree = measurable.filter((p) => p.checks_agreement[cf]).length;
    perCheckAgreement[cf] = measurable.length
      ? { rate: agree / measurable.length, measured_on: measurable.length }
      : { rate: null, measured_on: 0 };
  }
  const counts: Record<Verdict, number> = { accept: 0, needs_revision: 0, reject: 0 };
  for (const p of perItem) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;

  return {
    per_item: perItem,
    summary: {
      total_items: total,
      reviewers: ['claude', 'gemini'] as const,
      verdict_agreement_rate: total ? agreeCount / total : 0,
      per_check_agreement: perCheckAgreement,
      merged_verdict_counts: counts,
      disagreement_item_ids: perItem.filter((p) => !p.agreement).map((p) => p.item_id),
    },
  };
}

// ─── runSecondOpinion orchestrator ──────────────────────────

export async function runSecondOpinion(workspaceDir: string): Promise<void> {
  if (geminiRunning) return;
  geminiRunning = true;
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');

  try {
    const before = await readBlackboard(blackboardPath);
    if (!before) throw new Error('blackboard.json not readable');
    if (!Array.isArray(before.data?.items) || before.data.items.length === 0) {
      throw new Error('no items to review (run the full workflow first)');
    }
    if (!before.data.review_claude) {
      throw new Error('data.review_claude missing (did agent-4 complete?)');
    }

    // Clear any previous re-run state
    if (before.data.review_gemini) {
      delete (before.data as Record<string, unknown>).review_gemini;
      delete (before.data as Record<string, unknown>).review_merged;
    }
    // Critical: DELETE not null — Gemini's surgical-replace tool can
    // otherwise leave a stale "review": null sibling key that shadows
    // its real output (spike v3 bugfix, commit 11cce02).
    delete (before.data as Record<string, unknown>).review;
    await writeBlackboard(blackboardPath, before);
    coordinatorEvents.emit('board:updated', { board: before });

    const result = await spawnGeminiReviewer(workspaceDir);

    // Read back, validate, rename review → review_gemini, compute merged
    const after = await readBlackboard(blackboardPath);
    if (!after) throw new Error('blackboard.json not readable after gemini');
    if (!after.data.review) {
      throw new Error('Gemini exited but data.review is empty (skill not followed)');
    }
    after.data.review_gemini = after.data.review;
    delete (after.data as Record<string, unknown>).review;
    after.data.review_merged = mergeReviews(
      after.data.review_claude as ReviewBlock | null,
      after.data.review_gemini as ReviewBlock | null,
    ) as Blackboard['data']['review_merged'];

    // token accounting (Gemini CLI doesn't report USD; we store tokens)
    after.costs = after.costs ?? { total_usd: 0, by_agent: {} };
    after.costs.by_agent.gemini_reviewer = {
      tokens: result?.total_tokens ?? 0,
      input_tokens: result?.input_tokens ?? 0,
      duration_ms: result?.duration_ms ?? 0,
      cost_usd_note: 'not reported by Gemini CLI; compute from token pricing if needed',
    };

    await writeBlackboard(blackboardPath, after);
    coordinatorEvents.emit('board:updated', { board: after });
    coordinatorEvents.emit('second-opinion:completed', {
      board: after,
      merged_summary: (after.data.review_merged as { summary?: unknown })?.summary,
    });
  } catch (err) {
    coordinatorEvents.emit('second-opinion:error', { error: (err as Error).message });
  } finally {
    geminiRunning = false;
  }
}
