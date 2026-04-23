import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@ulms/ui/styles/shell.css';
import { setupIpcBridge } from './state/ipcBridge';
import { useShellStore } from './state/shellStore';

setupIpcBridge();

// e2e test hook: expose the store so Playwright tests can seed state
// directly (items / agents / stage) without having to actually spawn
// claude / gemini. Active in DEV builds and when ULMS_E2E=1 is passed
// to the renderer via process env. Safe in prod too — contextIsolation
// still prevents leaking Node APIs, this is just a React store.
(window as unknown as { __ulms?: { store: typeof useShellStore } }).__ulms = {
  store: useShellStore,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
