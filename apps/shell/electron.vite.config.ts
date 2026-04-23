import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// electron-vite treats main / preload / renderer as three separate Vite
// builds. The renderer gets the React plugin + our @/ path alias; main
// and preload stay plain TS.

export default defineConfig({
  // electron-vite bakes in filename conventions:
  //   out/main/index.js    (matches package.json "main")
  //   out/preload/preload.mjs
  //   out/renderer/index.html
  // We explicitly force main to "index.js" via rollup output, and
  // match the preload path in electron/main.ts instead of renaming it
  // (lib fileName option was being overridden by Vite SSR defaults).
  main: {
    build: {
      lib: { entry: 'electron/main.ts', formats: ['es'] },
      outDir: 'out/main',
      rollupOptions: { output: { entryFileNames: 'index.js' } },
    },
  },
  preload: {
    build: {
      lib: { entry: 'electron/preload.ts', formats: ['es'] },
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
