// Claude 4-agent sequential workflow. Ports spike v3's spawnAgent +
// runWorkflow with stream-json parsing. Events are emitted via a simple
// event bus; ipc.ts subscribes and forwards to webContents.
//
// Note on skills: each agent's prompt is a single-line slash command
// (e.g. "/agent-1-extractor"). Claude CLI discovers the SKILL.md from
// cwd/.claude/skills/<name>/SKILL.md. We spawn with cwd = workspaceDir
// so the skills in apps/shell/workspace/.claude/skills/ are found.

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  AgentId,
  Blackboard,
  ClaudeStreamMsg,
  ResultSnapshot,
} from './types';
import { AGENTS, readBlackboard, resetBlackboard, writeBlackboard } from './blackboard';
import { getStaged, inputsReady } from './inputs';

// ─── binary resolution ──────────────────────────────────────

function resolveBinary(name: string, fallback: string): string {
  try {
    const p = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
    if (p) return p;
  } catch {
    // fall through
  }
  return fallback;
}

export const CLAUDE_BIN = resolveBinary('claude', `${process.env.HOME}/.local/bin/claude`);
export const GEMINI_BIN = resolveBinary('gemini', '/opt/homebrew/bin/gemini');

// ─── config ──────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 300_000;
const MAX_BUDGET_PER_CALL = '0.50';
const MODEL = process.env.ULMS_MODEL || 'haiku';

const AGENT_SLUGS: Record<AgentId, string> = {
  agent_1: 'agent-1-extractor',
  agent_2: 'agent-2-mapper',
  agent_3: 'agent-3-designer',
  agent_4: 'agent-4-reviewer',
};

// ─── event bus ───────────────────────────────────────────────

export const coordinatorEvents = new EventEmitter();

// Named events (payload shapes mirror spike's sendUI channels):
export interface WorkflowStartedPayload {}
export interface AgentStartedPayload { agent: AgentId }
export interface AgentStreamPayload { agent: AgentId; msg: ClaudeStreamMsg }
export interface AgentRawPayload { agent: AgentId; line: string }
export interface AgentPtyPayload { agent: AgentId; data: string }
export interface AgentCompletedPayload {
  agent: AgentId;
  exit_code: number | null;
  result: ResultSnapshot | null;
}
export interface BoardUpdatedPayload { board: Blackboard }
export interface SchemaWarnPayload { agent: AgentId; warnings: string[] }
export interface WorkflowCompletedPayload {
  board: Blackboard;
  total_cost_usd: number;
  total_duration_ms: number;
  per_agent: Array<{
    agent: AgentId;
    cost_usd: number;
    duration_ms: number;
    subtype: string;
  }>;
}
export interface WorkflowErrorPayload { error: string }

// ─── workflow state ─────────────────────────────────────────

let isRunning = false;
let currentProc: ChildProcess | null = null;

export function isWorkflowRunning(): boolean {
  return isRunning;
}

export function stopWorkflow(): void {
  if (currentProc) {
    try { currentProc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

// ─── spawnAgent ──────────────────────────────────────────────

export function spawnAgent(
  agentName: AgentId,
  workspaceDir: string,
): Promise<{ result: ResultSnapshot | null }> {
  return new Promise((resolve, reject) => {
    const slug = AGENT_SLUGS[agentName];
    const prompt = `/${slug}`;
    coordinatorEvents.emit('agent:started', { agent: agentName });

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      '--max-budget-usd', MAX_BUDGET_PER_CALL,
      '--model', MODEL,
      '--add-dir', workspaceDir,
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentProc = proc;

    let lineBuf = '';
    let lastResult: ResultSnapshot | null = null;

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`${agentName} timeout after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      coordinatorEvents.emit('agent:pty', { agent: agentName, data });

      lineBuf += data;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '').trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as ClaudeStreamMsg;
          if (msg.type === 'result') {
            lastResult = {
              total_cost_usd: (msg as { total_cost_usd?: number }).total_cost_usd,
              duration_ms: (msg as { duration_ms?: number }).duration_ms,
              subtype: (msg as { subtype?: string }).subtype,
              usage: (msg as { usage?: ResultSnapshot['usage'] }).usage,
            };
          }
          coordinatorEvents.emit('agent:stream', { agent: agentName, msg });
        } catch {
          coordinatorEvents.emit('agent:raw', { agent: agentName, line });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      coordinatorEvents.emit('agent:pty', { agent: agentName, data: `[stderr] ${chunk.toString()}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (currentProc === proc) currentProc = null;
      reject(new Error(`${agentName} spawn error: ${err.message}`));
    });

    proc.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (currentProc === proc) currentProc = null;
      coordinatorEvents.emit('agent:completed', {
        agent: agentName,
        exit_code: exitCode,
        result: lastResult,
      });
      if (exitCode === 0) {
        resolve({ result: lastResult });
      } else {
        reject(new Error(`${agentName} exited with code ${exitCode}`));
      }
    });
  });
}

// ─── schema sanity check ────────────────────────────────────

function schemaCheck(agentName: AgentId, board: Blackboard): string[] {
  const warns: string[] = [];
  const data = board.data;
  if (agentName === 'agent_1') {
    const kus = data.knowledge_units as Array<Record<string, unknown>> | null;
    if (!Array.isArray(kus) || kus.length === 0) {
      warns.push('data.knowledge_units missing or empty');
    } else {
      for (const [i, ku] of kus.entries()) {
        if (!ku.ku_id) warns.push(`ku[${i}] missing ku_id`);
        if (!ku.source_excerpt) warns.push(`ku[${i}] missing source_excerpt (Iron Law B risk)`);
      }
    }
  } else if (agentName === 'agent_2') {
    const m = data.mapping as { blueprint?: { slot_specs?: unknown[] }; ku_to_dimensions?: unknown } | null;
    if (!m) warns.push('data.mapping missing');
    else {
      if (!m.blueprint || !Array.isArray(m.blueprint.slot_specs)) {
        warns.push('mapping.blueprint.slot_specs missing');
      }
      if (!m.ku_to_dimensions) warns.push('mapping.ku_to_dimensions missing');
    }
  } else if (agentName === 'agent_3') {
    const items = data.items as Array<Record<string, unknown>> | null;
    if (!Array.isArray(items) || items.length === 0) {
      warns.push('data.items missing or empty');
    } else {
      for (const [i, it] of items.entries()) {
        if (!it.item_id) warns.push(`item[${i}] missing item_id`);
        const core = it.core as { answer?: unknown } | undefined;
        if (!core || core.answer === undefined) warns.push(`item[${i}] missing core.answer`);
      }
    }
  } else if (agentName === 'agent_4') {
    const r = data.review as { per_item?: unknown[]; summary?: unknown } | null;
    if (!r) warns.push('data.review missing');
    else {
      if (!Array.isArray(r.per_item)) warns.push('review.per_item missing');
      if (!r.summary) warns.push('review.summary missing');
    }
  }
  return warns;
}

// ─── runWorkflow ─────────────────────────────────────────────

export async function runWorkflow(workspaceDir: string): Promise<void> {
  if (isRunning) return;
  if (!inputsReady()) {
    coordinatorEvents.emit('workflow:error', { error: 'material and dimensions must be loaded first' });
    return;
  }
  isRunning = true;

  const blackboardPath = path.join(workspaceDir, 'blackboard.json');

  try {
    await resetBlackboard(blackboardPath, getStaged());
    coordinatorEvents.emit('workflow:started', {});
    const initial = await readBlackboard(blackboardPath);
    if (initial) coordinatorEvents.emit('board:updated', { board: initial });

    const results: (ResultSnapshot | null)[] = [];
    for (let i = 0; i < AGENTS.length; i++) {
      const agentName = AGENTS[i];
      const { result } = await spawnAgent(agentName, workspaceDir);
      results.push(result);

      const board = await readBlackboard(blackboardPath);
      if (!board) throw new Error('blackboard.json not readable after ' + agentName);

      // update cost
      board.costs = board.costs || { total_usd: 0, by_agent: {} };
      board.costs.by_agent[agentName] = result?.total_cost_usd ?? 0;
      board.costs.total_usd = Object.values(board.costs.by_agent).reduce<number>(
        (s, v) => s + (typeof v === 'number' ? v : 0),
        0,
      );
      await writeBlackboard(blackboardPath, board);
      coordinatorEvents.emit('board:updated', { board });

      const warns = schemaCheck(agentName, board);
      if (warns.length) coordinatorEvents.emit('schema:warn', { agent: agentName, warnings: warns });

      const expectedStep = i + 1;
      if (board.workflow.current_step < expectedStep) {
        throw new Error(
          `${agentName} exited but workflow.current_step is ${board.workflow.current_step}, expected >= ${expectedStep}`,
        );
      }
    }

    // Post-loop: rename data.review → data.review_claude (spike v3 bugfix)
    const postBoard = await readBlackboard(blackboardPath);
    if (postBoard && postBoard.data.review) {
      postBoard.data.review_claude = postBoard.data.review;
      postBoard.data.review = null;
      await writeBlackboard(blackboardPath, postBoard);
      coordinatorEvents.emit('board:updated', { board: postBoard });
    }

    const totalCost = results.reduce<number>((s, r) => s + (r?.total_cost_usd ?? 0), 0);
    const totalDuration = results.reduce<number>((s, r) => s + (r?.duration_ms ?? 0), 0);
    const finalBoard = await readBlackboard(blackboardPath);
    coordinatorEvents.emit('workflow:completed', {
      board: finalBoard,
      total_cost_usd: totalCost,
      total_duration_ms: totalDuration,
      per_agent: results.map((r, i) => ({
        agent: AGENTS[i],
        cost_usd: r?.total_cost_usd ?? 0,
        duration_ms: r?.duration_ms ?? 0,
        subtype: r?.subtype ?? 'unknown',
      })),
    });
  } catch (err) {
    coordinatorEvents.emit('workflow:error', { error: (err as Error).message });
  } finally {
    isRunning = false;
  }
}

// Expose for ipc.ts
export { readBlackboard as readBlackboardFile };
