import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite uses sensible default entry points:
//   main    -> src/main/index.ts
//   preload -> src/preload/index.ts
//   renderer-> src/renderer/index.html  (root: src/renderer)
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
