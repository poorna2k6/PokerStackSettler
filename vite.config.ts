import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import { shareApiMiddleware } from './server/dev';

export default defineConfig({
  base: './',
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
  plugins: [
    {
      name: 'share-api-dev',
      configureServer(server) { server.middlewares.use(shareApiMiddleware()); },
      configurePreviewServer(server) { server.middlewares.use(shareApiMiddleware()); }
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'StackSettle Pro',
        short_name: 'StackSettle',
        description: 'Poker cash-game buy-in tracking and settlement, works offline.',
        id: './',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0a3d2a',
        theme_color: '#0a3d2a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'], navigateFallbackDenylist: [/^\/api\//] }
    })
  ]
});
