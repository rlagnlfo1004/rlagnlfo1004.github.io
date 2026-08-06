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
    }),
});

export const collections = { posts };
