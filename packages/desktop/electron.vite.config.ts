import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, '../shared/src/index.ts')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@apager/shared': shared } },
    build: {
      rollupOptions: {
        // Optionale Native-Module von ws; ws laeuft ohne sie.
        external: ['bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@apager/shared': shared } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@apager/shared': shared } },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
