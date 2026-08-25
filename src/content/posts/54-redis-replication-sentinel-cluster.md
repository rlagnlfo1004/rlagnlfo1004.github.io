---
title: "단일 인스턴스에서 세 번 갈아탑니다 (복제, Sentinel, Cluster)"
description: "Redis 를 하나로 띄우면 그 하나가 죽을 때 전부 멈춥니다. 읽기를 나누는 복제, 자동 승격을 맡는 Sentinel, 데이터를 쪼개는 Cluster 까지, 세 단계가 각각 무엇을 푸는지 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "복제", "Sentinel", "Cluster", "고가용성", "면접"]
draft: false
---

## [배경 - 하나로 버티다 만난 세 가지 한계]

[42번 글](/posts/42-redis-distributed-lock-fencing-token/)에서 분산 락이 Sentinel 페일오버 순간에 어떻게 깨지는지를 봤습니다. 그 글을 쓰면서 저는 Sentinel 을 "장애 나면 알아서 넘겨주는 것" 정도로만 알고 있었어요. 복제와 Sentinel 과 Cluster 를 거의 한 덩어리로 묶어서 이해하고 있었던 겁니다.

그런데 이 셋은 푸는 문제가 서로 달라요. 복제는 읽기를 나누고, Sentinel 은 승격을 자동화하고, Cluster 는 데이터를 쪼갭니다. 면접에서 "복제랑 클러스터 차이가 뭐예요"라는 질문을 받으면 저는 얼버무렸을 거예요. 그래서 단일 인스턴스에서 시작해 한 단계씩 갈아타면서, 각 단계가 정확히 무엇을 더 얻는지 정리했습니다.

이 글에도 제가 잰 숫자는 없어요. 나오는 값은 Redis 문서의 기본값이거나 프로토콜에 정의된 상수입니다.

## [문제 상황 분석 - 단일 인스턴스의 한 점]

Redis 를 하나만 띄우면 클라이언트가 그 하나에만 붙습니다. 편하죠. 다만 그 하나가 죽는 순간 읽기도 쓰기도 전부 막히고, 아직 디스크로 내려가지 않은 데이터는 위험해집니다. 이걸 SPOF(Single Point of Failure)라고 부르고, 고가용성 이야기는 전부 이 한 점을 어떻게 없애느냐에서 출발해요.

## [복제 - 읽기를 나누고 사본을 둔다]

첫 단계는 Master 하나에 Replica 를 여럿 붙이는 겁니다. 쓰기는 Master 가 받고, 읽기는 Replica 들이 나눠 받아요. 읽기 트래픽이 많은 서비스라면 이것만으로도 숨통이 트입니다.

<svg class="diagram" viewBox="0 0 720 256" role="img" aria-label="클라이언트가 Master 에 쓰고, Master 가 복제 스트림으로 두 Replica 에 전파하며, 읽기는 Replica 가 처리하는 구조">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">쓰기는 Master 로 모으고, 읽기는 Replica 로 나눈다</text>
  <defs>
    <marker id="d54a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d54b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/></marker>
  </defs>
  <rect x="288" y="30" width="144" height="34" rx="9" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="360" y="52" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">클라이언트</text>
  <line x1="360" y1="64" x2="360" y2="88" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d54a)"/>
  <text x="372" y="81" font-size="10.5" fill="var(--ink-2, #545A64)">쓰기</text>
  <rect x="290" y="90" width="140" height="44" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.4"/>
  <text x="360" y="117" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Master</text>
  <line x1="330" y1="134" x2="185" y2="188" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d54b)"/>
  <line x1="390" y1="134" x2="535" y2="188" stroke="var(--clay, #3182F6)" stroke-width="1.3" marker-end="url(#d54b)"/>
  <text x="360" y="168" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">복제 스트림 (비동기)</text>
  <rect x="110" y="190" width="140" height="44" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="180" y="217" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Replica 1</text>
  <rect x="470" y="190" width="140" height="44" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="540" y="217" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Replica 2</text>
  <text x="180" y="250" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">읽기 요청 처리</text>
  <text x="540" y="250" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">읽기 요청 처리</text>
</svg>

복제가 붙는 과정은 이렇습니다. Replica 가 처음 연결되면 Master 가 그 시점의 스냅샷(RDB)을 통째로 넘겨요(full resync). 그다음부터는 들어오는 쓰기 명령을 복제 스트림으로 계속 흘려보냅니다. 연결이 잠깐 끊겼다 붙으면 매번 전체를 다시 받지 않고, 복제 백로그에 남은 차이만 받는 부분 재동기화(PSYNC)를 시도해요.

다만 여기에 함정이 하나 있습니다. 기본 복제는 **비동기** 예요. Master 가 클라이언트에게 "저장했어"라고 답한 직후에 죽으면, 아직 Replica 로 넘어가지 않은 쓰기는 사라질 수 있습니다. `WAIT` 명령으로 몇 개의 Replica 까지 전달되길 기다릴 수 있지만, 그만큼 응답이 느려져요. 그리고 복제만으로는 **자동 승격이 없습니다.** Master 가 죽어도 누군가 Replica 를 Master 로 올려줘야 하는데, 그 누군가가 다음 단계입니다.

## [Sentinel - 죽음을 판정하고 승격한다]

Sentinel 은 Master 와 Replica 를 지켜보다가, Master 가 죽으면 Replica 하나를 자동으로 승격시키고 클라이언트에게 새 주소를 알려줍니다. 그 자신이 또 SPOF 가 되면 안 되니 보통 홀수로, 최소 세 대를 띄워요.

여기서 핵심 개념이 죽음을 판정하는 두 단계입니다.

<svg class="diagram" viewBox="0 0 720 210" role="img" aria-label="Sentinel 이 주관적 다운과 객관적 다운을 거쳐 페일오버로 가는 흐름">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">혼자 의심하는 단계와, 정족수가 동의하는 단계를 나눈다</text>
  <rect x="30" y="52" width="180" height="80" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1.2"/>
  <text x="120" y="82" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">S-DOWN</text>
  <text x="120" y="102" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">주관적 다운</text>
  <text x="120" y="118" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">한 Sentinel 이 응답 없다고 판단</text>
  <defs>
    <marker id="d54c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <line x1="210" y1="92" x2="266" y2="92" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d54c)"/>
  <text x="238" y="82" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">Quorum</text>
  <text x="238" y="110" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">이상 동의</text>
  <rect x="270" y="52" width="180" height="80" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.4"/>
  <text x="360" y="82" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O-DOWN</text>
  <text x="360" y="102" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">객관적 다운</text>
  <text x="360" y="118" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">정족수가 동의하면 확정</text>
  <line x1="450" y1="92" x2="506" y2="92" stroke="var(--ink-3, #8B9099)" stroke-width="1.3" marker-end="url(#d54c)"/>
  <rect x="510" y="52" width="180" height="80" rx="10" fill="var(--surface, #FAFAFB)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="600" y="82" font-size="12.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">Fail-Over</text>
  <text x="600" y="102" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">리더 Sentinel 선출 뒤</text>
  <text x="600" y="118" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">Replica 를 Master 로 승격</text>
  <text x="360" y="176" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">역할: Monitoring, Notification, 자동 Failover, 새 주소를 알려주는 Configuration Provider</text>
</svg>

한 Sentinel 이 "얘 응답이 없네"라고 생각하는 건 아직 혼자만의 판단이라 S-DOWN(주관적 다운)입니다. 여기서 Quorum, 즉 정해둔 정족수 이상의 Sentinel 이 같은 판단에 동의하면 그때 O-DOWN(객관적 다운)으로 확정돼요. 확정되면 Sentinel 들이 리더를 하나 뽑아 페일오버를 실행합니다. 그러니까 Quorum 은 "몇 명이 동의해야 죽었다고 인정할지"의 문턱이에요. 이 승격이 도는 짧은 순간에 락이 어떻게 깨질 수 있는지가 [42번 글](/posts/42-redis-distributed-lock-fencing-token/)의 주제였습니다.

## [Cluster - 데이터를 쪼갠다]

복제와 Sentinel 이 가용성을 위한 것이었다면, Cluster 는 확장성을 위한 겁니다. 데이터 자체를 여러 Master 에 나눠 담아요. 열쇠는 16384 개의 해시 슬롯입니다.

<svg class="diagram" viewBox="0 0 720 250" role="img" aria-label="16384 개 슬롯을 세 Master 가 나눠 갖고 Gossip 으로 상태를 주고받는 클러스터">
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">모든 키를 16384 개 슬롯 중 하나로 보내고, 슬롯 범위를 Master 들이 나눠 책임진다</text>
  <rect x="20" y="60" width="200" height="70" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="120" y="88" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Master 1</text>
  <text x="120" y="110" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">slot 0 – 5460</text>
  <rect x="260" y="60" width="200" height="70" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="360" y="88" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Master 2</text>
  <text x="360" y="110" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">slot 5461 – 10922</text>
  <rect x="500" y="60" width="200" height="70" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.3"/>
  <text x="600" y="88" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Master 3</text>
  <text x="600" y="110" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">slot 10923 – 16383</text>
  <line x1="220" y1="95" x2="260" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="4 3"/>
  <line x1="460" y1="95" x2="500" y2="95" stroke="var(--ink-3, #8B9099)" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="360" y="150" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Gossip 으로 서로의 상태와 슬롯 정보를 주고받음</text>
  <rect x="70" y="176" width="120" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="130" y="200" font-size="11" text-anchor="middle" fill="var(--ink-3, #8B9099)">Replica 1</text>
  <rect x="310" y="176" width="120" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="370" y="200" font-size="11" text-anchor="middle" fill="var(--ink-3, #8B9099)">Replica 2</text>
  <rect x="550" y="176" width="120" height="40" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="610" y="200" font-size="11" text-anchor="middle" fill="var(--ink-3, #8B9099)">Replica 3</text>
  <line x1="120" y1="130" x2="130" y2="174" stroke="var(--ink-3, #8B9099)" stroke-width="1"/>
  <line x1="360" y1="130" x2="370" y2="174" stroke="var(--ink-3, #8B9099)" stroke-width="1"/>
  <line x1="600" y1="130" x2="610" y2="174" stroke="var(--ink-3, #8B9099)" stroke-width="1"/>
</svg>

모든 키는 `CRC16(key) mod 16384` 로 슬롯 번호가 정해지고, 그 슬롯을 어느 Master 가 맡는지에 따라 노드가 결정됩니다. 노드들은 Gossip 프로토콜로 서로의 상태와 슬롯 배치를 주고받아요. 클라이언트가 엉뚱한 노드에 물으면 그 노드가 `MOVED 슬롯 주소` 로 "그건 저기야"라고 되돌려주고, 슬롯이 이동하는 중이면 `ASK` 로 임시 안내합니다. 똑똑한 클라이언트는 슬롯과 노드의 대응을 캐싱해서 한 번에 맞는 노드로 가요.

여기서 실무 함정이 하나 나옵니다. 여러 키를 함께 다루는 명령은 그 키들이 **같은 슬롯**에 있어야 해요. 아니면 `CROSSSLOT` 에러가 납니다. 그래서 같은 노드에 묶고 싶은 키들은 이름에 중괄호를 넣습니다. `user:{1000}:name` 과 `user:{1000}:age` 처럼요. 중괄호 안의 `1000` 만 해싱하기 때문에 두 키가 같은 슬롯으로 가고, 결과적으로 같은 노드에 배치됩니다. 이걸 해시태그라고 불러요.

## [세 계층 정리 - 무엇을 푸는가]

비교 항목이 세 개라 표로 정리합니다.

| 계층 | 푸는 문제 | 대표 개념 |
| --- | --- | --- |
| 복제 | 읽기 확장, 데이터 사본 | Master-Replica, PSYNC, 복제 백로그 |
| Sentinel | 자동 페일오버로 가용성 | Quorum, S-DOWN, O-DOWN |
| Cluster | 쓰기와 용량의 수평 확장 | 16384 슬롯, Gossip, 해시태그 |

## [결론]

단일 인스턴스에서 세 번 갈아타는 여정이었습니다. 복제로 읽기와 사본을, Sentinel 로 자동 승격을, Cluster 로 수평 분할을 얻었어요. 각 단계는 앞 단계를 대체하는 게 아니라 얹는 구조라, Cluster 안에서도 각 Master 는 자기 Replica 를 두고 복제를 씁니다.

남은 한계를 적어둘게요. 저는 이 구조들을 실제로 띄워 페일오버 시간을 재보지 않았습니다. 그리고 비동기 복제의 유실 구간, 페일오버 도중의 split-brain, Cluster 의 cross-slot 제약은 각각 따로 깊게 볼 만한 주제예요. 특히 페일오버 순간의 안전성은 이미 [42번 글](/posts/42-redis-distributed-lock-fencing-token/)에서 락을 예로 한 번 다뤘으니, 다음에는 복제 지연 자체를 `INFO replication` 으로 관찰해 이 글의 비동기 이야기를 숫자로 보강하려고 합니다.

<!-- 측정 필요: 페일오버 소요 시간, INFO replication 의 master_repl_offset 지연 관찰 -->
