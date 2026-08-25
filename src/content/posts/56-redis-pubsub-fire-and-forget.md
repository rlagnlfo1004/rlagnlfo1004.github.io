---
title: "발행하고 잊습니다 (Redis Pub/Sub 과 Fire-and-Forget)"
description: "발행자와 구독자가 서로를 모른 채 채널로 연결됩니다. 편하지만 메시지를 저장하지 않아서, 발행 순간에 듣고 있지 않으면 그 메시지는 사라져요. Pub/Sub 의 내부 구조와 전달 보장의 한계를 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "Pub/Sub", "메시징", "CS", "면접"]
draft: false
---

## [배경 - 실시간 알림에 손댔다가]

실시간으로 무언가를 밀어주는 기능을 붙일 때 Redis Pub/Sub 이 자주 첫 후보로 올라옵니다. 명령 세 개면 되고, 붙이기도 쉬워요. 저도 그렇게 가볍게 시작했다가 한 가지에서 멈칫했습니다. **구독자가 잠깐 끊긴 사이에 발행된 메시지는 어디로 갔을까.**

답을 찾아보니 "어디에도 안 갔다"였어요. Pub/Sub 은 메시지를 저장하지 않습니다. 이 한 문장이 Pub/Sub 을 쓸 수 있는 곳과 쓰면 안 되는 곳을 가릅니다. 그래서 이 방식이 안에서 어떻게 동작하고, 무엇을 보장하지 않는지 정리했어요.

## [문제 상황 분석 - 서로 모르는 발행자와 구독자]

Pub/Sub 의 핵심은 발행자(Publisher)와 구독자(Subscriber)가 서로를 직접 알지 못한다는 겁니다. 둘 사이에 채널이 있고, 발행자는 채널에 던지고, 구독자는 채널에서 받아요. 누가 몇 명 듣고 있는지 발행자는 신경 쓰지 않습니다.

<svg class="diagram" viewBox="0 0 720 210" role="img" aria-label="발행자들이 채널에 던지고 구독자들이 채널에서 실시간으로 받는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">발행자와 구독자는 서로를 모르고, 오직 채널을 통해서만 이어진다</text>
  <rect x="30" y="52" width="130" height="38" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="95" y="76" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Publisher 1</text>
  <rect x="30" y="122" width="130" height="38" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="95" y="146" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Publisher 2</text>
  <rect x="285" y="82" width="150" height="48" rx="12" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.5"/>
  <text x="360" y="111" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Channel</text>
  <defs>
    <marker id="d56a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <line x1="160" y1="71" x2="284" y2="98" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d56a)"/>
  <line x1="160" y1="141" x2="284" y2="114" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d56a)"/>
  <line x1="435" y1="98" x2="558" y2="66" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d56a)"/>
  <line x1="435" y1="106" x2="558" y2="106" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d56a)"/>
  <line x1="435" y1="114" x2="558" y2="146" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d56a)"/>
  <rect x="560" y="48" width="130" height="36" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="625" y="71" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Subscriber 1</text>
  <rect x="560" y="88" width="130" height="36" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="625" y="111" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Subscriber 2</text>
  <rect x="560" y="128" width="130" height="36" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="625" y="151" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Subscriber 3</text>
  <text x="360" y="150" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">저장 없이 즉시 전달</text>
</svg>

이렇게 발행자와 구독자를 떼어놓으면 시스템을 느슨하게 연결할 수 있어요. 발행하는 쪽은 받는 쪽의 수나 상태를 몰라도 됩니다.

## [세 명령 - SUBSCRIBE, PSUBSCRIBE, PUBLISH]

Pub/Sub 은 명령 세 개로 요약됩니다.

- `SUBSCRIBE` 는 정확한 채널명을 구독해요. 여러 채널을 동시에 구독할 수 있습니다.
- `PSUBSCRIBE` 는 패턴을 구독합니다. `news.*` 처럼 와일드카드로 여러 채널을 한 번에 걸어요.
- `PUBLISH` 는 채널에 메시지를 발행합니다. 그 순간 구독 중인 클라이언트에게 곧장 전달돼요.

## [내부 구조 - 채널은 dict, 패턴은 list]

서버는 구독 정보를 두 개의 자료구조로 관리합니다.

<svg class="diagram" viewBox="0 0 720 214" role="img" aria-label="pubsub_channels 는 채널명에서 구독자 리스트로 가는 dict, pubsub_patterns 는 패턴 리스트">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">정확한 채널은 dict 로 O(1) 에 찾고, 패턴은 리스트를 순회하며 매칭한다</text>
  <rect x="30" y="42" width="320" height="158" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="50" y="66" font-size="12" font-weight="700" fill="var(--ink, #16181A)">pubsub_channels (dict)</text>
  <rect x="50" y="80" width="280" height="30" rx="6" fill="var(--clay-soft, #EAF2FE)"/>
  <text x="62" y="100" font-size="11" fill="var(--clay-text, #1B64DA)">"news"</text>
  <text x="318" y="100" font-size="10.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">→ [sub1, sub2]</text>
  <rect x="50" y="116" width="280" height="30" rx="6" fill="var(--clay-soft, #EAF2FE)"/>
  <text x="62" y="136" font-size="11" fill="var(--clay-text, #1B64DA)">"sports"</text>
  <text x="318" y="136" font-size="10.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">→ [sub3]</text>
  <text x="50" y="170" font-size="10.5" fill="var(--ink-3, #8B9099)">발행 시 채널명으로 바로 조회</text>
  <text x="50" y="186" font-size="10.5" fill="var(--ink-3, #8B9099)">구독자 수만큼 전달, O(N)</text>
  <rect x="370" y="42" width="320" height="158" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="390" y="66" font-size="12" font-weight="700" fill="var(--ink, #16181A)">pubsub_patterns (list)</text>
  <rect x="390" y="80" width="280" height="30" rx="6" fill="var(--sunk, #F1F3F6)"/>
  <text x="402" y="100" font-size="11" fill="var(--ink-2, #545A64)">"news.*"</text>
  <text x="658" y="100" font-size="10.5" text-anchor="end" fill="var(--ink-3, #8B9099)">→ subX</text>
  <rect x="390" y="116" width="280" height="30" rx="6" fill="var(--sunk, #F1F3F6)"/>
  <text x="402" y="136" font-size="11" fill="var(--ink-2, #545A64)">"log.?"</text>
  <text x="658" y="136" font-size="10.5" text-anchor="end" fill="var(--ink-3, #8B9099)">→ subY</text>
  <text x="390" y="170" font-size="10.5" fill="var(--ink-3, #8B9099)">등록된 패턴을 하나씩 순회하며</text>
  <text x="390" y="186" font-size="10.5" fill="var(--ink-3, #8B9099)">매칭되는 구독자에게 전달</text>
</svg>

`pubsub_channels` 는 채널명에서 구독자 리스트로 가는 딕셔너리라, 발행할 때 채널을 O(1) 로 찾아 그 리스트에 뿌립니다. `pubsub_patterns` 는 등록된 패턴들의 리스트라, 발행 채널이 각 패턴에 맞는지 순회하며 확인해요. 정확히는 채널 전달은 해시 조회라 빠르고, 패턴 전달은 패턴 수만큼 순회가 필요합니다.

## [전달 보장 - Fire-and-Forget]

여기가 Pub/Sub 의 성격을 결정하는 지점입니다. Pub/Sub 은 쐈으면 끝인 Fire-and-Forget, 즉 At-Most-Once 예요. 도착 확인도 없고 재전송도 없습니다. 전달 보장의 세 단계를 비교하면 이렇습니다.

| 보장 수준 | 뜻 | 대표 |
| --- | --- | --- |
| At-Most-Once | 0번 또는 1번, 유실 가능 | Redis Pub/Sub |
| At-Least-Once | 최소 1번, 중복 가능하며 ACK 사용 | RabbitMQ, Redis Stream |
| Exactly-Once | 정확히 1번 | Kafka 트랜잭션 |

그래서 반드시 기억할 함정이 하나 있어요. Pub/Sub 은 **발행 순간에 구독 중인** 클라이언트에게만 전달합니다. 발행 전에 구독하지 않았거나 잠깐 끊긴 구독자는 그 메시지를 영영 받지 못해요. 대신 얻는 건 가벼움입니다. 저장하지 않으니 디스크 입출력이 없고, 조회도 없고, 메시지 때문에 메모리가 쌓이지도 않아요. 실시간성이 전부이고 한두 개쯤 놓쳐도 괜찮은 알림에 어울립니다.

한 가지 덧붙이면, 일반 Pub/Sub 은 클러스터에서 모든 노드로 메시지를 퍼뜨려서 확장성이 나빠요. 그래서 7.0 에 `SSUBSCRIBE` 와 `SPUBLISH` 라는 샤드 단위 Pub/Sub 이 들어왔습니다. 채널을 슬롯에 묶어 해당 샤드 안에서만 퍼뜨리는 방식이에요.

## [그래서 언제 쓰나 - Stream 과의 갈림길]

제가 처음 멈칫했던 "끊긴 사이의 메시지"를 살리고 싶다면, Pub/Sub 이 아니라 다른 도구가 필요합니다. 저장하고, 지나간 메시지를 다시 읽고, 소비자가 어디까지 처리했는지 추적하려면 [57번 글](/posts/57-redis-stream-consumer-group/)에서 볼 Stream 으로 가야 해요. Pub/Sub 을 쓰기로 했다면 그건 유실을 감수한 선택이라는 걸 알고 쓰는 게 맞습니다.

## [결론]

Pub/Sub 은 발행하고 잊는 실시간 채널이었습니다. 발행자와 구독자를 떼어놓아 느슨하게 연결하는 대신, 메시지를 저장하지 않아 유실을 허용해요. 이 성격을 알고 쓰면 강력하고, 모르고 쓰면 "왜 어떤 메시지는 안 오지"로 헤매게 됩니다.

남은 한계를 적어둘게요. 저는 대량 구독자에게 발행할 때 전달이 얼마나 걸리는지 재보지 않았고, 패턴 구독이 많아질 때 순회 비용이 어떻게 늘어나는지도 관찰하지 않았습니다. 다음에는 `PUBSUB CHANNELS` 와 `PUBSUB NUMSUB` 로 실제 구독 상태를 들여다보며 이 글을 보강하려고 해요.

<!-- 측정 필요: 구독자 수에 따른 PUBLISH 전달 지연, 패턴 구독 순회 비용 -->
