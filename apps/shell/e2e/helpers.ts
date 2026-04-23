// Test helpers: launch a fresh Electron instance, clear persisted
// localStorage state (so each test starts from a known UI), provide a
// store-seeding helper.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHELL_ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(SHELL_ROOT, 'workspace');

async function cleanWorkspaceState(): Promise<void> {
  // A real dev run leaves blackboard.json behind with items from the
  // last workflow. If tests then trigger IPC writes (e.g. items:override),
  // coordinator reads that stale blackboard and fires board:updated with
  // its real items, which translateBoard pumps into the store —
  // overwriting whatever test state we seeded. Wipe it before every
  // launch so tests start from a known empty coordinator state.
  for (const name of ['blackboard.json']) {
    await fs.rm(path.join(WORKSPACE, name), { force: true });
  }
  // inputs/ gets re-created on first real upload; clean for isolation.
  await fs.rm(path.join(WORKSPACE, 'inputs'), { recursive: true, force: true });
}

export async function launchShell(): Promise<{
  app: ElectronApplication;
  win: Page;
}> {
  await cleanWorkspaceState();
  const app = await electron.launch({
    args: [path.join(SHELL_ROOT, 'out', 'main', 'index.js')],
    cwd: SHELL_ROOT,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.shell').waitFor({ state: 'visible', timeout: 10_000 });
  // Clear persisted zustand state so density/openTabIds from a prior
  // run don't leak across tests
  await win.evaluate(() => {
    window.localStorage.removeItem('ulms-shell-ui');
  });
  return { app, win };
}

/**
 * Seed the zustand store from test code. Sends a JSON-serialized patch
 * to the renderer, which applies it via store.setState.
 */
export async function seed(
  win: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await win.evaluate((json) => {
    const parsed = JSON.parse(json);
    const store = (window as unknown as { __ulms?: { store: { setState: (p: unknown) => void } } })
      .__ulms?.store;
    if (!store) throw new Error('window.__ulms.store not exposed');
    store.setState(parsed);
  }, JSON.stringify(patch));
}

export const fakeItem = (overrides: Partial<{
  id: string;
  stem: string;
  dim: string;
  difficulty: 'low' | 'med' | 'high';
  construct: string;
  bloom: 'recall' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';
  type: 'mc_single' | 'mc_multi' | 'fill' | 'ordering' | 'short_answer';
  source: string;
  claude: 'accept' | 'needs_revision' | 'reject';
  gemini: 'accept' | 'needs_revision' | 'reject';
  user: null | 'flag' | 'reject' | 'promote' | 'ship';
  agreement: 'accept' | 'reject' | 'revise' | 'disagree';
}> = {}) => ({
  id: 'item_test',
  stem: 'Test stem — is this right?',
  dim: '①記憶',
  difficulty: 'low' as const,
  construct: 'test_construct',
  bloom: 'recall' as const,
  type: 'mc_single' as const,
  source: '§test',
  claude: 'accept' as const,
  gemini: 'accept' as const,
  user: null,
  agreement: 'accept' as const,
  ...overrides,
});
