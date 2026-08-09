import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkReadingTime from './src/plugins/remark-reading-time.mjs';
import rehypeTableScroll from './src/plugins/rehype-table-scroll.mjs';

// 커스텀 도메인. public/CNAME 파일과 값이 같아야 한다.
export default defineConfig({
  site: 'https://it.looksgood2.me',
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkReadingTime],
    rehypePlugins: [rehypeTableScroll],
    shikiConfig: {
      // vitesse 는 따뜻한 갈색 계열이라 이 사이트의 차가운 회색·파랑과 겉돌고,
      // 라이트 모드에서는 대비까지 낮아 코드가 흐리게 보였다. 깃허브 쌍으로 바꾼다.
      // 배경은 global.css 에서 --code-bg 로 덮어쓴다.
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false, // 라이트와 다크 CSS 변수를 둘 다 내보낸다
      wrap: false,
    },
  },
});
