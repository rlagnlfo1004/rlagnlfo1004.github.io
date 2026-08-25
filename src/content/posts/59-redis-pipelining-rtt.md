---
title: "서버는 빠른데 왕복이 느립니다 (Pipelining 과 RTT)"
description: "Redis 명령 하나는 마이크로초인데 천 번을 부르면 느려집니다. 범인은 서버가 아니라 네트워크 왕복이에요. RTT 가 쌓이는 구조와, 파이프라이닝이 그 왕복을 어떻게 줄이는지 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "성능", "네트워크", "Pipelining", "CS", "면접"]
draft: false
---

## [배경 - 명령은 빠른데 전체가 느렸다]

Redis 명령 하나는 아주 빠릅니다. 그런데 반복문 안에서 키 천 개를 하나씩 `GET` 하면 체감이 확 느려져요. 서버 로그를 보면 각 명령은 여전히 마이크로초 단위인데, 전체 작업은 그것과 안 맞게 오래 걸립니다.

처음에는 Redis 가 느린 줄 알았어요. 그런데 원인은 Redis 바깥, 정확히는 클라이언트와 서버 사이의 네트워크 왕복에 있었습니다. 명령을 하나 보내고 응답을 받는 이 왕복이 천 번 쌓이면, 서버가 아무리 빨라도 그 벽에 막혀요. 그래서 이 왕복이 무엇이고, 파이프라이닝이 그중 무엇을 없애는지 정리했습니다.

## [문제 상황 분석 - RTT 가 쌓인다]

RTT(Round Trip Time)는 명령 하나를 보내고 응답을 받기까지의 왕복 시간입니다. 전송, 서버 처리, 응답으로 이뤄지고, 물리적 거리가 이 값을 지배해요. 문제는 명령을 순차로 보낼 때예요. 앞 명령의 응답을 받아야 다음 명령을 보내면, 명령이 N 개일 때 `RTT × N` 이 그대로 쌓입니다.

<svg class="diagram" viewBox="0 0 720 236" role="img" aria-label="순차 방식은 명령마다 왕복이 반복되어 RTT 가 N 번 쌓이고, 파이프라인은 한 번에 몰아 왕복이 한 번에 가깝다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">순차는 왕복을 N 번 반복하고, 파이프라인은 한 번에 몰아 왕복을 한 번에 가깝게 만든다</text>
  <text x="20" y="44" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">순차</text>
  <line x1="60" y1="52" x2="60" y2="118" stroke="var(--rule, rgba(22,24,26,.2))" stroke-width="1"/>
  <line x1="660" y1="52" x2="660" y2="118" stroke="var(--rule, rgba(22,24,26,.2))" stroke-width="1"/>
  <text x="60" y="64" font-size="9" text-anchor="middle" fill="var(--ink-3, #8B9099)">client</text>
  <text x="660" y="64" font-size="9" text-anchor="middle" fill="var(--ink-3, #8B9099)">server</text>
  <g stroke="var(--ink-3, #8B9099)" stroke-width="1">
    <line x1="60" y1="74" x2="656" y2="84" marker-end="url(#d59a)"/>
    <line x1="660" y1="86" x2="64" y2="96" marker-end="url(#d59a)"/>
    <line x1="60" y1="98" x2="656" y2="108" marker-end="url(#d59a)"/>
  </g>
  <defs>
    <marker id="d59a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d59b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker>
  </defs>
  <text x="360" y="130" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">명령 1 왕복, 명령 2 왕복 … 총 RTT × N</text>
  <text x="20" y="164" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">파이프라인</text>
  <line x1="60" y1="172" x2="60" y2="224" stroke="var(--clay, #3182F6)" stroke-width="1" opacity="0.5"/>
  <line x1="660" y1="172" x2="660" y2="224" stroke="var(--clay, #3182F6)" stroke-width="1" opacity="0.5"/>
  <g stroke="var(--clay, #3182F6)" stroke-width="1.3">
    <line x1="60" y1="182" x2="656" y2="188" marker-end="url(#d59b)"/>
    <line x1="60" y1="188" x2="656" y2="194" marker-end="url(#d59b)"/>
    <line x1="60" y1="194" x2="656" y2="200" marker-end="url(#d59b)"/>
    <line x1="660" y1="206" x2="64" y2="212" marker-end="url(#d59b)"/>
    <line x1="660" y1="210" x2="64" y2="216" marker-end="url(#d59b)"/>
    <line x1="660" y1="214" x2="64" y2="220" marker-end="url(#d59b)"/>
  </g>
  <text x="360" y="234" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">한꺼번에 보내고 한꺼번에 받음, RTT × 1 에 가까움</text>
</svg>

## [파이프라이닝 - 응답을 기다리지 않는다]

파이프라이닝은 앞 명령의 응답을 기다리지 않고 명령을 한꺼번에 몰아 보낸 뒤, 응답도 한꺼번에 받는 방식입니다. 순서는 이래요.

- 클라이언트가 명령들을 버퍼에 쌓습니다. 곧장 보내지 않아요.
- 버퍼가 flush 되면 하나의 TCP 스트림으로 몰아 보냅니다.
- 서버는 도착 순서대로 처리하고 응답을 응답 버퍼에 쌓아 되돌려줘요.
- 클라이언트가 응답을 순서대로 각 명령에 매핑합니다.

<svg class="diagram" viewBox="0 0 720 176" role="img" aria-label="클라이언트가 명령을 버퍼에 모아 flush 하면 하나의 스트림으로 보내고, 서버가 응답 버퍼에 쌓아 되돌려주면 순서대로 매핑한다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">버퍼에 모았다가 flush 될 때 한 번에 보내고, 응답도 한꺼번에 받아 순서대로 매핑한다</text>
  <defs>
    <marker id="d59c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker>
    <marker id="d59d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
  </defs>
  <rect x="24" y="42" width="200" height="114" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="40" y="64" font-size="11" font-weight="700" fill="var(--ink, #16181A)">클라이언트 버퍼</text>
  <g font-size="10.5">
    <rect x="40" y="74" width="168" height="22" rx="5" fill="var(--clay-soft, #EAF2FE)"/><text x="50" y="89" fill="var(--clay-text, #1B64DA)">GET a</text>
    <rect x="40" y="100" width="168" height="22" rx="5" fill="var(--clay-soft, #EAF2FE)"/><text x="50" y="115" fill="var(--clay-text, #1B64DA)">GET b</text>
    <rect x="40" y="126" width="168" height="22" rx="5" fill="var(--clay-soft, #EAF2FE)"/><text x="50" y="141" fill="var(--clay-text, #1B64DA)">GET c</text>
  </g>
  <line x1="224" y1="84" x2="494" y2="84" stroke="var(--clay, #3182F6)" stroke-width="1.6" marker-end="url(#d59c)"/>
  <text x="360" y="76" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">flush, 하나의 TCP 스트림으로</text>
  <line x1="494" y1="118" x2="224" y2="118" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d59d)"/>
  <text x="360" y="136" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">응답을 순서대로 각 명령에 매핑</text>
  <rect x="498" y="64" width="196" height="76" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="596" y="96" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Redis 서버</text>
  <text x="596" y="116" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">순서대로 처리, 응답 버퍼에 적재</text>
</svg>

결과적으로 `RTT × N` 이 `RTT × 1` 에 가까워집니다. 여기서 오해하기 쉬운 게 하나 있어요. 파이프라이닝은 서버를 더 빠르게 만드는 게 아닙니다. 서버가 하는 일의 양은 그대로예요. 낭비되던 네트워크 왕복이 사라지는 것뿐입니다.

## [파이프라이닝은 트랜잭션이 아니다]

이 둘은 여러 명령을 묶는다는 점이 닮아서 헷갈리기 쉬운데, 목적이 완전히 다릅니다.

| 항목 | Pipelining | Transaction (MULTI) |
| --- | --- | --- |
| 목적 | 네트워크 왕복 절감 | 원자적 실행 |
| 원자성 | 없음 | 있음 |
| 실행 | 명령이 각각 독립 실행 | EXEC 시점에 한꺼번에 |
| 중간 끼어듦 | 다른 클라이언트가 끼어들 수 있음 | 완전 격리 |
| 부분 성공 | 허용됨 | 큐 전체가 함께 처리 |

정확히는 파이프라이닝은 왕복 최적화이고, 트랜잭션은 원자적 실행이에요. 파이프라인으로 묶은 명령들 사이에는 다른 클라이언트의 명령이 끼어들 수 있고, 일부만 성공할 수도 있습니다. 트랜잭션의 격리와 롤백 없는 원자성은 [58번 글](/posts/58-redis-transaction-multi-exec-watch/)에서 따로 다뤘어요.

## [둘을 겹치기]

그렇다고 둘이 배타적인 건 아닙니다. 많은 클라이언트가 `MULTI`, `EXEC` 를 파이프라인에 실어 보내요. 원자성은 트랜잭션에서, 왕복 절감은 파이프라이닝에서 동시에 얻는 흔한 패턴입니다.

다만 파이프라인을 무작정 크게 잡으면 안 돼요. 보내는 명령과 받는 응답이 모두 버퍼에 쌓이니, 한 번에 수만 개를 몰면 그 버퍼가 메모리를 먹습니다. 그래서 보통 수천 개 단위로 배치를 쪼갭니다. 왕복을 줄이려다 메모리를 키우는 함정을 피하는 거예요.

## [결론]

파이프라이닝은 서버를 손대지 않고 네트워크 왕복을 줄이는 방법이었습니다. RTT 가 N 번 쌓이던 걸 한 번에 가깝게 접어서, 대량 명령의 체감 속도를 끌어올려요. 원자성이 필요하면 트랜잭션을, 둘 다 필요하면 트랜잭션을 파이프라인에 실으면 됩니다.

남은 한계를 적어둘게요. 저는 같은 작업을 순차와 파이프라인으로 돌려 실제 시간 차이를 재보지 않았습니다. RTT 는 배포 환경의 네트워크 거리에 크게 좌우되니, 로컬에서 잰 값과 원격에서 잰 값은 완전히 다를 거예요. 다음에는 같은 반복 작업을 두 방식으로 돌려 `redis-benchmark` 나 클라이언트 타이머로 절대값과 배수를 함께 재서 이 글을 보강하려고 합니다.

<!-- 측정 필요: 동일 N 명령의 순차 vs 파이프라인 소요 시간, 절대값과 배수 -->
