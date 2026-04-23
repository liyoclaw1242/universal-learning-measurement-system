/// <reference types="vite/client" />

// Preload bridge — populated progressively as IPC handlers land.
interface Window {
  ulms: import('../electron/preload').UlmsBridge;
}
