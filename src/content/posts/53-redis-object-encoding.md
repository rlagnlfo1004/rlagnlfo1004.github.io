---
title: "같은 타입인데 인코딩이 조용히 바뀝니다 (Redis Object 와 내부 인코딩)"
description: "String, List, Set, Hash, Sorted Set 이 메모리 안에서 어떤 모습으로 담기는지, 그리고 왜 조용히 다른 구조로 갈아타는지 봤습니다. 공유 정수 풀, embstr 44바이트의 유래, quicklist 파라미터, 되돌아오지 않는 승격까지 소스 레벨로 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "자료구조", "CS", "인코딩", "메모리", "면접"]
draft: false
---

## [배경 - 자료구조 서버라고 부르면서 건너뛴 것]

[43번 글](/posts/43-redis-io-model-internals/)에서 이벤트 루프를, [47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 데이터가 메모리에 산다는 사실을 봤습니다. 그런데 두 글 모두 "Redis 는 자료구조 서버"라는 문장을 아무렇지 않게 쓰고 넘어갔어요. 정작 그 자료구조가 메모리에 **어떤 모습으로** 담기는지는 한 번도 열어보지 않았습니다.

면접용으로 자료구조를 손으로 정리하다가 이상한 걸 발견했어요. 같은 `Hash` 인데 필드가 열 개일 때와 만 개일 때 내부 구현이 다르다는 겁니다. `SET` 에 숫자를 넣으면 문자열이 아니라 정수로 저장된다는 것도요. 그러니까 Redis 의 타입은 겉면이고, 그 아래에 **인코딩**이라는 층이 하나 더 있었습니다.

이 층을 모르면 두 가지에서 헤맵니다. 하나는 메모리 산정이에요. "String 하나에 몇 바이트?"라는 질문의 답이 값에 따라 몇 배씩 달라집니다. 다른 하나는 지연입니다. 작은 컬렉션은 배열 위에서 O(n) 으로 도는데, 그 n 이 커지는 순간 [43번 글](/posts/43-redis-io-model-internals/)에서 본 직렬 구간을 붙잡아요. 결국 인코딩은 성능과 메모리를 동시에 건드리는 층입니다.

미리 밝혀둘게요. 이 글에는 제가 잰 숫자가 없습니다. 나오는 값은 Redis 소스의 상수이거나 기본 설정값이고, 각각 어느 쪽인지 표시해뒀어요.

## [문제 상황 분석 - 타입과 인코딩은 다른 층이다]

### 모든 값은 robj 로 감싸진다

Redis 에 무엇을 넣든, 그 값은 곧장 저장되지 않습니다. `redisObject`(줄여서 robj)라는 봉투에 한 번 담깁니다. 이 봉투가 **타입**(String, List, Set, Hash, Sorted Set)과 **인코딩**을 따로 들고 있어요.

<svg class="diagram" viewBox="0 0 720 208" role="img" aria-label="redisObject 가 type, encoding, 실제 데이터 포인터를 감싸는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">겉으로 보이는 타입 아래에, 실제로 어떻게 담을지 정하는 encoding 이 따로 있다</text>
  <rect x="40" y="44" width="300" height="132" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="60" y="70" font-size="12" font-weight="700" fill="var(--ink, #16181A)">redisObject</text>
  <rect x="60" y="82" width="260" height="26" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="72" y="99" font-size="11.5" fill="var(--clay-text, #1B64DA)">type</text>
  <text x="308" y="99" font-size="11.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">OBJ_HASH</text>
  <rect x="60" y="112" width="260" height="26" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="72" y="129" font-size="11.5" fill="var(--clay-text, #1B64DA)">encoding</text>
  <text x="308" y="129" font-size="11.5" text-anchor="end" fill="var(--clay-text, #1B64DA)">listpack | hashtable</text>
  <rect x="60" y="142" width="260" height="26" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="72" y="159" font-size="11.5" fill="var(--ink-2, #545A64)">ptr</text>
  <text x="308" y="159" font-size="11.5" text-anchor="end" fill="var(--ink-3, #8B9099)">실제 자료구조로</text>
  <defs>
    <marker id="d53a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="340" y1="155" x2="470" y2="155" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d53a)"/>
  <rect x="474" y="120" width="206" height="70" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="577" y="150" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">listpack</text>
  <text x="577" y="170" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">작을 때의 실제 저장</text>
</svg>

`OBJECT ENCODING <key>` 명령으로 지금 이 순간 어떤 인코딩인지 직접 확인할 수 있어요. 같은 키인데도 값이 커지면 이 응답이 바뀝니다. 그리고 robj 에는 눈에 잘 안 띄는 필드가 하나 더 있는데, 바로 `lru` 입니다. 이 필드가 뒤에서 볼 공유 정수 이야기와 eviction 을 이어주는 열쇠예요.

### 왜 굳이 인코딩을 나눌까

이유는 하나입니다. **작을 때는 메모리를 아끼고, 커지면 속도를 지키려는** 거예요. 원소가 몇 개 안 되는데 해시 테이블을 통째로 잡으면 포인터와 버킷 오버헤드가 데이터보다 커집니다. 그래서 작을 때는 배열 하나에 촘촘히 눕혀두고, 원소가 많아져서 그 방식이 느려지는 순간 확장성 좋은 구조로 갈아탑니다. 정확히는 이 갈아타기가 타입마다 다르게 정의돼 있어요.

### 정수는 아예 공유해버립니다

인코딩 이야기를 하기 전에 메모리를 아끼는 또 다른 장치를 봐야 해요. Redis 는 자주 쓰는 작은 정수, 그러니까 0 부터 9999 까지를 서버가 뜰 때 미리 만들어두고 **공유**합니다(`OBJ_SHARED_INTEGERS`, 기본 1만 개). `SET a 100`, `SET b 100` 을 하면 두 키가 각자 100 을 들지 않고 같은 공유 robj 를 refcount 로 가리켜요. 카운터가 널려 있는 서비스에서 이게 꽤 큰 절약입니다.

그런데 여기 함정이 있어요. `maxmemory` 를 걸고 eviction 정책을 LRU 나 LFU 로 두면, 키마다 마지막 접근 시각이나 접근 빈도를 robj 의 `lru` 필드에 따로 새겨야 합니다. 공유 객체는 여러 키가 함께 가리키니 그 키별 정보를 담을 자리가 없어요. 그래서 **LRU/LFU 를 켜는 순간 공유 정수가 비활성화됩니다.** 메모리를 아끼려고 eviction 을 켰는데 정수 공유가 꺼져서 오히려 정수 키가 무거워지는, 방향이 어긋나는 상황이 여기서 나옵니다. 이걸 알고 나면 "정수 하나 몇 바이트"라는 질문에 "정책에 따라 다릅니다"라고 답하게 돼요.

## [String - int, embstr, raw]

String 은 가장 단순해 보이지만 안에서 세 갈래로 갈립니다. 그 전에 바탕이 되는 구조체부터 봐야 해요. Redis 의 문자열은 C 의 널 종료 문자열이 아니라 **SDS**(Simple Dynamic String)입니다.

SDS 가 C 문자열과 다른 지점은 세 가지예요.

- 길이를 헤더에 들고 있습니다. 그래서 `STRLEN` 이 O(1) 이에요. C 의 `strlen` 은 끝까지 세느라 O(N) 이고요.
- 여유 공간을 미리 잡아둡니다. `APPEND` 할 때마다 매번 재할당하지 않아요.
- 길이 기반이라 중간에 널 바이트가 있어도 잘리지 않습니다. 이걸 Binary Safe 라고 부르고, 덕분에 JPEG 든 직렬화된 객체든 그대로 담깁니다.

이 바탕 위에서 String 의 인코딩이 정해집니다.

<svg class="diagram" viewBox="0 0 720 210" role="img" aria-label="String 값이 int, embstr, raw 세 인코딩으로 갈리는 분기">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">SET 한 값이 무엇이고 얼마나 긴가에 따라 세 갈래로 담긴다</text>
  <rect x="286" y="34" width="148" height="34" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="360" y="55" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">SET 한 값</text>
  <defs>
    <marker id="d53b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="360" y1="68" x2="140" y2="110" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d53b)"/>
  <line x1="360" y1="68" x2="360" y2="110" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d53b)"/>
  <line x1="360" y1="68" x2="580" y2="110" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d53b)"/>
  <rect x="60" y="112" width="160" height="76" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="140" y="138" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">int</text>
  <text x="140" y="160" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">정수로 파싱되면</text>
  <text x="140" y="175" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">long 으로 저장</text>
  <rect x="280" y="112" width="160" height="76" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="360" y="138" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">embstr</text>
  <text x="360" y="160" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">44 바이트 이하</text>
  <text x="360" y="175" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">robj 와 한 덩어리</text>
  <rect x="500" y="112" width="160" height="76" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="580" y="138" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">raw</text>
  <text x="580" y="160" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">44 바이트 초과</text>
  <text x="580" y="175" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">SDS 를 따로 할당</text>
</svg>

`44 바이트`라는 경계는 제가 정한 게 아니라 Redis 소스의 상수입니다(`OBJ_ENCODING_EMBSTR_SIZE_LIMIT`). 이 숫자가 왜 하필 44 인지가 재미있어요. embstr 은 robj 와 문자열 버퍼(SDS)를 **한 번의 할당으로** 붙여 담습니다. robj 헤더와 SDS 헤더, 널 종료 한 바이트까지 다 합쳤을 때 그 덩어리가 메모리 할당기(jemalloc)의 64바이트짜리 작은 청크 안에 딱 들어가는 문자열 길이의 상한이 44 예요. 그러니까 44 는 "한 번 할당으로 캐시 지역성 좋게 담을 수 있는 최대 길이"를 할당기 사정에 맞춰 역산한 값입니다.

여기서 실무에서 자주 놓치는 두 가지가 나와요. 첫째, **embstr 은 사실상 읽기 전용 취급**입니다. `APPEND` 나 `SETRANGE` 로 조금이라도 고치면 크기와 상관없이 곧장 raw 로 강등돼요. 짧은 문자열이라 embstr 인데 거기에 계속 `APPEND` 를 때리면, 그 순간 raw 로 바뀌고 다시는 embstr 로 돌아오지 않습니다. 둘째, **int 인코딩도 문자열 연산이 닿으면 raw 로 풀립니다.** `SET n 100` 은 int 로 담기지만 거기에 `APPEND n "abc"` 를 하면 숫자로서의 이점이 사라지고 raw 문자열이 돼요. `INCR`, `DECR` 이 빠른 건 int 인코딩 위에서 파싱 없이 바로 더하기 때문인데, 이 형태를 깨는 연산을 섞으면 그 이점을 스스로 버리는 셈입니다.

## [List - quicklist]

List 는 양끝 삽입과 삭제가 O(1) 인 시퀀스입니다. 큐와 스택이 여기서 나와요. 그런데 내부 구현을 "연결 리스트"라고만 외우면 반쪽입니다.

순수 연결 리스트는 원소마다 앞뒤 포인터를 답니다. 원소가 많아지면 그 포인터들이 데이터만큼 메모리를 먹어요. 그래서 지금의 Redis 는 **quicklist** 를 씁니다. listpack 이라는 작은 배열 조각들을 이중 연결한 하이브리드예요. 조각 안에서는 포인터 없이 촘촘하게, 조각과 조각 사이만 연결로 잇습니다. 덕분에 양끝 O(1) 은 지키면서 포인터 낭비를 줄여요. 아주 작은 List 는 조각 하나(listpack)로만 존재하기도 합니다.

이 조각의 크기를 정하는 게 `list-max-listpack-size` 입니다(예전 이름은 `list-max-ziplist-size`). 값을 읽는 규칙이 조금 특이해요.

- **양수**면 노드 하나에 담을 **엔트리 개수**를 뜻합니다. 128 이면 조각마다 원소 128 개까지예요.
- **음수**면 노드 하나의 **바이트 상한**을 뜻하고, 기본값 `-2` 는 조각당 8KB 입니다(그 외 -1 은 4KB, -3 은 16KB 식으로 커집니다).

기본이 바이트 기준(`-2`, 8KB)인 이유는, 원소 크기가 제각각일 때 개수로 자르면 어떤 조각은 너무 크고 어떤 조각은 너무 작아지기 때문이에요. 바이트로 자르면 조각 크기가 고르게 유지됩니다. 여기에 `list-compress-depth` 를 켜면 양 끝 몇 개 노드만 남기고 가운데 노드들을 LZF 로 압축해요. 큐처럼 양끝만 자주 건드리고 가운데는 잠자는 워크로드라면, 이 압축으로 메모리를 더 줄일 수 있습니다. 기본값은 0 이라 압축이 꺼져 있어요.

## [Set - intset, listpack, hashtable]

Set 은 중복 없는 컬렉션이고, 멤버가 있는지 확인하는 `SISMEMBER` 가 O(1) 이라 "봤음, 안 봤음" 판정에 강합니다. 인코딩은 세 단계예요.

- 멤버가 전부 정수이고 개수가 적으면 **intset** 입니다. 정렬된 정수 배열이라 이진 탐색으로 찾아요(O(log n)). 개수 상한은 `set-max-intset-entries` 이고 기본값은 512 입니다.
- 정수가 아닌 작은 멤버가 섞이면 **listpack** 으로 담깁니다. 7.2 부터 들어온 경로예요. 개수 상한은 `set-max-listpack-entries`, 기본값 128 입니다.
- 커지거나 문자열이 많이 섞이면 **hashtable** 로 승격합니다.

여기서 조심할 지점이 하나 있어요. intset 은 정수 전용이라, **정수만 담긴 Set 에 문자열 멤버를 딱 하나 넣는 순간** 전체가 listpack 이나 hashtable 로 갈아탑니다. 개수는 그대로여도 형태가 바뀌는 거예요. `SINTER`, `SUNION`, `SDIFF` 로 교집합, 합집합, 차집합을 서버에서 바로 계산할 수 있는데, 큰 Set 에 이걸 때리면 그 시간만큼 이벤트 루프가 멈춥니다. 이 위험은 [47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 본 싱글 스레드 특성과 같은 뿌리예요.

## [Hash - listpack, hashtable]

Hash 는 필드와 값의 묶음이라 객체를 통째로 직렬화하지 않고 **필드 단위로 부분 접근**할 수 있어요. 작을 때는 listpack, 커지면 hashtable 입니다. 승격 임계값은 두 개예요.

- `hash-max-listpack-entries` 기본값 128 (필드 개수)
- `hash-max-listpack-value` 기본값 64 (한 값의 바이트)

둘 중 하나라도 넘으면 hashtable 로 갑니다. 그리고 7.0 부터 이 작은 인코딩의 이름이 ziplist 에서 listpack 으로 바뀌었어요. 예전 글이나 문서에서 ziplist 를 보면 지금의 listpack 이라고 읽으면 됩니다. 참고로 7.4 부터는 `HEXPIRE` 로 **필드마다 TTL** 을 걸 수 있게 됐는데, 예전에는 키 전체에만 만료를 걸 수 있었던 제약이 풀린 겁니다.

hashtable 로 올라간 뒤에도 눈에 안 보이는 일이 하나 더 벌어져요. Redis 의 딕셔너리는 커질 때 **점진적 리해싱**을 합니다. 새 해시 테이블을 옆에 만들어두고, 이후 들어오는 명령마다 버킷을 조금씩 옮겨요. 한 번에 전부 옮기면 그 순간 서버가 멈추니까, 그 비용을 여러 명령에 잘게 나눠 분산하는 겁니다. 이것도 [43번 글](/posts/43-redis-io-model-internals/)에서 본 "직렬 구간을 짧게 유지한다"는 철학의 연장이에요.

## [Sorted Set - listpack, skiplist + hashtable]

Sorted Set 은 이번 글에서 가장 재미있는 타입입니다. 멤버마다 score 라는 실수를 붙여 자동 정렬하는데, 큰 경우에 **두 자료구조를 동시에** 들고 있어요.

<svg class="diagram" viewBox="0 0 720 236" role="img" aria-label="Sorted Set 이 hashtable 과 skiplist 두 구조를 동시에 유지하는 그림">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">멤버로 점수를 찾을 때와, 점수 순으로 범위를 훑을 때를 각각 빠르게 한다</text>
  <rect x="40" y="44" width="300" height="170" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="60" y="70" font-size="12" font-weight="700" fill="var(--ink, #16181A)">hashtable</text>
  <text x="60" y="88" font-size="10.5" fill="var(--ink-3, #8B9099)">멤버 → score 를 O(1) 로</text>
  <rect x="60" y="100" width="260" height="26" rx="6" fill="var(--sunk, #F1F3F6)"/>
  <text x="72" y="117" font-size="11" fill="var(--ink-2, #545A64)">"user:A"</text>
  <text x="308" y="117" font-size="11" text-anchor="end" fill="var(--ink, #16181A)">1500</text>
  <rect x="60" y="132" width="260" height="26" rx="6" fill="var(--sunk, #F1F3F6)"/>
  <text x="72" y="149" font-size="11" fill="var(--ink-2, #545A64)">"user:B"</text>
  <text x="308" y="149" font-size="11" text-anchor="end" fill="var(--ink, #16181A)">980</text>
  <rect x="60" y="164" width="260" height="26" rx="6" fill="var(--sunk, #F1F3F6)"/>
  <text x="72" y="181" font-size="11" fill="var(--ink-2, #545A64)">"user:C"</text>
  <text x="308" y="181" font-size="11" text-anchor="end" fill="var(--ink, #16181A)">2100</text>
  <rect x="380" y="44" width="300" height="170" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="400" y="70" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">skiplist</text>
  <text x="400" y="88" font-size="10.5" fill="var(--clay-text, #1B64DA)">score 순서로 O(log N) 범위 조회</text>
  <text x="392" y="116" font-size="9" fill="var(--clay-text, #1B64DA)">상위</text>
  <text x="392" y="154" font-size="9" fill="var(--clay-text, #1B64DA)">하위</text>
  <line x1="424" y1="112" x2="636" y2="112" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.75"/>
  <circle cx="430" cy="112" r="5" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.5"/>
  <circle cx="628" cy="112" r="5" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.5"/>
  <line x1="424" y1="150" x2="660" y2="150" stroke="var(--clay, #3182F6)" stroke-width="1.4"/>
  <g>
    <circle cx="430" cy="150" r="6" fill="var(--clay, #3182F6)"/><text x="430" y="176" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">980</text>
    <circle cx="528" cy="150" r="6" fill="var(--clay, #3182F6)"/><text x="528" y="176" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">1500</text>
    <circle cx="628" cy="150" r="6" fill="var(--clay, #3182F6)"/><text x="628" y="176" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">2100</text>
  </g>
  <line x1="430" y1="117" x2="430" y2="144" stroke="var(--clay, #3182F6)" stroke-width="1" opacity="0.5"/>
  <line x1="628" y1="117" x2="628" y2="144" stroke="var(--clay, #3182F6)" stroke-width="1" opacity="0.5"/>
  <text x="400" y="205" font-size="10" fill="var(--clay-text, #1B64DA)">상위 레벨 포인터로 1500 을 건너뛰어 O(log N)</text>
</svg>

`ZSCORE` 처럼 "이 멤버 점수 얼마야"는 hashtable 이 O(1) 로 답하고, `ZRANGE` 처럼 "1등부터 10등까지"는 skiplist 가 정렬을 유지한 덕에 O(log N) 로 훑어요. 두 구조가 같은 멤버와 점수를 각자의 방식으로 들고 있으니 메모리는 더 쓰지만, 서로 다른 두 질의를 모두 빠르게 만드는 값입니다. 균형 이진 트리 대신 skiplist 를 쓰는 이유는 세 가지예요. 구현이 단순해서 버그가 적고, 범위 스캔이 리스트를 따라가기만 하면 되어 자연스럽고, 노드마다 레벨을 확률로 정해서 회전 없이 균형이 유지되기 때문입니다. 작을 때는 물론 listpack 하나로 버티고, `zset-max-listpack-entries` 기본값 128 을 넘으면 이 두 구조 조합으로 승격해요. 이 타입을 실제로 대기열에 써먹은 이야기는 [38번 글](/posts/38-redis-zset-waiting-queue-admission/)에 있습니다.

## [정리 - 승격은 한 방향이다]

임계값을 표로 모으면 이렇습니다. 값은 모두 Redis 기본 설정값이에요.

| 타입 | 작을 때 | 커지면 | 승격 기준 (기본값) |
| --- | --- | --- | --- |
| String | int / embstr | raw | 44 바이트 초과, 또는 문자열 연산 |
| List | listpack | quicklist | list-max-listpack-size (-2, 8KB) |
| Set | intset / listpack | hashtable | intset 512, listpack 128 |
| Hash | listpack | hashtable | entries 128, value 64B |
| Sorted Set | listpack | skiplist + hashtable | zset-max-listpack-entries 128 |

여기서 꼭 기억할 게 하나 있어요. 이 승격은 **한 방향**입니다. 한번 hashtable 로 올라간 Hash 는 필드를 다시 지워서 작아져도 listpack 으로 되돌아오지 않아요. 왜 되돌리지 않을까요. 되돌리려면 명령마다 "지금 작아졌나?"를 확인해야 하고, 임계값 근처에서 값이 오르내리면 무거운 변환이 계속 왕복하며 오히려 지연을 만듭니다. 그래서 Redis 는 한 번 올라가면 그냥 그 상태로 둡니다.

실무에서 이게 조용한 메모리 누수처럼 보일 때가 있어요. 예를 들어 필드가 평소 100 개인 Hash 가 어떤 배치 작업 때문에 잠깐 129 개까지 부풀었다고 해봅시다. 그 순간 hashtable 로 승격하고, 배치가 끝나 다시 100 개로 줄어도 인코딩은 hashtable 그대로예요. listpack 시절보다 몇 배 무거운 메모리를 그 뒤로 계속 씁니다. "잠깐 크게 부풀렸다가 줄이면 되겠지"라는 접근이 통하지 않는 이유가 이거예요.

버릴 뻔한 접근이 하나 있었습니다. 임계값을 크게 올려서 무조건 listpack 을 유지하면 메모리가 절약될 것 같았어요. 그런데 listpack 은 조회가 선형(O(n))이라, 원소가 많아지면 그 순회가 이벤트 루프를 잡습니다. 결과적으로 메모리를 아끼려다 지연을 키우는 셈이라, 기본값을 크게 벗어나지 않는 편이 안전했어요.

## [실무 적용 - 인코딩을 의식하는 규칙]

정리하면 규칙은 "인코딩이 조용히 바뀐다는 걸 잊지 않는다"로 모입니다.

**1. 임계값을 함부로 올리지 않습니다.** listpack 을 오래 유지하려고 `hash-max-listpack-entries` 를 크게 잡으면, 그 컬렉션의 조회가 O(n) 으로 길어져 직렬 구간을 붙잡아요. 메모리와 지연은 맞바꾸는 관계라, 기본값에는 이유가 있습니다.

**2. 큰 키를 정기적으로 관찰합니다.** `redis-cli --bigkeys` 로 타입별로 가장 큰 키를 훑고, 의심되는 키는 `OBJECT ENCODING` 과 `MEMORY USAGE` 로 실제 인코딩과 바이트를 확인해요. 승격이 일어난 키를 눈으로 봐야 대응할 수 있습니다.

**3. 순간 스파이크를 경계합니다.** 배치나 이관 작업이 컬렉션을 잠깐 부풀리면 그게 영구적인 무거운 인코딩으로 남아요. 크게 만들 일이 있으면 아예 별도 키로 처리하고 끝나면 지우는 편이, 살아 있는 키를 부풀렸다 줄이는 것보다 안전합니다.

**4. 큰 값은 쪼개거나 밖으로 뺍니다.** 값 하나가 커서 raw 로 가거나 컬렉션이 hashtable/skiplist 로 올라가면, 그 직렬화 비용이 전부 직렬 구간이에요. 이미지나 큰 문서는 Redis 밖(오브젝트 스토리지 등)에 두고 Redis 에는 참조만 담는 쪽을 먼저 생각합니다.

**5. 카운터는 정수 형태를 지킵니다.** `INCR` 로 도는 카운터에 문자열 연산을 섞지 않으면 int 인코딩이 유지돼요. 공유 정수 풀의 이점도 여기서 살아나는데, 다만 eviction 정책을 켜면 그 공유가 꺼진다는 걸 함께 기억해야 합니다.

## [결론]

Redis 의 타입은 계약이고, 인코딩은 그 계약을 지키는 방식이었습니다. 작을 때 촘촘히 담고 커질 때 갈아타는 이 구조 덕분에 같은 명령이 상황에 따라 다른 비용을 냅니다. 그리고 그 갈아타기가 한 방향이라, 한 번 커진 흔적은 메모리에 남아요.

제 눈이 바뀐 지점은 "String 하나 몇 바이트"라는 질문을 대하는 태도였습니다. 예전에는 값의 길이만 생각했는데, 이제는 정수인지 문자열인지, 어떤 연산이 닿았는지, eviction 정책이 켜져 있는지까지 따지게 됐어요. 인코딩은 겉으로 안 보이지만 성능과 메모리를 동시에 정하는 층이었습니다.

남은 한계를 적어둘게요. 이 글의 임계값은 전부 기본값이고 버전과 설정에 따라 달라집니다. 그리고 저는 각 인코딩에서 실제로 메모리가 얼마나 차이 나는지 재보지 않았어요. 특히 공유 정수를 켜고 끌 때의 차이, 순간 스파이크로 승격된 Hash 가 얼마나 더 먹는지는 숫자로 확인해야 설득력이 생깁니다. 다음에는 `MEMORY USAGE` 로 같은 데이터를 인코딩별로 담아 실제 바이트를 재보려고 해요. 그때는 인용값이 아니라 제가 잰 숫자로 이 글을 보강할 수 있을 겁니다.

<!-- 측정 필요: 동일 데이터를 listpack vs hashtable 로 담고 MEMORY USAGE 비교, 공유 정수 on/off 시 정수 키 메모리 차이, 스파이크 승격 후 잔존 메모리 -->
