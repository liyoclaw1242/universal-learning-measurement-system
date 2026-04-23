// Blackboard file management. Port of spike v3's resetBlackboard +
// readBlackboard + emptyBlackboard — with the v3 bug fixes applied
// (review_claude/gemini/merged NOT in initial schema; they're added by
// the coordinator after agent-4 runs, so agent-4 can't pre-fill them).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Blackboard, StagedInputs } from './types';

export const AGENTS = ['agent_1', 'agent_2', 'agent_3', 'agent_4'] as const;

const DEFAULT_PARAMS = {
  target_item_count: 6,
  difficulty_distribution: { easy: 0.34, medium: 0.5, hard: 0.16 },
  item_types: { mc_single: 0.5, fill: 0.3, ordering: 0.2 },
};

export function buildEmptyBlackboard(staged: StagedInputs): Blackboard {
  return {
    workflow: {
      current_step: 0,
      total_steps: 4,
      steps: [...AGENTS],
      status: 'pending',
    },
    user_input: {
      material: staged.material,
      competency_dimensions: staged.dimensions ?? [],
      domain_guidance: staged.domain_guidance,
      assessment_params: staged.assessment_params ?? DEFAULT_PARAMS,
    },
    data: {
      knowledge_units: null,
      mapping: null,
      items: null,
      review: null,
    },
    log: [],
    costs: { total_usd: 0, by_agent: {} },
  };
}

export async function writeBlackboard(filePath: string, board: Blackboard): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(board, null, 2));
}

export async function readBlackboard(filePath: string): Promise<Blackboard | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Blackboard;
  } catch {
    return null;
  }
}

export async function resetBlackboard(filePath: string, staged: StagedInputs): Promise<Blackboard> {
  const b = buildEmptyBlackboard(staged);
  await writeBlackboard(filePath, b);
  return b;
}
