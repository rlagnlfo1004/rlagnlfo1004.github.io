---
title: "캐시를 어디에 언제 쓰느냐가 다릅니다 (Cache-Aside 부터 Stampede 까지)"
description: "Redis 를 가장 많이 쓰는 자리가 캐시입니다. 캐시와 DB 를 어떤 순서로 건드리느냐가 정합성과 유실을 가르고, 인기 키가 만료되는 순간 요청이 몰리는 Stampede 까지 이어져요. 네 가지 전략과 그 대응을 정리했습니다."
date: 2026-08-25
project: "공통"
tags: ["Redis", "캐시", "Cache Stampede", "성능", "CS", "면접"]
draft: false
---

## [배경 - 캐시를 붙였는데 문제가 옮겨갔다]

느린 조회 앞에 Redis 를 캐시로 두는 건 거의 기본기입니다. 그런데 붙이고 나면 문제가 사라지는 게 아니라 모양을 바꿔서 다시 나타나요. 캐시와 DB 가 언제 어긋나는지, 갱신하면 캐시를 어떻게 지워야 하는지, 인기 키가 만료되는 순간 무슨 일이 벌어지는지 같은 새 질문이 생깁니다.

[47번 글](/posts/47-redis-inmemory-io-multiplexing/)에서 Redis 가 왜 빠른지를 봤다면, 이번엔 그 빠름을 캐시로 어떻게 쓰느냐입니다. 캐시를 어디에 두고 언제 채우느냐에 따라 정합성과 속도와 유실 위험이 갈려요. 네 가지 기본 전략과, 캐시가 무너지는 Stampede 문제를 정리했습니다.

## [읽기 전략 - Cache-Aside 와 Read-Through]

가장 흔한 건 Cache-Aside, 다른 말로 Lazy Loading 입니다. 애플리케이션이 캐시를 먼저 보고, 없으면 DB 에서 읽어 캐시에 채운 뒤 돌려줘요.

<svg class="diagram" viewBox="0 0 720 200" role="img" aria-label="Cache-Aside 에서 캐시 미스면 DB 를 읽어 캐시에 채우고 반환하는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">캐시를 먼저 보고, 없으면 DB 에서 읽어 채운 뒤 다음 요청부터 캐시로 답한다</text>
  <rect x="30" y="70" width="110" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="85" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">App</text>
  <rect x="300" y="70" width="120" height="46" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="360" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="580" y="70" width="110" height="46" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="635" y="98" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB</text>
  <defs>
    <marker id="d60a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
  </defs>
  <line x1="140" y1="86" x2="296" y2="86" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="218" y="78" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">1. 조회</text>
  <line x1="360" y1="116" x2="360" y2="150" stroke="var(--ink-3, #8B9099)" stroke-width="1.2"/>
  <text x="372" y="138" font-size="10" fill="var(--ink-3, #8B9099)">miss</text>
  <line x1="420" y1="100" x2="576" y2="100" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="498" y="92" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">2. DB 조회</text>
  <line x1="576" y1="112" x2="422" y2="140" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d60a)"/>
  <text x="498" y="146" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">3. 캐시에 저장</text>
</svg>

Cache-Aside 는 조회가 많은 데이터에 잘 맞아요. 다만 단점이 둘 있습니다. 캐시에 없을 때 첫 요청은 느리고, 원본이 갱신되면 캐시를 무효화해줘야 최신값이 반영돼요. 이걸 안 하면 낡은 값을 계속 돌려줍니다.

Read-Through 는 여기서 한 겹을 더 감춥니다. 애플리케이션은 캐시만 보고, 미스가 나면 캐시 계층이 알아서 DB 를 읽어 채워요. Cache-Aside 의 로직을 캐시 계층 안으로 넣은 셈입니다. 다만 Redis 자체가 이걸 기본 제공하지는 않아서, 별도의 라이브러리나 계층이 필요해요.

## [쓰기 전략 - Write-Through 와 Write-Behind]

쓰기 쪽은 정합성과 속도 사이에서 갈립니다. Write-Through 는 캐시와 DB 에 동시에 써요. 캐시가 항상 최신이라 강한 일관성을 얻지만, 매 쓰기가 두 곳을 거치니 쓰기 지연이 늘어납니다. Write-Behind 는 캐시에 먼저 쓰고 DB 는 비동기로 모아서 반영해요. 쓰기가 매우 빠른 대신, 반영 전에 캐시가 유실되면 데이터가 사라집니다.

<svg class="diagram" viewBox="0 0 720 178" role="img" aria-label="Write-Through 는 캐시와 DB 에 동시에 쓰고, Write-Behind 는 캐시에 먼저 쓰고 나중에 DB 로 반영한다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같이 쓰면 정합성이 강해지고, 미뤄 쓰면 빨라지는 대신 유실을 감수한다</text>
  <rect x="20" y="40" width="330" height="128" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.1"/>
  <text x="40" y="64" font-size="12" font-weight="700" fill="var(--ink, #16181A)">Write-Through</text>
  <rect x="40" y="78" width="80" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="80" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">App</text>
  <rect x="150" y="78" width="80" height="34" rx="7" fill="var(--clay-soft, #EAF2FE)"/><text x="190" y="100" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="260" y="78" width="70" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="295" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">DB</text>
  <line x1="120" y1="95" x2="146" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <line x1="230" y1="95" x2="256" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <defs><marker id="d60b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker></defs>
  <text x="185" y="134" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">동시에 씀 → 항상 최신, 쓰기 느림</text>
  <rect x="370" y="40" width="330" height="128" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.1"/>
  <text x="390" y="64" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">Write-Behind</text>
  <rect x="390" y="78" width="80" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="430" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">App</text>
  <rect x="500" y="78" width="80" height="34" rx="7" fill="var(--clay-soft, #EAF2FE)"/><text x="540" y="100" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <rect x="610" y="78" width="70" height="34" rx="7" fill="var(--sunk, #F1F3F6)"/><text x="645" y="100" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">DB</text>
  <line x1="470" y1="95" x2="496" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" marker-end="url(#d60b)"/>
  <line x1="580" y1="95" x2="606" y2="95" stroke="var(--clay, #3182F6)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#d60b)"/>
  <text x="535" y="134" font-size="10" text-anchor="middle" fill="var(--clay-text, #1B64DA)">먼저 쓰고 나중에 모아 반영 → 빠름, 유실 위험</text>
</svg>

## [Cache Stampede - 만료 순간 몰린다]

전략을 정하고 나면 다음 함정이 기다립니다. 인기 있는 키의 TTL 이 만료되는 순간, 그 키를 노리던 수많은 요청이 동시에 캐시 미스를 냅니다. 그리고 전부 DB 로 몰려요. 순간적으로 DB 가 과부하로 휘청이는 이 현상을 Cache Stampede 또는 Thundering Herd 라고 부릅니다.

<svg class="diagram" viewBox="0 0 720 176" role="img" aria-label="여러 요청이 같은 키의 만료 순간에 동시에 미스를 내고 전부 DB 로 몰리는 Stampede">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 키가 만료된 찰나, 동시 요청이 전부 미스를 내고 DB 로 몰린다</text>
  <g font-size="10.5" text-anchor="middle">
    <rect x="30" y="50" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="70" fill="var(--ink, #16181A)">요청 1</text>
    <rect x="30" y="86" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="106" fill="var(--ink, #16181A)">요청 2</text>
    <rect x="30" y="122" width="90" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="75" y="142" fill="var(--ink, #16181A)">요청 3</text>
  </g>
  <rect x="290" y="76" width="130" height="50" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="355" y="98" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <text x="355" y="114" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">키 만료 (miss)</text>
  <defs><marker id="d60c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker></defs>
  <line x1="120" y1="65" x2="286" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="120" y1="101" x2="286" y2="101" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="120" y1="137" x2="286" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" marker-end="url(#d60c)"/>
  <line x1="420" y1="90" x2="576" y2="90" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <line x1="420" y1="101" x2="576" y2="101" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <line x1="420" y1="112" x2="576" y2="112" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d60c)"/>
  <rect x="580" y="76" width="110" height="50" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.3"/>
  <text x="635" y="98" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB</text>
  <text x="635" y="114" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">중복 조회 폭주</text>
</svg>

## [대응 - PER, 락, 지터]

몰리는 걸 막는 방법이 몇 가지예요.

- PER(Probabilistic Early Recomputation)은 만료되기 전에 확률적으로 미리 갱신합니다. 만료가 임박할수록 갱신 확률이 올라가서, 한 요청이 남들보다 먼저 캐시를 새로 채워요. 개념을 식으로 쓰면 `현재시각 - 델타 × 베타 × ln(난수) ≥ 만료시각` 인데, 베타가 튜닝 계수입니다.
- 락 기반은 첫 요청만 DB 를 조회하게 합니다. `SET key value NX` 로 락을 잡은 요청만 원본을 읽고, 나머지는 잠깐 기다렸다 채워진 캐시를 읽어요. Redis 의 원자적 `SETNX` 가 분산 락이 되는 겁니다. 이렇게 하나만 나가게 만드는 걸 Single Flight 라고 불러요.
- TTL 지터는 만료 시각을 살짝 흩뿌리는 방법입니다. 여러 키에 같은 TTL 을 주면 동시에 만료되니, 랜덤을 조금 더해 만료를 분산시켜요.

락으로 동시 요청을 하나로 줄이는 발상은 [39번 글](/posts/39-redis-lua-atomic-inventory/)의 원자적 처리와 뿌리가 같습니다. 여러 요청이 같은 자원을 동시에 건드리지 못하게 막는다는 점에서요.

<svg class="diagram" viewBox="0 0 720 190" role="img" aria-label="Single Flight, SET NX 로 락을 잡은 한 요청만 DB 를 조회해 캐시를 채우고 나머지는 대기 후 캐시를 읽는다">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">락을 잡은 첫 요청만 DB 로 나가고, 나머지는 기다렸다 채워진 캐시를 읽는다</text>
  <defs>
    <marker id="d60d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d60e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker>
  </defs>
  <rect x="24" y="60" width="96" height="30" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="80" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">요청 1</text>
  <rect x="24" y="98" width="96" height="26" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="116" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">요청 2</text>
  <rect x="24" y="130" width="96" height="26" rx="7" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="72" y="148" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">요청 3</text>
  <rect x="172" y="56" width="150" height="42" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="247" y="74" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">SET key NX</text>
  <text x="247" y="89" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">락 획득은 하나만</text>
  <line x1="120" y1="76" x2="168" y2="76" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <line x1="120" y1="111" x2="168" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#d60d)"/>
  <line x1="120" y1="143" x2="168" y2="96" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#d60d)"/>
  <line x1="322" y1="77" x2="392" y2="77" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <rect x="396" y="56" width="108" height="42" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))"/><text x="450" y="81" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">DB 조회</text>
  <line x1="504" y1="77" x2="572" y2="77" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d60e)"/>
  <rect x="576" y="56" width="120" height="42" rx="9" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/><text x="636" y="74" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">캐시 채움</text>
  <text x="636" y="90" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Redis</text>
  <text x="247" y="150" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">나머지는 잠깐 대기</text>
  <line x1="300" y1="146" x2="574" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1.1" stroke-dasharray="4 3" marker-end="url(#d60d)"/>
  <text x="486" y="150" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">채워진 캐시를 읽음</text>
</svg>

## [메모리가 차면 - eviction]

캐시는 결국 메모리가 찹니다. `maxmemory` 에 도달하면 `maxmemory-policy` 에 따라 키를 축출해요. 가장 오래 안 쓴 키를 버리는 `allkeys-lru`, 가장 덜 쓴 키를 버리는 `allkeys-lfu`, 만료가 임박한 키부터 버리는 `volatile-ttl` 같은 정책이 있습니다. 순수 캐시라면 보통 lru 나 lfu 가 무난해요. 이 정책을 안 정해두면 메모리가 찼을 때 쓰기가 거부되거나 예상 못 한 키가 사라질 수 있습니다.

## [결론]

캐시는 어디에 두고 언제 채우느냐의 문제였습니다. 읽기는 Cache-Aside 와 Read-Through, 쓰기는 Write-Through 와 Write-Behind 로 갈리고, 각 선택은 정합성과 속도와 유실 사이의 저울질이에요. 그리고 캐시가 만료되는 순간의 Stampede 는 PER 과 락과 지터로 눌러야 했습니다.

남은 한계를 적어둘게요. 저는 Stampede 를 실제로 재현해 DB 부하가 얼마나 튀는지, PER 과 락 중 어느 쪽이 어떤 트래픽에서 유리한지를 재보지 않았습니다. 정답은 워크로드가 정하고, 조회와 갱신의 비율이 전략을 바꿔요. 다음에는 동시 요청을 걸어 Stampede 를 만들고, 락을 걸기 전과 후의 DB 조회 수를 세서 이 글을 제가 잰 값으로 보강하려고 합니다.

<!-- 측정 필요: 동시 만료 시 DB 조회 수, Single Flight 락 적용 전후 비교 -->
