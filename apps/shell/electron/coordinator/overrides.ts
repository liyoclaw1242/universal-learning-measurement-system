// Item user-override persistence.
// Writes `blackboard.data.items[i].user_override` and emits
// board:updated so the renderer re-syncs.

import path from 'node:path';
import { readBlackboard, writeBlackboard } from './blackboard';
import { coordinatorEvents } from './workflow';

export type UserOverride = 'flag' | 'reject' | 'promote' | 'ship' | null;

export async function applyItemOverride(
  workspaceDir: string,
  itemId: string,
  override: UserOverride,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');
  const board = await readBlackboard(blackboardPath);
  if (!board) return { ok: false, error: 'blackboard.json not readable' };
  if (!Array.isArray(board.data.items)) {
    return { ok: false, error: 'no items to override' };
  }
  let found = false;
  board.data.items = board.data.items.map((raw) => {
    const it = raw as { item_id?: string } & Record<string, unknown>;
    if (it.item_id === itemId) {
      found = true;
      return { ...it, user_override: override };
    }
    return it;
  });
  if (!found) return { ok: false, error: `item ${itemId} not found` };
  await writeBlackboard(blackboardPath, board);
  coordinatorEvents.emit('board:updated', { board });
  return { ok: true };
}
