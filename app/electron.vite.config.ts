import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// electron-vite treats main / preload / renderer as three separate Vite
// builds. The renderer gets the React plugin + our @/ path alias; main
// and preload stay plain TS.

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: 'electron/main.ts',
      },
      outDir: 'out/main',
    },
  },
  preload: {
    build: {
      lib: {
        entry: 'electron/preload.ts',
      },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: path.resolve(__dirname, 'index.html'),
      },
    },
  },
});
