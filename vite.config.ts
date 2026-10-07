import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  // 部署在站点子路径(如 /stream/)时,构建产物必须带此前缀;按自己的部署路径修改
  base: '/stream/',
  plugins: [
    react(),
    // libmedia avplayer 的 webpack 分块(163.avplayer.js 等)在运行时按
    // import.meta.url 相对路径加载,rollup 不会打包它们,必须原样拷进产物,
    // 且要与打包后的 avplayer js 同目录(默认 dist/assets/)。
    // dev 模式下配合 optimizeDeps.exclude 从源路径加载,无需拷贝。
    viteStaticCopy({
      targets: [{ src: 'node_modules/@libmedia/avplayer/dist/esm/[0-9]*.avplayer.js', dest: 'assets' }],
    }),
  ],
  // jassub 内部用 new Worker(new URL(...)) 的 ESM worker,rollup 打包它需要 es 格式
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@libmedia/avplayer'] },
  server: { port: 5173 },
  build: { target: 'es2022' },
})
