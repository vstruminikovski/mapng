import { defineConfig } from 'vite';

// GitHub Pages serves the game from /<repo>/ — the deploy workflow sets VITE_BASE.
const base = process.env.VITE_BASE || './';

export default defineConfig({
  base,
  build: { target: 'es2020', chunkSizeWarningLimit: 2600 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
