// ULMS formal v1 — Electron main process
// After step 7a: registers the IPC surface backed by the ported
// coordinator (apps/shell/electron/coordinator/*). Spawns claude CLI
// with cwd = apps/shell/workspace/ so its .claude/skills/ discovery
// finds the four agent skills.

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registerIpc } from './ipc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// apps/shell/workspace — relative to the compiled main bundle.
// Dev: out/main/index.js → ../../workspace resolves to
// apps/shell/workspace. Same relative path inside packaged app.
const WORKSPACE_DIR = path.resolve(__dirname, '../../workspace');

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f5f5f7', // --ulms-canvas
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // relax for later fs/spawn bridge
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    // electron-vite dev server URL injection
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpc(WORKSPACE_DIR);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
