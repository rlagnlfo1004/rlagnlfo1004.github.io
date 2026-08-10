# 문제를 정의하고 서비스로 증명해왔습니다

불편을 그냥 넘기지 않고 해결할 문제로 정의한 뒤 직접 만들어 운영했습니다.
정답이 하나가 아닌 자리에서 무엇을 고르고 무엇을 버렸는지, 그 근거를 직접 잰 숫자와 함께 적습니다.

글에 나오는 코드는 실제 저장소의 코드이고, 수치는 전부 직접 측정한 값입니다.

## 로컬에서 보기

```bash
npm install
npm run dev
```

## 글 추가하기

`src/content/posts/` 에 마크다운 파일을 만들면 됩니다.

```markdown
---
title: "제목"
description: "목록에 보이는 한 줄 설명"
date: 2026-08-06
project: "아주이벤트"
tags: ["JPA", "Hibernate"]
---

## [배경 - 이 글을 쓰게 된 계기]

본문
```

`project` 는 목록 페이지의 필터에 쓰입니다. 새 값을 넣으면 `src/pages/index.astro` 의
`order` 배열에도 추가해야 필터 버튼이 생깁니다.

`main` 브랜치에 푸시하면 GitHub Actions 가 빌드해서 자동 배포합니다.

## 구조

```
src/
├── content/posts/    글 원고 (마크다운)
├── layouts/          공통 레이아웃
├── pages/            목록 페이지와 글 페이지
├── components/       목차
├── plugins/          읽는 시간 계산, 표 스크롤 래퍼
├── assets/diagrams/  다이어그램 원본 (본문에는 인라인 SVG 로 넣습니다)
└── styles/           스타일
```

## 본문에 다이어그램 넣기

`<svg class="diagram">` 을 마크다운 본문에 그대로 씁니다. 인라인이어야 `var(--clay)` 같은
테마 토큰을 상속받아 다크 모드에서 같이 뒤집힙니다.

**SVG 안에 빈 줄을 넣으면 안 됩니다.** 마크다운은 빈 줄에서 HTML 블록을 끊기 때문에,
빈 줄 아래의 도형들이 `<svg>` 밖으로 밀려나 `<p>` 안의 텍스트로 렌더링됩니다. 제목 한 줄만
보이고 그림이 사라지는데, 빌드는 에러 없이 통과하니 눈으로 봐야만 발견됩니다. 구획을 나누려면
빈 줄 대신 `<!-- 주석 -->` 을 쓰세요.

빌드 뒤 원본과 결과의 도형 개수가 같은지 확인하면 확실합니다.

```bash
python3 - <<'PY'
import glob, re, os
for p in sorted(glob.glob('src/content/posts/*.md')):
    src = open(p, encoding='utf-8').read()
    for m in re.finditer(r'<svg class="diagram".*?</svg>', src, re.S):
        slug = os.path.basename(p)[:-3]
        dist = open(f'dist/posts/{slug}/index.html', encoding='utf-8').read()
        n_src = len(re.findall(r'<(text|rect|path|line|marker)\b', m.group(0)))
        n_dist = sum(len(re.findall(r'<(text|rect|path|line|marker)\b', d))
                     for d in re.findall(r'<svg class="diagram".*?</svg>', dist, re.S))
        print(('OK  ' if n_src <= n_dist else 'FAIL'), slug, n_src, n_dist)
PY
```

## 제목과 공유 이미지

사이트 이름과 한 줄 설명은 `src/consts.ts` 한 곳에 있습니다. 탭 제목은 여기 값 뒤에
페이지 이름을 붙여 만들기 때문에, 페이지에서는 `title="아카이브"` 처럼 페이지 이름만 넘깁니다.

파비콘은 `public/favicon.svg` 가 원본입니다. 라이트와 다크 색을 한 파일에
`prefers-color-scheme` 로 넣어뒀습니다 — 파비콘 링크는 테마별로 갈아끼울 수가 없습니다.
색만 따로 필요하면 `src/assets/icons/favicon-light.svg`, `favicon-dark.svg` 를 보면 됩니다.

16px 에서는 막대 5개가 서로 붙어 뭉개지므로 4개로 줄인 `src/assets/icons/favicon-16.svg`
를 씁니다.

**도형을 고칠 때 좌표를 정수로 유지해야 합니다.** 64 격자 판은 좌표와 크기가 모두
짝수여야 하고(브라우저가 16 CSS 픽셀로 그리는데 레티나에서는 32 디바이스 픽셀이라
반으로 줄어듭니다), 16 격자 판은 정수여야 합니다. 반 칸 어긋나면 획이 회색으로 번집니다.

PNG 폴백은 여기서 굽습니다.

```bash
node -e '
const sharp = require("sharp"), fs = require("fs");
const light = fs.readFileSync("src/assets/icons/favicon-light.svg");
const small = fs.readFileSync("src/assets/icons/favicon-16.svg");
sharp(small, { density: 512 }).resize(16, 16).png().toFile("public/favicon-16.png");
sharp(light, { density: 512 }).resize(32, 32).png().toFile("public/favicon-32.png");
sharp(light, { density: 512 }).resize(180, 180).png().toFile("public/apple-touch-icon.png");
'
```

링크 미리보기 이미지는 `src/assets/og.html` 이 원본입니다. 고친 뒤 다시 굽습니다.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 \
  --virtual-time-budget=6000 --screenshot=public/og.png src/assets/og.html
```

## 단축키

`D` 키로 다크 모드와 라이트 모드를 전환합니다.
