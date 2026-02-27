import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
    watch: {
      // Prevent Vite reloading when Python writes __pycache__, config yaml,
      // or the SQLite state DB during daemon/market-loop cycles.
      ignored: [
        '**/__pycache__/**',
        '**/*.pyc',
        '**/config/*.yaml',
        '**/.greenfloor/**',
        '**/greenfloor.egg-info/**',
        '**/*.sqlite',
        '**/*.log',
        '**/*.err',
      ],
    },
  },
  build: {
    outDir: 'dist',
  },
})
