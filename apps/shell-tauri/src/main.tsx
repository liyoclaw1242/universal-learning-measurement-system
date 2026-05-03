import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@ulms/ui/styles/shell.css';
import { setupIpcBridge } from './state/ipcBridge';
import { useShellStore } from './state/shellStore';

setupIpcBridge();

// e2e test hook: expose the store so Playwright tests can seed state
// directly without having to spawn claude / gemini.
(window as unknown as { __ulms?: { store: typeof useShellStore } }).__ulms = {
  store: useShellStore,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
