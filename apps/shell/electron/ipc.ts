// IPC registration: binds ipcMain handlers that the preload bridge
// invokes, and forwards coordinatorEvents to every open window's
// webContents so the renderer store can subscribe.

import path from 'node:path';
import { ipcMain, BrowserWindow } from 'electron';
import { readBlackboard } from './coordinator/blackboard';
import {
  clearGuidance,
  getStatus,
  pickDimensions,
  pickGuidance,
  pickMaterial,
} from './coordinator/inputs';
import {
  coordinatorEvents,
  runWorkflow,
  stopWorkflow,
  isWorkflowRunning,
} from './coordinator/workflow';
import {
  runSecondOpinion,
  stopSecondOpinion,
  isSecondOpinionRunning,
} from './coordinator/gemini';
import { applyItemOverride, type UserOverride } from './coordinator/overrides';
import { exportItems } from './coordinator/export';

export function registerIpc(workspaceDir: string): void {
  const blackboardPath = path.join(workspaceDir, 'blackboard.json');

  // ─── invoke handlers ─────────────────────────────────────

  ipcMain.handle('inputs:pick-material', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickMaterial(win, workspaceDir);
  });

  ipcMain.handle('inputs:pick-dimensions', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickDimensions(win, workspaceDir);
  });

  ipcMain.handle('inputs:pick-guidance', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickGuidance(win, workspaceDir);
  });

  ipcMain.handle('inputs:clear-guidance', async () => {
    clearGuidance();
    return { ok: true as const };
  });

  ipcMain.handle('inputs:status', async () => getStatus());

  ipcMain.handle('workflow:start', async () => {
    if (isWorkflowRunning()) return { ok: false as const, error: 'already running' };
    runWorkflow(workspaceDir).catch((err) => {
      console.error('runWorkflow threw:', err);
    });
    return { ok: true as const };
  });

  ipcMain.handle('workflow:stop', async () => {
    stopWorkflow();
    return { ok: true as const };
  });

  ipcMain.handle('review:second-opinion', async () => {
    if (isSecondOpinionRunning()) return { ok: false as const, error: 'already running' };
    runSecondOpinion(workspaceDir).catch((err) => {
      console.error('runSecondOpinion threw:', err);
    });
    return { ok: true as const };
  });

  ipcMain.handle('review:stop-second-opinion', async () => {
    stopSecondOpinion();
    return { ok: true as const };
  });

  ipcMain.handle('board:read', async () => readBlackboard(blackboardPath));

  ipcMain.handle('items:override', async (_e, itemId: string, override: UserOverride) => {
    return applyItemOverride(workspaceDir, itemId, override);
  });

  ipcMain.handle('export:items', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return exportItems(win, workspaceDir);
  });

  // ─── event forwarders (coordinator → all windows) ────────

  const eventNames = [
    'workflow:started',
    'workflow:completed',
    'workflow:error',
    'board:updated',
    'schema:warn',
    'agent:started',
    'agent:stream',
    'agent:pty',
    'agent:raw',
    'agent:completed',
    'gemini:started',
    'gemini:stream',
    'gemini:pty',
    'gemini:raw',
    'gemini:completed',
    'second-opinion:completed',
    'second-opinion:error',
  ] as const;

  for (const name of eventNames) {
    coordinatorEvents.on(name, (payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(name, payload);
      }
    });
  }
}
