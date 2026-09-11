import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5177,
  },
  build: {
    outDir: '../server/dist/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3007',
      '/ws': { target: 'ws://127.0.0.1:3007', ws: true },
    },
  },
});
