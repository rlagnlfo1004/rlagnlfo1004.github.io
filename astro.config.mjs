import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 도메인을 연결하면 site 값을 그 주소로 바꾸면 됩니다.
export default defineConfig({
  site: 'https://rlagnlfo1004.github.io',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },
});
