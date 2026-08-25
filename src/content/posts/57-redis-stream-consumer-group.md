---
title: "구독자가 없어도 메시지를 남깁니다 (Redis Stream 과 Consumer Group)"
description: "Pub/Sub 은 발행하고 잊지만, Stream 은 로그처럼 메시지를 남기고 소비자가 어디까지 처리했는지 추적합니다. Consumer Group 과 PEL 이 어떻게 at-least-once 를 만드는지, Redis 안의 작은 메시지 큐를 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "Stream", "메시징", "Consumer Group", "CS", "면접"]
draft: false
---

## [배경 - Pub/Sub 이 흘린 것을 주우려다]

[56번 글](/posts/56-redis-pubsub-fire-and-forget/)에서 Pub/Sub 이 발행하고 잊는 방식이라는 걸 봤습니다. 구독자가 잠깐 끊긴 사이에 발행된 메시지는 사라졌어요. 그 글의 마지막에서 "그걸 살리려면 다른 도구가 필요하다"고 적었는데, 그 다른 도구가 Stream 입니다.

Stream 은 Redis 5.0 에 들어온 append-only 로그형 자료구조예요. 저는 처음에 이걸 "그냥 List 로 만든 큐랑 뭐가 다르지" 정도로 봤는데, 소비자가 어디까지 읽었는지 추적하고 처리 확인까지 다루는 부분에서 완전히 달랐습니다. 사실상 Redis 안에 들어온 작은 Kafka 예요. 그래서 무엇을 어떻게 남기고, 어떻게 중복 없이 나눠 소비하는지 정리했어요.

## [문제 상황 분석 - 저장되는 로그라는 발상]

Pub/Sub 과 Stream 을 가르는 한 가지는 저장 여부입니다. Pub/Sub 은 지금 듣는 사람에게만 전달하고 버려요. Stream 은 메시지를 로그에 쌓아두고, 소비해도 지우지 않습니다. 그래서 과거 메시지를 다시 읽을 수 있고, 여러 소비자가 각자 독립적으로 읽을 수 있어요. 각 메시지에는 `밀리초-시퀀스` 형태의 고유 ID 가 붙어서 순서가 보장됩니다.

<svg class="diagram" viewBox="0 0 720 150" role="img" aria-label="스트림에 엔트리가 ID 순서로 쌓이고 XADD 가 끝에 새 엔트리를 덧붙이며, 소비해도 지워지지 않는다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">ID 순서대로 계속 덧붙이고, 소비는 읽기일 뿐 삭제가 아니다</text>
  <g font-size="10.5" text-anchor="middle">
    <rect x="30" y="54" width="118" height="46" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="89" y="82" fill="var(--ink, #16181A)">1690-0</text>
    <rect x="156" y="54" width="118" height="46" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="215" y="82" fill="var(--ink, #16181A)">1690-1</text>
    <rect x="282" y="54" width="118" height="46" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="341" y="82" fill="var(--ink, #16181A)">1691-0</text>
    <rect x="408" y="54" width="118" height="46" rx="7" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/><text x="467" y="82" fill="var(--clay-text, #1B64DA)">1692-0</text>
  </g>
  <defs><marker id="d57z" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker></defs>
  <rect x="548" y="54" width="128" height="46" rx="7" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.1" stroke-dasharray="4 3"/>
  <text x="612" y="82" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">새 엔트리</text>
  <line x1="526" y1="77" x2="544" y2="77" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d57z)"/>
  <text x="30" y="128" font-size="10.5" fill="var(--ink-3, #8B9099)">소비해도 남아 있어 과거 재생이 된다</text>
  <text x="676" y="128" font-size="10.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">XADD * 로 끝에 추가</text>
</svg>

## [핵심 명령 - XADD, XREAD, XACK]

명령부터 정리하면 이렇습니다.

| 명령 | 하는 일 |
| --- | --- |
| XADD | 엔트리를 추가, ID 를 `*` 로 주면 자동 생성 |
| XREAD | 특정 ID 이후를 읽음, BLOCK 으로 새 메시지까지 대기 |
| XREADGROUP | 소비 그룹으로 읽고, 읽은 즉시 PEL 에 등록 |
| XACK | 처리 완료를 알려 PEL 에서 제거 |
| XCLAIM | 죽은 소비자의 미처리 메시지를 다른 소비자가 인수 |

`XREAD` 에 `BLOCK` 을 붙이면 폴링 없이 새 메시지가 올 때까지 기다립니다. 계속 되묻지 않고 조용히 대기하다가 도착하는 순간 받는 거예요.

## [Consumer Group - 나눠서 소비한다]

하나의 스트림을 여러 소비자가 나눠 처리하고 싶을 때 Consumer Group 을 씁니다. 그룹은 자기가 어디까지 나눠줬는지를 Last Delivered ID 로 기억해요. 덕분에 각 소비자가 서로 다른 메시지를 받아 중복 없이 일을 나눕니다.

<svg class="diagram" viewBox="0 0 720 220" role="img" aria-label="스트림의 엔트리들을 그룹이 Last Delivered ID 기준으로 소비자들에게 나눠주는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">그룹이 어디까지 나눠줬는지 기억하며, 소비자마다 다른 메시지를 준다</text>
  <g font-size="10.5" text-anchor="middle">
    <rect x="30" y="44" width="70" height="40" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="65" y="68" fill="var(--ink-2, #545A64)">…-1</text>
    <rect x="104" y="44" width="70" height="40" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="139" y="68" fill="var(--ink-2, #545A64)">…-2</text>
    <rect x="178" y="44" width="70" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/><text x="213" y="68" fill="var(--clay-text, #1B64DA)">…-3</text>
    <rect x="252" y="44" width="70" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/><text x="287" y="68" fill="var(--clay-text, #1B64DA)">…-4</text>
  </g>
  <text x="30" y="102" font-size="10" fill="var(--ink-3, #8B9099)">이미 나눠준 것</text>
  <text x="348" y="102" font-size="10" text-anchor="end" fill="var(--clay-text, #1B64DA)">Last Delivered ID 이후</text>
  <rect x="360" y="90" width="150" height="34" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="435" y="112" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Consumer Group</text>
  <defs>
    <marker id="d57a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="287" y1="84" x2="400" y2="88" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57a)"/>
  <line x1="510" y1="100" x2="580" y2="70" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57a)"/>
  <line x1="510" y1="112" x2="580" y2="150" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57a)"/>
  <rect x="582" y="52" width="110" height="34" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="637" y="74" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Consumer A</text>
  <rect x="582" y="134" width="110" height="34" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="637" y="156" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Consumer B</text>
  <text x="360" y="150" font-size="10.5" fill="var(--ink-3, #8B9099)">…-3 은 A 에게, …-4 는 B 에게</text>
</svg>

## [PEL - 처리 확인이 없으면 남는다]

Stream 이 at-least-once 를 보장하는 장치가 PEL(Pending Entries List)입니다. "전달했지만 아직 확인 안 된" 메시지 목록이에요. 흐름은 이렇습니다. `XREADGROUP` 으로 메시지를 받으면 그 즉시 PEL 에 올라가고, 처리를 끝낸 소비자가 `XACK` 를 보내면 PEL 에서 빠집니다.

<svg class="diagram" viewBox="0 0 720 150" role="img" aria-label="XREADGROUP 으로 PEL 에 등록되고 XACK 로 제거되며, 실패 시 XCLAIM 으로 재할당되는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">확인이 올 때까지 대기 목록에 남기고, 소비자가 죽으면 다른 소비자가 인수한다</text>
  <rect x="20" y="52" width="150" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="95" y="80" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">XREADGROUP</text>
  <defs>
    <marker id="d57b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="170" y1="75" x2="226" y2="75" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d57b)"/>
  <rect x="230" y="52" width="150" height="46" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.4"/>
  <text x="305" y="74" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">PEL 에 등록</text>
  <text x="305" y="90" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">처리 대기 목록</text>
  <line x1="380" y1="75" x2="436" y2="75" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d57b)"/>
  <rect x="440" y="52" width="150" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="515" y="80" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">XACK → 제거</text>
  <line x1="305" y1="98" x2="305" y2="126" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57b)"/>
  <text x="315" y="122" font-size="10" fill="var(--ink-3, #8B9099)">소비자가 죽어 XACK 안 옴</text>
  <rect x="440" y="112" width="230" height="30" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.1"/>
  <text x="555" y="132" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">XCLAIM 으로 다른 소비자가 인수</text>
  <line x1="305" y1="140" x2="436" y2="132" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57b)"/>
</svg>

그래서 소비자가 처리 도중에 죽어 `XACK` 를 못 보내면, 그 메시지는 PEL 에 남아 있다가 `XCLAIM` 으로 다른 소비자에게 넘어가 다시 처리됩니다. 최소 한 번은 처리된다는 보장이 이렇게 만들어져요. 다만 그 대가로 같은 메시지가 두 번 처리될 수 있으니, 소비 로직은 멱등하게 짜는 게 안전합니다. 멱등성 자체는 [40번 글](/posts/40-idempotency-key-filter-fingerprint/)에서 따로 다룬 적이 있어요.

## [여러 그룹 - 같은 로그를 각자]

하나의 스트림에 그룹을 여럿 만들면 그룹끼리는 독립적입니다. 그룹 A 는 결제 처리를, 그룹 B 는 분석 적재를 하는 식으로 같은 메시지를 각자 소비해요. 발행하고 잊는 Pub/Sub 과 달리, 여기서는 팬아웃을 하면서도 각 그룹이 자기 진행 상황을 따로 기억합니다.

한 가지 놓치기 쉬운 게 있어요. 로그는 지우지 않으면 무한히 자랍니다. 그래서 `XADD` 에 `MAXLEN` 이나 `MINID` 를 붙여 오래된 엔트리를 잘라내며 메모리를 관리해야 해요. 저장한다는 장점이 그대로 메모리 부담이라, 이 트리밍을 빼먹으면 스트림이 조용히 메모리를 먹습니다.

## [결론]

Stream 은 저장되는 로그였고, Consumer Group 과 PEL 이 그 위에서 중복 없는 분배와 최소 한 번의 처리를 만들었습니다. Pub/Sub 이 흘려보낸 메시지를 여기서는 남겨두고 추적해요.

남은 한계를 적어둘게요. 저는 소비자를 강제로 죽여 PEL 에 얼마나 쌓이는지, `XCLAIM` 재할당이 어떻게 도는지를 실제로 재현해보지 않았습니다. 그리고 Stream 과 RabbitMQ, Kafka 를 언제 갈라 쓰는지는 그 자체로 긴 이야기예요. RabbitMQ 의 백프레셔와 실패 격리는 [25번 글](/posts/25-rabbitmq-backpressure-failure-isolation/)에서 다룬 적이 있으니, 다음에는 `XPENDING` 과 `XINFO GROUPS` 로 실제 대기 상태를 관찰하며 이 글을 보강하려고 합니다.

<!-- 측정 필요: 소비자 장애 시 XPENDING 누적, XCLAIM 재처리 지연 -->
