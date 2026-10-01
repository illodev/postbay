import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks to Vite only; API and media requests are proxied to the API process,
// so cookies and signed media URLs work without CORS.
const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/media': api },
  },
  build: { outDir: 'dist', sourcemap: true },
});
