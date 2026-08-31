---
title: "영상은 올린 그대로 재생하지 않습니다 (OCI Media Flow 로 인코딩 파이프라인 세우기)"
description: "mp4 하나를 올리면 왜 파일이 수백 개로 쪼개져 나오는지, 코덱과 컨테이너·적응형 비트레이트·HLS·세그먼트와 키프레임까지 인코딩의 원리를 훑고, 그걸 관리형 워크플로 한 방으로 처리하는 OCI Media Flow 가 어떤 추상인지 정리했습니다. 217편 강의 영상 파이프라인을 세우며 내린 실제 선택도 근거와 함께 적었어요."
date: 2026-08-26
project: "코리안쌤"
tags: ["OCI", "Media Flow", "인코딩", "HLS", "영상"]
draft: false
---

## [배경 - 217편을 올려야 하는데, 올린 파일로는 안 됩니다]

강의 영상 217편을 서비스에 얹어야 했습니다. 처음엔 단순하게 생각했어요. mp4 를 스토리지에 올리고 그 URL 을 `<video>` 에 물리면 끝 아닌가. 그런데 원본을 그대로 트는 순간 두 가지가 동시에 무너집니다. 회선이 좋은 사람은 멀쩡히 보는데 회선이 나쁜 사람은 계속 멈추고, 큰 화면에서 보는 사람에겐 흐리게 나오는데 그 화질을 맞추려고 비트레이트를 올리면 이번엔 폰으로 보는 사람이 데이터를 태웁니다. **한 벌로는 모두를 만족시킬 수 없다**는 게 문제의 뿌리였어요.

그래서 원본은 재생용이 아니라 **재료**입니다. 재생 가능한 형태로 바꾸는 과정이 인코딩이고, 이걸 손으로 `ffmpeg` 돌려가며 217번 하는 대신 관리형 서비스에 맡긴 게 OCI Media Flow 입니다. 이 글은 그 파이프라인을 세우며 "인코딩이 정확히 무슨 일을 하는가"부터 "Media Flow 가 그걸 어떻게 감싸는가"까지 제가 이해한 순서대로 풀어놓은 기록이에요.

미리 밝혀둘게요. 이 글에는 **제가 인코딩을 돌려 직접 잰 숫자가 아직 없습니다.** 나오는 값은 OCI 콘솔에서 확인한 사양이거나, 원본 파일을 뜯어본 값이거나, Oracle 문서에 적힌 값입니다. 각각 어느 쪽인지 본문에 표시해뒀어요. 실제 인코딩 결과(rung 별 용량·잡 소요·자막 오염 정도)는 샘플 잡을 돌리는 다음 단계에서 재고, 그때 이 글을 실측으로 보강할 생각입니다.

## [먼저 - 인코딩이 정확히 무슨 일인가]

용어부터 정리해야 뒤가 안 꼬입니다. `sample.mp4` 에서 **mp4 는 코덱이 아니라 컨테이너**예요.

- **컨테이너**(mp4, MOV, MKV …): 영상 스트림·오디오 스트림·자막·메타데이터를 한 상자에 담는 포장 규격입니다. 상자일 뿐이라 안에 무슨 코덱이 들었는지는 상자만 봐선 몰라요.
- **코덱**(H.264, H.265, AAC …): 픽셀과 소리를 **어떻게 압축했는가**입니다. 실제 화질과 용량을 좌우하는 건 여기예요.

그래서 "mp4 니까 어디서든 재생되겠지"는 틀립니다. 같은 mp4 상자라도 안에 H.265 가 들었으면 못 트는 환경이 있어요. 그리고 우리가 하려는 건 상자를 바꾸는 게 아니라 **안의 내용물을 다시 압축하는 것**입니다. 이걸 트랜스코드(transcode)라고 부르고, 정확히는 이렇게 돌아갑니다.

> **트랜스코드 = 디코딩 → (해상도·비트레이트·코덱 변경) → 다시 인코딩**

원본을 픽셀 프레임으로 완전히 풀었다가, 새 설정으로 다시 압축하는 겁니다. 여기서 중요한 사실 하나. **H.264 같은 손실 압축은 다시 인코딩할 때마다 화질을 조금씩 잃습니다.** 그래서 원본(마스터)은 함부로 버리면 안 되고, 재인코딩이 필요하면 언제나 마스터에서 새로 뽑아야 해요. 이게 나중에 원본 버킷을 30일 뒤 Archive 로 내리되 **지우지는 않는** 라이프사이클을 건 이유이기도 합니다. 값싸게 재워두되, 다시 뽑아야 할 날을 위해 남겨두는 거죠.

## [왜 한 벌로는 안 되나 - 적응형 비트레이트(ABR)]

배경에서 말한 딜레마의 정답은 오래전에 나와 있습니다. **한 벌로 안 되면 여러 벌 만들면 된다.** 같은 영상을 화질·비트레이트가 다른 여러 벌로 인코딩해 두고, 재생기가 지금 회선 상태를 보고 **매 순간 알맞은 벌을 골라 받는** 방식입니다. 이걸 적응형 비트레이트 스트리밍(ABR, Adaptive Bitrate)이라고 불러요.

이 "여러 벌"의 묶음을 **래더(ladder)** 라고 부릅니다. 사다리처럼 화질이 층층이 쌓여 있고, 재생기가 회선이 나빠지면 아래 칸으로, 좋아지면 위 칸으로 갈아탑니다. 각 칸 하나를 rung(가로대)이라고 해요.

<svg class="diagram" viewBox="0 0 720 288" role="img" aria-label="가로 4단과 세로 3단 인코딩 래더, 재생기가 회선에 따라 rung 을 오르내리는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같은 영상을 여러 화질로 만들어 두고, 재생기가 회선에 맞는 칸을 고른다</text>
  <text x="40" y="46" font-size="12" font-weight="700" fill="var(--ink, #16181A)">가로 16:9 — 4단</text>
  <rect x="40" y="58" width="230" height="30" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="52" y="78" font-size="11.5" fill="var(--clay-text, #1B64DA)">1920×1080</text>
  <text x="258" y="78" font-size="10.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">가장 무겁다</text>
  <rect x="62" y="98" width="186" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="74" y="117" font-size="11.5" fill="var(--ink-2, #545A64)">1280×720</text>
  <rect x="84" y="136" width="142" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="96" y="155" font-size="11.5" fill="var(--ink-2, #545A64)">960×540</text>
  <rect x="106" y="174" width="98" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="118" y="193" font-size="11.5" fill="var(--ink-2, #545A64)">640×360</text>
  <text x="40" y="224" font-size="10.5" fill="var(--ink-3, #8B9099)">칸 사이가 고르게 벌어져 있어 어느 회선에서든 가까운 칸에 착지한다</text>
  <defs>
    <marker id="d61a" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="300" y1="70" x2="300" y2="192" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-start="url(#d61a)" marker-end="url(#d61a)"/>
  <text x="312" y="120" font-size="10" fill="var(--ink-3, #8B9099)">회선 ↑</text>
  <text x="312" y="150" font-size="10" fill="var(--ink-3, #8B9099)">회선 ↓</text>
  <line x1="392" y1="46" x2="392" y2="214" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="440" y="46" font-size="12" font-weight="700" fill="var(--ink, #16181A)">세로 9:16 — 3단</text>
  <rect x="440" y="58" width="150" height="30" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="452" y="78" font-size="11.5" fill="var(--clay-text, #1B64DA)">1080×1920</text>
  <text x="580" y="78" font-size="10.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">원본과 동일</text>
  <rect x="462" y="112" width="106" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="474" y="131" font-size="11.5" fill="var(--ink-2, #545A64)">720×1280</text>
  <rect x="484" y="164" width="72" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="496" y="183" font-size="11.5" fill="var(--ink-2, #545A64)">540×960</text>
  <text x="440" y="224" font-size="10.5" fill="var(--ink-3, #8B9099)">중간 칸(720)을 빼면 1080→540 로 급락한다 — 그래서 넣었다</text>
</svg>

여기서 rung 을 몇 개, 어느 해상도로 둘지가 순수한 설계 판단입니다. 칸이 너무 적으면 회선이 조금 나빠졌을 때 화질이 **한 단계가 아니라 절벽처럼** 떨어지고, 너무 많으면 인코딩·저장 비용만 늘어요. 우리가 가로 4단·세로 3단으로 정한 근거는 뒤(`래더를 어떻게 짰나`)에서 따로 풀겠습니다.

## [HLS - 왜 한 편이 파일 수백 개가 되나]

래더를 만들었다고 끝이 아닙니다. 재생기가 **매 순간 칸을 갈아타려면** 영상이 통짜 파일이면 안 돼요. 통짜 mp4 는 "지금부터 저화질로 바꿔줘"를 중간에 끼워 넣을 수가 없거든요. 그래서 각 rung 을 다시 **몇 초짜리 조각으로 잘게 쪼갭니다.** 이 방식의 대표가 HLS(HTTP Live Streaming)예요.

HLS 의 구조는 플레이리스트 두 층 + 세그먼트로 되어 있습니다.

- **마스터 플레이리스트**(`master.m3u8`): "이 영상엔 이런 화질들이 있다"는 목차. 각 rung 의 해상도·대역폭과 그 rung 의 플레이리스트 위치를 적어둡니다.
- **변형(variant) 플레이리스트**(rung 마다 하나): "이 화질의 조각들은 이 순서로 있다"는 목록. 세그먼트 파일들을 순서대로 나열해요.
- **세그먼트**: 실제 영상 조각(`.ts` 또는 fMP4). 하나가 3초라면 4분짜리 영상은 한 rung 만 80조각입니다.

<svg class="diagram" viewBox="0 0 720 300" role="img" aria-label="HLS 출력 구조 — master.m3u8 가 rung 별 variant 플레이리스트를 가리키고 각 variant 가 세그먼트들을 나열한다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">재생기는 master 를 먼저 받고, 회선에 맞는 variant 하나를 골라 그 세그먼트만 내려받는다</text>
  <rect x="288" y="34" width="144" height="36" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.4"/>
  <text x="360" y="57" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">master.m3u8</text>
  <line x1="360" y1="70" x2="95"  y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.1"/>
  <line x1="360" y1="70" x2="270" y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.1"/>
  <line x1="360" y1="70" x2="450" y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.1"/>
  <line x1="360" y1="70" x2="625" y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.1"/>
  <g font-size="10.5">
    <rect x="20"  y="106" width="150" height="46" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
    <text x="95"  y="127" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">1080p</text>
    <text x="95"  y="143" text-anchor="middle" fill="var(--ink-3, #8B9099)">variant.m3u8</text>
    <rect x="195" y="106" width="150" height="46" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
    <text x="270" y="127" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">720p</text>
    <text x="270" y="143" text-anchor="middle" fill="var(--ink-3, #8B9099)">variant.m3u8</text>
    <rect x="375" y="106" width="150" height="46" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
    <text x="450" y="127" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">540p</text>
    <text x="450" y="143" text-anchor="middle" fill="var(--ink-3, #8B9099)">variant.m3u8</text>
    <rect x="550" y="106" width="150" height="46" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
    <text x="625" y="127" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">360p</text>
    <text x="625" y="143" text-anchor="middle" fill="var(--ink-3, #8B9099)">variant.m3u8</text>
  </g>
  <g>
    <line x1="95"  y1="152" x2="95"  y2="200" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <line x1="270" y1="152" x2="270" y2="200" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <line x1="450" y1="152" x2="450" y2="200" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <line x1="625" y1="152" x2="625" y2="200" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  </g>
  <g fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="0.8">
    <rect x="48"  y="204" width="14" height="14" rx="2"/><rect x="68"  y="204" width="14" height="14" rx="2"/><rect x="88"  y="204" width="14" height="14" rx="2"/><rect x="108" y="204" width="14" height="14" rx="2"/><rect x="128" y="204" width="14" height="14" rx="2"/>
    <rect x="223" y="204" width="14" height="14" rx="2"/><rect x="243" y="204" width="14" height="14" rx="2"/><rect x="263" y="204" width="14" height="14" rx="2"/><rect x="283" y="204" width="14" height="14" rx="2"/><rect x="303" y="204" width="14" height="14" rx="2"/>
    <rect x="403" y="204" width="14" height="14" rx="2"/><rect x="423" y="204" width="14" height="14" rx="2"/><rect x="443" y="204" width="14" height="14" rx="2"/><rect x="463" y="204" width="14" height="14" rx="2"/><rect x="483" y="204" width="14" height="14" rx="2"/>
    <rect x="578" y="204" width="14" height="14" rx="2"/><rect x="598" y="204" width="14" height="14" rx="2"/><rect x="618" y="204" width="14" height="14" rx="2"/><rect x="638" y="204" width="14" height="14" rx="2"/><rect x="658" y="204" width="14" height="14" rx="2"/>
  </g>
  <text x="95"  y="236" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">001.ts 002.ts …</text>
  <text x="270" y="236" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">001.ts 002.ts …</text>
  <text x="450" y="236" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">001.ts 002.ts …</text>
  <text x="625" y="236" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">001.ts 002.ts …</text>
  <text x="360" y="272" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">4분 영상 · 3초 세그먼트 · 4단 = 세그먼트만 약 320개 + 플레이리스트 5개</text>
  <text x="360" y="289" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">그래서 "mp4 하나 올렸는데 출력은 수백 개"가 된다</text>
</svg>

이제 왜 출력 버킷 하나에서 파일이 폭발하는지 보입니다. 재생기 입장에서는 우아해요. `master.m3u8` 를 먼저 받아 목차를 보고, 지금 회선에 맞는 variant 를 골라 그 세그먼트만 순서대로 내려받다가, 회선이 나빠지면 **다음 세그먼트부터** 조용히 낮은 rung 으로 갈아탑니다. 사용자는 화질이 슬쩍 내려간 것만 느끼고 끊김은 없어요.

여기서 운영상의 함정이 하나 있었습니다. 출력 버킷은 세그먼트가 수만 개씩 쌓이는 곳이라, 여기에 "객체 생성 이벤트 발행"을 켜두면 세그먼트마다 이벤트가 터져 나옵니다. 217편이면 수만 건이에요. 그래서 **원본 버킷만 이벤트를 켜고 출력 버킷은 끕니다.** 트리거는 "원본이 올라왔다" 한 번이면 충분하니까요.

## [세그먼트와 키프레임 - 3초로 정한 이유]

세그먼트 하나가 3초라는 건 그냥 고른 숫자가 아닙니다. 여기엔 압축의 내부 구조가 걸려 있어요.

영상은 프레임을 그냥 나열하지 않습니다. 옆 프레임끼리 거의 똑같으니까, **키프레임(I-frame)** 하나를 온전히 저장하고 그 뒤 프레임들은 "앞 프레임과 뭐가 달라졌는지"(P·B-frame)만 기록해 용량을 줄여요. 키프레임 하나로 시작하는 이 묶음을 GOP(Group of Pictures)라고 부릅니다.

<svg class="diagram" viewBox="0 0 720 168" role="img" aria-label="프레임 시퀀스에서 세그먼트 경계가 키프레임 위에 떨어지는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">세그먼트는 키프레임(I)에서 시작해야 혼자 디코딩된다 — 그래서 GOP 길이를 세그먼트에 맞춘다</text>
  <line x1="48" y1="42" x2="48" y2="108" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="3 3"/>
  <line x1="316" y1="42" x2="316" y2="108" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="3 3"/>
  <line x1="584" y1="42" x2="584" y2="108" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="3 3"/>
  <text x="182" y="38" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">세그먼트 1 (≈3초)</text>
  <text x="450" y="38" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">세그먼트 2 (≈3초)</text>
  <g font-size="12" font-weight="700" text-anchor="middle">
    <rect x="56"  y="52" width="44" height="40" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/><text x="78"  y="77" fill="var(--clay-text, #1B64DA)">I</text>
    <rect x="104" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="126" y="77" fill="var(--ink-2, #545A64)">P</text>
    <rect x="152" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="174" y="77" fill="var(--ink-2, #545A64)">P</text>
    <rect x="200" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="222" y="77" fill="var(--ink-2, #545A64)">B</text>
    <rect x="248" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="270" y="77" fill="var(--ink-2, #545A64)">P</text>
    <rect x="324" y="52" width="44" height="40" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/><text x="346" y="77" fill="var(--clay-text, #1B64DA)">I</text>
    <rect x="372" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="394" y="77" fill="var(--ink-2, #545A64)">P</text>
    <rect x="420" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="442" y="77" fill="var(--ink-2, #545A64)">P</text>
    <rect x="468" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="490" y="77" fill="var(--ink-2, #545A64)">B</text>
    <rect x="516" y="52" width="44" height="40" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/><text x="538" y="77" fill="var(--ink-2, #545A64)">P</text>
  </g>
  <text x="182" y="112" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">실제로는 프레임 수십 개</text>
  <text x="450" y="112" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">실제로는 프레임 수십 개</text>
  <text x="0" y="140" font-size="11" fill="var(--ink-2, #545A64)">I = 키프레임, 혼자 그림이 된다   ·   P·B = 앞뒤 프레임과의 차이만 기록</text>
  <text x="0" y="158" font-size="11" fill="var(--ink-3, #8B9099)">세그먼트 경계가 I 위에 떨어지지 않으면, 그 조각은 앞 조각 없이는 못 푼다</text>
</svg>

문제는 P·B-frame 은 **혼자서는 그림이 안 된다**는 거예요. 앞 키프레임이 있어야 복원됩니다. 그런데 세그먼트는 독립적으로 내려받아 바로 재생돼야 하고, rung 을 갈아탈 때도 "새 화질의 이 세그먼트부터" 딱 이어져야 하죠. 그러려면 **모든 세그먼트가 키프레임으로 시작**해야 합니다. 그래서 인코더는 GOP 길이를 세그먼트 길이에 맞춰 정렬해요. 세그먼트가 3초면 3초마다 강제로 키프레임을 하나 박습니다.

여기서 트레이드오프가 생깁니다.

- **세그먼트를 짧게**(예: 2초): 회선 변화에 빠르게 반응하고, rung 전환이 잦아도 자연스럽습니다. 대신 키프레임이 촘촘해져 같은 화질이라도 용량이 늘고, 파일·요청 수가 폭증해요.
- **세그먼트를 길게**(예: 6초): 파일 수가 줄고 압축 효율이 좋아집니다. 대신 회선이 나빠졌을 때 다음 전환 기회까지 더 오래 버텨야 해서 반응이 굼떠요.

3초는 이 둘 사이의 흔한 절충값이고, 우리도 콘솔에서 세그먼트 길이를 초 단위로 넣을 수 있는 걸 확인하고 3초로 뒀습니다(이 값은 업계에서 널리 쓰는 관행값이지, 제가 A/B 로 재본 최적값은 아닙니다).

## [OCI Media Flow - 워크플로는 템플릿, 잡은 실행]

지금까지가 "인코딩이 뭘 하는가"였습니다. 이걸 217번 손으로 하지 않으려고 쓴 게 OCI Media Flow 예요. 핵심은 두 개념을 분리해서 이해하는 겁니다.

- **미디어 워크플로(media workflow)**: 무엇을 어떤 순서로 할지 적어둔 **템플릿**. "원본을 받아 → H.264 로 이 래더대로 트랜스코드하고 → HLS 로 패키징하고 → 영어 자막을 뽑아 → 출력 버킷에 쓴다"는 태스크의 그래프예요. **한 번 정의하면 계속 재사용**합니다.
- **잡(job)**: 그 워크플로에 **원본 하나를 넣어 1회 실행**한 것. 217편이면 워크플로는 2개(가로용·세로용)뿐이고 잡은 217번 도는 구조입니다.

<svg class="diagram" viewBox="0 0 720 250" role="img" aria-label="Media Flow 에서 워크플로는 태스크 그래프 템플릿이고 잡은 원본 하나를 넣어 실행한 것">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">워크플로는 한 번 정의하고, 잡은 원본마다 그 워크플로를 1회 실행한다</text>
  <rect x="20" y="34" width="680" height="104" rx="12" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="38" y="58" font-size="12" font-weight="700" fill="var(--ink, #16181A)">media workflow — 태스크 그래프 (재사용 템플릿)</text>
  <defs>
    <marker id="d61c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <g font-size="10.5" text-anchor="middle">
    <rect x="38"  y="74" width="112" height="46" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="94"  y="94" font-weight="700" fill="var(--ink, #16181A)">Input</text><text x="94"  y="110" fill="var(--ink-3, #8B9099)">원본 지정</text>
    <rect x="170" y="74" width="112" height="46" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
    <text x="226" y="94" font-weight="700" fill="var(--clay-text, #1B64DA)">Transcode</text><text x="226" y="110" fill="var(--clay-text, #1B64DA)">H.264 래더</text>
    <rect x="302" y="74" width="112" height="46" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
    <text x="358" y="94" font-weight="700" fill="var(--clay-text, #1B64DA)">HLS 패키징</text><text x="358" y="110" fill="var(--clay-text, #1B64DA)">3초 세그먼트</text>
    <rect x="434" y="74" width="112" height="46" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="490" y="94" font-weight="700" fill="var(--ink, #16181A)">Transcribe</text><text x="490" y="110" fill="var(--ink-3, #8B9099)">영어 STT</text>
    <rect x="566" y="74" width="112" height="46" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="622" y="94" font-weight="700" fill="var(--ink, #16181A)">Output</text><text x="622" y="110" fill="var(--ink-3, #8B9099)">출력 버킷</text>
  </g>
  <line x1="150" y1="97" x2="168" y2="97" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d61c)"/>
  <line x1="282" y1="97" x2="300" y2="97" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d61c)"/>
  <line x1="414" y1="97" x2="432" y2="97" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d61c)"/>
  <line x1="546" y1="97" x2="564" y2="97" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d61c)"/>
  <g font-size="10.5" text-anchor="middle">
    <rect x="60"  y="176" width="170" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="145" y="193" font-weight="700" fill="var(--ink, #16181A)">잡 #1</text><text x="145" y="208" fill="var(--ink-3, #8B9099)">idiom4.mp4</text>
    <rect x="275" y="176" width="170" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="360" y="193" font-weight="700" fill="var(--ink, #16181A)">잡 #2</text><text x="360" y="208" fill="var(--ink-3, #8B9099)">Ch14-1.mp4</text>
    <rect x="490" y="176" width="170" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
    <text x="575" y="193" font-weight="700" fill="var(--ink, #16181A)">잡 #3 …</text><text x="575" y="208" fill="var(--ink-3, #8B9099)">원본마다 하나씩</text>
  </g>
  <line x1="145" y1="176" x2="145" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d61c)"/>
  <line x1="360" y1="176" x2="360" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d61c)"/>
  <line x1="575" y1="176" x2="575" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d61c)"/>
  <text x="360" y="238" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">잡마다 원본만 다르다 · 결과는 출력 버킷 프리픽스로 나뉜다</text>
</svg>

"관리형"이 실제로 뜻하는 건 이겁니다. **인코딩 서버를 우리가 띄우지 않아요.** `ffmpeg` 를 설치하고, GPU 인스턴스를 잡고, 큐를 관리하고, 실패를 재시도하는 그 모든 걸 서비스가 대신합니다. 우리는 워크플로만 선언하고 잡을 던지면 돼요. 서비스는 자기 신원(서비스 주체)으로 원본 버킷을 읽고 출력 버킷에 씁니다 — 우리 쪽에 정적 키를 심을 필요가 없어요. 대신 그 서비스 주체에게 두 버킷 접근 권한을 정책으로 열어줘야 하고, 이걸 빼먹으면 **잡은 멀쩡히 생성됐다가 실행 중에 조용히 실패**합니다. 파이프라인에서 제일 흔하게 밟는 지뢰였어요.

콘솔에서 선택지를 열어보며 확정한 사양 몇 가지도 적어둡니다. 전부 **콘솔에서 눈으로 확인한 값**이에요.

- **비디오 코덱은 H.264.** H.265(HEVC)는 콘솔 선택지에 아예 없었습니다. H.265 가 같은 화질에 용량이 더 작지만, 없으니 고민할 것도 없이 H.264 로 확정했어요. (원본 일부는 HEVC 로 촬영돼 있는데, 트랜스코드 단계에서 H.264 로 다시 인코딩되니 재생 호환성 문제는 여기서 정리됩니다.)
- **오디오는 AAC.** HE-AAC 프로파일 선택지는 없었어요.
- **패키징은 HLS 를 워크플로 안에서 직접.** 별도의 스트리밍 배포 채널(Media Streams)을 태우면 `$0.05/GB` 가 붙는데, HLS 패키징이 워크플로 태스크로 들어 있어 그걸 우회했습니다.
- **프로파일은 Standard 와 Quality 두 종류.** Standard 는 rung 별 비트레이트를 프로파일에 위임하고, Quality(premium)는 비트레이트를 직접 지정하게 해줍니다. 217편 전량 기준 비용 차이는 일회성 몇 달러 수준이라(문서 기준 추정), **화질 차이가 눈에 보이는지만 샘플로 확인하고** 안 보이면 Standard 로 갈 계획이에요.

## [래더를 어떻게 짰나 - 가로 4단 · 세로 3단]

앞에서 미룬 이야기입니다. 우리 콘텐츠는 두 종류예요. 가로 16:9 브리핑 강의와, 세로 9:16 입모양 클립. 시청 환경이 달라서 래더도 다르게 짰습니다.

**가로는 4단(1080 / 720 / 540 / 360).** 데스크톱·태블릿·폰에 글로벌 회선까지, 화면 크기도 대역폭도 다양성이 큽니다. 그래서 표준 16:9 VOD 래더를 그대로 따랐어요. 칸을 촘촘히 두면 회선이 출렁여도 **가까운 칸으로 한 계단씩** 갈아탈 수 있습니다. 판단 근거로 뜯어본 원본은 `idiom4.mp4`(16:9, 약 3분 54초)였어요.

**세로는 3단(1080 / 720 / 540).** 세로 클립은 폰 세로 시청 전용이라 화면 크기 다양성은 작지만, 글로벌 모바일 회선의 대역폭 다양성은 남습니다. 여기서 2단(1080 + 540)을 검토했다가 접었는데, 그 이유가 이 절의 핵심이에요. 1080 과 540 사이는 픽셀 수로 4배 차이입니다. 회선이 조금만 나빠져도 **풀 해상도에서 1/4 해상도로 한 번에 급락**해요. 입술·혀 모양이 학습의 핵심인 콘텐츠라 그 급락이 치명적이라, 중간에 720 을 끼워 **한 계단씩 부드럽게** 내려가게 했습니다. 클립이 20초 안팎으로 짧아 rung 을 하나 더 인코딩·저장하는 비용도 미미했고요. 근거로 뜯어본 원본 `Ch14-1.mp4` 는 1080×1920 · HEVC · 약 5.3Mbps · 21.5초였습니다(원본을 뜯어본 값).

두 래더에 공통으로 건 원칙이 하나 있어요. **없는 디테일을 만드는 업스케일은 넣지 않는다.** 최상단 1080 rung 은 원본이 1080 이상일 때만 유효합니다. 원본이 720p 짜리인데 억지로 1080 으로 늘리면 용량만 먹고 화질은 그대로예요. 그래서 최상단 rung 은 원본 해상도를 확인한 뒤에만 두고, 마스터가 720p 면 최상단을 720 으로 내립니다.

> 한 가지 정직하게 남겨둘 것. 여기서 "칸 사이가 고르다"는 판단은 주로 **해상도(픽셀 수)의 간격**을 보고 한 겁니다. Standard 프로파일에서는 rung 별 실제 비트레이트를 서비스가 정하기 때문에, 제가 지금 "비트레이트가 몇 배씩 벌어진다"를 못 박을 수는 없어요. 이건 샘플 잡을 돌려 rung 별 실제 용량을 재봐야 확정됩니다.

## [트랜스코드 밖의 태스크 - Transcribe 는 영어만]

워크플로에는 트랜스코드 말고 **AI 태스크**도 같은 잡 안에서 함께 돌릴 수 있습니다. 우리가 켠 건 Transcribe(음성→텍스트, STT)예요. 인코딩 잡 한 번에 전사문(JSON + SRT 자막)이 출력 버킷에 같이 떨어집니다. 이게 편한 이유는 명확해요. 나중에 따로 자막을 뽑으려면 **원본을 다시 꺼내 재처리**해야 하는데, 원본은 30일 뒤 Archive 로 내려갑니다. 인코딩하는 김에 한 번에 뽑아두면 그 복원 비용을 통째로 아껴요.

다만 여기서 아프게 확인한 한계가 있습니다.

- **워크플로 안의 Transcribe 는 영어·포르투갈어·스페인어 3개 언어만 됩니다.** 한국어 전사는 이 경로로는 불가능해요.
- **번역 기능은 파이프라인 어디에도 없습니다.** Transcribe 는 "들리는 언어를 그 언어 글자로 받아쓰기"까지가 전부예요. 부가로 켤 수 있는 텍스트 분석 옵션도 개체·감정·핵심어 추출이지 번역이 아닙니다.

우리 강의는 영어 오디오가 대부분이라 English 로 켰습니다. 문제는 중간중간 섞인 **한국어 예문 구간**이에요. 엔진이 English 로 고정돼 있어 "이건 한국어다"라고 판별할 수단 자체가 없어서, 한국어 발음을 영어 음향 모델에 억지로 매핑합니다(`안녕하세요` → `on new ha say oh` 같은 식으로). SRT 는 타임코드가 붙으니 그 구간이 통째로 오염된 자막 블록으로 남아요. 이걸 어떻게 후처리할지(LLM 번역 + DB 예문 치환 등)는 인코딩을 먼저 세운 뒤 실측을 보고 다시 설계할 문제라, 이 글에서는 **켜서 영어 전사문까지만 확보**하는 선에서 멈췄습니다. 오염이 얼마나 심한지가 그 다음 설계의 입력값이거든요.

## [정리 - 개념과 우리 선택을 한 장으로]

| 인코딩 개념 | 하는 일 | Media Flow 에서 | 우리 선택 |
| --- | --- | --- | --- |
| 컨테이너 vs 코덱 | 상자와 내용물 | Input 태스크가 원본을 받음 | 출력 코덱 H.264 / AAC |
| 트랜스코드 | 디코딩 후 재인코딩 | Transcode 태스크 | Standard 프로파일(잠정) |
| 래더(ABR) | 화질 여러 벌 | rung 별 크기 지정 | 가로 4단 · 세로 3단 |
| HLS 패키징 | 조각+플레이리스트 | Package 태스크(HLS) | 세그먼트 3초, Media Streams 우회 |
| 키프레임/GOP | 세그먼트 독립 재생 | 세그먼트 길이에 정렬 | 3초(관행값) |
| STT | 음성→자막 | Transcribe 태스크 | English, 번역은 파이프라인 밖 |
| 원본 보존 | 재인코딩 대비 | 원본 버킷 분리 | 30일 뒤 Archive, 삭제 안 함 |

한 문장으로 줄이면, **원본은 재료고 인코딩은 그 재료를 여러 화질·잘게 쪼갠 조각·자막으로 바꾸는 일이며, Media Flow 는 그 과정을 "워크플로 선언 + 잡 실행"이라는 두 손잡이로 감싼 관리형 서비스**입니다.

## [결론]

이 글을 쓰며 제일 크게 바뀐 건 "영상 올리기"라는 말의 무게였어요. 올리는 건 원본 하나지만, 재생되기까지는 트랜스코드·래더·HLS·세그먼트·자막이라는 층이 겹겹이 쌓이고, 그 결과 파일은 한 편당 수백 개로 불어납니다. Media Flow 는 그 층을 우리가 손으로 쌓지 않게 해주는 대신, **각 층에서 무슨 선택을 하는지는 여전히 우리가 정해야** 했습니다. rung 을 몇 개 둘지, 세그먼트를 몇 초로 할지, 어떤 태스크를 켤지는 서비스가 대신 골라주지 않아요.

남은 한계를 정직하게 적어둡니다. **이 글의 숫자는 아직 실측이 아닙니다.** rung 별 실제 용량, 잡 하나가 도는 시간, 자막 오염 정도, Standard 와 Quality 의 눈에 보이는 화질 차이 — 이건 전부 샘플 잡을 실제로 돌려봐야 나오는 값이에요. 특히 세로 래더의 "칸 간격이 고르다"는 판단은 해상도로 세운 것이라, 비트레이트 실측으로 확인이 필요합니다. 다음 글에서는 가로·세로 샘플을 한 편씩 실제로 인코딩해, 여기 적은 설계가 실측과 맞았는지 — 어긋났으면 어디서 어떻게 어긋났는지 — 제가 잰 숫자로 되짚어보려고 합니다.

<!-- 측정 필요: 샘플 잡 1편씩 — rung별 용량 / 잡 소요 / SRT 한국어 구간 오염 / Standard vs Quality 육안 비교 -->
