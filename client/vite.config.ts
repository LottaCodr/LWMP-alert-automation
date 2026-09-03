import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the SPA is served by Vite and the API by the Express server on
 * `PORT` (default 3000). Requests are proxied so the browser only ever uses
 * relative URLs — the same code works unchanged when both are served from one
 * origin in production.
 */
const apiTarget = process.env.VITE_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT ?? 5173),
    // Preview environments proxy through a generated hostname.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: true,
  },
});
