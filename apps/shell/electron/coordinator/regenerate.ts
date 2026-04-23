// Per-item regeneration. User rejects / dislikes an item → we re-run
// agent-3 (designer) for JUST that slot, without showing the reviewer's
// concerns to the designer (D1.b — keep agent boundaries clean, rely on
// slot_spec + KU as the only inputs).
//
// Mechanism: temporarily reduce blackboard.mapping.blueprint.slot_specs
// to the single target slot + clear data.items, run /agent-3-designer,
// read back the new item, then restore original state with the new item
// swapped in. The reviewer re-run is NOT automatic; user re-triggers
// "Run Gemini Second Opinion" (or a future "Re-review" flow) to get
// fresh verdicts on the regenerated items.

import path from 'node:path';
import { readBlackboard, writeBlackboard } from './blackboard';
import { coordinatorEvents, spawnAgent } from './workflow';
import type { Blackboard } from './types';

// ─── types (loose; mirrors blackboard schema) ──────────────

interface BBItem {
  item_id?: string;
  slot_index?: number;
  [key: string]: unknown;
}

interface BBSlotSpec {
  slot_index?: number;
  [key: string]: unknown;
}

interface BBMapping {
  blueprint?: { slot_specs?: BBSlotSpec[]; total_slots?: number; [k: string]: unknown };
  [key: string]: unknown;
}

interface BBReview {
  per_item?: Array<{ item_id: string; [k: string]: unknown }>;
  summary?: Record<string, unknown>;
}

// ─── guardrails ─────────────────────────────────────────────

let currentItemId: string | null = null;
let batchRunning = false;

export function isRegenerating(): boolean {
  return currentItemId !== null || batchRunning;
}

export function currentRegenerationItem(): string | null {
  return currentItemId;
}

// ─── main entrypoint ────────────────────────────────────────

export async function regenerateItem(workspaceDir: string, itemId: string): Promise<void> {
  if (currentItemId) throw new Error('another item is already being regenerated');
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');

  const original = await readBlackboard(blackboardPath);
  if (!original) throw new Error('blackboard.json not readable');

  const originalItems = (original.data.items ?? []) as BBItem[];
  const itemIdx = originalItems.findIndex((i) => i.item_id === itemId);
  if (itemIdx < 0) throw new Error(`item ${itemId} not found`);
  const targetSlotIndex = originalItems[itemIdx].slot_index;
  if (typeof targetSlotIndex !== 'number') {
    throw new Error(`item ${itemId} has no slot_index`);
  }

  const originalMapping = original.data.mapping as BBMapping | null;
  const slotSpecs = originalMapping?.blueprint?.slot_specs ?? [];
  const slotSpec = slotSpecs.find((s) => s.slot_index === targetSlotIndex);
  if (!slotSpec) throw new Error(`slot_spec for slot_index ${targetSlotIndex} not found`);

  currentItemId = itemId;
  coordinatorEvents.emit('regenerate:started', { item_id: itemId });

  try {
    // Build reduced blackboard: same user_input, same KUs, but only ONE
    // slot in blueprint + no existing items. agent-3 will produce one
    // item — we'll splice it back into originalItems.
    const reduced: Blackboard = {
      ...original,
      workflow: { ...original.workflow, current_step: 2, status: 'pending' },
      data: {
        ...original.data,
        items: null,
        review: null,
        // Preserve other review blocks verbatim — agent-3 doesn't read them,
        // and we'll restore/filter after the run anyway.
        mapping: {
          ...(originalMapping ?? {}),
          blueprint: {
            ...(originalMapping?.blueprint ?? {}),
            total_slots: 1,
            slot_specs: [slotSpec],
          },
        } as unknown as Blackboard['data']['mapping'],
      },
    };

    await writeBlackboard(blackboardPath, reduced);
    const { result } = await spawnAgent('agent_3', workspaceDir);

    // Read back the result; agent-3 should have written exactly one item
    const post = await readBlackboard(blackboardPath);
    if (!post) throw new Error('blackboard missing after agent-3');
    const newItems = (post.data.items ?? []) as BBItem[];
    if (newItems.length === 0) throw new Error('agent-3 produced no item');
    const newItem = newItems[0];
    // Force the original item_id + slot_index so downstream code can find it
    newItem.item_id = itemId;
    newItem.slot_index = targetSlotIndex;
    // Clear any stale user_override (post-regen the item is new, unjudged)
    delete newItem.user_override;

    // Restore original blackboard + splice the new item in place
    const restored: Blackboard = { ...original };
    restored.data = {
      ...original.data,
      items: originalItems.map((it, i) => (i === itemIdx ? newItem : it)) as unknown[],
      mapping: originalMapping as Blackboard['data']['mapping'],
      review: null,
    };
    restored.workflow = { ...original.workflow };

    // Drop stale review entries for the regenerated item across all three
    // review blocks. Summary fields stay stale until user re-runs review.
    const dropByItemId = (r: BBReview | null | undefined): BBReview | null => {
      if (!r) return r ?? null;
      const per = Array.isArray(r.per_item) ? r.per_item.filter((e) => e.item_id !== itemId) : r.per_item;
      return { ...r, per_item: per };
    };
    restored.data.review_claude = dropByItemId(restored.data.review_claude as BBReview | null) as Blackboard['data']['review_claude'];
    restored.data.review_gemini = dropByItemId(restored.data.review_gemini as BBReview | null) as Blackboard['data']['review_gemini'];
    restored.data.review_merged = dropByItemId(restored.data.review_merged as BBReview | null) as Blackboard['data']['review_merged'];

    // Accrue regenerate cost into a dedicated bucket so the main
    // per-agent cost totals stay meaningful.
    restored.costs = restored.costs ?? { total_usd: 0, by_agent: {} };
    const prior = (restored.costs.by_agent.regenerate as number) ?? 0;
    restored.costs.by_agent.regenerate = prior + (result?.total_cost_usd ?? 0);
    restored.costs.total_usd = Object.values(restored.costs.by_agent).reduce<number>(
      (s, v) => s + (typeof v === 'number' ? v : 0),
      0,
    );

    await writeBlackboard(blackboardPath, restored);
    coordinatorEvents.emit('board:updated', { board: restored });
    coordinatorEvents.emit('regenerate:completed', {
      item_id: itemId,
      cost_usd: result?.total_cost_usd ?? 0,
      duration_ms: result?.duration_ms ?? 0,
    });
  } catch (err) {
    coordinatorEvents.emit('regenerate:error', { item_id: itemId, error: (err as Error).message });
    throw err;
  } finally {
    currentItemId = null;
  }
}

// ─── batch: re-run all items with user_override='reject' ────

export async function regenerateRejected(workspaceDir: string): Promise<void> {
  if (batchRunning) throw new Error('batch already running');
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');
  const snap = await readBlackboard(blackboardPath);
  if (!snap) throw new Error('blackboard.json not readable');
  const items = (snap.data.items ?? []) as BBItem[];
  const rejectedIds = items
    .filter((it) => (it.user_override as string | undefined) === 'reject')
    .map((it) => it.item_id as string)
    .filter(Boolean);

  if (rejectedIds.length === 0) {
    coordinatorEvents.emit('regenerate-batch:completed', { count: 0, regenerated: [] });
    return;
  }

  batchRunning = true;
  coordinatorEvents.emit('regenerate-batch:started', { item_ids: rejectedIds });
  const completed: string[] = [];
  try {
    for (const id of rejectedIds) {
      try {
        await regenerateItem(workspaceDir, id);
        completed.push(id);
        coordinatorEvents.emit('regenerate-batch:item-done', {
          item_id: id,
          remaining: rejectedIds.length - completed.length,
        });
      } catch (err) {
        // One failure shouldn't abort the whole batch; record + continue.
        coordinatorEvents.emit('regenerate:error', {
          item_id: id,
          error: (err as Error).message,
        });
      }
    }
    coordinatorEvents.emit('regenerate-batch:completed', {
      count: completed.length,
      regenerated: completed,
    });
  } finally {
    batchRunning = false;
  }
}
