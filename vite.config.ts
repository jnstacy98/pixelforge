import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { outDir: 'dist', target: 'chrome120' }, server: { port: 5173, strictPort: true } });
