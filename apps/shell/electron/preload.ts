// Preload — contextBridge surface for the renderer.
// Wraps ipcRenderer.invoke + ipcRenderer.on into a typed `window.ulms`.
// Event subscriptions return an unsubscribe function.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;

function subscribe(channel: string, cb: (payload: unknown) => void): Unsubscribe {
  const handler = (_: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  // ── input loaders ─────────────────────────────────────
  pickMaterial: () => ipcRenderer.invoke('inputs:pick-material'),
  pickDimensions: () => ipcRenderer.invoke('inputs:pick-dimensions'),
  pickGuidance: () => ipcRenderer.invoke('inputs:pick-guidance'),
  clearGuidance: () => ipcRenderer.invoke('inputs:clear-guidance'),
  inputsStatus: () => ipcRenderer.invoke('inputs:status'),

  // ── workflow ──────────────────────────────────────────
  startWorkflow: () => ipcRenderer.invoke('workflow:start'),
  stopWorkflow: () => ipcRenderer.invoke('workflow:stop'),
  readBlackboard: () => ipcRenderer.invoke('board:read'),

  // ── second opinion (Gemini) ──────────────────────────
  startSecondOpinion: () => ipcRenderer.invoke('review:second-opinion'),
  stopSecondOpinion: () => ipcRenderer.invoke('review:stop-second-opinion'),

  // ── event subscriptions ───────────────────────────────
  onWorkflowStarted: (cb: () => void): Unsubscribe =>
    subscribe('workflow:started', () => cb()),
  onWorkflowCompleted: (cb: (payload: unknown) => void): Unsubscribe =>
    subscribe('workflow:completed', cb),
  onWorkflowError: (cb: (payload: { error: string }) => void): Unsubscribe =>
    subscribe('workflow:error', (p) => cb(p as { error: string })),
  onBoardUpdated: (cb: (payload: { board: unknown }) => void): Unsubscribe =>
    subscribe('board:updated', (p) => cb(p as { board: unknown })),
  onSchemaWarn: (cb: (payload: { agent: string; warnings: string[] }) => void): Unsubscribe =>
    subscribe('schema:warn', (p) => cb(p as { agent: string; warnings: string[] })),
  onAgentStarted: (cb: (payload: { agent: string }) => void): Unsubscribe =>
    subscribe('agent:started', (p) => cb(p as { agent: string })),
  onAgentStream: (cb: (payload: { agent: string; msg: unknown }) => void): Unsubscribe =>
    subscribe('agent:stream', (p) => cb(p as { agent: string; msg: unknown })),
  onAgentPty: (cb: (payload: { agent: string; data: string }) => void): Unsubscribe =>
    subscribe('agent:pty', (p) => cb(p as { agent: string; data: string })),
  onAgentRaw: (cb: (payload: { agent: string; line: string }) => void): Unsubscribe =>
    subscribe('agent:raw', (p) => cb(p as { agent: string; line: string })),
  onAgentCompleted: (cb: (payload: unknown) => void): Unsubscribe =>
    subscribe('agent:completed', cb),

  // Gemini second-opinion events
  onGeminiStarted: (cb: () => void): Unsubscribe =>
    subscribe('gemini:started', () => cb()),
  onGeminiStream: (cb: (payload: { msg: unknown }) => void): Unsubscribe =>
    subscribe('gemini:stream', (p) => cb(p as { msg: unknown })),
  onGeminiPty: (cb: (payload: { data: string }) => void): Unsubscribe =>
    subscribe('gemini:pty', (p) => cb(p as { data: string })),
  onGeminiRaw: (cb: (payload: { line: string }) => void): Unsubscribe =>
    subscribe('gemini:raw', (p) => cb(p as { line: string })),
  onGeminiCompleted: (cb: (payload: unknown) => void): Unsubscribe =>
    subscribe('gemini:completed', cb),
  onSecondOpinionCompleted: (cb: (payload: unknown) => void): Unsubscribe =>
    subscribe('second-opinion:completed', cb),
  onSecondOpinionError: (cb: (payload: { error: string }) => void): Unsubscribe =>
    subscribe('second-opinion:error', (p) => cb(p as { error: string })),

  // legacy sanity check
  ping(): string {
    return 'ulms-ready';
  },
};

contextBridge.exposeInMainWorld('ulms', api);

export type UlmsBridge = typeof api;
