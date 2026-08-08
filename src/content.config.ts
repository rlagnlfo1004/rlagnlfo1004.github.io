import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const posts = defineCollection({
  loader: glob({ base: "./src/content/posts", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      date: z.date(),
      project: z.string(),          // 아주이벤트 · 메일상자 · 아올다 클라우드 · 공통 · 회고
      tags: z.array(z.string()).default([]),
      cover: image().optional(),    // 목록 썸네일 (없으면 텍스트만 렌더)
      coverAlt: z.string().optional(),
      draft: z.boolean().default(false),
      featured: z.boolean().default(false),   // 홈 상단 "먼저 읽어볼 글" 카드
      // 글 머리의 실측 요약 박스. 본문에서 이미 측정한 값만 넣습니다.
      metrics: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .max(3)
        .optional(),
    }),
});

export const collections = { posts };
