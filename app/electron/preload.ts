// ULMS preload — contextBridge exposing the minimal IPC surface renderer
// is allowed to use. Kept deliberately empty at scaffold stage; specific
// handlers (inputs loaders, workflow start/stop, second-opinion trigger)
// are added alongside their coordinator-side counterparts in step 7.

import { contextBridge } from 'electron';

const api = {
  // intentionally empty for now. First real handlers land when we port
  // the spike's coordinator (ADR 001 · Migration strategy row "Coordinator
  // logic").
  ping(): string {
    return 'ulms-ready';
  },
};

contextBridge.exposeInMainWorld('ulms', api);

export type UlmsBridge = typeof api;
