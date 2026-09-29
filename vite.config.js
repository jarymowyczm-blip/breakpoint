import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the client is served by Vite (5173) while the authoritative
// game server listens on 8080. Everything the client needs (REST + WebSocket)
// is proxied so the browser only ever talks to one origin -- the same shape it
// has in production, where `server/index.js` serves `dist/` itself.
const GAME_SERVER = process.env.GAME_SERVER_URL || 'http://localhost:8080';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: GAME_SERVER, changeOrigin: true },
      '/ws': { target: GAME_SERVER, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // The three.js bundle is legitimately large; splitting it out means a code
    // change to the game does not invalidate the cached engine chunk.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // A function rather than the object form: this Vite build uses rolldown,
        // which only accepts the callback shape.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
