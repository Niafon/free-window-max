import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({ root: resolve('apps/web'), plugins: [react()], build: { outDir: resolve('apps/web/dist'), emptyOutDir: true }, server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://localhost:3000', '/health': 'http://localhost:3000' } } });
