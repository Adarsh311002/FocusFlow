import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// `vitest/config` re-exports Vite's `defineConfig` with the `test` block typed,
// which keeps this file free of casts.
import { defineConfig } from 'vitest/config';

// The API binds to 127.0.0.1; targeting it directly avoids `localhost` resolving to
// IPv6 (::1) on Windows.
const API_ORIGIN = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Single-origin development: the browser only ever talks to the Vite origin, so the
    // app never needs an API URL (docs/architecture/overview.md, "Local development").
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true },
      '/socket.io': { target: API_ORIGIN, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
