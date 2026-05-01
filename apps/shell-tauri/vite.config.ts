import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri-recommended config: fixed dev port, no clearScreen so we keep
// Tauri's logs in the terminal, env passthrough for TAURI_* vars.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
