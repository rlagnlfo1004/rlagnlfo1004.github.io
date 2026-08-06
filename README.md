# 백엔드 개발 기록

Java, Spring 백엔드 개발 블로그입니다.
아주이벤트, 메일상자, 아올다 클라우드를 만들면서 마주친 문제와 해결 과정을 적습니다.

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
category: "아주이벤트"
tags: ["JPA", "Hibernate"]
---

# 제목

본문
```

`main` 브랜치에 푸시하면 GitHub Actions 가 빌드해서 자동 배포합니다.

## 구조

```
src/
├── content/posts/    글 원고 (마크다운)
├── layouts/          공통 레이아웃
├── pages/            목록 페이지와 글 페이지
└── styles/           스타일
public/diagrams/      본문에 들어가는 다이어그램
```

## 단축키

`D` 키로 다크 모드와 라이트 모드를 전환합니다.
