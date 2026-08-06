import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkReadingTime from './src/plugins/remark-reading-time.mjs';

// 커스텀 도메인. public/CNAME 파일과 값이 같아야 한다.
export default defineConfig({
  site: 'https://it.looksgood2.me',
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkReadingTime],
    shikiConfig: {
      // 따뜻한 계열 테마. 배경은 global.css 에서 --code-bg 로 덮어쓴다.
      themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
      defaultColor: false, // 라이트와 다크 CSS 변수를 둘 다 내보낸다
      wrap: false,
    },
  },
});
