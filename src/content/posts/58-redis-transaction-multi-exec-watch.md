---
title: "묶어서 실행하지만 되돌리지는 않습니다 (MULTI, EXEC, WATCH)"
description: "Redis 트랜잭션은 여러 명령을 큐에 모아 순차로 실행합니다. 그런데 RDB 를 떠올리며 롤백을 기대하면 배신당해요. 롤백이 없는 이유와, WATCH 로 만드는 낙관적 잠금을 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "트랜잭션", "동시성", "CS", "면접"]
draft: false
---

## [배경 - 트랜잭션이라길래 롤백을 기대했다가]

관계형 DB 를 먼저 배운 사람에게 "트랜잭션"이라는 단어는 곧 "다 되거나 다 안 되거나"입니다. 저도 그랬어요. 그래서 Redis 의 `MULTI` 와 `EXEC` 를 처음 봤을 때 당연히 롤백이 있을 거라고 생각했습니다.

그런데 Redis 트랜잭션에는 롤백이 없어요. 중간에 명령 하나가 런타임에 실패해도 이미 실행된 명령은 되돌아오지 않습니다. 이 사실을 모르고 쓰면 "트랜잭션으로 묶었는데 왜 절반만 반영됐지"로 헤매게 돼요. 그래서 Redis 트랜잭션이 정확히 무엇을 보장하고 무엇을 보장하지 않는지, 그리고 그 빈자리를 `WATCH` 가 어떻게 메우는지 정리했습니다.

## [문제 상황 분석 - 큐에 쌓고 한 번에 실행]

Redis 트랜잭션의 뼈대는 세 명령입니다. `MULTI` 로 시작하고, 이후 명령들은 실행되지 않고 큐에 쌓여요. 각 명령의 응답으로 `QUEUED` 가 돌아옵니다. 그리고 `EXEC` 를 부르면 큐를 순서대로 실행하고 결과를 배열로 돌려줘요. 취소하려면 `DISCARD` 로 큐를 버립니다.

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

Redis 는 명령을 한 스레드가 순차로 처리하니, `EXEC` 가 도는 동안은 다른 클라이언트의 명령이 섞이지 않아요. 이 격리는 [43번 글](/posts/43-redis-io-model-internals/)에서 본 싱글 스레드 특성에서 그냥 따라 나옵니다.

## [왜 롤백이 없는가 - 두 종류의 오류]

여기가 핵심입니다. 오류를 두 종류로 나눠야 이해가 돼요.

| 오류 종류 | 언제 걸리나 | 결과 |
| --- | --- | --- |
| 문법 오류 | 큐잉 중 감지, 예를 들어 인자 수가 틀림 | EXEC 전체가 거부됨 |
| 런타임 오류 | EXEC 실행 중, 예를 들어 List 에 INCR | 그 명령만 실패, 나머지는 그대로 실행 |

문법이 틀린 명령은 큐에 담는 단계에서 걸러져서, 그런 게 하나라도 있으면 `EXEC` 자체가 거부됩니다. 그런데 자료형이 안 맞아 실행 도중에 터지는 런타임 오류는 다릅니다. 그 명령만 실패하고 앞뒤 명령은 정상 실행돼요. 그리고 이미 실행된 건 되돌리지 않습니다.

Redis 가 롤백을 뺀 이유는 분명해요. 런타임 오류는 대개 프로그래밍 실수이고, 그걸 되돌리는 복잡함을 떠안느니 단순함과 성능을 지키겠다는 입장입니다. 그래서 정합성은 개발자 책임으로 넘어와요. 명령이 올바른 자료형에 가는지는 미리 보장해야 한다는 뜻입니다.

## [WATCH - 낙관적 잠금]

롤백이 없다면, 여러 클라이언트가 같은 값을 동시에 고치는 상황은 어떻게 다룰까요. 여기서 `WATCH` 가 나옵니다. 감시하던 키가 `EXEC` 직전까지 다른 곳에서 바뀌면, 트랜잭션이 통째로 취소되고 `nil` 을 돌려줘요.

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

이건 락을 걸지 않는 낙관적 동시성 제어입니다. "바뀌었으면 다시"로 처리하는 Compare And Set 이에요. 재고를 읽어 판단하고 차감하는, 이른바 read-modify-write 를 안전하게 감쌀 때 씁니다.

## [ACID 로 보면]

관계형 DB 의 ACID 에 대응시키면 Redis 트랜잭션의 성격이 또렷해집니다.

| 속성 | Redis 트랜잭션 |
| --- | --- |
| Atomicity | 부분 지원, 롤백 없음 |
| Consistency | 애플리케이션 책임 |
| Isolation | 완전, 단일 스레드 순차 실행 |
| Durability | 설정에 따름 (AOF, RDB) |

## [복잡한 원자성은 Lua 로 - 버린 선택지]

한동안 저는 조건 분기가 낀 원자적 연산도 `WATCH` 로 풀려고 했어요. 그런데 "조회 결과에 따라 다르게 쓰기" 같은 로직은 `WATCH` 와 재시도를 겹겹이 쌓아야 해서 지저분해집니다. 그럴 때는 Lua 스크립트가 깔끔해요. 스크립트 전체가 하나의 원자 단위로 돌기 때문입니다. 재고를 확인하고 차감하는 로직을 Lua 한 덩어리로 묶은 이야기는 [39번 글](/posts/39-redis-lua-atomic-inventory/)에 있어요. 정확히는 트랜잭션은 "정해진 명령 묶음"에, Lua 는 "로직이 낀 원자 연산"에 어울립니다.

## [결론]

Redis 트랜잭션은 묶어서 순차로 실행하고 완전히 격리하지만, 되돌리지는 않았습니다. 롤백이 없다는 사실을 알고 나면 이름에 속지 않고 쓸 수 있어요. 동시 변경은 `WATCH` 의 낙관적 잠금으로, 조건 로직은 Lua 로 넘기는 식으로 역할을 나누게 됩니다.

남은 한계를 적어둘게요. 저는 `WATCH` 재시도가 경쟁이 심할 때 얼마나 자주 실패하는지를 재보지 않았습니다. 그리고 낙관적 잠금과 Lua 원자 연산 중 어느 쪽이 어떤 부하에서 유리한지는 실제 경쟁 상황을 만들어 비교해야 알 수 있어요. 다음에는 동시 요청을 걸어 `WATCH` 실패율을 관찰하며 이 글을 보강하려고 합니다.

<!-- 측정 필요: 경쟁 상황에서 WATCH 재시도 실패율, WATCH 재시도 vs Lua 처리량 비교 -->
