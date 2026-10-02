import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks to Vite only; API and media requests are proxied to the API process,
// so cookies and signed media URLs work without CORS.
const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // /.well-known: the discovery documents an AI assistant reads before signing in (MCP, see apps/api/src/routes/mcp.ts).
    proxy: { '/api': api, '/media': api, '/.well-known': api },
  },
  build: { outDir: 'dist', sourcemap: true },
});
