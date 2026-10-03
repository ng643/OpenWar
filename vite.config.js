import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the built game can be opened from any folder / static host
  base: './',
  server: { port: 5173 },
  test: { environment: 'node', include: ['test/**/*.test.js'], testTimeout: 30000 }
});
