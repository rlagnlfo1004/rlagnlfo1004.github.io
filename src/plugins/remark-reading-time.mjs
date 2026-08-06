import { toString } from "mdast-util-to-string";

// 한글은 분당 500자 기준으로 계산합니다.
export default function remarkReadingTime() {
  return (tree, file) => {
    const text = toString(tree);
    const minutes = Math.max(1, Math.round(text.length / 500));
    file.data.astro.frontmatter.minutes = minutes;
  };
}
