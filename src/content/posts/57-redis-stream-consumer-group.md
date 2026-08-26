---
title: "구독자가 없어도 메시지를 남깁니다 (Redis Stream 과 Consumer Group)"
description: "Pub/Sub 은 발행하고 잊지만, Stream 은 로그처럼 메시지를 남기고 소비자가 어디까지 처리했는지 추적합니다. rax 로 쌓이는 내부 구조부터 PEL 의 이중 장부, XAUTOCLAIM 회수, at-least-once 가 정확히 어디서 만들어지는지까지, Redis 안의 작은 메시지 큐를 깊게 들여다봤어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "Stream", "메시징", "Consumer Group", "PEL", "CS", "면접"]
draft: false
---

## [배경 - Pub/Sub 이 흘린 것을 주우려다]

[56번 글](/posts/56-redis-pubsub-fire-and-forget/)에서 Pub/Sub 이 발행하고 잊는 방식이라는 걸 봤습니다. 구독자가 잠깐 끊긴 사이에 발행된 메시지는 사라졌어요. 그 글의 마지막에서 "그걸 살리려면 다른 도구가 필요하다"고 적었는데, 그 다른 도구가 Stream 입니다.

Stream 은 Redis 5.0 에 들어온 append-only 로그형 자료구조예요. 저는 처음에 이걸 "그냥 List 로 만든 큐랑 뭐가 다르지" 정도로 봤습니다. 그런데 소비자가 어디까지 읽었는지 추적하고, 처리 확인을 받고, 죽은 소비자의 몫을 다른 소비자가 이어받는 부분에서 완전히 달랐어요. 흔히 "Redis 안에 들어온 작은 Kafka"라고 부르는데, 이 비유가 어디까지 맞고 어디서 깨지는지가 이 글의 절반입니다.

미리 밝혀둘게요. 이 글에는 제가 잰 숫자가 없습니다. 나오는 값은 Redis 문서의 기본값이거나 명령의 정의이고, 그렇다는 걸 표시해뒀어요. 대신 명령 목록을 나열하는 데서 멈추지 않고, 저장이 어떤 모습으로 이뤄지고 무엇을 보장하며 어디서 대가를 치르는지까지 들어갑니다.

## [문제 상황 분석 - 저장되는 로그라는 발상]

Pub/Sub 과 Stream 을 가르는 한 가지는 저장 여부입니다. Pub/Sub 은 지금 듣는 사람에게만 전달하고 버려요. Stream 은 메시지를 로그에 쌓아두고, 소비해도 지우지 않습니다. 그래서 과거 메시지를 다시 읽을 수 있고, 여러 소비자가 각자 독립적으로 읽을 수 있어요. 각 메시지에는 `밀리초-시퀀스` 형태의 고유 ID 가 붙어서 순서가 보장됩니다. 같은 밀리초에 여러 개가 들어와도 시퀀스가 올라가며 단조 증가해요.

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

## [내부 구조 - rax 와 macro-node]

"로그처럼 쌓인다"를 List 처럼 상상하면 반쪽입니다. Stream 은 엔트리를 하나씩 노드로 잇지 않아요. 내부는 **rax**, 그러니까 기수 트리(radix tree)이고, 이 트리의 잎에 여러 엔트리를 묶은 **macro-node** 가 달립니다. 각 macro-node 는 listpack 하나로, 그 안에 엔트리 수십 개가 촘촘히 눕습니다.

<svg class="diagram" viewBox="0 0 720 210" role="img" aria-label="rax 트리의 잎마다 여러 엔트리를 담은 listpack macro-node 가 달리고, ID 로 노드를 빠르게 찾는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">ID 로 노드를 찾고, 노드 하나 안에 엔트리 여러 개를 촘촘히 담는다</text>
  <rect x="300" y="36" width="120" height="34" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="360" y="58" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">rax (ID 색인)</text>
  <defs><marker id="d57rx" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker></defs>
  <line x1="330" y1="70" x2="180" y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57rx)"/>
  <line x1="390" y1="70" x2="540" y2="104" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d57rx)"/>
  <rect x="40" y="106" width="280" height="86" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="56" y="128" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">macro-node (listpack)</text>
  <text x="56" y="148" font-size="10" fill="var(--clay-text, #1B64DA)">1690-0, 1690-1, 1691-0 …</text>
  <text x="56" y="166" font-size="10" fill="var(--clay-text, #1B64DA)">첫 엔트리가 필드 이름을 기록</text>
  <text x="56" y="182" font-size="10" fill="var(--clay-text, #1B64DA)">뒤 엔트리는 같으면 생략, ID 는 델타</text>
  <rect x="400" y="106" width="280" height="86" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="416" y="128" font-size="11" font-weight="700" fill="var(--ink, #16181A)">macro-node (listpack)</text>
  <text x="416" y="148" font-size="10" fill="var(--ink-3, #8B9099)">1692-0, 1692-1 …</text>
  <text x="416" y="166" font-size="10" fill="var(--ink-3, #8B9099)">트리밍은 이 노드 단위로</text>
  <text x="416" y="182" font-size="10" fill="var(--ink-3, #8B9099)">범위 조회도 노드에서 시작점을 찾음</text>
</svg>

이 구조가 두 가지를 만듭니다. 하나는 압축이에요. macro-node 안에서 첫 엔트리가 필드 이름들을 적어두면, 뒤따르는 엔트리는 같은 필드 구성일 때 이름을 다시 적지 않고 값만 남깁니다. 그리고 엔트리 ID 도 노드 안에서는 앞 ID 와의 차이(델타)로 저장돼요. 같은 모양의 메시지가 줄줄이 들어오는 로그일수록 촘촘하게 눕습니다.

다른 하나는 **노드 단위로 움직인다**는 성질입니다. 특정 ID 를 찾을 때는 rax 로 노드를 O(log) 에 짚고 그 안에서 훑고, 뒤에서 볼 트리밍도 개별 엔트리가 아니라 노드 경계에서 이뤄져요. 이 성질이 나중에 근사 트리밍의 값을 결정합니다.

## [핵심 명령 - 쓰고, 읽고, 확인한다]

명령부터 정리하면 이렇습니다.

| 명령 | 하는 일 |
| --- | --- |
| XADD | 엔트리를 추가, ID 를 `*` 로 주면 자동 생성. `NOMKSTREAM` 이면 없을 때 만들지 않음 |
| XREAD | 특정 ID 이후를 읽음, `BLOCK` 으로 새 메시지까지 대기 |
| XREADGROUP | 소비 그룹으로 읽고, 읽은 즉시 PEL 에 등록 |
| XACK | 처리 완료를 알려 PEL 에서 제거 |
| XCLAIM / XAUTOCLAIM | 죽은 소비자의 미처리 메시지를 다른 소비자가 인수 |
| XPENDING | 대기 중인 메시지의 요약 또는 상세를 조회 |

`XREAD` 에 `BLOCK` 을 붙이면 폴링 없이 새 메시지가 올 때까지 기다립니다. 계속 되묻지 않고 조용히 대기하다가 도착하는 순간 받는 거예요. 그룹 없이 `XREAD` 만 쓰면 소비 추적이 없는 단순 구독이고, 처리 확인과 분배가 필요하면 `XREADGROUP` 으로 넘어갑니다.

## [Consumer Group - 나눠서 소비한다]

하나의 스트림을 여러 소비자가 나눠 처리하고 싶을 때 Consumer Group 을 씁니다. 그룹은 자기가 어디까지 나눠줬는지를 **Last Delivered ID** 로 기억해요. 덕분에 각 소비자가 서로 다른 메시지를 받아 중복 없이 일을 나눕니다.

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

그룹을 만들 때 시작점을 정하는 게 생각보다 중요해요. `XGROUP CREATE stream group $` 는 "지금 이 순간 이후"의 메시지만 소비합니다. 반면 `XGROUP CREATE stream group 0` 은 스트림에 이미 쌓여 있던 처음부터 소비해요. 저는 이 차이를 모르고 `$` 로 만들었다가 "왜 예전 데이터가 안 들어오지"로 한참 헤맬 뻔했습니다. 스트림이 없을 때 그룹과 함께 만들려면 `MKSTREAM` 을 붙이고, 마지막 ID 를 강제로 옮겨야 하면 `XSETID` 를 씁니다.

읽는 방식도 두 갈래예요. `XREADGROUP` 에서 특수 ID `>` 로 읽으면 아직 아무에게도 전달되지 않은 새 메시지를 받고, 이때 Last Delivered ID 가 전진합니다. 반대로 구체적인 ID(예: `0`)로 읽으면 새 메시지가 아니라 **그 소비자가 아직 확인 안 한 자기 몫**을 다시 읽어요. 소비자가 재시작한 뒤 밀린 일을 이어받는 게 이 경로입니다.

## [PEL - 이중 장부와 전달 횟수]

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

여기서 한 겹을 더 벗기면 PEL 은 사실 **두 장부**예요. 그룹 전체의 PEL 이 있고, 그 아래에 소비자마다 자기 몫만 담은 PEL 이 따로 있습니다. 그래서 "이 그룹에 밀린 게 총 몇 개인지"와 "이 소비자가 붙잡고 있는 게 몇 개인지"를 각각 볼 수 있어요. 그리고 PEL 의 각 항목은 단순한 ID 가 아니라 마지막 전달 시각과 **전달 횟수(delivery counter)** 를 함께 들고 있습니다.

이 전달 횟수가 실무에서 결정적이에요. 어떤 메시지가 처리될 때마다 실패해서 계속 다른 소비자에게 넘어가면, 그 횟수가 자꾸 올라갑니다. 이 값이 임계치를 넘는 엔트리는 코드가 도저히 소화 못 하는 포이즌 메시지로 보고, 별도 스트림이나 데드레터로 빼내는 판단을 할 수 있어요. `XPENDING stream group` 만 부르면 총 개수와 최소와 최대 ID, 소비자별 개수 같은 요약이 나오고, 뒤에 `IDLE`, 범위, 개수, 소비자를 붙이면 각 대기 엔트리의 idle time 과 전달 횟수까지 상세히 나옵니다.

## [죽은 소비자 회수 - XCLAIM 과 XAUTOCLAIM]

소비자가 처리 도중에 죽어 `XACK` 를 못 보내면, 그 메시지는 죽은 소비자의 PEL 에 그대로 남습니다. 아무도 손대지 않으면 영영 처리되지 않아요. 그래서 살아 있는 소비자가 주기적으로 "너무 오래 붙잡혀 있는 것"을 회수해야 합니다.

`XCLAIM stream group new-consumer min-idle-time id...` 는 지정한 메시지가 `min-idle-time` 보다 오래 방치됐을 때만 소유권을 새 소비자로 옮겨요. idle 조건을 두는 이유는, 잠깐 처리 중인 걸 성급하게 뺏으면 같은 메시지를 둘이 동시에 처리하기 때문입니다. 다만 회수할 ID 를 미리 알아야 한다는 게 불편해요. 그래서 6.2 에 들어온 `XAUTOCLAIM` 은 idle 을 넘긴 대기 메시지를 커서로 훑어 한꺼번에 인수합니다. 죽은 소비자를 특정할 필요 없이, "이 그룹에서 30초 넘게 방치된 걸 내가 가져간다" 같은 회수 루프를 짧게 짤 수 있어요.

주의할 점 하나. 인수는 기본적으로 전달 횟수를 올립니다. 그래서 회수가 반복되는 메시지는 자연히 전달 횟수가 높아지고, 앞에서 말한 포이즌 판별과 맞물립니다. 무한히 서로 떠넘기는 대신, 몇 번 넘어간 건 격리하라는 신호가 여기서 나와요.

## [at-least-once 가 정확히 어디서 만들어지나]

"최소 한 번"이라는 보장은 마법이 아니라 PEL 의 부작용입니다. 소비자가 언제 죽느냐로 나눠 보면 분명해져요.

- 읽기 직후에 죽으면, 이미 PEL 에 올라가 있으니 나중에 회수돼 다시 처리됩니다.
- 처리 도중에 죽어도 마찬가지로 PEL 에 남아 재처리돼요.
- 처리는 끝냈는데 `XACK` 를 보내기 직전에 죽으면, 서버는 확인을 못 받았으니 그 메시지를 아직 대기로 봅니다. 결국 한 번 더 처리돼요.

그래서 Stream 의 소비는 같은 메시지가 두 번 실행될 수 있다는 걸 전제로 짜야 합니다. 최소 한 번을 얻는 대가가 중복 가능성이라, 소비 로직은 멱등하게 만드는 게 안전해요. 멱등성을 키와 지문으로 다뤘던 이야기는 [40번 글](/posts/40-idempotency-key-filter-fingerprint/)에 있습니다. 정확히는 Stream 이 "안 잃음"을 맡고, "두 번 해도 괜찮음"은 소비자가 맡는 분업이에요.

## [메모리 - 근사 트리밍이 값을 아낀다]

저장한다는 장점은 그대로 메모리 부담입니다. 로그는 지우지 않으면 무한히 자라요. 그래서 `XADD` 에 `MAXLEN` 이나 `MINID` 를 붙여 오래된 엔트리를 잘라내며 관리합니다. 그런데 그냥 `MAXLEN 1000` 은 정확히 1000 개를 맞추려고 엔트리 단위로 깎느라 비싸요.

여기서 앞의 내부 구조가 값을 합니다. `MAXLEN ~ 1000` 처럼 물결표를 붙이면 **근사 트리밍**이 돼요. 정확히 1000 을 맞추지 않고, macro-node 경계에서만 통째로 떼어냅니다. 그래서 실제로는 1000 보다 조금 더 남을 수 있지만, 노드 하나를 버리는 값싼 연산이라 훨씬 가벼워요. `MINID` 는 개수 대신 "이 ID 이하는 버려" 식으로 시간 기준 정리에 어울립니다. 이 트리밍을 빼먹으면 스트림이 조용히 메모리를 먹어요.

## [여러 그룹, 그리고 Kafka 와의 거리]

하나의 스트림에 그룹을 여럿 만들면 그룹끼리는 독립적입니다. 그룹 A 는 결제 처리를, 그룹 B 는 분석 적재를 하는 식으로 같은 메시지를 각자 소비해요. 발행하고 잊는 Pub/Sub 과 달리, 여기서는 팬아웃을 하면서도 각 그룹이 자기 진행 상황을 따로 기억합니다.

그럼 정말 "작은 Kafka"일까요. 닮은 곳까지는 맞는데, 냉정하게 세 지점에서 갈립니다.

- 파티션이 없어요. Kafka 는 파티션으로 병렬성과 파티션 내 순서를 함께 얻지만, Stream 은 하나의 로그를 그룹이 소비자들에게 나눠주는 구조라 병렬성 모델이 다릅니다.
- 장기 보존 설계가 아니에요. Kafka 는 디스크 위의 보존형 로그이지만, Stream 은 메모리에 사는 자료구조이고 트리밍으로 크기를 눌러야 합니다.
- 내구성이 Redis 복제에 종속돼요. 비동기 복제라 페일오버 순간에 아직 복제되지 않은 엔트리와 PEL 상태가 사라질 수 있습니다. 이 유실 축은 [54번 글](/posts/54-redis-replication-sentinel-cluster/)의 비동기 복제 이야기와 같은 뿌리예요.

그러니 "메시지를 잠깐 남기고 나눠 소비하되, 운영 부담을 늘리기는 싫은" 자리에는 Stream 이 좋고, 장기 보존과 강한 내구성이 핵심이면 Kafka 나 RabbitMQ 를 봐야 합니다. RabbitMQ 의 백프레셔와 실패 격리는 [25번 글](/posts/25-rabbitmq-backpressure-failure-isolation/)에서 다룬 적이 있어요.

## [실무 적용 - 이 구조에서 나오는 규칙]

정리하면 규칙은 저장이라는 장점의 뒷면을 관리하는 데 모입니다.

**1. 트리밍을 반드시 겁니다.** `MAXLEN ~` 이나 `MINID` 없이 쓰면 스트림이 메모리를 무한히 먹어요. 개수 기준이면 근사 트리밍, 시간 기준이면 MINID 를 씁니다.

**2. 소비는 멱등하게 짭니다.** at-least-once 라 중복 처리는 예외가 아니라 정상 경로입니다. 처리 결과를 멱등 키로 막습니다.

**3. 죽은 소비자 회수를 주기적으로 돌립니다.** `XAUTOCLAIM` 으로 idle 을 넘긴 대기 메시지를 이어받는 루프를 하나 둡니다. 이게 없으면 죽은 소비자의 몫이 영영 안 처리돼요.

**4. 전달 횟수로 포이즌을 격리합니다.** 계속 재처리되는 메시지는 데드레터로 빼서, 하나가 파이프라인 전체를 막는 걸 피합니다.

**5. 그룹 시작점을 의식합니다.** `$` 와 `0` 의 차이를 모르고 만들면 과거 데이터가 통째로 빠지거나 예상보다 많이 딸려 옵니다.

**6. XREADGROUP 은 BLOCK 으로.** 폴링 대신 대기로 두면 불필요한 왕복이 줄어요.

## [결론]

Stream 은 저장되는 로그였고, rax 와 macro-node 가 그걸 촘촘히 담았습니다. 그 위에서 Consumer Group 과 두 장부의 PEL, 전달 횟수, XAUTOCLAIM 회수가 맞물려 중복 없는 분배와 최소 한 번의 처리를 만들었어요. Pub/Sub 이 흘려보낸 메시지를 여기서는 남겨두고 추적합니다.

남은 한계를 적어둘게요.

첫째, 측정이 없습니다. 소비자를 강제로 죽여 PEL 에 얼마나 쌓이는지, `XAUTOCLAIM` 회수가 실제로 어떤 지연으로 도는지 재현해보지 않았어요. `XPENDING` 과 `XINFO GROUPS`, `XINFO STREAM FULL` 로 확인할 수 있는 것들인데 아직 안 했습니다.

둘째, 근사 트리밍이 실제로 얼마나 더 남기는지, 노드 크기가 트리밍과 조회 비용에 어떻게 영향을 주는지는 데이터 분포에 크게 좌우돼요. 여기서 숫자를 말하면 지어내는 게 됩니다.

셋째, 저는 처음에 Stream 을 "작은 Kafka"로만 봤는데, 이 글을 정리하고 나서야 그 비유가 파티션과 보존과 내구성에서 깨진다는 걸 제대로 봤어요. 도구를 이름으로 고르면 안 되고, 무엇을 보장하고 무엇을 포기하는지로 골라야 한다는 걸 다시 배웠습니다.

<!-- 측정 필요: 소비자 장애 시 XPENDING 누적, XAUTOCLAIM 재처리 지연, MAXLEN ~ 의 실제 잔여 개수 -->
