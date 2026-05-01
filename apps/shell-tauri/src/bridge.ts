// Thin wrapper around Tauri's invoke + event listen, mirroring the shape
// of `window.ulms` from the Electron preload so a future port can keep
// renderer code mostly unchanged.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface AgentStreamPayload {
  agent: string;
  line: string;
}

export interface AgentCompletedPayload {
  agent: string;
  exit_code: number | null;
}

export interface WorkflowErrorPayload {
  error: string;
}

export const bridge = {
  startWorkflow: () => invoke<void>('start_workflow'),
  stopWorkflow: () => invoke<void>('stop_workflow'),

  onAgentStream: (cb: (p: AgentStreamPayload) => void): Promise<UnlistenFn> =>
    listen<AgentStreamPayload>('agent:stream', (e) => cb(e.payload)),
  onAgentCompleted: (cb: (p: AgentCompletedPayload) => void): Promise<UnlistenFn> =>
    listen<AgentCompletedPayload>('agent:completed', (e) => cb(e.payload)),
  onWorkflowError: (cb: (p: WorkflowErrorPayload) => void): Promise<UnlistenFn> =>
    listen<WorkflowErrorPayload>('workflow:error', (e) => cb(e.payload)),
};
