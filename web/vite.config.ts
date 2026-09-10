import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API port is configurable so the dev server can coexist with whatever else
// is already bound to 3000 on a given machine.
const apiPort = process.env.API_PORT ?? '3000';
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': apiTarget,
      '/dev': apiTarget,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
