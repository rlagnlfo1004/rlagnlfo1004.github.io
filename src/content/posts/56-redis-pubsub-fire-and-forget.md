---
title: "발행하고 잊습니다 (Redis Pub/Sub 과 Fire-and-Forget)"
description: "발행자와 구독자가 서로를 모른 채 채널로 연결됩니다. 편하지만 메시지를 저장하지 않아서, 발행 순간에 듣고 있지 않으면 그 메시지는 사라져요. 구독 커넥션의 제약, PUBLISH 의 O(N+M) 비용, 그리고 느린 구독자가 조용히 끊기는 진짜 유실 지점까지 파고들었습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "Pub/Sub", "메시징", "전달 보장", "CS", "면접"]
draft: false
---

## [배경 - 실시간 알림에 손댔다가]

실시간으로 무언가를 밀어주는 기능을 붙일 때 Redis Pub/Sub 이 자주 첫 후보로 올라옵니다. 명령 세 개면 되고, 붙이기도 쉬워요. 저도 그렇게 가볍게 시작했다가 한 가지에서 멈칫했습니다. **구독자가 잠깐 끊긴 사이에 발행된 메시지는 어디로 갔을까.**

답을 찾아보니 "어디에도 안 갔다"였어요. Pub/Sub 은 메시지를 저장하지 않습니다. 이 한 문장이 Pub/Sub 을 쓸 수 있는 곳과 쓰면 안 되는 곳을 가릅니다. 그런데 그 글을 정리하면서 유실은 "구독을 안 한 시점"에만 생긴다고 오해하고 있었어요. 실제로는 멀쩡히 구독 중인 클라이언트도 메시지를 놓칠 수 있고, 그 이유가 서버 안쪽에 있었습니다. 그래서 이 방식이 안에서 어떻게 동작하고, 무엇을 보장하지 않으며, 어디서 조용히 새는지 정리했어요.

미리 밝혀둘게요. 이 글에는 제가 잰 숫자가 없습니다. 나오는 값은 Redis 의 기본 설정값이거나 프로토콜에 정의된 상수이고, 그렇다고 표시해뒀어요.

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

이렇게 발행자와 구독자를 떼어놓으면 시스템을 느슨하게 연결할 수 있어요. 발행하는 쪽은 받는 쪽의 수나 상태를 몰라도 됩니다. 다만 이 느슨함이 곧 "받는 쪽이 지금 없어도 발행은 성공한다"는 뜻이기도 해서, 뒤에서 볼 유실의 뿌리가 여기 있습니다.

## [세 명령과 구독 상태 - SUBSCRIBE, PSUBSCRIBE, PUBLISH]

Pub/Sub 은 명령 세 개로 요약됩니다.

- `SUBSCRIBE` 는 정확한 채널명을 구독해요. 여러 채널을 동시에 구독할 수 있습니다.
- `PSUBSCRIBE` 는 패턴을 구독합니다. `news.*` 처럼 와일드카드로 여러 채널을 한 번에 걸어요.
- `PUBLISH` 는 채널에 메시지를 발행합니다. 그 순간 구독 중인 클라이언트에게 곧장 전달돼요.

여기서 처음 쓸 때 놓치기 쉬운 제약이 하나 있어요. **한 커넥션이 구독 상태에 들어가면, 그 커넥션은 사실상 Pub/Sub 전용이 됩니다.** 예전 프로토콜인 RESP2 에서는 구독 중인 커넥션이 받을 수 있는 명령이 `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE` 와 그 해제 명령들, 그리고 `PING`, `RESET`, `QUIT` 정도로 제한돼요. 그 상태에서 `GET` 같은 일반 명령을 보내면 거부됩니다.

이유는 응답 스트림에 있어요. 구독 커넥션에는 서버가 언제든 메시지를 밀어 넣는데, 여기에 일반 명령의 응답까지 섞이면 클라이언트가 "이 프레임이 내가 요청한 응답인지, 서버가 밀어준 메시지인지"를 구분하기 어려워집니다. 그래서 클라이언트 라이브러리는 대개 **구독 전용 커넥션을 따로 하나 두고**, 일반 명령은 다른 커넥션으로 보내요. 새 프로토콜인 RESP3 는 이 문제를 push 타입이라는 별도 메시지 종류로 풀어서, 밀어준 메시지와 명령 응답을 프로토콜 차원에서 구분합니다. 그래서 RESP3 에서는 같은 커넥션에서 구독과 일반 명령을 섞어 쓸 수 있어요.

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

`pubsub_channels` 는 채널명에서 구독자 리스트로 가는 딕셔너리라, 발행할 때 채널을 O(1) 로 찾아 그 리스트에 뿌립니다. `pubsub_patterns` 는 등록된 패턴들의 리스트라, 발행 채널이 각 패턴에 맞는지 순회하며 확인해요.

그래서 `PUBLISH` 한 번의 비용은 정확히는 **O(N+M)** 입니다. N 은 그 채널의 구독자 수이고, M 은 서버에 등록된 패턴의 개수예요. 채널 조회 자체는 해시라 빠른데, 구독자에게 하나씩 써 넣는 N 과 패턴을 하나씩 매칭하는 M 이 붙습니다. 패턴 매칭은 `stringmatchlen` 으로 문자 단위 비교라 공짜가 아니에요. 그리고 이 전체가 [43번 글](/posts/43-redis-io-model-internals/)에서 본 그 직렬 구간, 즉 명령을 실행하는 단일 스레드 위에서 돕니다. 구독자가 수만 명이거나 패턴이 잔뜩 등록돼 있으면, 발행 하나가 그동안 다른 명령을 밀어내는 겁니다. 발행이 가볍다는 인상은 구독자가 적을 때의 이야기예요.

## [전달 보장 - Fire-and-Forget]

여기가 Pub/Sub 의 성격을 결정하는 지점입니다. Pub/Sub 은 쐈으면 끝인 Fire-and-Forget, 즉 At-Most-Once 예요. 도착 확인도 없고 재전송도 없습니다. 전달 보장의 세 단계를 비교하면 이렇습니다.

| 보장 수준 | 뜻 | 대표 |
| --- | --- | --- |
| At-Most-Once | 0번 또는 1번, 유실 가능 | Redis Pub/Sub |
| At-Least-Once | 최소 1번, 중복 가능하며 ACK 사용 | RabbitMQ, Redis Stream |
| Exactly-Once | 정확히 1번 | Kafka 트랜잭션 |

그래서 반드시 기억할 함정이 하나 있어요. Pub/Sub 은 **발행 순간에 구독 중인** 클라이언트에게만 전달합니다. 발행 전에 구독하지 않았거나 잠깐 끊긴 구독자는 그 메시지를 영영 받지 못해요. 대신 얻는 건 가벼움입니다. 저장하지 않으니 디스크 입출력이 없고, 조회도 없고, 메시지 때문에 메모리가 쌓이지도 않아요.

여기까지가 대부분의 글이 말하는 지점이고, 제가 처음 이해한 지점이기도 합니다. 그런데 "구독 중이면 받는다"도 사실은 조건부였어요.

## [조용히 사라지는 구독자 - 출력 버퍼]

멀쩡히 구독 중인데도 메시지를 놓치는 경로가 하나 더 있습니다. 여기가 실무에서 진짜로 물리는 곳이에요.

Redis 가 구독자에게 메시지를 보낸다는 건, 곧장 소켓에 밀어 넣는다는 뜻이 아닙니다. 일단 그 클라이언트의 **출력 버퍼**에 담고, 이 버퍼는 Redis 의 메모리예요. 구독자가 느려서 이 메시지를 제때 읽어가지 못하면 버퍼가 계속 부풀어요. 서버가 이걸 무한정 방치하면 느린 구독자 하나가 서버 메모리를 통째로 먹어버립니다.

그래서 Redis 는 한도를 둡니다. `client-output-buffer-limit` 의 pubsub 몫은 기본값이 hard 32mb, soft 8mb 60초예요.

```
client-output-buffer-limit pubsub 32mb 8mb 60
```

버퍼가 hard 인 32MB 를 넘기거나, soft 인 8MB 를 60초 동안 계속 넘고 있으면, 서버가 **그 연결을 강제로 끊습니다.** 여기서 핵심은 이 끊김이 조용하다는 거예요. 발행자는 아무 에러도 못 받고, 끊긴 구독자는 재연결하기 전까지 그 사이 메시지를 통째로 놓칩니다.

<svg class="diagram" viewBox="0 0 720 200" role="img" aria-label="느린 구독자의 출력 버퍼가 한도를 넘으면 서버가 연결을 끊어 그 사이 메시지가 유실되는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">구독 중이어도, 못 읽어가 버퍼가 한도를 넘으면 서버가 연결을 끊는다</text>
  <rect x="24" y="52" width="150" height="44" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="99" y="79" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <defs>
    <marker id="d56b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d56c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--danger, #E5484D)"/></marker>
  </defs>
  <line x1="174" y1="74" x2="250" y2="74" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d56b)"/>
  <text x="212" y="66" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">밀어넣기</text>
  <rect x="254" y="44" width="180" height="60" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="344" y="66" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">출력 버퍼</text>
  <text x="344" y="84" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">Redis 메모리, 계속 부풂</text>
  <text x="344" y="97" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">32mb 초과</text>
  <line x1="434" y1="74" x2="510" y2="74" stroke="var(--danger, #E5484D)" stroke-width="1.4" marker-end="url(#d56c)"/>
  <text x="472" y="66" font-size="9.5" text-anchor="middle" fill="var(--danger, #E5484D)">강제 종료</text>
  <rect x="514" y="52" width="180" height="44" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="604" y="72" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">느린 구독자</text>
  <text x="604" y="88" font-size="9" text-anchor="middle" fill="var(--ink-3, #8B9099)">못 읽어가는 중</text>
  <text x="24" y="140" font-size="11" fill="var(--ink-2, #545A64)">발행자는 에러를 받지 않는다. 끊긴 구독자는 재연결 전까지의 메시지를 통째로 놓친다.</text>
  <text x="24" y="162" font-size="11" fill="var(--ink-3, #8B9099)">구독자가 말없이 사라지는 원인의 상당수가 여기다. Pub/Sub 은 그 사이를 메워주지 않는다.</text>
</svg>

이 버퍼 이야기는 [43번 글](/posts/43-redis-io-model-internals/)에서 느린 클라이언트를 다룰 때 이미 나왔어요. 그때는 일반 클라이언트가 큰 결과를 안 읽어가는 경우였는데, Pub/Sub 은 서버가 능동적으로 메시지를 밀어 넣는 구조라 이 문제가 훨씬 쉽게 터집니다. 그러니 "구독만 하고 있으면 다 받는다"가 아니라, **읽는 속도가 발행 속도를 따라가지 못하면 끊긴다**가 정확해요.

## [클러스터에서 - 전 노드로 퍼진다]

Pub/Sub 을 클러스터에 올리면 또 다른 성질이 드러납니다. 채널은 특정 슬롯에 묶이지 않아서, 어느 노드에 발행하든 그 메시지가 **cluster bus 를 타고 모든 노드로 퍼져요.** 어느 노드에 붙은 구독자든 다 받게 하려면 어쩔 수 없는 설계인데, 노드가 늘수록 발행 하나가 만드는 내부 트래픽이 커집니다.

그래서 7.0 에 샤드 단위 Pub/Sub 이 들어왔어요. `SSUBSCRIBE` 와 `SPUBLISH` 는 채널을 슬롯에 묶어서, 그 슬롯을 담당하는 샤드 안에서만 메시지를 퍼뜨립니다. 전 노드 브로드캐스트를 피하는 대신, 발행자와 구독자가 같은 샤드를 봐야 한다는 제약이 붙어요. 결과적으로 확장성과 배치 제약을 맞바꾼 셈입니다.

## [keyspace notifications - 같은 성격을 물려받는다]

한 가지 덧붙이면, Redis 의 키 이벤트 알림도 Pub/Sub 위에 얹혀 있습니다. `notify-keyspace-events` 를 켜면 키가 만료되거나 변경될 때 서버가 정해진 채널로 이벤트를 발행해요. 편리하지만 이건 어디까지나 Pub/Sub 이라, 지금까지 본 성격을 그대로 물려받습니다. 구독자가 없거나 느려서 끊기면 그 이벤트도 사라져요. 그래서 "만료 이벤트를 받아 후처리한다"는 설계를 유실 없이 만들려면, 이 알림만으로는 부족하고 별도의 안전망이 필요합니다.

## [그래서 언제 쓰나 - Stream 과의 갈림길]

제가 처음 멈칫했던 "끊긴 사이의 메시지"를 살리고 싶다면, Pub/Sub 이 아니라 다른 도구가 필요합니다. 저장하고, 지나간 메시지를 다시 읽고, 소비자가 어디까지 처리했는지 추적하려면 [57번 글](/posts/57-redis-stream-consumer-group/)에서 볼 Stream 으로 가야 해요. 정확히는 Pub/Sub 은 "지금 듣는 사람에게 가볍게"이고, Stream 은 "남겨두고 확인받으며"입니다. Pub/Sub 을 쓰기로 했다면 그건 유실을 감수한 선택이라는 걸 알고 쓰는 게 맞습니다.

## [실무 적용 - 이 구조에서 나오는 규칙]

정리하면 규칙은 이렇게 좁혀집니다.

**1. 유실을 감수해도 되는 알림에만 씁니다.** 몇 개 놓쳐도 되는 실시간 표시, 예를 들어 "누가 지금 접속했다" 같은 신호에 어울려요. 놓치면 안 되는 이벤트는 Stream 이나 큐로 보냅니다.

**2. 구독자를 빠르게 유지합니다.** 구독 콜백 안에서 무거운 일을 직접 하지 말고 받은 걸 큐에 넘기고 바로 리턴해요. 소비가 밀리면 출력 버퍼가 차서 조용히 끊깁니다.

**3. 대량 팬아웃의 발행 비용을 감안합니다.** `PUBLISH` 는 O(N+M) 이고 직렬 구간에서 돌아요. 구독자가 아주 많거나 패턴을 남발하면 발행 자체가 서버를 붙잡습니다.

**4. 전용 커넥션을 씁니다.** RESP2 에서 구독 커넥션은 일반 명령을 못 받아요. 라이브러리가 이미 이렇게 하는 경우가 많지만, 직접 다룬다면 구독과 일반 명령의 커넥션을 나눕니다.

**5. 클러스터면 샤드 Pub/Sub 을 검토합니다.** 일반 Pub/Sub 은 전 노드로 퍼져요. 채널을 샤드에 묶어도 되는 구조라면 `SSUBSCRIBE`, `SPUBLISH` 로 내부 트래픽을 줄입니다.

**6. keyspace notification 에 정합성을 기대지 않습니다.** 만료 이벤트도 유실될 수 있으니, 반드시 처리돼야 하는 후속 작업은 이 알림 하나에만 걸지 않아요.

## [결론]

Pub/Sub 은 발행하고 잊는 실시간 채널이었습니다. 발행자와 구독자를 떼어놓아 느슨하게 연결하는 대신, 메시지를 저장하지 않아 유실을 허용해요. 이 성격을 알고 쓰면 강력하고, 모르고 쓰면 "왜 어떤 메시지는 안 오지"로 헤매게 됩니다.

제가 이 글을 쓰면서 바뀐 건 유실을 보는 눈이었어요. 처음에는 "구독을 안 한 사이에만 샌다"고 좁게 봤는데, 실제로는 발행의 O(N+M) 비용, 느린 구독자의 버퍼 초과 종료, 클러스터의 전 노드 브로드캐스트까지 유실과 부하가 여러 층에 걸쳐 있었습니다. Pub/Sub 이 가볍다는 말은 조건이 맞을 때의 이야기이고, 그 조건을 벗어나는 순간을 계산에 넣어야 안전하게 쓸 수 있어요.

남은 한계를 적어둘게요. 저는 대량 구독자에게 발행할 때 전달이 얼마나 걸리는지, 느린 구독자가 실제로 몇 초 만에 버퍼 한도에 걸려 끊기는지를 재보지 않았습니다. 패턴 구독이 많아질 때 M 이 어떻게 부담이 되는지도 관찰하지 않았어요. 다음에는 `PUBSUB CHANNELS`, `PUBSUB NUMSUB`, `PUBSUB NUMPAT` 로 실제 구독 상태를 들여다보고, `CLIENT LIST` 의 출력 버퍼 크기를 관찰하며 이 글을 제가 잰 값으로 보강하려고 합니다.

<!-- 측정 필요: 구독자 수에 따른 PUBLISH 전달 지연, 느린 구독자의 버퍼 초과 종료까지 시간, 패턴 수 M 에 따른 발행 비용 -->
