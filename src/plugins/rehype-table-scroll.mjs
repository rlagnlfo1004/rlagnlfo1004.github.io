import { SKIP, visit } from "unist-util-visit";

/**
 * 표를 가로 스크롤 래퍼로 감쌉니다.
 *
 * 본문 표는 셀에 `white-space: nowrap` 이 걸려 있어서 열이 많아지거나 긴 예외 메시지가
 * 들어가면 본문 폭(--measure)을 넘어갑니다. 스크롤 컨테이너가 없으면 넘친 부분이
 * 그대로 그려져서 오른쪽에 고정된 목차 위로 겹칩니다.
 *
 * 다이어그램에 쓰는 .diagram-scroll 과 같은 방식이고, 마크다운 표는 직접 래퍼를 쓸 수
 * 없으니 여기서 붙입니다.
 */
export default function rehypeTableScroll() {
  return (tree) => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "table" || !parent || index === null) return;

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"] },
        children: [node],
      };

      // 방금 만든 래퍼로 다시 내려가지 않도록 건너뛴다.
      return [SKIP, index + 1];
    });
  };
}
