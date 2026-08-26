---
title: "묶어서 실행하지만 되돌리지는 않습니다 (MULTI, EXEC, WATCH)"
description: "Redis 트랜잭션은 여러 명령을 큐에 모아 순차로 실행합니다. 그런데 RDB 를 떠올리며 롤백을 기대하면 배신당해요. 롤백이 없는 이유, WATCH 가 어떤 순간에 트랜잭션을 더럽히는지, 그리고 조건 로직이 낀 원자성은 왜 Lua 로 넘어가는지 소스 동작까지 따라가 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "트랜잭션", "동시성", "낙관적 잠금", "CS", "면접"]
draft: false
---

## [배경 - 트랜잭션이라길래 롤백을 기대했다가]

관계형 DB 를 먼저 배운 사람에게 "트랜잭션"이라는 단어는 곧 "다 되거나 다 안 되거나"입니다. 저도 그랬어요. 그래서 Redis 의 `MULTI` 와 `EXEC` 를 처음 봤을 때 당연히 롤백이 있을 거라고 생각했습니다.

그런데 Redis 트랜잭션에는 롤백이 없어요. 중간에 명령 하나가 런타임에 실패해도 이미 실행된 명령은 되돌아오지 않습니다. 이 사실을 모르고 쓰면 "트랜잭션으로 묶었는데 왜 절반만 반영됐지"로 헤매게 돼요.

처음에는 이걸 Redis 의 미완성이나 결함으로 읽었습니다. 그런데 뜯어보니 롤백을 뺀 건 실수가 아니라 선택이었어요. 그 선택이 무엇을 지키려고 무엇을 포기했는지, `WATCH` 가 정확히 어느 순간에 트랜잭션을 취소시키는지, 그리고 조건 분기가 낀 원자성은 왜 결국 Lua 로 넘어가는지를 소스의 동작 수준에서 따라가 봤습니다.

미리 밝혀둘게요. 이 글에는 제가 잰 숫자가 없습니다. 벤치마크를 돌리지 않았고, 나오는 동작은 Redis 문서와 명령 의미론에 정의된 것들이에요.

## [문제 상황 분석 - 큐에 쌓고 한 번에 실행]

Redis 트랜잭션의 뼈대는 네 명령입니다. `MULTI` 로 시작하면 이후 명령들은 곧장 실행되지 않고 큐에 쌓여요. 각 명령의 응답으로 `QUEUED` 가 돌아옵니다. 그리고 `EXEC` 를 부르면 큐를 순서대로 한꺼번에 실행하고 결과를 배열로 돌려줘요. 도중에 그만두려면 `DISCARD` 로 큐를 버립니다.

<svg class="diagram" viewBox="0 0 720 170" role="img" aria-label="MULTI 이후 명령이 큐에 쌓이고 EXEC 시점에 순서대로 실행되는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">MULTI 와 EXEC 사이의 명령은 즉시 실행되지 않고 큐에 모인다</text>
  <rect x="20" y="52" width="90" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="65" y="77" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">MULTI</text>
  <defs>
    <marker id="d58a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="110" y1="72" x2="150" y2="72" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58a)"/>
  <rect x="154" y="44" width="240" height="56" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="274" y="66" font-size="11" text-anchor="middle" fill="var(--clay-text, #1B64DA)">명령 1 → QUEUED</text>
  <text x="274" y="84" font-size="11" text-anchor="middle" fill="var(--clay-text, #1B64DA)">명령 2 → QUEUED</text>
  <text x="274" y="96" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">큐에 쌓이는 중</text>
  <line x1="394" y1="72" x2="434" y2="72" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58a)"/>
  <rect x="438" y="52" width="90" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="483" y="77" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">EXEC</text>
  <line x1="528" y1="72" x2="568" y2="72" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58a)"/>
  <rect x="572" y="52" width="128" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="636" y="77" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">순서대로 실행</text>
  <text x="360" y="134" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">EXEC 이 도는 동안은 다른 클라이언트가 끼어들지 못한다 (완전 격리)</text>
</svg>

여기서 첫 오해를 하나 짚어야 해요. 격리가 걸리는 구간은 큐잉이 아니라 `EXEC` 입니다. `MULTI` 로 큐를 쌓는 동안에는 그저 이 커넥션의 명령을 미뤄 담아둘 뿐이라, 다른 클라이언트는 그 사이에도 같은 키를 자유롭게 읽고 씁니다. 그러다 `EXEC` 가 불리는 순간, 큐에 담긴 명령 전체가 하나의 단위로 실행돼요. Redis 는 명령을 한 스레드가 순차로 처리하니, `EXEC` 가 도는 동안은 다른 클라이언트의 명령이 그 사이에 섞이지 않습니다. 이 격리는 [43번 글](/posts/43-redis-io-model-internals/)에서 본 싱글 스레드 특성에서 그냥 따라 나와요. 특별한 잠금 장치가 있는 게 아니라, 애초에 끼어들 다른 실행 흐름이 없는 겁니다.

그러니까 트랜잭션이 사는 시간을 둘로 나눠서 봐야 합니다. 쌓는 시간은 격리되지 않고, 실행하는 시간만 격리돼요. 이 구분이 뒤에서 `WATCH` 가 왜 필요한지로 이어집니다.

## [왜 롤백이 없는가 - 두 종류의 오류]

여기가 핵심입니다. 오류를 두 종류로 나눠야 이해가 돼요. 하나는 명령을 큐에 담는 단계에서 걸리는 오류이고, 하나는 `EXEC` 로 실행하는 단계에서 터지는 오류입니다.

<svg class="diagram" viewBox="0 0 720 250" role="img" aria-label="큐잉 단계의 문법 오류는 EXEC 전체를 거부하고, 실행 단계의 런타임 오류는 그 명령만 실패하며 앞뒤는 그대로 반영된다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">걸리는 시점이 다르면 결과도 다르다. 하나는 통째로 거부, 하나는 부분 반영</text>
  <defs>
    <marker id="d58c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
  </defs>
  <rect x="20" y="44" width="330" height="180" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
  <text x="40" y="68" font-size="12" font-weight="700" fill="var(--ink, #16181A)">문법 오류 (큐잉 중)</text>
  <text x="40" y="88" font-size="10.5" fill="var(--ink-3, #8B9099)">인자 수가 틀림, 없는 명령 등</text>
  <rect x="40" y="100" width="290" height="24" rx="6" fill="var(--sunk, #F1F3F6)"/><text x="52" y="117" font-size="10.5" fill="var(--ink-2, #545A64)">SET a 1        → QUEUED</text>
  <rect x="40" y="128" width="290" height="24" rx="6" fill="var(--clay-soft, #EAF2FE)"/><text x="52" y="145" font-size="10.5" fill="var(--clay-text, #1B64DA)">INCR            → 에러 (인자 부족)</text>
  <rect x="40" y="156" width="290" height="24" rx="6" fill="var(--sunk, #F1F3F6)"/><text x="52" y="173" font-size="10.5" fill="var(--ink-2, #545A64)">SET b 2        → QUEUED</text>
  <text x="40" y="202" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">EXEC → EXECABORT, 전체 거부</text>
  <text x="40" y="218" font-size="10" fill="var(--ink-3, #8B9099)">아무것도 반영되지 않는다</text>
  <rect x="370" y="44" width="330" height="180" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.1"/>
  <text x="390" y="68" font-size="12" font-weight="700" fill="var(--ink, #16181A)">런타임 오류 (EXEC 중)</text>
  <text x="390" y="88" font-size="10.5" fill="var(--ink-3, #8B9099)">자료형 불일치 등, 실행해봐야 앎</text>
  <rect x="390" y="100" width="290" height="24" rx="6" fill="var(--clay-soft, #EAF2FE)"/><text x="402" y="117" font-size="10.5" fill="var(--clay-text, #1B64DA)">SET k "hello"  → OK (반영됨)</text>
  <rect x="390" y="128" width="290" height="24" rx="6" fill="var(--sunk, #F1F3F6)"/><text x="402" y="145" font-size="10.5" fill="var(--ink-2, #545A64)">INCR k         → 에러 (문자열)</text>
  <rect x="390" y="156" width="290" height="24" rx="6" fill="var(--clay-soft, #EAF2FE)"/><text x="402" y="173" font-size="10.5" fill="var(--clay-text, #1B64DA)">SET m "world"  → OK (반영됨)</text>
  <text x="390" y="202" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">그 명령만 실패, 롤백 없음</text>
  <text x="390" y="218" font-size="10" fill="var(--ink-3, #8B9099)">k 와 m 은 그대로 남는다</text>
</svg>

문법이 틀린 명령은 큐에 담는 단계에서 걸러집니다. 인자 수가 안 맞거나 존재하지 않는 명령이면 그 자리에서 에러를 돌려주고, Redis 는 이 커넥션의 트랜잭션에 "더럽혀졌다"는 표시를 해둬요. 그래서 그런 명령이 하나라도 있으면 `EXEC` 자체가 `EXECABORT` 로 거부되고 큐 전체가 버려집니다. 이 동작은 2.6.5 부터예요. 그 이전에는 잘못된 명령만 빼고 나머지를 실행했는데, 부분 실행이 더 위험하다는 판단으로 바뀌었습니다.

그런데 자료형이 안 맞아 실행 도중에 터지는 런타임 오류는 다릅니다. 문자열 키에 `INCR` 을 거는 건 큐잉 단계에서는 알 수 없어요. 명령 자체는 문법이 맞으니까요. 실제로 실행해봐야 "이 키는 숫자가 아니라 안 됩니다"가 드러납니다. 이때 그 명령만 실패하고 앞뒤 명령은 정상 실행돼요. 그리고 이미 실행된 건 되돌리지 않습니다.

Redis 가 롤백을 뺀 이유는 분명해요. 런타임 오류는 대개 잘못된 자료형에 명령을 건 프로그래밍 실수이고, 그건 테스트에서 잡아야 할 종류입니다. 그런 실수를 되돌리려고 모든 명령에 취소 로그와 보상 경로를 달면, 그 복잡함과 비용을 정상 경로가 항상 짊어지게 돼요. 정확히는 드문 실수를 위해 흔한 정상 실행을 느리게 만드는 셈입니다. 그래서 Redis 는 단순함과 성능을 지키는 쪽을 골랐고, 정합성 보장은 개발자에게 넘겼어요. 명령이 올바른 자료형에 가는지는 미리 보장해야 한다는 뜻입니다.

## [WATCH - 어떤 순간에 트랜잭션이 더럽혀지는가]

롤백이 없다면, 여러 클라이언트가 같은 값을 동시에 고치는 상황은 어떻게 다룰까요. 앞에서 큐를 쌓는 동안에는 격리가 없다고 했죠. 그 틈에 다른 누군가가 내가 읽고 판단한 값을 바꿔버릴 수 있습니다. 여기서 `WATCH` 가 나와요.

<svg class="diagram" viewBox="0 0 720 176" role="img" aria-label="WATCH 로 키를 감시하다가 EXEC 직전 변경이 있으면 취소하고, 없으면 실행하는 CAS 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">잠그지 않고, 바뀌었으면 다시 하게 만든다 (Compare And Set)</text>
  <rect x="30" y="50" width="110" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="85" y="75" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">WATCH key</text>
  <defs>
    <marker id="d58b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="140" y1="70" x2="180" y2="70" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58b)"/>
  <rect x="184" y="50" width="150" height="40" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="259" y="75" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">읽고, 판단하고</text>
  <line x1="334" y1="70" x2="374" y2="70" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58b)"/>
  <rect x="378" y="50" width="150" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="453" y="75" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">MULTI … EXEC</text>
  <line x1="453" y1="90" x2="330" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58b)"/>
  <line x1="453" y1="90" x2="600" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d58b)"/>
  <rect x="210" y="142" width="230" height="28" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="325" y="161" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">키가 안 바뀜 → 실행</text>
  <rect x="470" y="142" width="230" height="28" rx="7" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/>
  <text x="585" y="161" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">바뀌었으면 취소(nil), 다시 시도</text>
</svg>

`WATCH key` 를 걸면, 감시하던 키가 `EXEC` 직전까지 다른 곳에서 바뀔 경우 트랜잭션이 통째로 취소되고 `nil` 을 돌려줍니다. 락을 걸지 않는 낙관적 동시성 제어예요. "일단 진행하되, 실행 직전에 전제가 깨졌으면 없던 일로" 하는 Compare And Set 입니다.

동작을 조금 더 안으로 들어가 보면 이렇습니다. 서버는 각 DB 마다 `watched_keys` 라는 딕셔너리를 들고, 어떤 클라이언트가 어떤 키를 감시하는지 이어둡니다. 그 키를 누군가 수정하면 Redis 가 그 키를 감시하던 모든 클라이언트에 "더럽혀짐(dirty CAS)" 표시를 달아요. 그러면 그 클라이언트가 나중에 `EXEC` 를 불러도, Redis 는 표시를 보고 실행 없이 `nil` 을 돌려줍니다.

여기서 실무자가 놓치기 쉬운 지점이 몇 개 있어요.

- **값이 같아도 더럽혀집니다.** 감시 중인 키에 원래와 똑같은 값을 다시 `SET` 해도, Redis 는 값을 비교하는 게 아니라 수정 이벤트를 보기 때문에 트랜잭션이 취소돼요.
- **키 만료도 변경으로 봅니다.** 감시하던 키의 TTL 이 지나 사라지면 그것도 수정으로 취급됩니다.
- **`FLUSHDB` 나 `FLUSHALL` 은 전부 더럽힙니다.** DB 를 비우면 감시 중이던 모든 키가 바뀐 것으로 처리돼요.
- **`EXEC` 나 `UNWATCH` 를 부르면 감시가 풀립니다.** 트랜잭션을 실행하든 취소하든, 그 시점에 감시 목록이 비워져요. 그래서 재시도할 때는 `WATCH` 부터 다시 걸어야 합니다.

이 성격 때문에 `WATCH` 는 재고를 읽어 판단하고 차감하는, 이른바 read-modify-write 를 안전하게 감쌀 때 씁니다. 다만 경쟁이 심하면 문제가 생겨요. 여러 클라이언트가 같은 키를 두고 계속 `WATCH` 와 재시도를 반복하면, 서로가 서로를 더럽혀서 아무도 성공하지 못한 채 재시도만 도는 구간이 생깁니다. 락이 없어 데드락은 안 나지만, 대신 진행이 안 되는 라이브락에 가까운 상황이에요. 정확히는 낙관적 잠금은 충돌이 드물 때 이득이고, 충돌이 잦으면 오히려 재시도 비용이 쌓입니다.

## [MULTI 안에서는 분기하지 못한다 - Lua 로 넘어가는 지점]

`WATCH` 로도 안 풀리는 게 하나 더 있어요. 트랜잭션 안에서는 앞 명령의 결과를 보고 다음 명령을 바꾸지 못합니다. 큐에 쌓는 동안에는 명령들이 실행되지 않으니 결과가 없고, 결과는 `EXEC` 때 배열로 한꺼번에 돌아와요. 그러니 "재고를 읽어서 0보다 크면 차감하고 아니면 거부한다" 같은 조건 분기를 트랜잭션 하나로는 표현할 수 없습니다.

한동안 저는 이런 로직도 `WATCH` 로 풀려고 했어요. 재고를 읽고, `WATCH` 를 건 뒤, 애플리케이션에서 판단하고, `MULTI`/`EXEC` 로 차감하고, 취소되면 처음부터 다시. 됩니다. 다만 조건이 여러 개로 늘고 재시도가 겹치면 이 왕복이 지저분해지고, 경쟁이 심할수록 재시도가 늘어요.

그럴 때는 Lua 스크립트가 깔끔합니다. 스크립트 전체가 하나의 원자 단위로 돌기 때문에, 그 안에서는 마음껏 읽고 판단하고 쓸 수 있어요. 재고를 확인하고 차감하는 로직을 Lua 한 덩어리로 묶은 이야기는 [39번 글](/posts/39-redis-lua-atomic-inventory/)에 있습니다. 정확히는 트랜잭션은 "정해진 명령 묶음"에, Lua 는 "조회 결과에 따라 갈라지는 원자 연산"에 어울려요.

다만 Lua 도 공짜가 아닙니다. [43번 글](/posts/43-redis-io-model-internals/)에서 봤듯, 스크립트는 통째로 직렬 구간에 들어가서 도는 동안 서버 전체를 붙잡습니다. 트랜잭션의 `EXEC` 도 마찬가지예요. 그러니 어느 쪽을 고르든 "이 원자 단위가 서버를 얼마나 오래 잡느냐"를 같이 생각해야 합니다. 원자성을 얻는 대가가 정지 시간이라는 건 두 방식에 공통이에요. 7.0 부터는 Lua 스크립트를 서버에 이름으로 등록해 두고 부르는 Functions 도 들어왔는데, 원자적으로 돈다는 성격과 그동안 서버를 잡는다는 대가는 같습니다.

## [ACID 로 보면]

관계형 DB 의 ACID 에 대응시키면 Redis 트랜잭션의 성격이 또렷해집니다.

| 속성 | Redis 트랜잭션 |
| --- | --- |
| Atomicity | 부분 지원. 큐 전체가 함께 실행되지만 런타임 오류에 롤백이 없음 |
| Consistency | 애플리케이션 책임. 자료형이 맞는지는 개발자가 보장 |
| Isolation | 완전. 단일 스레드가 EXEC 를 끊김 없이 실행 |
| Durability | 설정에 따름. AOF 와 RDB 가 정한다 |

원자성이 "부분 지원"인 게 이 표의 핵심입니다. 큐에 담긴 명령들이 다른 클라이언트의 개입 없이 한 덩어리로 실행된다는 의미의 원자성은 있어요. 그런데 "하나라도 실패하면 전부 되돌린다"는 의미의 원자성은 없습니다. 같은 단어를 관계형 DB 와 다르게 쓴다는 걸 알아야, 이름에 속지 않고 씁니다.

## [실무 적용 - 이름 대신 동작으로 쓰기]

정리하면 규칙은 이렇게 나옵니다.

**1. 롤백을 전제로 설계하지 않습니다.** 트랜잭션으로 묶었다고 실패 시 원상복구를 기대하면 안 돼요. 자료형이 맞는지는 코드에서 미리 보장하고, 되돌림이 꼭 필요한 흐름이라면 그건 트랜잭션이 아니라 보상 로직으로 따로 설계합니다.

**2. read-modify-write 는 WATCH 로 감쌉니다.** 읽어서 판단하고 쓰는 흐름은 큐잉 구간의 틈에서 깨질 수 있어요. `WATCH` 로 전제를 감시하고, 취소되면 `WATCH` 부터 다시 겁니다.

**3. 조건 분기가 끼면 Lua 로 넘깁니다.** 결과를 보고 갈라지는 로직은 트랜잭션으로 표현되지 않아요. Lua 스크립트 하나로 묶는 편이 재시도 없이 깔끔합니다.

**4. 원자 단위를 짧게 유지합니다.** `EXEC` 든 Lua 든 도는 동안 서버가 멈춰요. 큐에 수백 개를 담거나 스크립트에 큰 순회를 넣으면 그만큼 다른 요청이 밀립니다.

**5. 경쟁이 심하면 낙관적 잠금을 재검토합니다.** `WATCH` 재시도가 계속 실패한다면, 충돌이 잦다는 신호예요. 그때는 키를 잘게 쪼개 경쟁을 분산하거나, 처음부터 Lua 로 한 번에 판정하는 쪽이 낫습니다.

## [결론]

Redis 트랜잭션은 묶어서 순차로 실행하고 완전히 격리하지만, 되돌리지는 않았습니다. 롤백이 없다는 사실을 알고 나면 이름에 속지 않고 쓸 수 있어요. 큐잉 구간은 격리되지 않고 `EXEC` 구간만 격리된다는 것, `WATCH` 는 값이 아니라 수정 이벤트를 보고 취소한다는 것, 조건 로직은 Lua 로 넘어간다는 것까지가 이 글에서 다시 세운 지도입니다.

제 코드에서 바뀐 건 트랜잭션과 Lua 를 고르는 기준이었어요. 예전에는 "여러 명령을 묶고 싶으면 트랜잭션"이라고만 생각했는데, 이제는 "정해진 묶음이면 트랜잭션, 결과를 보고 갈라지면 Lua, 둘 다 도는 동안 서버가 멈춘다"로 읽습니다.

남은 한계도 적어둘게요.

첫째, 측정이 없습니다. `WATCH` 재시도가 경쟁이 심할 때 얼마나 자주 실패하는지, 같은 로직을 `WATCH` 재시도와 Lua 로 짰을 때 처리량이 어떻게 갈리는지를 재보지 않았어요. 동시 요청을 걸어 `WATCH` 실패율을 관찰하면 확인할 수 있는 것들인데 아직 안 했습니다.

둘째, 클러스터를 다루지 않았어요. 이 글은 단일 노드 기준입니다. 클러스터에서는 트랜잭션에 담긴 키들이 같은 슬롯에 있어야 하고, 그렇지 않으면 `CROSSSLOT` 에러가 나요. 이 제약은 [42번 글](/posts/42-redis-distributed-lock-fencing-token/)에서 락을 예로 한 번 스쳤으니, 다음에 따로 볼 만합니다.

셋째, 저 역시 `WATCH` 의 "값이 같아도 더럽혀진다"를 처음에는 몰랐어요. 결과적으로 안전하게 짰던 것과 그 동작을 알고 짠 것은 다릅니다. 이걸 알고 나서야 제 재시도 로직이 왜 가끔 헛돌았는지 다시 읽을 수 있었습니다.

<!-- 측정 필요: 경쟁 상황에서 WATCH 재시도 실패율, WATCH 재시도 vs Lua 처리량 비교 -->
