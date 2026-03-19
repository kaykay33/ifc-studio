import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  // Change 'ifc-studio' to your actual GitHub repo name
  base: '/ifc-studio/',

  plugins: [
    wasm(),
    topLevelAwait()
  ],

  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsDir: 'assets',
  },

  optimizeDeps: {
    exclude: ['web-ifc']
  },

  server: {
    headers: {
      // Required for SharedArrayBuffer (multi-threaded web-ifc)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  }
})
