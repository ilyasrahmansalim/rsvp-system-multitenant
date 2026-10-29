import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Output statis -> cocok untuk Cloudflare Pages (tanpa adapter).
// Ganti `site` dengan domain produksi Anda.
export default defineConfig({
  site: 'https://halo.pages.dev',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [tailwind({ applyBaseStyles: false })],
  vite: {
    ssr: { noExternal: ['@rsvp/shared'] },
  },
});
