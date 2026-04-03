import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 关键修复：将绝对路径改为相对路径，解决 Electron 打包后的白屏找不到资源问题
  base: './', 
})