import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const apiPort = process.env.VITE_API_PORT || '3100';
const apiHost = process.env.VITE_API_HOST || '127.0.0.1';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.ico', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'Remote Agent TUI',
        short_name: 'AgentTUI',
        description: 'Remote coding agent TUI manager',
        start_url: '/',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Only cache static assets, not API calls or WebSocket
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: 'NetworkOnly',
          },
        ],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
      },
    }),
  ],
  server: {
    port: parseInt(process.env.VITE_DEV_PORT || '5173', 10),
    proxy: {
      '/api': `http://${apiHost}:${apiPort}`,
      '/ws': {
        target: `ws://${apiHost}:${apiPort}`,
        ws: true,
      },
    },
  },
});