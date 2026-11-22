import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.STORE_SERVER_URL ?? 'http://localhost:3000';

export default defineConfig({
  base: '/next/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': SERVER,
      '/auth': SERVER,
      '/img': SERVER,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
