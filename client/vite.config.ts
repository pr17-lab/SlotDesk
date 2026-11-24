import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The '@/…' imports in the shadcn/ui files come from tsconfig.json's paths.
  resolve: { tsconfigPaths: true },
  server: {
    // The browser only talks to Vite, so the app and the API share one origin
    // in development too. No changeOrigin: Express must see the real Origin.
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
