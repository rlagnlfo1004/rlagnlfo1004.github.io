---
title: "메모리에 두고, 커널에 한 번만 묻는다 (In-Memory 와 I/O 멀티플렉싱)"
description: "Redis가 빠른 이유를 두 층에서 봤습니다. 하나는 데이터가 사는 층이고, 하나는 커널에게 소켓을 묻는 방식이에요. 블로킹 I/O부터 select, poll, epoll, kqueue까지 그림으로 정리했습니다."
date: 2026-08-11
project: "공통"
tags: ["Redis", "CS", "I/O 멀티플렉싱", "epoll", "커널", "자료구조", "면접"]
---

## [배경 - 43번에서 한 줄로 넘긴 것]

[43번 글](/posts/43-redis-io-model-internals/)에서 Redis의 이벤트 루프를 따라가면서 이렇게 적었습니다.

> 커넥션이 1만 개여도 스레드는 하나이고, 커널에게 "이 1만 개 중에 준비된 것만 알려줘"라고 한 번 물어봅니다.

이 문장을 쓰고 넘어갔는데, 다시 읽으니 설명한 게 아니라 이름만 붙인 거였어요. **커널에게 어떻게 물어보길래 1만 개를 한 번에 물어볼 수 있는지**를 저는 몰랐습니다. `epoll` 이 O(1)이라는 말도 외운 문장이었지 이유를 대지 못했어요.

그리고 하나가 더 있었습니다. 43번은 Redis 안쪽만 봤는데, Redis가 빠른 이유는 사실 두 개입니다. 하나는 **데이터가 메모리에 있다**는 것이고, 하나는 **소켓을 기다리는 방식**이에요. 앞의 것을 당연하게 여기고 건너뛰었더라고요.

그래서 이번엔 Redis보다 한 층 아래로 내려갔습니다. 메모리 계층에서 시작해서, 블로킹 I/O가 뭘 기다리는지, 멀티플렉싱이 그중 무엇을 바꾸는지, `select` 와 `epoll` 의 차이가 어디서 생기는지까지 봤어요.

미리 밝혀둘게요. **이 글에는 제가 잰 숫자가 없습니다.** 나오는 값은 널리 인용되는 자릿수이거나 Redis 문서에 적힌 기본값이고, 각각 어느 쪽인지 표시해뒀습니다.

## [1. In-Memory - 데이터가 어느 층에 사는가]

### 층이 바뀌면 자릿수가 바뀝니다

"메모리가 디스크보다 빠르다"는 문장은 다들 압니다. 문제는 그게 **얼마나** 빠른지를 자릿수로 갖고 있지 않다는 거예요. 저도 "몇 배쯤" 정도로만 알고 있었습니다.

<svg class="diagram" viewBox="0 0 720 400" role="img" aria-label="Core 부터 Disk 까지의 저장 계층과 각 층의 접근 시간 자릿수">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같은 1 바이트를 읽는 데 걸리는 시간은 층마다 자릿수가 다르다</text>
  <defs>
    <marker id="d47a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="110" y1="330" x2="110" y2="50" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d47a)"/>
  <text x="0" y="52" font-size="11" fill="var(--ink-2, #545A64)">용량 큼</text>
  <text x="0" y="332" font-size="11" fill="var(--ink-2, #545A64)">용량 작음</text>
  <line x1="610" y1="50" x2="610" y2="330" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d47a)"/>
  <text x="630" y="52" font-size="11" fill="var(--ink-2, #545A64)">속도 느림</text>
  <text x="630" y="332" font-size="11" fill="var(--ink-2, #545A64)">속도 빠름</text>
  <rect x="150" y="40" width="420" height="38" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="164" y="64" font-size="12" font-weight="700" fill="var(--ink, #16181A)">Disk</text>
  <text x="556" y="64" font-size="11" text-anchor="end" fill="var(--ink-3, #8B9099)">SSD 랜덤 읽기 ~100 µs   ·   HDD 탐색 ~10 ms</text>
  <rect x="180" y="90" width="360" height="38" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="194" y="114" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">Memory  (DRAM)</text>
  <text x="526" y="114" font-size="11" text-anchor="end" fill="var(--clay-text, #1B64DA)">~100 ns</text>
  <rect x="548" y="99" width="52" height="20" rx="10" fill="var(--clay, #3182F6)"/>
  <text x="574" y="113" font-size="10.5" font-weight="700" text-anchor="middle" fill="#FFFFFF">Redis</text>
  <rect x="210" y="140" width="300" height="38" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="224" y="164" font-size="12" font-weight="700" fill="var(--ink, #16181A)">L3 cache</text>
  <text x="496" y="164" font-size="11" text-anchor="end" fill="var(--ink-3, #8B9099)">~15 ns</text>
  <rect x="240" y="190" width="240" height="38" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="254" y="214" font-size="12" font-weight="700" fill="var(--ink, #16181A)">L2 cache</text>
  <text x="466" y="214" font-size="11" text-anchor="end" fill="var(--ink-3, #8B9099)">~4 ns</text>
  <rect x="270" y="240" width="180" height="38" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="284" y="264" font-size="12" font-weight="700" fill="var(--ink, #16181A)">L1 cache</text>
  <text x="436" y="264" font-size="11" text-anchor="end" fill="var(--ink-3, #8B9099)">~1 ns</text>
  <rect x="300" y="290" width="120" height="38" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="360" y="314" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Core</text>
  <line x1="0" y1="352" x2="720" y2="352" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="372" font-size="11" fill="var(--ink-3, #8B9099)">널리 인용되는 자릿수이고 제가 잰 값이 아닙니다. 하드웨어마다 다르니 절대값이 아니라 간격만 보세요.</text>
  <text x="0" y="392" font-size="11" fill="var(--ink-3, #8B9099)">Memory 와 Disk 사이에서 세 자릿수가 벌어집니다. Redis 가 사는 층은 그 위쪽입니다.</text>
</svg>

중요한 건 정확한 숫자가 아니라 **Memory 와 Disk 사이에서 세 자릿수가 벌어진다**는 사실입니다. 나노초와 마이크로초의 차이예요.

디스크를 읽는 DB가 아무리 잘 만들어져도, 캐시가 빗나가는 순간 이 간격을 그대로 맞습니다. 그래서 그런 DB의 최적화는 상당 부분 "어떻게 디스크를 덜 읽을까"에 쓰여요. [44번 글](/posts/44-mysql-innodb-internals/)에서 본 InnoDB의 버퍼 풀, 페이지 구조, 클러스터드 인덱스가 전부 그 문제를 푸는 장치였습니다.

**Redis는 그 문제 자체가 없습니다.** 데이터가 처음부터 위층에 있으니까요.

### 대가는 용량입니다

당연히 공짜가 아닙니다. 그림에서 위로 갈수록 용량이 커지고 아래로 갈수록 작아져요. 메모리에 다 담을 수 있는 만큼만 담을 수 있다는 게 Redis의 전제입니다.

그래서 Redis를 쓸 때의 판단은 언제나 "이 데이터를 메모리 가격에 둘 만한가"가 됩니다. [38번 글](/posts/38-redis-zset-waiting-queue-admission/)에서 대기열을 Redis에 둔 것도, 그 데이터가 짧게 살고 자주 읽혀서였어요. 영구 보관이 필요한 원장은 [15번 글](/posts/15-point-transaction-ledger-design/)처럼 RDB에 뒀습니다.

### 덜 알려진 이득: 구현이 단순해집니다

이건 저도 이 글을 쓰면서 처음 제대로 이해한 부분인데, In-Memory의 이득이 속도만은 아닙니다.

**메모리 위의 자료구조는 디스크 위의 자료구조보다 구현이 훨씬 쉽습니다.** 디스크에 자료구조를 올리려면 페이지 경계, 부분 쓰기, 크래시 복구, 버퍼 관리를 전부 다뤄야 해요. 메모리에서는 그냥 포인터를 다루면 됩니다.

이게 Redis가 스킵 리스트나 인트셋 같은 자료구조를 **여러 개** 갖고 각 상황에 맞게 갈아탈 수 있는 이유이기도 합니다. 뒤에서 다시 볼게요. 코드가 단순하다는 건 버그가 적다는 뜻이고, Redis가 스스로 내세우는 "rock solid" 가 여기서 나옵니다.

## [2. 그런데 왜 스레드를 안 쓰나]

### 멀티스레드는 공짜가 아닙니다

메모리에 있어서 빠른 건 알겠는데, 그럼 코어를 다 쓰면 더 빠르지 않을까요. 요청 하나가 완료될 때까지 스레드가 막힐 텐데, 스레드 하나로 수천 개를 어떻게 처리한다는 걸까요.

멀티스레드로 가면 공유 자료구조에 락이나 동기화가 붙습니다. 그 동시성 버그는 재현이 어렵기로 유명하고, 원인을 찾는 데 드는 시간이 얻는 성능보다 클 때가 많아요. 그래서 질문이 뒤집힙니다. **성능을 위해 그 복잡도를 감수할 만한가.**

Redis의 답은 "안 감수한다" 였습니다. 대신 다른 걸 씁니다.

<svg class="diagram" viewBox="0 0 720 330" role="img" aria-label="소켓 여러 개를 커널이 감시하고 준비된 것만 이벤트 루프가 하나씩 처리하는 구조">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">소켓 수천 개를 스레드 하나가 처리하는 구조</text>
  <defs>
    <marker id="d47b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d47c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="76" y="46" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink-2, #545A64)">연결된 소켓</text>
  <rect x="0" y="54" width="152" height="178" rx="8" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1" stroke-dasharray="4 3"/>
  <rect x="18" y="76" width="116" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="76" y="96" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Socket 1</text>
  <rect x="18" y="120" width="116" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="76" y="140" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Socket 2</text>
  <rect x="18" y="164" width="116" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="76" y="184" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Socket 3</text>
  <text x="76" y="214" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">… 1 만 개까지</text>
  <text x="282" y="46" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">I/O Multiplex</text>
  <rect x="202" y="54" width="160" height="178" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1" stroke-dasharray="4 3"/>
  <rect x="218" y="76" width="128" height="30" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="282" y="96" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Socket 2 · 읽기 준비</text>
  <rect x="218" y="120" width="128" height="30" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="282" y="140" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Socket 3 · 읽기 준비</text>
  <rect x="218" y="164" width="128" height="30" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="282" y="184" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Socket 1 · 읽기 준비</text>
  <text x="282" y="214" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">준비된 것만 넘어온다</text>
  <path d="M134 91 C 172 91, 182 179, 214 179" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="0.9" marker-end="url(#d47b)"/>
  <path d="M134 135 C 172 135, 182 91, 214 91" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="0.9" marker-end="url(#d47b)"/>
  <path d="M134 179 C 172 179, 182 135, 214 135" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="0.9" marker-end="url(#d47b)"/>
  <circle cx="432" cy="143" r="42" fill="var(--sunk, #F1F3F6)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="432" y="139" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Event</text>
  <text x="432" y="155" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Loop</text>
  <path d="M362 143 L386 143" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47c)"/>
  <rect x="502" y="119" width="88" height="48" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="546" y="139" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Task</text>
  <text x="546" y="155" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Queue</text>
  <path d="M476 143 L498 143" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47c)"/>
  <rect x="614" y="90" width="106" height="44" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="667" y="109" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Event</text>
  <text x="667" y="124" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Dispatcher</text>
  <rect x="614" y="152" width="106" height="44" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="667" y="171" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Event</text>
  <text x="667" y="186" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">Processors</text>
  <path d="M590 137 C 600 137, 602 112, 610 112" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47c)"/>
  <path d="M667 134 L667 148" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47c)"/>
  <path d="M282 232 L282 250" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" stroke-dasharray="3 3"/>
  <text x="282" y="266" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">여기까지는 커널이 여러 소켓을 동시에 감시한다</text>
  <path d="M432 185 L432 240 L560 240 L560 250" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" stroke-dasharray="3 3"/>
  <text x="560" y="266" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">여기부터는 스레드 하나</text>
  <line x1="0" y1="286" x2="720" y2="286" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="306" font-size="11" fill="var(--ink-3, #8B9099)">요청마다 스레드를 만들지 않습니다. 커널에게 한 번 물어보고, 준비됐다고 알려준 것만 순서대로 처리합니다.</text>
  <text x="0" y="324" font-size="11" fill="var(--ink-3, #8B9099)">공유 자료를 건드리는 지점이 한 곳뿐이라 락이 필요 없습니다. 이 구조를 리액터 패턴이라고 부릅니다.</text>
</svg>

**I/O 멀티플렉싱**입니다. OS가 스레드 하나에게 "이 소켓 목록을 다 지켜보다가 뭐라도 준비되면 깨워줄게" 를 제공해줘요. 리액티브 프로그래밍에서 말하는 리액터 패턴이 이겁니다.

여기서 얻는 게 두 가지입니다. 스레드가 하나라서 **락이 없고**, 스레드가 하나라서 **컨텍스트 스위치와 스택 메모리도 없습니다.** 커넥션 1만 개에 스레드 1만 개를 띄우면 스택만 수 GB예요.

이제 진짜 질문으로 갑니다. 블로킹 I/O와 뭐가 다른 걸까요.

## [3. 블로킹 I/O 모델 - 무엇을 기다리는가]

먼저 정확히 짚어야 할 게 있습니다. **소켓에서 데이터를 읽는 일은 한 단계가 아니라 두 단계입니다.**

<svg class="diagram" viewBox="0 0 720 316" role="img" aria-label="블로킹 I/O 에서 recvfrom 한 번이 데이터 대기와 복사 두 구간을 모두 기다린다">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">블로킹 I/O — recvfrom 하나가 두 구간을 다 기다린다</text>
  <defs>
    <marker id="d47d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-2, #545A64)"/>
    </marker>
    <marker id="d47e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="200" y="40" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-2, #545A64)">애플리케이션  (유저 공간)</text>
  <text x="470" y="40" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-2, #545A64)">커널</text>
  <rect x="0" y="52" width="720" height="100" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="200" y="80" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">recvfrom() 호출</text>
  <text x="200" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">이 스레드는 여기서 멈춘다</text>
  <path d="M266 76 L 396 76" stroke="var(--ink-2, #545A64)" stroke-width="1.2" marker-end="url(#d47d)"/>
  <text x="331" y="66" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">시스템 콜</text>
  <text x="470" y="80" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">도착한 데이터 없음</text>
  <path d="M470 90 L470 114" stroke="var(--ink-2, #545A64)" stroke-width="1.2" marker-end="url(#d47d)"/>
  <text x="470" y="134" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">데이터 도착</text>
  <text x="712" y="74" font-size="11" font-weight="700" text-anchor="end" fill="var(--ink-2, #545A64)">① 데이터를 기다리는 구간</text>
  <rect x="0" y="160" width="720" height="86" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="470" y="188" font-size="11" text-anchor="middle" fill="var(--clay-text, #1B64DA)">커널 버퍼 → 유저 버퍼로 복사</text>
  <path d="M404 218 L 266 218" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47e)"/>
  <text x="335" y="208" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">return OK</text>
  <text x="200" y="222" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">recvfrom() 반환</text>
  <text x="712" y="182" font-size="11" font-weight="700" text-anchor="end" fill="var(--clay-text, #1B64DA)">② 복사하는 구간</text>
  <line x1="0" y1="264" x2="720" y2="264" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="284" font-size="11" fill="var(--ink-3, #8B9099)">두 구간 모두 스레드가 멈춰 있습니다. 소켓 하나를 기다리려고 스레드 하나가 통째로 붙잡힙니다.</text>
  <text x="0" y="304" font-size="11" fill="var(--ink-3, #8B9099)">그래서 이 모델로 동시 접속을 늘리려면 스레드나 프로세스를 그만큼 늘려야 합니다.</text>
</svg>

`read` 나 `recvfrom` 을 부르면 이 순서로 갑니다.

1. 커널이 네트워크에서 데이터가 도착하기를 기다립니다 — **여기가 대부분의 시간**
2. 도착한 데이터를 커널 버퍼에서 유저 공간 버퍼로 복사합니다

블로킹 I/O에서는 **호출 하나가 이 둘을 다 기다립니다.** 스레드는 두 구간이 끝날 때까지 아무것도 못 해요.

그러니 이 모델로 동시 접속을 늘리는 방법은 하나뿐입니다. 스레드나 프로세스를 그만큼 만드는 것. 클라이언트 1만 개면 스레드 1만 개예요. 스택 메모리도 문제지만, 스케줄러가 그 1만 개를 번갈아 올리는 컨텍스트 스위치 비용이 더 큽니다.

이게 전통적인 스레드 풀 기반 서버가 커넥션 수에서 벽을 만나는 이유입니다. 톰캣의 `max-connections` 와 스레드 풀 크기를 고민하게 되는 지점도 같은 뿌리예요.

## [4. I/O 멀티플렉싱 모델 - 먼저 묻고 나중에 읽는다]

멀티플렉싱은 이 두 구간 중 **①만 떼어냅니다.**

<svg class="diagram" viewBox="0 0 720 348" role="img" aria-label="멀티플렉싱은 select 로 준비 여부를 먼저 확인한 뒤 recvfrom 으로 읽는다">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">I/O 멀티플렉싱 — 준비됐는지 먼저 묻고, 그다음에 읽는다</text>
  <defs>
    <marker id="d47f" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
    <marker id="d47g" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-2, #545A64)"/>
    </marker>
  </defs>
  <text x="200" y="40" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-2, #545A64)">애플리케이션  (유저 공간)</text>
  <text x="470" y="40" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-2, #545A64)">커널</text>
  <rect x="0" y="52" width="720" height="116" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="200" y="80" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">select() 호출</text>
  <text x="200" y="100" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">소켓 1 만 개를 한꺼번에 맡긴다</text>
  <path d="M266 76 L 396 76" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47f)"/>
  <text x="331" y="66" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">시스템 콜 ①</text>
  <text x="470" y="80" font-size="11" text-anchor="middle" fill="var(--clay-text, #1B64DA)">아직 아무것도 준비 안 됨</text>
  <path d="M470 90 L470 110" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47f)"/>
  <text x="470" y="128" font-size="11" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Socket 3 이 읽기 가능해짐</text>
  <path d="M404 152 L 266 152" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d47f)"/>
  <text x="335" y="144" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">준비된 소켓 목록 반환</text>
  <text x="712" y="74" font-size="11" font-weight="700" text-anchor="end" fill="var(--clay-text, #1B64DA)">① 준비 여부를 기다림</text>
  <rect x="0" y="176" width="720" height="96" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="200" y="204" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">recvfrom() 호출</text>
  <path d="M272 200 L 396 200" stroke="var(--ink-2, #545A64)" stroke-width="1.2" marker-end="url(#d47g)"/>
  <text x="334" y="190" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">시스템 콜 ②</text>
  <text x="470" y="204" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">커널 버퍼 → 유저 버퍼로 복사</text>
  <path d="M404 240 L 266 240" stroke="var(--ink-2, #545A64)" stroke-width="1.2" marker-end="url(#d47g)"/>
  <text x="335" y="232" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">return OK</text>
  <text x="200" y="244" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">데이터 도착</text>
  <text x="712" y="198" font-size="11" font-weight="700" text-anchor="end" fill="var(--ink-2, #545A64)">② 복사하는 구간 (그대로 블록)</text>
  <line x1="0" y1="290" x2="720" y2="290" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="310" font-size="11" fill="var(--ink-3, #8B9099)">시스템 콜이 한 번에서 두 번으로 늘었습니다. 호출 하나만 놓고 보면 멀티플렉싱이 오히려 손해입니다.</text>
  <text x="0" y="330" font-size="11" fill="var(--ink-3, #8B9099)">그런데도 이기는 이유는 ① 이 소켓 하나가 아니라 1 만 개를 한꺼번에 기다려주기 때문입니다.</text>
</svg>

### 멀티플렉싱을 써도 읽기 함수는 여전히 블록합니다

여기가 제가 오해했던 부분입니다. "멀티플렉싱 = 논블로킹" 이 아니에요.

`recvfrom` 은 여전히 블록합니다. 다만 **부를 때 이미 데이터가 준비돼 있다는 걸 알고** 부르기 때문에, ② 구간만 잠깐 기다리고 바로 돌아옵니다. ①에서 무한정 기다리는 일이 없어지는 거예요.

### 시스템 콜은 오히려 늘어납니다

솔직하게 짚으면, 소켓 하나만 놓고 보면 멀티플렉싱이 **더 느립니다.** 시스템 콜이 한 번에서 두 번으로 늘었으니까요.

이기는 지점은 딱 하나입니다. **`select` 한 번이 소켓 1만 개를 동시에 기다려준다는 것.** 블로킹 모델에서 1만 개를 기다리려면 스레드 1만 개가 필요했는데, 여기서는 스레드 하나면 됩니다.

그러니까 멀티플렉싱이 사는 건 **지연이 아니라 커넥션 수**입니다. 43번에서 `io-threads` 를 두고 "지연이 아니라 처리량" 이라고 적었는데, 그보다 한 층 아래에서 이미 같은 구조였어요.

## [5. select, poll, epoll, kqueue - 차이는 어디서 생기나]

멀티플렉싱을 제공하는 시스템 콜은 하나가 아닙니다. 그리고 이 넷의 차이가 Redis 성능의 실제 근거예요.

### select — 매번 전체를 훑는다

`fd_set` 이라는 비트맵에 관심 있는 fd를 켜서 넘깁니다. 커널은 그 전체를 훑어보고, 준비된 것만 비트로 남긴 채 돌려줘요.

문제가 셋입니다.

**1. 매번 전체를 복사합니다.** 감시 대상이 1만 개면 호출할 때마다 1만 개짜리 집합이 유저 공간과 커널을 오갑니다.

**2. 반환된 뒤에도 전체를 훑어야 합니다.** 커널은 "몇 개가 준비됐다" 만 알려주고, **어느 것인지는 안 알려줍니다.** 그래서 애플리케이션이 `FD_ISSET` 으로 1만 개를 다 검사해야 해요. 여기서 O(n)이 한 번 더 붙습니다.

**3. 집합이 호출 중에 덮어써집니다.** 준비된 것만 남기고 지워버리니, 다음 호출 전에 매번 다시 채워야 해요.

거기에 `FD_SETSIZE` 가 보통 1024라 감시할 수 있는 fd 수 자체에 상한이 있습니다.

### poll — 상한은 풀었지만 O(n)은 그대로

`struct pollfd` 배열을 넘깁니다. 비트맵이 아니라 배열이라 1024 제한이 없고, 관심 이벤트(`events`)와 결과(`revents`)가 분리돼 있어서 매번 다시 채울 필요도 없어요.

그런데 **복사와 스캔은 그대로입니다.** 여전히 호출마다 배열 전체가 오가고, 커널이 전체를 훑고, 애플리케이션도 전체를 훑어요.

### epoll / kqueue — 목록을 커널에 맡긴다

여기서 발상이 바뀝니다. **매번 목록을 들고 가지 말고, 커널에 등록해두자.**

```c
int ep = epoll_create1(0);                 // 감시 인스턴스를 만든다
epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev);     // 관심 목록에 한 번만 등록한다
int n = epoll_wait(ep, events, max, -1);   // 준비된 것만 배열로 받는다
```

세 가지가 동시에 해결됩니다.

**1. 등록이 한 번뿐입니다.** `epoll_ctl` 은 커넥션이 생길 때 한 번, 끊길 때 한 번 부릅니다. `epoll_wait` 는 목록을 안 들고 가요.

**2. 준비된 것만 돌려줍니다.** 커널이 관심 목록(레드블랙 트리)과 준비 목록을 따로 들고 있다가, 소켓이 준비되면 콜백이 그 소켓을 준비 목록에 올립니다. `epoll_wait` 는 그 준비 목록만 배열로 복사해줘요. **애플리케이션이 전체를 훑는 루프가 사라집니다.**

**3. 그래서 비용이 감시 대상 수가 아니라 준비된 이벤트 수에 비례합니다.** 흔히 O(1)이라고 부르는 게 이 뜻이에요. 정확히는 "감시 대상 n에 대해 상수" 입니다.

FreeBSD와 macOS의 `kqueue` 도 같은 발상입니다. 한 가지 더 나은 점은 `kevent()` 호출 하나에 등록(changelist)과 대기(eventlist)를 같이 넘길 수 있어서, 시스템 콜 횟수를 더 줄일 수 있다는 거예요.

| | 등록 방식 | 호출당 복사 | 준비된 fd 찾기 | fd 수 상한 |
|---|---|---|---|---|
| `select` | 매 호출마다 전체 | O(n) | O(n) 스캔 | `FD_SETSIZE` (보통 1024) |
| `poll` | 매 호출마다 전체 | O(n) | O(n) 스캔 | 없음 |
| `epoll` | 한 번 등록 | 준비된 것만 | 커널이 목록으로 줌 | 없음 |
| `kqueue` | 한 번 등록 (호출에 실어보낼 수 있음) | 준비된 것만 | 커널이 목록으로 줌 | 없음 |

이 표의 세 번째 열이 실제로 어떤 차이를 만드는지가 아래 그래프입니다.

<svg class="diagram" viewBox="0 0 720 424" role="img" aria-label="파일 디스크립터 수가 늘어날 때 select 와 poll 은 시간이 선형으로 늘고 epoll 과 kqueue 는 평평하다">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">감시 대상이 늘어날 때 걸리는 시간</text>
  <line x1="360" y1="11" x2="384" y2="11" stroke="var(--ink-3, #8B9099)" stroke-width="2"/>
  <text x="390" y="15" font-size="10.5" fill="var(--ink-2, #545A64)">select · poll  (O(n))</text>
  <line x1="530" y1="11" x2="554" y2="11" stroke="var(--clay, #3182F6)" stroke-width="2"/>
  <text x="560" y="15" font-size="10.5" fill="var(--ink-2, #545A64)">epoll · kqueue  (O(1))</text>
  <line x1="96" y1="40" x2="630" y2="40" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="96" y1="195" x2="630" y2="195" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="96" y1="350" x2="630" y2="350" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="88" y="44" font-size="10" text-anchor="end" fill="var(--ink-3, #8B9099)">100,000</text>
  <text x="88" y="199" font-size="10" text-anchor="end" fill="var(--ink-3, #8B9099)">10,000</text>
  <text x="88" y="354" font-size="10" text-anchor="end" fill="var(--ink-3, #8B9099)">1,000</text>
  <line x1="185" y1="26" x2="185" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="274" y1="26" x2="274" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="363" y1="26" x2="363" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="452" y1="26" x2="452" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="541" y1="26" x2="541" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="630" y1="26" x2="630" y2="350" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="96" y1="26" x2="96" y2="350" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="96" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">0</text>
  <text x="185" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">2,500</text>
  <text x="274" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">5,000</text>
  <text x="363" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">7,500</text>
  <text x="452" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">10,000</text>
  <text x="541" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">12,500</text>
  <text x="630" y="368" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">15,000</text>
  <text x="363" y="390" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">감시하는 파일 디스크립터 수</text>
  <text x="22" y="188" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)" transform="rotate(-90 22 188)">처리 시간 (µs, 로그 눈금)</text>
  <polyline points="96,288 114,278 132,242 149,202 167,172 185,148 203,136 238,121 274,105 310,92 363,77 452,57 541,43 630,29" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="96,291 114,270 132,229 149,189 167,163 185,144 203,131 238,119 274,104 310,92 363,78 452,58 541,44 630,32" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="96,291 107,276 117,249 132,237 167,234 274,233 452,233 577,233 630,228" fill="none" stroke="var(--clay, #3182F6)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="96,291 110,281 125,264 139,250 167,246 203,244 274,247 452,247 523,243 630,246" fill="none" stroke="var(--clay, #3182F6)" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="638" y="27" font-size="10.5" font-weight="700" fill="var(--ink-2, #545A64)">select</text>
  <text x="638" y="44" font-size="10.5" font-weight="700" fill="var(--ink-2, #545A64)">poll</text>
  <text x="638" y="226" font-size="10.5" font-weight="700" fill="var(--clay-text, #1B64DA)">epoll</text>
  <text x="638" y="252" font-size="10.5" font-weight="700" fill="var(--clay-text, #1B64DA)">kqueue</text>
  <line x1="0" y1="400" x2="720" y2="400" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="418" font-size="11" fill="var(--ink-3, #8B9099)">libevent 문서에 실린 벤치마크 그래프를 다시 그린 것입니다. 제가 잰 값이 아니고, 세로축은 로그 눈금이에요.</text>
</svg>

가로축이 감시하는 fd 수, 세로축이 걸린 시간입니다. **`select` 와 `poll` 은 fd가 늘어난 만큼 시간이 같이 늘고, `epoll` 과 `kqueue` 는 평평합니다.** 세로축이 로그 눈금이라는 걸 감안하면 오른쪽 끝에서 스무 배가 넘게 벌어져요.

fd가 몇백 개일 때는 넷 다 비슷합니다. 차이는 수천 개를 넘어가면서 생겨요. 커넥션이 적은 서버라면 `select` 를 써도 티가 안 납니다.

### Redis는 컴파일 시점에 하나를 고릅니다

Redis는 이 넷을 직접 고르지 않습니다. `ae.c` 가 빌드하는 플랫폼을 보고 가장 좋은 걸 자동으로 넣어요.

```c
/* ae.c — 성능이 좋은 순서대로 시도한다 */
#ifdef HAVE_EVPORT
#include "ae_evport.c"          /* Solaris 10 */
#else
    #ifdef HAVE_EPOLL
    #include "ae_epoll.c"       /* Linux */
    #else
        #ifdef HAVE_KQUEUE
        #include "ae_kqueue.c"  /* macOS, FreeBSD */
        #else
        #include "ae_select.c"  /* 그 외 전부 */
        #endif
    #endif
#endif
```

`select` 는 마지막 수단입니다. 그리고 이 넷이 전부 `aeApiPoll()` 이라는 같은 함수 이름으로 감싸져 있어서, 위층의 이벤트 루프는 무엇이 깔렸는지 몰라도 됩니다. **여러 구현을 하나의 인터페이스로 캡슐화한 리액터 패턴**이 이겁니다.

참고로 Redis의 `ae_epoll.c` 는 `EPOLLET` 을 쓰지 않습니다. 엣지 트리거가 아니라 레벨 트리거예요. 엣지 트리거는 이론상 깨우는 횟수가 적지만, 한 번 깨어났을 때 버퍼가 빌 때까지 읽어내야 해서 코드가 까다로워집니다. 다시 **rock solid** 쪽 선택입니다.

## [6. 그래서 O(n) 명령이 위험합니다]

여기까지 오면 43번에서 규칙으로만 적었던 것들의 이유가 붙습니다.

**커널이 아무리 O(1)로 소켓을 골라줘도, 그 뒤에 명령 하나가 O(n)이면 거기서 다 막힙니다.** 이벤트 루프는 하나고, 앞의 명령이 끝나야 다음 이벤트를 처리하니까요.

- `KEYS` 대신 `SCAN` — `KEYS` 는 키 공간 전체를 훑는 동안 서버가 멈춥니다. `SCAN` 은 커서로 조금씩 나눠 훑어요. 대신 순회 중 추가된 키를 보장하지 않고 같은 키를 두 번 볼 수도 있습니다. **정확성을 내주고 지연을 사는 거래**예요.
- `DEL` 대신 `UNLINK` — `DEL` 은 메모리를 실제로 해제하는 시간까지 메인 스레드가 씁니다. 요소가 100만 개인 컬렉션이면 그만큼 멈춰요. `UNLINK` 는 키를 네임스페이스에서 떼어내는 것만 하고(O(1)), 실제 해제는 백그라운드 스레드에 넘깁니다.

싱글 스레드라 CPU 코어를 다 못 쓴다는 지적도 여기서 나옵니다. 그래서 한 서버에 Redis 인스턴스를 여러 개 띄워 코어를 나눠 쓰는 방식이 흔해요.

## [7. 왜 인기 있나 - Efficient Data Structure]

마지막으로 In-Memory의 이득으로 돌아옵니다. 디스크에 어떻게 잘 눕힐지를 고민하지 않아도 되니까, **Redis는 상황마다 다른 자료구조를 쓸 수 있습니다.**

<div class="diagram-scroll" style="--diagram-min-w: 900px">
<svg class="diagram" viewBox="0 0 980 366" role="img" aria-label="Redis 자료형이 크기에 따라 인코딩을 갈아타는 구조와 SDS, 스킵 리스트의 내부 모양">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">Efficient Data Structure — 자료형 하나가 인코딩 여러 개를 갈아탄다</text>
  <defs>
    <marker id="d47h" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <rect x="0" y="56" width="104" height="32" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="52" y="77" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">String</text>
  <rect x="0" y="104" width="104" height="32" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="52" y="125" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">List</text>
  <rect x="0" y="152" width="104" height="32" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="52" y="173" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Hash</text>
  <rect x="0" y="200" width="104" height="32" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="52" y="221" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Set</text>
  <rect x="0" y="248" width="104" height="32" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="52" y="269" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Sorted Set</text>
  <path d="M104 72 L160 59" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 120 L160 101" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 120 L160 143" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 168 L160 143" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 168 L160 185" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 216 L160 143" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 216 L160 185" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 216 L160 227" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 264 L160 143" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <path d="M104 264 L160 269" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <rect x="164" y="44" width="126" height="30" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="227" y="63" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">SDS</text>
  <rect x="164" y="86" width="126" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="227" y="105" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">QuickList</text>
  <rect x="164" y="128" width="126" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="227" y="147" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">ListPack</text>
  <rect x="164" y="170" width="126" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="227" y="189" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">HashTable</text>
  <rect x="164" y="212" width="126" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="227" y="231" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">IntSet</text>
  <rect x="164" y="254" width="126" height="30" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="227" y="273" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">SkipList</text>
  <text x="52" y="306" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">자료형</text>
  <text x="227" y="306" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">실제 인코딩</text>
  <rect x="326" y="40" width="310" height="152" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="340" y="60" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">SDS  (Simple Dynamic Strings)</text>
  <rect x="340" y="70" width="104" height="26" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="392" y="87" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">len   5</text>
  <rect x="340" y="100" width="104" height="26" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="392" y="117" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">alloc   10</text>
  <rect x="340" y="130" width="104" height="26" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="392" y="147" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">flags</text>
  <rect x="340" y="160" width="104" height="26" rx="4" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="392" y="177" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">buf</text>
  <path d="M444 173 L462 173" stroke="var(--ink-3, #8B9099)" stroke-width="0.8" marker-end="url(#d47h)"/>
  <rect x="468" y="160" width="26" height="26" rx="3" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="481" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">R</text>
  <rect x="494" y="160" width="26" height="26" rx="3" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="507" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">e</text>
  <rect x="520" y="160" width="26" height="26" rx="3" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="533" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">d</text>
  <rect x="546" y="160" width="26" height="26" rx="3" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="559" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">i</text>
  <rect x="572" y="160" width="26" height="26" rx="3" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="585" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">s</text>
  <rect x="598" y="160" width="26" height="26" rx="3" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="611" y="177" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">\0</text>
  <text x="464" y="82" font-size="10" fill="var(--ink-2, #545A64)">1.  길이 조회가 O(1)  —  끝까지 세지 않는다</text>
  <text x="464" y="102" font-size="10" fill="var(--ink-2, #545A64)">2.  공간을 미리 잡아둬 append 때마다</text>
  <text x="476" y="118" font-size="10" fill="var(--ink-2, #545A64)">재할당하지 않는다  (여유분 = alloc − len)</text>
  <text x="464" y="138" font-size="10" fill="var(--ink-2, #545A64)">3.  바이너리 세이프  —  \0 이 중간에 있어도</text>
  <text x="476" y="154" font-size="10" fill="var(--ink-2, #545A64)">문자열이 끊기지 않는다</text>
  <rect x="660" y="40" width="320" height="152" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="674" y="60" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">Skip List</text>
  <line x1="690" y1="84" x2="944" y2="84" stroke="var(--ink-3, #8B9099)" stroke-width="0.7" stroke-dasharray="3 3"/>
  <line x1="690" y1="120" x2="944" y2="120" stroke="var(--ink-3, #8B9099)" stroke-width="0.7" stroke-dasharray="3 3"/>
  <line x1="690" y1="156" x2="944" y2="156" stroke="var(--ink-3, #8B9099)" stroke-width="0.7" stroke-dasharray="3 3"/>
  <rect x="676" y="72" width="28" height="24" rx="4" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="690" y="88" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">1</text>
  <rect x="800" y="72" width="28" height="24" rx="4" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="814" y="88" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">9</text>
  <rect x="930" y="72" width="28" height="24" rx="4" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="944" y="88" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">31</text>
  <rect x="676" y="108" width="28" height="24" rx="4" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="690" y="124" font-size="10" text-anchor="middle" fill="var(--ink, #16181A)">1</text>
  <rect x="738" y="108" width="28" height="24" rx="4" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="752" y="124" font-size="10" text-anchor="middle" fill="var(--ink, #16181A)">4</text>
  <rect x="800" y="108" width="28" height="24" rx="4" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="814" y="124" font-size="10" text-anchor="middle" fill="var(--ink, #16181A)">9</text>
  <rect x="862" y="108" width="28" height="24" rx="4" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="876" y="124" font-size="10" text-anchor="middle" fill="var(--ink, #16181A)">18</text>
  <rect x="930" y="108" width="28" height="24" rx="4" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="944" y="124" font-size="10" text-anchor="middle" fill="var(--ink, #16181A)">31</text>
  <rect x="676" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="690" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">1</text>
  <rect x="707" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="721" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">2</text>
  <rect x="738" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="752" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">4</text>
  <rect x="769" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="783" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">6</text>
  <rect x="800" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="814" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">9</text>
  <rect x="831" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="845" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">13</text>
  <rect x="862" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="876" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">18</text>
  <rect x="893" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="907" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">25</text>
  <rect x="930" y="144" width="28" height="24" rx="4" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="944" y="160" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">31</text>
  <text x="674" y="182" font-size="10.5" fill="var(--ink-2, #545A64)">위층 인덱스로 건너뛰다 내려온다. 탐색 평균 O(log n).</text>
  <line x1="0" y1="322" x2="980" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="342" font-size="11" fill="var(--ink-3, #8B9099)">작을 때는 배열처럼 이어 붙인 ListPack, 커지면 HashTable 이나 SkipList 로 갈아탑니다. 경계값은 설정으로 바꿀 수 있어요.</text>
  <text x="0" y="360" font-size="11" fill="var(--ink-3, #8B9099)">7.0 부터 ZipList 가 ListPack 으로 바뀌었습니다. 예전 자료의 length / free 는 지금 SDS 에서 len / alloc 입니다.</text>
</svg>
</div>
<p class="diagram-note">왼쪽 화살표가 엇갈리는 게 핵심입니다. 자료형과 인코딩은 1:1이 아니에요. 같은 Hash라도 작으면 ListPack, 커지면 HashTable 로 돌아갑니다.</p>

### 크기에 따라 갈아탑니다

`OBJECT ENCODING` 으로 직접 확인할 수 있습니다. 기본 경계값은 이래요. (전부 Redis 문서의 기본값이고 제가 잰 값이 아닙니다.)

| 자료형 | 작을 때 | 넘어가면 | 경계 설정 |
|---|---|---|---|
| String | `int` / `embstr` | `raw` (SDS) | `embstr` 은 44 바이트까지 |
| Hash | `listpack` | `hashtable` | `hash-max-listpack-entries 128` · `-value 64` |
| Set | `intset` / `listpack` | `hashtable` | `set-max-intset-entries 512` · `set-max-listpack-entries 128` |
| Sorted Set | `listpack` | `skiplist` | `zset-max-listpack-entries 128` · `-value 64` |
| List | `listpack` | `quicklist` | `list-max-listpack-size -2` (노드당 8KB) |

이 설계의 논리는 단순합니다. **요소가 적으면 해시 테이블의 오버헤드가 데이터보다 큽니다.** 필드 세 개짜리 해시에 버킷 배열과 포인터를 깔면 배보다 배꼽이 커요. 그래서 작을 때는 그냥 메모리에 쭉 이어 붙인 `listpack` 을 쓰고 선형 탐색합니다. 세 개를 훑는 O(n)은 O(1)보다 빠르니까요.

### 스킵 리스트를 쓰는 이유

Sorted Set은 크면 `skiplist` 로 갑니다. 균형 이진 트리를 쓸 수도 있었을 텐데 스킵 리스트를 골랐어요.

이유가 몇 가지 있습니다. **구현이 훨씬 단순합니다** — 회전이 없고 확률로 층을 정하니 코드가 짧아요. 그리고 **범위 조회가 자연스럽습니다** — 맨 아래층이 그냥 정렬된 연결 리스트라, `ZRANGE` 나 `ZRANGEBYSCORE` 는 시작점을 찾고 옆으로 걸어가면 끝입니다.

[38번 글](/posts/38-redis-zset-waiting-queue-admission/)에서 대기열을 Sorted Set으로 만들고 `ZRANGEBYSCORE` 로 앞쪽을 잘라 입장시켰는데, 그게 이 구조 위에서 돈 거였습니다. 그때는 명령 이름만 알고 썼어요.

여기서도 다시 In-Memory 이야기로 돌아옵니다. 이 자료구조들이 전부 메모리 위에 있으니까 만들 수 있었던 겁니다. 디스크 위에 스킵 리스트와 인트셋과 리스트팩을 각각 얹으려면, 그 각각에 대해 페이지 배치와 크래시 복구를 설계해야 해요.

## [실무 적용 - 내 코드로 돌아오면]

이 글은 원리 정리라 코드를 고친 게 없습니다. 대신 예전 판단들에 근거가 붙었어요.

**1. Redis에 무엇을 둘지의 기준이 선명해졌습니다.** "빨라서" 가 아니라 "메모리 값을 낼 만큼 자주 읽히고 짧게 사는가" 입니다. [38번](/posts/38-redis-zset-waiting-queue-admission/)의 대기열은 맞고, 영구 원장은 아니에요.

**2. 커넥션 수는 Redis에게 부담이 아닙니다.** `epoll` 이 O(1)이니 커넥션이 늘어도 이벤트 루프가 느려지지 않아요. **부담은 명령의 무게입니다.** 이건 [33번 글](/posts/33-http-connection-pool-vs-keepalive/)에서 본 HTTP 커넥션 풀과 정반대의 감각이라 헷갈리기 쉬운 지점입니다.

**3. Lua를 보는 눈은 43번에서 바뀐 그대로입니다.** 커널이 O(1)로 골라줘도 그 뒤가 O(n)이면 소용없다는 게, 왜 스크립트를 상수 시간으로 유지해야 하는지의 이유예요.

**4. `OBJECT ENCODING` 을 확인하는 습관이 생겼습니다.** 메모리가 예상보다 클 때, 컬렉션이 경계값을 넘어 인코딩이 바뀌었을 가능성을 먼저 봅니다.

## [결론]

"Redis는 왜 빠른가" 의 답은 두 개인데, 결국 한 문장으로 모입니다.

**데이터는 메모리에 두고, 소켓은 커널에게 한 번만 묻는다.**

앞의 절반은 디스크와의 세 자릿수 차이를 통째로 건너뛰는 거고, 뒤의 절반은 커넥션 1만 개를 스레드 하나로 감당하는 겁니다. 그리고 뒤의 절반이 성립하기 때문에 락도 컨텍스트 스위치도 없앨 수 있었고, 그 단순함이 다시 자료구조를 여러 개 둘 여유를 만들었어요.

43번에서 "병목이 CPU가 아니라서 싱글 스레드로 충분하다" 고 썼는데, 이번에 그 문장의 밑을 보고 나니 순서가 반대였습니다. **`epoll` 같은 것이 있어서 싱글 스레드가 가능했고**, 싱글 스레드라서 나머지 설계가 단순해진 거예요.

한계도 적어둘게요.

첫째, **측정이 없습니다.** `select` 와 `epoll` 을 직접 비교해본 적이 없어요. 위 그래프는 libevent 문서에 실린 것을 다시 그린 것이고 제 환경의 값이 아닙니다.

둘째, **커널 코드를 읽지 않았습니다.** `epoll` 이 레드블랙 트리와 준비 목록을 쓴다는 건 문서와 해설을 통해 아는 것이지, `fs/eventpoll.c` 를 열어본 게 아니에요.

셋째, **`io_uring` 을 다루지 않았습니다.** 이 글의 모델들은 전부 "준비됐는지 알려주는" 방식인데, `io_uring` 은 "완료되면 알려주는" 쪽입니다. 다른 계열이라 여기에 섞지 않았어요.

넷째, **자료구조는 겉모양만 봤습니다.** `listpack` 의 실제 바이트 레이아웃이나 `quicklist` 의 압축 옵션까지는 안 들어갔습니다. 인코딩이 갈아타는 원리와 그 이유까지만 정리했어요.
