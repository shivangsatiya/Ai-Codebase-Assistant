import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // Playwright owns e2e/**/*.spec.ts entirely - without this
    // exclusion, Vitest's own default test-file matching picks up
    // those same .spec.ts files and tries to run them as unit tests,
    // where `test.beforeAll`/`page`/`context` etc. don't exist at all.
    // Found immediately by actually running the suite after adding the
    // E2E files, not assumed to be a non-issue.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
