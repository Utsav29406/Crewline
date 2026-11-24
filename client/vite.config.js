import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // face-api bundles TensorFlow.js; it is lazy-loaded only when the camera opens.
  build: { chunkSizeWarningLimit: 1400 },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
