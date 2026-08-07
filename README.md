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

## 단축키

`D` 키로 다크 모드와 라이트 모드를 전환합니다.
