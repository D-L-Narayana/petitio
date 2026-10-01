/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built bundle can be served from any sub-path (preview gallery or Vercel root).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 6100, strictPort: true, host: '127.0.0.1' },
  preview: { port: 6100, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
