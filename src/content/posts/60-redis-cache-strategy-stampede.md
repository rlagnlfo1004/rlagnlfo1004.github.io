---
title: "캐시를 어디에 언제 쓰느냐가 다릅니다 (Cache-Aside 부터 Stampede 까지)"
description: "Redis 를 가장 많이 쓰는 자리가 캐시입니다. 캐시와 DB 를 어떤 순서로 건드리느냐가 정합성을 가르고, 무효화 순서에는 낡은 값이 굳는 경합이 숨어 있어요. 읽기와 쓰기 전략, 무효화 경합, 그리고 캐시가 무너지는 세 가지 방식과 그 대응을 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "캐시", "Cache Stampede", "정합성", "성능", "CS", "면접"]
draft: false
---

## [배경 - 캐시를 붙였는데 문제가 옮겨갔다]

느린 조회 앞에 Redis 를 캐시로 두는 건 거의 기본기입니다. 그런데 붙이고 나면 문제가 사라지는 게 아니라 모양을 바꿔서 다시 나타나요. 캐시와 DB 가 언제 어긋나는지, 갱신하면 캐시를 어떻게 지워야 하는지, 인기 키가 만료되는 순간 무슨 일이 벌어지는지 같은 새 질문이 생깁니다.

[47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 Redis 가 왜 빠른지를 봤다면, 이번엔 그 빠름을 캐시로 어떻게 쓰느냐입니다. 처음에 저는 캐시를 "읽기 앞에 빠른 저장소 하나 끼우는 것" 정도로만 생각했어요. 그런데 실제로 어려운 건 속도가 아니라 **정합성**이었습니다. 캐시를 어디에 두고 언제 채우고 언제 지우느냐에 따라 낡은 값이 남고, 인기 키가 만료되는 순간 뒤의 DB 가 휘청여요. 이 글은 읽기와 쓰기 전략, 무효화 순서에 숨은 경합, 그리고 캐시가 무너지는 세 가지 방식을 순서대로 봅니다.

미리 밝혀둘게요. 이 글에는 제가 잰 숫자가 없습니다. 나오는 값은 Redis 기본 설정값이거나 널리 인용되는 자릿수이고, 각각 어느 쪽인지 표시해뒀어요.

## [읽기 전략 - Cache-Aside 와 Read-Through]

가장 흔한 건 Cache-Aside, 다른 말로 Lazy Loading 입니다. 애플리케이션이 캐시를 먼저 보고, 없으면 DB 에서 읽어 캐시에 채운 뒤 돌려줘요.

<svg class="diagram" viewBox="0 0 720 200" role="img" aria-label="Cache-Aside 에서 캐시 미스면 DB 를 읽어 캐시에 채우고 반환하는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">캐시를 먼저 보고, 없으면 DB 에서 읽어 채운 뒤 다음 요청부터 캐시로 답한다</text>
  <rect x="30" y="70" width="110" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="85" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">App</text>
  <rect x="300" y="70" width="120" height="46" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="360" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="580" y="70" width="110" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="635" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB</text>
  <defs>
    <marker id="d60a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
  </defs>
  <line x1="140" y1="86" x2="296" y2="86" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="218" y="78" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">1. 조회</text>
  <line x1="360" y1="116" x2="360" y2="150" stroke="var(--ink-3, #8B9099)" stroke-width="1.2"/>
  <text x="372" y="138" font-size="10" fill="var(--ink-3, #8B9099)">miss</text>
  <line x1="420" y1="100" x2="576" y2="100" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="498" y="92" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">2. DB 조회</text>
  <line x1="576" y1="112" x2="422" y2="140" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="498" y="146" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">3. 캐시에 저장</text>
</svg>

Cache-Aside 는 조회가 많은 데이터에 잘 맞아요. 다만 단점이 둘 있습니다. 캐시에 없을 때 첫 요청은 느리고, 원본이 갱신되면 캐시를 무효화해줘야 최신값이 반영돼요. 이걸 안 하면 낡은 값을 계속 돌려줍니다. 그리고 이 무효화가 이 글에서 가장 까다로운 부분인데, 뒤에서 따로 봅니다.

Read-Through 는 여기서 한 겹을 더 감춥니다. 애플리케이션은 캐시만 보고, 미스가 나면 캐시 계층이 알아서 DB 를 읽어 채워요. Cache-Aside 의 로직을 캐시 계층 안으로 넣은 셈입니다. 다만 Redis 자체가 이걸 기본 제공하지는 않아서, 별도의 라이브러리나 계층이 필요해요. 정확히는 둘의 차이는 "누가 DB 를 읽어 캐시를 채우느냐"이지 캐시를 늦게 채운다는 성격 자체는 같습니다.

## [쓰기 전략 - Write-Through 와 Write-Behind]

쓰기 쪽은 정합성과 속도 사이에서 갈립니다. Write-Through 는 캐시와 DB 에 동시에 써요. 캐시가 항상 최신이라 강한 일관성을 얻지만, 매 쓰기가 두 곳을 거치니 쓰기 지연이 늘어납니다. Write-Behind 는 캐시에 먼저 쓰고 DB 는 비동기로 모아서 반영해요. 쓰기가 매우 빠른 대신, 반영 전에 캐시가 유실되면 데이터가 사라집니다.

<svg class="diagram" viewBox="0 0 720 178" role="img" aria-label="Write-Through 는 캐시와 DB 에 동시에 쓰고, Write-Behind 는 캐시에 먼저 쓰고 나중에 DB 로 반영한다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같이 쓰면 정합성이 강해지고, 미뤄 쓰면 빨라지는 대신 유실을 감수한다</text>
  <rect x="20" y="40" width="330" height="128" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
  <text x="40" y="64" font-size="12" font-weight="700" fill="var(--ink, #16181A)">Write-Through</text>
  <rect x="40" y="78" width="80" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="80" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">App</text>
  <rect x="150" y="78" width="80" height="34" rx="7" fill="var(--clay-soft, #EAF2FE)"/><text x="190" y="100" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="260" y="78" width="70" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="295" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">DB</text>
  <line x1="120" y1="95" x2="146" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <line x1="230" y1="95" x2="256" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <defs><marker id="d60b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker></defs>
  <text x="185" y="134" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">동시에 씀 → 항상 최신, 쓰기 느림</text>
  <rect x="370" y="40" width="330" height="128" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.1"/>
  <text x="390" y="64" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">Write-Behind</text>
  <rect x="390" y="78" width="80" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="430" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">App</text>
  <rect x="500" y="78" width="80" height="34" rx="7" fill="var(--clay-soft, #EAF2FE)"/><text x="540" y="100" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="610" y="78" width="70" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="645" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">DB</text>
  <line x1="470" y1="95" x2="496" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <line x1="580" y1="95" x2="606" y2="95" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#d60b)"/>
  <text x="535" y="134" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">먼저 쓰고 나중에 모아 반영 → 빠름, 유실 위험</text>
</svg>

Write-Behind 에는 장점이 하나 더 있어요. 반영을 모아서 하니까 같은 키에 대한 여러 쓰기를 하나로 합칠 수 있습니다. 조회수를 초당 수백 번 올려도 DB 에는 몇 초에 한 번만 내려보내는 식이에요. 이 병합(coalescing)이 DB 쓰기 부하를 크게 줄여줍니다. 대가는 분명해요. 캐시에만 있고 아직 DB 로 안 내려간 구간이 존재하고, 그 사이에 캐시가 죽으면 그만큼 사라집니다. 그래서 Write-Behind 는 "조금 잃어도 되는 대신 쓰기가 폭주하는" 카운터 같은 데이터에 어울리고, 돈이나 주문처럼 유실이 곧 사고인 데이터에는 맞지 않아요.

## [무효화가 진짜 어려운 지점 - 순서와 경합]

Cache-Aside 를 쓰기로 했다면, 원본이 바뀔 때 캐시를 어떻게 처리할지 정해야 합니다. 여기서 두 가지 결정이 나와요. **캐시를 갱신할까 삭제할까**, 그리고 **DB 와 캐시 중 무엇을 먼저 건드릴까** 입니다.

먼저 갱신이 아니라 삭제가 기본인 이유부터 보겠습니다. 캐시를 새 값으로 갱신하려 들면, 두 쓰기가 동시에 오갈 때 순서가 뒤집힐 수 있어요. W1 이 값을 v1 로, W2 가 v2 로 바꾸는데 DB 에는 v2 가 최종으로 반영됐지만 캐시에는 W1 의 갱신이 나중에 도착해 v1 이 남는 식입니다. 삭제는 이 문제를 피해요. 캐시를 지우면 다음 읽기가 DB 라는 단일 진실에서 다시 채우니까요. 그래서 "갱신하지 말고 무효화한다"가 기본입니다.

다음은 순서입니다. 직관적으로는 "캐시 먼저 지우고 DB 를 바꾸자"가 자연스러워 보이는데, 여기에 함정이 있어요.

<svg class="diagram" viewBox="0 0 720 230" role="img" aria-label="캐시 삭제 후 DB 갱신 순서에서 읽기가 끼어들어 낡은 값이 캐시에 굳는 경합">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">캐시를 먼저 지우면, 그 틈에 들어온 읽기가 낡은 값을 다시 캐시에 굳힌다</text>
  <line x1="120" y1="40" x2="120" y2="214" stroke="var(--rule, rgba(22,24,26,.15))" stroke-width="1"/>
  <line x1="430" y1="40" x2="430" y2="214" stroke="var(--rule, rgba(22,24,26,.15))" stroke-width="1"/>
  <text x="70" y="54" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Write W</text>
  <text x="275" y="54" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Read R</text>
  <g font-size="10.5">
    <text x="10" y="86" fill="var(--clay-text, #1B64DA)">① 캐시 삭제</text>
    <text x="140" y="112" fill="var(--ink-2, #545A64)">② miss, DB 읽음 → 옛 값 v1</text>
    <text x="140" y="138" fill="var(--ink-2, #545A64)">③ 캐시에 v1 저장</text>
    <text x="10" y="164" fill="var(--clay-text, #1B64DA)">④ DB 를 v2 로 갱신</text>
  </g>
  <line x1="60" y1="92" x2="60" y2="170" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <line x1="275" y1="118" x2="275" y2="146" stroke="var(--ink-3, #8B9099)" stroke-width="1.2"/>
  <rect x="470" y="150" width="230" height="46" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="585" y="170" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">결과: 캐시엔 v1, DB 엔 v2</text>
  <text x="585" y="186" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">낡은 값이 계속 남는다</text>
</svg>

캐시를 먼저 지우면, 그 직후 읽기 R 이 미스로 DB 에서 아직 안 바뀐 옛 값 v1 을 읽어 캐시에 채우고, 그다음에야 W 가 DB 를 v2 로 바꿉니다. 결과적으로 캐시에는 v1 이, DB 에는 v2 가 남아 계속 어긋나요. 그래서 순서를 뒤집어 **DB 를 먼저 갱신하고 그다음 캐시를 삭제하는** 쪽이 더 안전합니다.

다만 이 순서도 완전하지는 않아요. R 이 미스로 DB 에서 v1 을 읽은 상태에서 잠깐 멈춰 있는 사이, W 가 DB 를 v2 로 바꾸고 캐시를 지운 뒤, 그제서야 R 이 캐시에 v1 을 채우면 다시 낡은 값이 굳습니다. 읽기의 DB 조회와 캐시 저장 사이가 벌어질 때 생기는 좁은 창이에요. 확률이 낮아서 앞의 순서만으로 대개 충분하지만, 정합성을 더 밀어붙여야 하면 **지연 이중 삭제**를 씁니다. DB 를 갱신하고 캐시를 지운 다음, 짧은 시간을 두고 한 번 더 지우는 방법이에요. 그 사이에 어떤 읽기가 낡은 값을 채워 넣었더라도 두 번째 삭제가 걷어냅니다. 정확히는 경합을 원천 차단하는 게 아니라, 낡은 값이 남아 있는 시간을 그 지연만큼으로 잘라내는 겁니다.

## [캐시가 무너지는 세 가지 - 이름부터 갈라야 한다]

캐시가 무너지는 상황을 뭉뚱그려 "Stampede"라고 부르기 쉬운데, 원인이 다른 세 가지가 섞여 있습니다. 원인이 다르면 대응도 달라서, 먼저 갈라야 해요.

| 이름 | 무엇이 원인인가 | 대응의 방향 |
| --- | --- | --- |
| Cache Stampede | 인기 있는 한 키가 만료되는 순간 요청이 몰림 | 재계산을 하나로 줄이거나 미리 갱신 |
| Cache Penetration | 존재하지 않는 키를 계속 조회해 매번 DB 로 샘 | 없음을 캐싱하거나 걸러내기 |
| Cache Avalanche | 많은 키가 같은 시각에 한꺼번에 만료됨 | 만료 시각을 흩뿌리기 |

## [Cache Stampede - 만료 순간 몰린다]

인기 있는 키의 TTL 이 만료되는 순간, 그 키를 노리던 수많은 요청이 동시에 캐시 미스를 냅니다. 그리고 전부 DB 로 몰려요. 순간적으로 DB 가 과부하로 휘청이는 이 현상을 Cache Stampede 또는 Thundering Herd 라고 부릅니다.

<svg class="diagram" viewBox="0 0 720 176" role="img" aria-label="여러 요청이 같은 키의 만료 순간에 동시에 미스를 내고 전부 DB 로 몰리는 Stampede">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 키가 만료된 찰나, 동시 요청이 전부 미스를 내고 DB 로 몰린다</text>
  <g font-size="10.5" text-anchor="middle">
    <rect x="30" y="50" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="70" fill="var(--ink, #16181A)">요청 1</text>
    <rect x="30" y="86" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="106" fill="var(--ink, #16181A)">요청 2</text>
    <rect x="30" y="122" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="142" fill="var(--ink, #16181A)">요청 3</text>
  </g>
  <rect x="290" y="76" width="130" height="50" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="355" y="98" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <text x="355" y="114" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">키 만료 (miss)</text>
  <defs><marker id="d60c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker></defs>
  <line x1="120" y1="65" x2="286" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="120" y1="101" x2="286" y2="101" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="120" y1="137" x2="286" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="420" y1="90" x2="576" y2="90" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <line x1="420" y1="101" x2="576" y2="101" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <line x1="420" y1="112" x2="576" y2="112" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <rect x="580" y="76" width="110" height="50" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="635" y="98" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB</text>
  <text x="635" y="114" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">중복 조회 폭주</text>
</svg>

무서운 건 재계산이 무거울 때예요. 원본 조회가 몇백 밀리초 걸리는 무거운 집계라면, 그 시간 동안 미스가 계속 쌓이면서 같은 계산이 수십 수백 번 중복으로 돕니다. 캐시가 있어서 평소엔 가려져 있던 DB 의 진짜 부하가, 만료라는 한 점에서 한꺼번에 드러나는 거예요.

## [Stampede 대응 - 미리 갱신, 하나만 내보내기, 아예 안 만료]

몰리는 걸 막는 방법이 몇 갈래로 나뉩니다. 셋 다 "동시에 DB 로 가는 요청 수를 줄인다"는 목표는 같지만 방식이 달라요.

**미리 갱신(PER).** Probabilistic Early Recomputation 은 만료되기 전에 확률적으로 미리 갱신합니다. 만료가 임박할수록 갱신 확률이 올라가서, 한 요청이 남들보다 먼저 캐시를 새로 채워요. 개념을 식으로 쓰면 이렇습니다.

```
now - delta * beta * ln(rand()) >= expiry
```

`delta` 는 지난번 값을 다시 계산하는 데 걸린 시간이고, `beta` 는 얼마나 공격적으로 미리 갱신할지 정하는 튜닝 계수예요. `rand()` 는 0 과 1 사이 난수라 `ln(rand())` 은 음수이고, 그래서 왼쪽 항은 만료 시각보다 조금씩 앞당겨집니다. 재계산이 무거운(`delta` 가 큰) 값일수록 더 일찍 갱신되고요. 이 방식의 장점은 락과 달리 아무도 기다리지 않는다는 겁니다. 대부분의 요청은 아직 살아 있는 캐시를 그대로 읽고, 확률에 뽑힌 한 요청만 조용히 백그라운드처럼 갱신해요.

**하나만 내보내기(Single Flight).** 락 기반은 첫 요청만 DB 를 조회하게 합니다. `SET key value NX` 로 락을 잡은 요청만 원본을 읽고, 나머지는 잠깐 기다렸다 채워진 캐시를 읽어요. Redis 의 원자적 `SET NX` 가 분산 락이 되는 겁니다. 이렇게 하나만 나가게 만드는 걸 Single Flight 라고 불러요.

<svg class="diagram" viewBox="0 0 720 190" role="img" aria-label="Single Flight, SET NX 로 락을 잡은 한 요청만 DB 를 조회해 캐시를 채우고 나머지는 대기 후 캐시를 읽는다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">락을 잡은 첫 요청만 DB 로 나가고, 나머지는 기다렸다 채워진 캐시를 읽는다</text>
  <defs>
    <marker id="d60d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d60e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker>
  </defs>
  <rect x="24" y="60" width="96" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="80" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">요청 1</text>
  <rect x="24" y="98" width="96" height="26" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="116" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">요청 2</text>
  <rect x="24" y="130" width="96" height="26" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="148" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">요청 3</text>
  <rect x="172" y="56" width="150" height="42" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="247" y="74" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">SET key NX</text>
  <text x="247" y="89" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">락 획득은 하나만</text>
  <line x1="120" y1="76" x2="168" y2="76" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <line x1="120" y1="111" x2="168" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#d60d)"/>
  <line x1="120" y1="143" x2="168" y2="96" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#d60d)"/>
  <line x1="322" y1="77" x2="392" y2="77" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <rect x="396" y="56" width="108" height="42" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="450" y="81" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB 조회</text>
  <line x1="504" y1="77" x2="572" y2="77" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <rect x="576" y="56" width="120" height="42" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/><text x="636" y="74" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">캐시 채움</text>
  <text x="636" y="90" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <text x="247" y="150" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">나머지는 잠깐 대기</text>
  <line x1="300" y1="146" x2="574" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" stroke-dasharray="4 3" marker-end="url(#d60d)"/>
  <text x="486" y="150" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">채워진 캐시를 읽음</text>
</svg>

그런데 이 락에는 함정이 있어요. 락을 잡은 요청이 재계산 도중에 죽으면, 나머지가 그 락을 영영 기다립니다. 그래서 락에는 반드시 TTL 을 걸어야 해요. 그런데 TTL 을 걸면 또 다른 틈이 생깁니다. TTL 이 만료됐는데 재계산은 아직 안 끝난 상태면, 대기하던 요청들이 락이 풀린 걸 보고 다시 우르르 DB 로 갑니다. 결국 락은 stampede 를 완전히 없애는 게 아니라 줄이는 장치예요. 락을 잡는 발상 자체는 [39번 글](/posts/39-redis-lua-atomic-inventory/)의 원자적 처리와 뿌리가 같습니다. 여러 요청이 같은 자원을 동시에 건드리지 못하게 막는다는 점에서요.

**아예 안 만료(logical expiry).** 마지막은 미스 자체를 없애는 접근입니다. 캐시 값에 논리적 만료 시각을 같이 담아두고, Redis 의 TTL 로는 키를 지우지 않아요. 읽을 때 논리 만료가 지났으면, 한 요청만 락을 잡아 백그라운드로 값을 갱신하고 그동안 나머지는 조금 낡은 값을 그대로 받습니다. 물리적으로는 키가 항상 살아 있으니 하드 미스가 없고, 그래서 몰릴 일도 없어요. 대가는 두 가지입니다. 갱신 직전까지 낡은 값을 잠깐 내보내고, TTL 로 자동 회수되지 않으니 메모리 관리를 따로 신경 써야 해요. 정합성보다 가용성이 급한 핫키에 어울리는 선택입니다.

## [Cache Penetration - 없는 걸 계속 묻는다]

Stampede 가 인기 키의 문제라면, Penetration 은 애초에 존재하지 않는 키의 문제예요. 없는 ID 를 계속 조회하면 캐시에는 당연히 없고, 그래서 매번 DB 까지 내려가 "없음"을 확인하고 돌아옵니다. 캐시가 아무 방어도 못 하는 상황이에요. 악의적으로 없는 키를 대량으로 두드리면 캐시를 통째로 우회해 DB 를 때릴 수 있습니다.

대응은 둘입니다. 하나는 **없음을 캐싱**하는 거예요. DB 에도 없더라는 결과를 짧은 TTL 로 캐시에 넣어두면, 같은 키를 다시 물어도 캐시에서 "없음"으로 끊어냅니다. 짧은 TTL 을 주는 이유는, 나중에 그 키가 실제로 생겼을 때 오래 "없음"으로 막지 않기 위해서예요. 다른 하나는 **블룸 필터**입니다. "이 키가 존재할 수도 있는가"를 아주 작은 메모리로 미리 걸러내는 확률적 자료구조인데, 확실히 없는 키는 DB 를 치기 전에 튕겨낼 수 있어요. 없다고 하면 확실히 없고, 있다고 하면 있을 수도 있는(가끔 틀리는) 성격이라 이 용도에 잘 맞습니다.

## [Cache Avalanche - 같이 만료된다]

Avalanche 는 여러 키가 같은 시각에 한꺼번에 만료되며 무너지는 상황입니다. 서버를 새로 띄우면서 캐시를 한 번에 채우고 전부 같은 TTL 을 주면, 그 TTL 이 다 지나는 순간 수많은 키가 동시에 만료돼요. 그러면 앞의 stampede 가 한 키가 아니라 수천 키에서 동시에 터집니다.

대응은 TTL 지터예요. 만료 시각에 약간의 무작위를 더해 흩뿌립니다. 예를 들어 기본 TTL 에 몇 퍼센트의 랜덤을 얹으면, 같이 채운 키들이 조금씩 다른 시각에 만료돼서 부하가 한 점에 몰리지 않아요. 만료 시각에 무작위를 섞으라는 조언은 [43번 글](/posts/43-redis-io-model-internals/)에서 능동적 만료의 지연 스파이크를 이야기할 때도 나왔는데, 뿌리가 같습니다. 같은 시각에 몰리는 일을 흩는 거예요.

## [메모리가 차면 - eviction]

캐시는 결국 메모리가 찹니다. `maxmemory` 에 도달하면 `maxmemory-policy` 에 따라 키를 축출해요. 가장 오래 안 쓴 키를 버리는 `allkeys-lru`, 가장 덜 쓴 키를 버리는 `allkeys-lfu`, 만료가 임박한 키부터 버리는 `volatile-ttl` 같은 정책이 있습니다.

여기서 [43번 글](/posts/43-redis-io-model-internals/)에서 본 사실을 다시 떠올릴 만해요. Redis 의 LRU 는 진짜 LRU 가 아니라 근사 LRU 입니다. 모든 키를 연결 리스트로 관리하는 비용이 커서, 무작위 표본을 뽑아 그중 가장 오래된 걸 버려요. `maxmemory-samples` 기본값은 5 이고, 이 값을 올리면 진짜 LRU 에 가까워지는 대신 CPU 를 더 씁니다. LFU 도 접근 횟수를 정확히 세는 게 아니라 확률적 카운터로 근사하고 시간이 지나면 값을 감쇠시켜요. 캐시 워크로드에서는 한 번 몰려 접근된 키가 오래 살아남는 문제를 줄여줘서 LRU 보다 나은 경우가 많습니다.

함정이 하나 있어요. `volatile-` 로 시작하는 정책은 **TTL 이 걸린 키만** 축출 대상으로 봅니다. 그런데 캐시에 TTL 없는 키가 많이 섞여 있으면, 메모리가 찼을 때 버릴 후보가 없어서 결국 쓰기가 OOM 에러로 실패해요. `noeviction` 과 같은 상황이 되는 겁니다. 그래서 순수 캐시라면 대개 `allkeys-lru` 나 `allkeys-lfu` 가 무난하고, `volatile-` 정책은 "TTL 있는 캐시 키와 TTL 없는 영구 키가 한 인스턴스에 섞여 있고, 캐시 키만 버리고 싶을 때"처럼 의도가 분명할 때 씁니다.

## [실무 적용 - 정합성과 부하를 같이 본다]

정리하면 규칙은 이렇게 모입니다.

**1. 갱신할 때 캐시는 갱신하지 말고 삭제합니다.** 두 쓰기의 순서가 뒤집혀도 다음 읽기가 DB 에서 다시 채우게 두는 편이 안전해요.

**2. DB 를 먼저 바꾸고 그다음 캐시를 지웁니다.** 순서를 뒤집으면 그 틈에 읽기가 낡은 값을 굳힙니다. 정합성이 더 급하면 지연 이중 삭제로 낡은 값이 남는 시간을 잘라내요.

**3. 무거운 재계산이 걸린 핫키에는 PER 이나 logical expiry 를 붙입니다.** 만료라는 한 점에 몰리는 걸 미리 흩거나 아예 없앱니다.

**4. 락으로 stampede 를 줄일 때는 락 TTL 을 반드시 겁니다.** 락 홀더가 죽어도 무한 대기가 안 생기게, 그리고 그 TTL 이 재계산보다 충분히 길게.

**5. 없는 키에는 없음을 캐싱하거나 블룸 필터로 거릅니다.** Penetration 은 캐시가 못 막는 우회라 별도 방어가 필요해요.

**6. 대량 만료에는 TTL 에 무작위를 섞습니다.** 같은 시각 동시 만료를 흩어 avalanche 를 막습니다.

**7. `maxmemory` 와 정책을 명시하고, 순수 캐시는 `allkeys-` 정책을 씁니다.** `volatile-` 정책은 TTL 없는 키가 섞이면 버릴 게 없어 OOM 이 날 수 있어요.

## [결론]

캐시는 어디에 두고 언제 채우느냐의 문제로 시작했지만, 실제로 어려운 건 언제 지우느냐였습니다. 읽기는 Cache-Aside 와 Read-Through, 쓰기는 Write-Through 와 Write-Behind 로 갈리고, 각 선택은 정합성과 속도와 유실 사이의 저울질이에요. 그리고 무효화 순서에는 낡은 값이 굳는 경합이 숨어 있었고, 캐시가 무너지는 방식은 Stampede 와 Penetration 과 Avalanche 로 원인부터 달랐습니다. 원인이 다르면 대응도 달라야 했어요.

남은 한계를 적어둘게요. 저는 Stampede 를 실제로 재현해 DB 부하가 얼마나 튀는지, PER 과 락과 logical expiry 중 어느 쪽이 어떤 트래픽에서 유리한지를 재보지 않았습니다. 무효화 경합도 확률이 낮아 재현이 까다로운데, 얼마나 자주 실제로 낡은 값이 남는지는 부하를 걸어봐야 알 수 있어요. 정답은 워크로드가 정하고, 조회와 갱신의 비율이 전략을 바꿉니다. 다음에는 동시 요청을 걸어 Stampede 를 만들고, 락과 PER 을 적용하기 전과 후의 DB 조회 수를 세서 이 글을 제가 잰 값으로 보강하려고 합니다.

<!-- 측정 필요: 동시 만료 시 DB 조회 수, PER/Single Flight/logical expiry 적용 전후 비교, 무효화 경합으로 낡은 값이 남는 빈도 -->
