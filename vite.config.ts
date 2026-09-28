import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the production build loads over file:// inside Electron
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // electron-builder writes release/ while the dev server is watching — an
    // un-ignored write there kills vite with EBUSY
    watch: { ignored: ['**/release/**', '**/dist/**'] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
