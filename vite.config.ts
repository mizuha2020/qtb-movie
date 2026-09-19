import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      // Only scan the root index.html; ignore built assets under android/
      entries: 'index.html',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: false,
    },
    build: {
      // Chia vendor chunk: browser cache tốt hơn khi deploy bản mới, và
      // các thư viện chỉ dùng bởi component lazy (shaka/hls/swiper) chỉ
      // tải theo chunk của component đó — đỡ parse lúc khởi động trên TV.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            // Phase 2: react + jsx-runtime PHẢI ở chunk riêng. Trước đây
            // jsx-runtime rớt chung vào vendor-motion (do motion import nó),
            // khiến entry import tĩnh vendor-motion -> motion parse lúc startup
            // dù không component sync nào dùng motion.
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')
            )
              return 'vendor-react';
            if (id.includes('@firebase') || id.includes('node_modules/firebase')) return 'vendor-firebase';
            if (id.includes('hls.js') || id.includes('hls.js')) return 'vendor-hls';
            if (id.includes('shaka-player')) return 'vendor-shaka';
            if (id.includes('swiper')) return 'vendor-swiper';
            if (id.includes('framer-motion') || id.includes('/motion')) return 'vendor-motion';
            if (id.includes('lucide-react')) return 'vendor-lucide';
            return undefined;
          },
        },
      },
    },
  };
});
