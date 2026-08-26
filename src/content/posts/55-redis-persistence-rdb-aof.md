---
title: "메모리는 껐다 켜면 사라집니다 (RDB, AOF, 그리고 하이브리드)"
description: "Redis 영속화는 스냅샷과 명령 로그 중 무엇을 고르느냐로 끝나지 않습니다. fork 가 서버를 멈추는 순간, everysec 가 디스크를 기다리는 구간, 저장 실패가 쓰기를 막는 기본값까지, 영속화가 직렬 구간과 만나는 지점을 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "영속화", "RDB", "AOF", "fork", "CS", "면접"]
draft: false
---

## [배경 - 캐시라고만 생각했다가]

저는 Redis 를 오래 캐시로만 썼어요. 캐시니까 사라져도 그만이라고 여겼고, 그래서 영속화 설정을 열어본 적이 없었어요. 그런데 대기열이나 카운터처럼 잠깐이라도 잃으면 곤란한 값을 Redis 에 두기 시작하면서 질문이 생겼어요. **이 프로세스가 재시작되면 지금 메모리에 있는 건 어떻게 되지.**

[47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 데이터가 메모리에 산다는 걸 강점으로만 봤는데, 메모리는 껐다 켜면 사라지는 층이기도 해요. 그래서 처음에는 이 글을 "RDB 냐 AOF 냐"의 선택 문제로 잡았습니다. 그런데 파고들수록 진짜 주제는 다른 데 있었습니다. **영속화를 켜는 순간 그 비용이 [43번 글](/posts/43-redis-io-model-internals/)에서 본 그 직렬 구간으로 들어온다**는 거예요. 저장이 도는 동안, fsync 를 기다리는 동안, 서버 전체가 그만큼 붙잡힙니다.

미리 밝혀둘게요. **이 글에는 제가 잰 숫자가 없습니다.** 나오는 값은 Redis 의 기본 설정값이거나 소스에 정의된 상수이고, 그렇다는 걸 표시해뒀어요.

## [문제 상황 분석 - 두 개의 축을 하나로 뭉쳐 봤다]

처음에 저는 "영속화"를 한 덩어리로 봤어요. 그런데 여기엔 성격이 다른 두 축이 섞여 있습니다.

하나는 **재시작 회복력**입니다. 이 프로세스를 내렸다 다시 올릴 때 메모리를 어디서 되살릴까의 문제예요. RDB 와 AOF 가 푸는 게 이쪽이에요. 다른 하나는 **노드가 통째로 죽었을 때의 내구성**이고, 이건 디스크 파일이 아니라 다른 노드에 사본을 두는 복제가 맡아요([54번 글](/posts/54-redis-replication-sentinel-cluster/)). 이 글은 앞쪽, 그러니까 한 노드가 자기 디스크로 상태를 어떻게 내려두느냐에 집중합니다. 그리고 이 "디스크로 내려두는" 행위가 공짜가 아니라는 게 이 글의 뒷부분 전체예요.

디스크로 내려두는 방법은 크게 둘이에요. 하나는 지금 이 순간의 **상태**를 통째로 사진 찍는 방식(RDB)이고, 하나는 상태에 이르기까지의 **과정**, 즉 들어온 쓰기 명령을 계속 적어두는 방식(AOF)이에요. 이 둘의 성격이 정반대라 선택의 축이 분명해져요. 복구가 빠른 대신 손실 구간이 크거나, 손실 구간이 작은 대신 복구가 느리거나예요.

## [RDB - 한 장의 스냅샷과 fork 의 대가]

RDB 는 메모리 전체를 하나의 이진 파일(`dump.rdb`)로 떠서 저장해요. 저장을 트리거하는 방법이 몇 가지 있어요.

- `SAVE` 는 동기 저장입니다. 저장하는 동안 서버가 멈춥니다. 그래서 운영 환경에서는 거의 쓰지 않아요.
- `BGSAVE` 는 자식 프로세스를 `fork` 해서 백그라운드로 저장해요. 메인은 계속 요청을 받습니다.
- `save 900 1` 같은 규칙을 두면 조건이 맞을 때 자동으로 BGSAVE 가 돌아요.

BGSAVE 가 메인을 멈추지 않고도 일관된 스냅샷을 뜨는 비결이 Copy-on-Write 예요.

<svg class="diagram" viewBox="0 0 720 236" role="img" aria-label="fork 이후 부모와 자식이 페이지를 공유하다가 부모가 쓰는 순간 그 페이지만 복제되는 Copy-on-Write">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">fork 직후엔 페이지를 공유하고, 부모가 고치는 페이지만 그때 복제한다</text>
  <rect x="40" y="44" width="150" height="40" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="115" y="69" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">부모 (메인)</text>
  <rect x="530" y="44" width="150" height="40" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="605" y="69" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">자식 (BGSAVE)</text>
  <defs>
    <marker id="d55a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="115" y1="84" x2="270" y2="128" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d55a)"/>
  <line x1="605" y1="84" x2="450" y2="128" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d55a)"/>
  <rect x="255" y="130" width="90" height="34" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="300" y="151" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">page A</text>
  <rect x="375" y="130" width="90" height="34" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="420" y="151" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">page B</text>
  <text x="360" y="185" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">공유 중인 물리 페이지</text>
  <rect x="255" y="196" width="90" height="30" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="300" y="216" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">page A'</text>
  <line x1="300" y1="164" x2="300" y2="194" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d55a)"/>
  <text x="470" y="216" font-size="10.5" fill="var(--clay-text, #1B64DA)">부모가 A 를 수정 → A 만 복제</text>
</svg>

`fork` 직후 부모와 자식은 같은 물리 페이지를 공유해요. 그러다 부모가 어떤 페이지를 수정하는 순간, 그 페이지만 복제됩니다. 덕분에 메모리를 통째로 복사하지 않고도 자식은 fork 시점의 일관된 이미지를 봐요. 여기까지가 흔히 아는 이야기예요.

### fork 는 순간이지만 공짜가 아니다

제가 처음에 놓쳤던 게 여기 있어요. `fork()` 그 자체가 순식간에 끝난다고 생각했습니다. 그런데 아닙니다. **fork 는 부모의 페이지 테이블을 자식에게 복사해야 하고, 이 시간은 데이터양이 아니라 페이지 테이블 크기, 즉 대략 인스턴스 메모리 크기에 비례합니다.** 메모리가 큰 인스턴스일수록 이 복사가 길어집니다. 그리고 이 순간만큼은 메인 스레드가 멈춥니다. 저장은 백그라운드로 도는데, 그 백그라운드를 만드는 fork 호출 자체가 앞단의 짧은 정지를 만드는 거예요.

이게 얼마나 걸렸는지는 `INFO stats` 의 `latest_fork_usec` 에 남아요. 큰 인스턴스에서 이 값이 밀리초 단위로 튀면, 그동안 모든 클라이언트가 대기했다는 뜻이에요. 43번에서 본 "직렬 구간을 짧게 유지한다"는 규칙이 여기서도 그대로 적용됩니다. 저장이라는 백그라운드 작업조차 그 시작점은 직렬 구간에 걸쳐 있어요.

### THP 를 끄라는 권고가 여기서 나온다

Copy-on-Write 에는 함정이 하나 더 있어요. 복제 단위가 페이지라는 점이에요. 리눅스 기본 페이지는 4KB 인데, THP(Transparent Huge Pages)가 켜져 있으면 이게 2MB 가 돼요. 그러면 부모가 4바이트짜리 값 하나만 고쳐도 그 값이 든 2MB 페이지를 통째로 복제합니다. 저장이 도는 동안 쓰기가 조금만 흩어져 있어도 복제되는 메모리가 폭증하고, 그 복제 비용이 지연으로 돌아옵니다.

그래서 Redis 는 기동할 때 THP 가 켜져 있으면 로그로 경고를 띄워요. 최악의 경우 저장 중 메모리가 순간적으로 크게 부풀 수 있는데, THP 는 그 최악을 더 나쁘게 만들어요. RDB 의 장점은 파일이 작고 로딩이 빠르다는 겁니다. 단점은 스냅샷과 스냅샷 사이에 죽으면 그 간격만큼 통째로 사라진다는 것, 그리고 방금 본 fork 의 대가예요.

### 저장이 실패하면 쓰기가 막힌다

운영에서 조용히 서비스를 멈추는 기본값이 하나 있어요. `stop-writes-on-bgsave-error` 예요. 기본값이 `yes` 입니다.

이 값이 켜져 있으면 **BGSAVE 가 한 번이라도 실패한 순간부터 모든 쓰기 명령이 거부돼요.** 디스크가 꽉 찼거나, 저장 디렉터리 권한이 틀렸거나, 스냅샷을 뜰 여유 메모리가 없거나 하는 이유로 저장이 실패하면, 그 뒤로 클라이언트는 쓰기 에러를 받기 시작해요. 캐시로만 쓰는 인스턴스에서 이걸 모르고 있다가 "왜 갑자기 쓰기가 안 되지"로 헤매는 경우가 흔합니다. Redis 가 이렇게 막는 이유는 분명해요. 저장이 안 되는데 쓰기를 계속 받으면, 다음에 죽었을 때 잃을 데이터가 계속 쌓이니까요. 다만 그 의도를 알고 있어야 디스크 여유를 감시할 생각을 하게 됩니다.

## [AOF - 쓰기 명령을 다 적는다]

AOF 는 상태 대신 과정을 남겨요. 들어온 쓰기 명령을 append-only 로그에 계속 적고, 재시작할 때 그 명령을 다시 실행해서 상태를 복원해요. 관건은 **언제 디스크에 실제로 내리느냐**, 즉 `fsync` 시점입니다. 세 가지 정책이 있어요.

| appendfsync | 언제 fsync | 성격 |
| --- | --- | --- |
| always | 명령마다 | 가장 안전하고 가장 느림 |
| everysec | 1초마다 | 균형, 최대 1초어치 손실 (권장) |
| no | OS 에 맡김 | 가장 빠르고 손실 위험이 큼 |

### everysec 가 "1초에 한 번"으로 끝나지 않는 이유

여기가 제가 표만 외우고 넘어갔던 지점입니다. everysec 는 "1초마다 fsync 하니 최대 1초 손실"이라고 정리하면 깔끔한데, 실제 동작은 한 겹 더 있어요.

`fsync` 는 디스크를 실제로 건드리는 블로킹 시스템 콜이라, 메인 스레드가 직접 하면 그동안 명령 처리가 멈춰요. 그래서 Redis 는 이걸 백그라운드 I/O 스레드(bio)에 넘겨요. 문제는 다음 초의 쓰기가 왔을 때 **직전 fsync 가 아직 안 끝나 있는 경우**입니다. 이때 메인 스레드는 새 데이터를 AOF 버퍼에 쓰기 전에 그 진행 중인 fsync 가 끝나길 기다리게 돼요. 디스크가 느리거나 순간적으로 바쁘면 바로 이 지점에서 Redis 지연이 튑니다.

<svg class="diagram" viewBox="0 0 720 210" role="img" aria-label="everysec 에서 직전 fsync 가 끝나기 전에 다음 쓰기가 오면 메인 스레드가 그 fsync 를 기다리는 구간">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">fsync 는 bio 스레드가 하지만, 직전 fsync 가 안 끝나면 메인이 그만큼 기다린다</text>
  <text x="20" y="48" font-size="11" font-weight="700" fill="var(--ink, #16181A)">메인</text>
  <line x1="60" y1="58" x2="690" y2="58" stroke="var(--rule, rgba(22,24,26,.15))" stroke-width="1"/>
  <rect x="70" y="46" width="120" height="24" rx="5" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="130" y="62" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">명령 처리</text>
  <rect x="380" y="46" width="150" height="24" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/>
  <text x="455" y="62" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">fsync 끝나길 대기 (정지)</text>
  <rect x="540" y="46" width="140" height="24" rx="5" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="610" y="62" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">다시 명령 처리</text>
  <text x="20" y="118" font-size="11" font-weight="700" fill="var(--ink, #16181A)">bio</text>
  <line x1="60" y1="128" x2="690" y2="128" stroke="var(--rule, rgba(22,24,26,.15))" stroke-width="1"/>
  <rect x="250" y="116" width="280" height="24" rx="5" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/>
  <text x="390" y="132" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">느린 fsync 가 디스크를 붙잡고 있음</text>
  <line x1="455" y1="70" x2="455" y2="116" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="3 3"/>
  <text x="70" y="175" font-size="10.5" fill="var(--ink-3, #8B9099)">디스크가 빠르면 이 대기 구간은 거의 0 이고, 느리면 여기서 지연이 튄다</text>
  <text x="70" y="193" font-size="10.5" fill="var(--ink-3, #8B9099)">no-appendfsync-on-rewrite 는 리라이트 중 이 fsync 를 생략해 지연을 줄인다 (유실 위험 증가)</text>
</svg>

그래서 `no-appendfsync-on-rewrite` 라는 설정이 있습니다. BGREWRITEAOF 가 도는 동안에는 디스크가 특히 바빠지는데, 이 값을 켜면 그 시간 동안 fsync 를 잠깐 생략해서 지연을 줄입니다. 대신 그 구간에 죽으면 유실이 커져요. 지연을 살 것이냐 안전을 지킬 것이냐의 저울질이 여기서도 반복돼요.

### 로그가 자라면 다시 쓴다

로그는 시간이 지날수록 계속 자랍니다. 조회수를 100 번 올렸으면 `INCR` 이 100 줄 쌓이는 식이에요. 그래서 `BGREWRITEAOF` 로 **지금 상태를 만드는 최소 명령 집합**으로 다시 씁니다. 100 줄이 `SET count 100` 한 줄로 압축되는 셈이죠. 이 리라이트도 RDB 처럼 자식 프로세스를 `fork` 해서 도니까, 앞에서 본 fork 의 대가가 똑같이 붙습니다. 리라이트가 도는 동안 들어온 새 쓰기는 부모가 따로 버퍼(AOF rewrite buffer)에 모아뒀다가, 자식이 끝나면 새 파일 뒤에 이어 붙여요. AOF 는 손실 구간이 초 단위로 작은 대신, 파일이 크고 재실행 로딩이 느립니다.

## [하이브리드와 Multi-part AOF - 앞은 스냅샷, 뒤는 로그]

그럼 RDB 의 빠른 로딩과 AOF 의 작은 손실을 같이 가질 수는 없을까요. 그게 하이브리드이고, 7.0 부터 기본값입니다. AOF 를 다시 쓸 때 앞부분은 RDB 스냅샷으로, 뒷부분은 그 이후의 AOF 로그로 채웁니다. 설정 이름은 `aof-use-rdb-preamble` 입니다.

<svg class="diagram" viewBox="0 0 720 150" role="img" aria-label="하이브리드 AOF 파일이 앞은 RDB 스냅샷, 뒤는 AOF 로그로 구성되는 모습">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 파일 안에서 앞은 스냅샷으로 빠르게 싣고, 뒤는 로그로 마지막까지 메운다</text>
  <rect x="40" y="44" width="360" height="60" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="220" y="70" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">RDB 스냅샷 (base)</text>
  <text x="220" y="90" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">여기까지 한 번에 로딩 (빠름)</text>
  <rect x="400" y="44" width="280" height="60" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="540" y="70" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">AOF 로그 (incr)</text>
  <text x="540" y="90" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">그 이후 변경만 재실행 (손실 최소)</text>
  <text x="360" y="132" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">manifest 가 base 와 incr 파일을 함께 가리킨다</text>
</svg>

여기서 7.0 이 바꾼 게 하나 더 있습니다. 예전에는 이 모든 걸 `appendonly.aof` 한 파일에 담았는데, 지금은 **Multi-part AOF** 라고 해서 여러 파일로 나눠요. `manifest` 파일이 목록을 들고, `base` 파일(하이브리드면 RDB 프리앰블)이 스냅샷을, `incr` 파일이 그 이후 증분 로그를 담아요. 이 파일들은 `appenddirname` 으로 지정한 디렉터리(기본 `appendonlydir`)에 모여 있습니다. 리라이트는 새 base 를 만들고 manifest 를 교체하는 식으로 도니까, 예전처럼 한 파일을 통째로 다시 쓰다 실패하는 위험이 줄었어요. 이름이나 예전 문서에서 단일 `appendonly.aof` 만 보고 "내 디렉터리엔 왜 파일이 여러 개지"라고 놀라지 않으려면 이 구조를 알아두면 됩니다.

결과적으로 로딩은 RDB 처럼 빠르고, 손실은 AOF 처럼 작아져요. 두 방식의 좋은 쪽만 이어 붙인 셈이에요.

## [내구성의 진실 - always 도 무손실은 아니다]

여기서 한 발 물러서서 짚고 싶은 게 있습니다. `appendfsync always` 로 매 명령마다 디스크에 내리면 무손실이라고 생각하기 쉬운데, 정확히는 아니에요.

`fsync` 가 성공했다는 건 데이터가 OS 를 지나 디스크 장치에 전달됐다는 뜻이지, 그 이후의 모든 층이 안전하다는 보장은 아닙니다. 그리고 더 중요한 건, always 로 지킨 건 어디까지나 **이 한 노드의 디스크**라는 점이에요. 이 노드 자체가 물리적으로 죽으면 그 디스크 파일에 접근할 수 없습니다. 그때 데이터를 살리는 건 영속화가 아니라 다른 노드에 미리 넘겨둔 사본, 즉 복제예요. 그런데 기본 복제는 비동기라 Master 가 "저장했어"라고 답한 직후 죽으면 아직 안 넘어간 쓰기가 사라질 수 있습니다([54번 글](/posts/54-redis-replication-sentinel-cluster/)에서 다룬 지점이에요).

그래서 저는 이제 영속화와 내구성을 분리해서 봅니다. **영속화는 이 노드를 껐다 켰을 때의 회복력이고, 진짜 내구성은 영속화와 복제가 함께 만드는 성질**이에요. 어느 하나만으로 "안 잃는다"고 말하면 반쪽입니다.

## [무엇을 언제 - 버린 선택지]

한동안 저는 "RDB 든 AOF 든 하나만 켜면 되지"라고 생각했습니다. 그런데 RDB 만 켜면 마지막 스냅샷 이후가 통째로 날아가고, AOF 만 켜면 로딩이 느립니다. 둘 다 켜는 게 낭비 같아 보였지만, 하이브리드가 바로 그 조합을 한 구조로 푼 거라 지금은 특별한 이유가 없으면 하이브리드를 써요.

버릴 뻔한 접근도 하나 있었습니다. Master 에서 저장을 자주 돌려 안전을 높이려 했는데, 그러면 fork 지연과 THP 증폭이 사용자 요청 경로에 그대로 얹힙니다. 그래서 저장 부담이 큰 워크로드라면 **저장은 Replica 에 맡기고 Master 는 요청만 받게** 나누는 편이 낫다는 걸 알게 됐어요. 반대로 순수 캐시처럼 사라져도 되는 데이터라면 영속화를 아예 꺼서 fork 부담을 없애는 선택도 정당합니다. 정확히는 데이터의 성격이 설정을 정하는 거예요.

## [실무 적용 - 이 구조에서 나오는 규칙]

정리하면 영속화의 실무 규칙은 "직렬 구간과 디스크를 건드리는 순간을 관리한다"로 모입니다.

**1. 특별한 이유가 없으면 하이브리드를 켜요.** 7.0 이후 기본값이고, 빠른 로딩과 작은 손실을 함께 얻습니다.

**2. everysec 를 기본으로 둡니다.** always 는 매 쓰기가 디스크를 기다리고, no 는 유실이 큽니다. 대부분의 서비스는 최대 1초 손실을 받아들이는 균형점이 맞아요.

**3. THP 를 끕니다.** fork 기반 저장과 상성이 나쁘고, COW 복제 단위를 4KB 에서 2MB 로 키워 메모리와 지연을 함께 부풉니다.

**4. `latest_fork_usec` 를 관찰해요.** 인스턴스가 클수록 fork 자체가 길어집니다. 이 값이 튀면 저장이 요청 지연을 만들고 있다는 신호예요.

**5. `stop-writes-on-bgsave-error` 의 존재를 압니다.** 기본이 yes 라, 디스크가 차서 저장이 실패하면 쓰기가 전부 막혀요. 저장 디렉터리의 디스크 여유를 감시 대상에 넣어요.

**6. 저장 부담이 크면 Replica 로 넘깁니다.** Master 는 요청을, Replica 는 스냅샷을 맡게 나누면 fork 지연이 사용자 경로에서 빠져요.

**7. 순수 캐시는 영속화를 끕니다.** 사라져도 되는 데이터에 저장을 켜두면 얻는 것 없이 fork 비용만 냅니다.

**8. 내구성이 목표라면 복제까지 같이 봐요.** 영속화만으로는 노드 자체의 죽음을 못 막아요.

## [결론]

영속화는 처음엔 복구 속도와 데이터 손실 사이의 저울질로만 보였습니다. RDB 는 빠른 로딩과 큰 손실 구간, AOF 는 작은 손실과 느린 로딩, 하이브리드는 그 사이의 절충이에요. 그런데 한 겹 들어가 보니 진짜 이야기는 그 저울 아래에 있었습니다. **저장이든 fsync 든, 결국 fork 와 디스크라는 두 개의 멈추는 지점을 통과한다**는 거예요. 43번에서 본 직렬 구간이 영속화에서도 그대로 반복됐습니다.

남은 한계를 적어둘게요. 저는 같은 데이터셋으로 RDB 로딩과 AOF 로딩의 시간을 재보지 않았고, everysec 에서 실제로 얼마나 손실이 나는지, 큰 인스턴스에서 `latest_fork_usec` 가 얼마나 튀는지도 관찰하지 않았습니다. 그리고 THP 가 켜졌을 때와 꺼졌을 때 저장 중 메모리 증가폭이 얼마나 차이 나는지는 쓰기 패턴에 크게 좌우돼요. 다음에는 `INFO persistence` 로 `rdb_last_save_time`, `aof_last_rewrite_time_sec`, `latest_fork_usec` 를 관찰해, 이 글의 이야기를 제가 잰 값으로 채워보려고 합니다.

<!-- 측정 필요: 동일 데이터셋 RDB vs AOF 로딩 시간, BGSAVE 중 used_memory 변화, latest_fork_usec 관찰, THP on/off 비교 -->
