# blog-site — rlagnlfo1004.github.io / it.looksgood2.me

Astro 5 기술 블로그. 글은 `src/content/posts/NN-slug.md`, 토큰과 조판은 `src/styles/global.css` 한 곳에 있습니다.
`main` 직접 커밋 → 푸시가 관례입니다(GitHub Pages 자동 배포). 커밋 메시지는 **한국어 한 줄, 서명·세션 링크 없음.**

---

## 다이어그램

이 블로그에서 그림은 **세 가지 방식**뿐이고, 셋 다 `global.css` 토큰을 읽어 다크 모드에서 같이 뒤집힙니다.

| 방식 | 형태 | 언제 |
|---|---|---|
| **인라인 SVG** (기본) | `<svg class="diagram" viewBox="0 0 720 H" role="img" aria-label="…">` | 좌표를 직접 잡는 구조도·계층도·타임라인. 현재 67개 |
| **mermaid** | `<figure class="mermaid-figure"><pre class="mermaid-src">…</pre></figure>` | 노드가 많고 자동 배치가 나은 flowchart·sequence. 그림 위 '이미지 복사 / 코드 복사'와 확대가 붙습니다 |
| ~~정적 파일~~ | `src/assets/diagrams/*.{svg,png}` | **쓰지 않습니다.** 참조 없는 옛 잔재라 여기에 새로 넣지 마세요 |

### 인라인 SVG 규칙 (기존 67개가 지키는 것)

- `viewBox="0 0 720 H"` — 폭은 **항상 720**. `--read: 51.25rem` 칸에서 거의 1:1로 렌더됩니다.
  가로로 긴 그림은 `<div class="diagram-scroll" style="--diagram-min-w: 900px">` 로 감쌉니다.
- **모든 색은 `var(--토큰, #폴백)`.** 리터럴 hex 하나가 다크 모드에서 밝은 덩어리로 뜹니다.
  폴백은 **`global.css` 에서 읽어옵니다.** 옛 글 일부에 리디자인 전 따뜻한 값(`#BF5F3B`, `#221F1B`)이
  남아 있는데 그건 낡은 값이라 복사하면 안 됩니다.
- `font-family` 는 **쓰지 않습니다.** `.prose .diagram text` 가 이미 `var(--font-sans)` 로 못 박아 둡니다.
  포트·프로토콜·측정 숫자처럼 mono 가 필요한 칸만 `font-family="var(--font-mono)"`.
- 글자 크기는 9.5–13. 제목 줄 13/600, 노드 이름 11.5–12/700, 부라벨·화살표 라벨 10.5–11.
- 한글은 mono 칸에 넣지 않습니다. 그림 아래 해설은 `<p class="diagram-note">`.
- `<marker id>` 는 글마다 접두어를 붙여 겹치지 않게 합니다 (`d47a`, `d47b` — 47번 글).

---

## diagram-design 스킬

전역에 플러그인으로 붙어 있습니다 (`diagram-design@diagram-design`, user scope).
39종 다이어그램 타입 레퍼런스 + 취향 게이트 + 기하 검증 스크립트를 갖고 있습니다.

**스킨은 이미 이 프로젝트에 묶여 있습니다.** 저장소 루트의 `.diagram-design` 마커가
`~/.diagram-design/profiles/looksgood-blog.md` 프로필을 가리키고, 그 프로필이 `global.css` 토큰을
스킬의 시맨틱 롤(`paper` / `ink` / `accent` …)에 매핑해 둡니다. 그래서:

- 첫 실행 브랜딩 질문(onboarding gate)이 **뜨지 않습니다.** 뜨면 마커가 깨진 것이니 고치세요.
- 스킬이 기본으로 내보내는 **Instrument Serif / Geist / Geist Mono 와 Google Fonts `<link>` 는 이 블로그에서 금지**입니다.
  서체는 Pretendard + JetBrains Mono 둘뿐입니다.
- `global.css` 토큰을 손대면 프로필도 같이 고칩니다: `/diagram-design:profile update looksgood-blog`.
  **`global.css` 가 원본이고 프로필이 사본입니다.**

### 글에 넣는 순서

스킬은 자체 완결 HTML 을 내보냅니다. 그건 **중간 산출물**이고, 글에 들어가는 것은 그 안의 `<svg>` 뿐입니다.

1. 작업용 HTML 을 **스크래치패드에** 만듭니다. 저장소에 `.html` 을 남기지 마세요.
   크기는 `--size=fit` 로 두고 viewBox 폭을 720 에 맞춥니다 (`doc-inline` 기본값 960 은 이 칸보다 넓습니다).
2. 스킬의 취향 게이트(SKILL.md §9)와 해당 타입의 `verify-*.py` 를 HTML 상태에서 돌립니다.
3. `<svg>` 만 떼어 글에 붙이고 이 블로그 형태로 바꿉니다:
   - `class="diagram"` 추가, `viewBox` 폭 720, `role="img"` + `aria-label` 유지
   - 리터럴 hex → `var(--토큰, #폴백)` (매핑은 프로필의 *Semantic roles* 표)
   - `font-family` 속성 제거 (mono 칸만 `var(--font-mono)`)
   - `<style>`·`<link>`·바깥 HTML 래퍼·배경 `<rect>` 제거 — 그림은 글 바탕에 투명하게 얹힙니다
4. `npx astro build` 로 확인하고, **라이트/다크 둘 다** 눈으로 봅니다.

노드가 10개를 넘거나 자동 배치가 나아 보이면 인라인 SVG 를 고집하지 말고 mermaid 로 갑니다.
`src/scripts/mermaid.ts` 가 `accent`/`soft`/`neutral`/`mute`/`warn` classDef 를 토큰에서 만들어 줍니다
(`warn` 로즈는 토큰에 없고 스크립트에만 있습니다 — 락·데드락·실패 경로에만).

### 슬래시 커맨드

| 커맨드 | 용도 |
|---|---|
| `/diagram-design:doctor` | 환경 점검 |
| `/diagram-design:profile` | `list` / `show` / `update looksgood-blog` / `save` |
| `/diagram-design:import-mermaid` | 기존 mermaid 소스를 에디토리얼 다이어그램으로 다시 그림 |
| `/diagram-design:import-drawio` | draw.io 파일을 다시 그림 |
| `/diagram-design:export-diagram` | HTML → `.svg` / `.png` (OG 카드·발표자료용) |
