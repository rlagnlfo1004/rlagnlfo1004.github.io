---
title: "메모리는 껐다 켜면 사라집니다 (RDB, AOF, 그리고 하이브리드)"
description: "Redis 를 캐시로만 쓰면 안 보이지만, 재시작과 장애를 생각하면 결국 디스크로 내려두는 방법을 정해야 합니다. 스냅샷 방식 RDB, 명령 로그 방식 AOF, 둘을 합친 하이브리드를 복구 속도와 손실이라는 축으로 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "영속화", "RDB", "AOF", "CS", "면접"]
draft: false
---

## [배경 - 캐시라고만 생각했다가]

저는 Redis 를 오래 캐시로만 썼습니다. 캐시니까 사라져도 그만이라고 여겼고, 그래서 영속화 설정을 열어본 적이 없었어요. 그런데 대기열이나 카운터처럼 잠깐이라도 잃으면 곤란한 값을 Redis 에 두기 시작하면서 질문이 생겼습니다. **이 프로세스가 재시작되면 지금 메모리에 있는 건 어떻게 되지.**

[47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 데이터가 메모리에 산다는 걸 강점으로만 봤는데, 메모리는 껐다 켜면 사라지는 층이기도 합니다. 그래서 Redis 가 이 휘발성을 어떻게 메우는지, 스냅샷 방식과 로그 방식이 각각 무엇을 포기하고 무엇을 얻는지 정리했어요.

이 글의 값은 전부 Redis 문서의 기본 설정값입니다. 제가 잰 복구 시간은 없어요.

## [문제 상황 분석 - 상태를 뜰까, 과정을 적을까]

디스크로 내려두는 방법은 크게 둘입니다. 하나는 지금 이 순간의 **상태**를 통째로 사진 찍는 방식(RDB)이고, 하나는 상태에 이르기까지의 **과정**, 즉 들어온 쓰기 명령을 계속 적어두는 방식(AOF)이에요. 이 둘의 성격이 정반대라 선택의 축이 분명해집니다. 복구가 빠른 대신 손실 구간이 크거나, 손실 구간이 작은 대신 복구가 느리거나예요.

## [RDB - 한 장의 스냅샷]

RDB 는 메모리 전체를 하나의 이진 파일(`dump.rdb`)로 떠서 저장합니다. 저장을 트리거하는 방법이 몇 가지예요.

- `SAVE` 는 동기 저장입니다. 저장하는 동안 서버가 멈춰요. 그래서 운영 환경에서는 거의 쓰지 않습니다.
- `BGSAVE` 는 자식 프로세스를 `fork` 해서 백그라운드로 저장합니다. 메인은 계속 요청을 받아요.
- `save 900 1` 같은 규칙을 두면 조건이 맞을 때 자동으로 BGSAVE 가 돕니다.

BGSAVE 가 메인을 멈추지 않고도 일관된 스냅샷을 뜨는 비결이 Copy-on-Write 입니다.

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

`fork` 직후 부모와 자식은 같은 물리 페이지를 공유합니다. 그러다 부모가 어떤 페이지를 수정하는 순간, 그 페이지만 복제돼요. 덕분에 메모리를 통째로 복사하지 않고도 자식은 fork 시점의 일관된 이미지를 봅니다. 다만 저장이 도는 동안 쓰기가 많으면 복제되는 페이지가 늘어서, 최악의 경우 메모리가 순간적으로 크게 부풀 수 있어요. RDB 의 장점은 파일이 작고 로딩이 빠르다는 겁니다. 단점은 스냅샷과 스냅샷 사이에 죽으면 그 간격만큼 통째로 사라진다는 거예요.

## [AOF - 쓰기 명령을 다 적는다]

AOF 는 상태 대신 과정을 남깁니다. 들어온 쓰기 명령을 append-only 로그에 계속 적고, 재시작할 때 그 명령을 다시 실행해서 상태를 복원해요. 관건은 **언제 디스크에 실제로 내리느냐**, 즉 `fsync` 시점입니다. 세 가지 정책이 있어요.

| appendfsync | 언제 fsync | 성격 |
| --- | --- | --- |
| always | 명령마다 | 가장 안전하고 가장 느림 |
| everysec | 1초마다 | 균형, 최대 1초어치 손실 (권장) |
| no | OS 에 맡김 | 가장 빠르고 손실 위험이 큼 |

로그는 시간이 지날수록 계속 자랍니다. 조회수를 100 번 올렸으면 `INCR` 이 100 줄 쌓이는 식이에요. 그래서 `BGREWRITEAOF` 로 **지금 상태를 만드는 최소 명령 집합**으로 다시 씁니다. 100 줄이 `SET count 100` 한 줄로 압축되는 셈이죠. AOF 는 손실 구간이 초 단위로 작은 대신, 파일이 크고 재실행 로딩이 느립니다.

## [하이브리드 - 앞은 RDB, 뒤는 AOF]

그럼 RDB 의 빠른 로딩과 AOF 의 작은 손실을 같이 가질 수는 없을까요. 그게 하이브리드이고, 7.0 부터 기본값입니다. AOF 를 다시 쓸 때 앞부분은 RDB 스냅샷으로, 뒷부분은 그 이후의 AOF 로그로 채워요. 설정 이름은 `aof-use-rdb-preamble` 입니다.

<svg class="diagram" viewBox="0 0 720 150" role="img" aria-label="하이브리드 AOF 파일이 앞은 RDB 스냅샷, 뒤는 AOF 로그로 구성되는 모습">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 파일 안에서 앞은 스냅샷으로 빠르게 싣고, 뒤는 로그로 마지막까지 메운다</text>
  <rect x="40" y="44" width="360" height="60" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="220" y="70" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">RDB 스냅샷</text>
  <text x="220" y="90" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">여기까지 한 번에 로딩 (빠름)</text>
  <rect x="400" y="44" width="280" height="60" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="540" y="70" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">AOF 로그</text>
  <text x="540" y="90" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">그 이후 변경만 재실행 (손실 최소)</text>
  <text x="360" y="132" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">하나의 AOF 파일</text>
</svg>

결과적으로 로딩은 RDB 처럼 빠르고, 손실은 AOF 처럼 작아집니다. 두 방식의 좋은 쪽만 이어 붙인 셈이에요.

## [무엇을 언제 - 버린 선택지]

한동안 저는 "RDB 든 AOF 든 하나만 켜면 되지"라고 생각했어요. 그런데 RDB 만 켜면 마지막 스냅샷 이후가 통째로 날아가고, AOF 만 켜면 로딩이 느려집니다. 둘 다 켜는 게 낭비 같아 보였지만, 하이브리드가 바로 그 조합을 한 파일로 푼 거라 지금은 특별한 이유가 없으면 하이브리드를 씁니다. 순수 캐시처럼 사라져도 되는 데이터라면 반대로 영속화를 아예 꺼서 fork 부담을 없애는 선택도 정당해요. 정확히는 데이터의 성격이 설정을 정하는 겁니다.

## [결론]

영속화는 결국 복구 속도와 데이터 손실 사이의 저울질이었습니다. RDB 는 빠른 로딩과 큰 손실 구간, AOF 는 작은 손실과 느린 로딩, 하이브리드는 그 사이의 절충이에요.

남은 한계를 적어둘게요. 저는 같은 데이터셋으로 RDB 로딩과 AOF 로딩의 시간을 재보지 않았고, everysec 에서 실제로 얼마나 손실이 나는지도 관찰하지 않았습니다. 그리고 BGSAVE 의 fork 가 메모리를 얼마나 부풀리는지는 쓰기 패턴에 크게 좌우돼요. 다음에는 `INFO persistence` 로 `rdb_last_save_time` 과 `aof_last_rewrite` 를 관찰해, 이 글의 이야기를 제가 잰 값으로 채워보려고 합니다.

<!-- 측정 필요: 동일 데이터셋 RDB vs AOF 로딩 시간, BGSAVE 중 used_memory 변화 -->
