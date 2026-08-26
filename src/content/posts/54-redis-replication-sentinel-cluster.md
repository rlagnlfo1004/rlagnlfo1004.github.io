---
title: "단일 인스턴스에서 세 번 갈아탑니다 (복제, Sentinel, Cluster)"
description: "Redis 를 하나로 띄우면 그 하나가 죽을 때 전부 멈춥니다. 읽기를 나누는 복제, 자동 승격을 맡는 Sentinel, 데이터를 쪼개는 Cluster 까지, 세 계층이 각각 무엇을 푸는지, 그리고 어디서 조용히 데이터를 잃는지 정리했어요."
date: 2026-08-25
project: "공통"
tags: ["Redis", "복제", "Sentinel", "Cluster", "고가용성", "면접"]
draft: false
---

## [배경 - 하나로 버티다 만난 세 가지 한계]

[42번 글](/posts/42-redis-distributed-lock-fencing-token/)에서 분산 락이 Sentinel 페일오버 순간에 어떻게 깨지는지를 봤습니다. 그 글을 쓰면서 저는 Sentinel 을 "장애 나면 알아서 넘겨주는 것" 정도로만 알고 있었어요. 복제와 Sentinel 과 Cluster 를 거의 한 덩어리로 묶어서 이해하고 있었던 겁니다.

그런데 이 셋은 푸는 문제가 서로 달라요. 복제는 읽기를 나누고, Sentinel 은 승격을 자동화하고, Cluster 는 데이터를 쪼갭니다. 면접에서 "복제랑 클러스터 차이가 뭐예요"라는 질문을 받으면 저는 얼버무렸을 거예요. 그래서 단일 인스턴스에서 시작해 한 단계씩 갈아타면서, 각 단계가 정확히 무엇을 더 얻는지, 그리고 무엇을 여전히 보장하지 못하는지 정리했습니다.

미리 한 가지를 못 박아 둘게요. 이 글을 관통하는 결론은 **고가용성과 내구성은 다른 축**이라는 겁니다. 복제와 Sentinel 을 붙이면 "안 죽는" 쪽은 좋아지지만, "데이터를 안 잃는" 쪽은 그것만으로 따라오지 않아요. 이 둘을 같은 것으로 묶어 이해한 게 제 오해의 뿌리였습니다.

이 글에도 제가 잰 숫자는 없어요. 나오는 값은 Redis 문서의 기본값이거나 프로토콜에 정의된 상수이고, 그렇다는 걸 표시해뒀습니다.

## [문제 상황 분석 - 단일 인스턴스의 한 점]

Redis 를 하나만 띄우면 클라이언트가 그 하나에만 붙습니다. 편하죠. 다만 그 하나가 죽는 순간 읽기도 쓰기도 전부 막히고, 아직 디스크로 내려가지 않은 데이터는 위험해집니다. 이걸 SPOF(Single Point of Failure)라고 부르고, 고가용성 이야기는 전부 이 한 점을 어떻게 없애느냐에서 출발해요.

그런데 이 "한 점"을 없애는 일은 사실 세 개의 다른 요구가 뭉쳐 있는 겁니다. 하나는 읽기가 한 노드에 몰리는 처리량 한계이고, 하나는 노드가 죽었을 때 누가 대신 받느냐는 가용성이고, 하나는 데이터 총량이 메모리 한 대를 넘느냐는 용량입니다. 복제, Sentinel, Cluster 는 이 셋에 하나씩 대응해요. 순서대로 갈아타 보겠습니다.

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

복제가 붙는 과정부터 봐야 뒤가 이해됩니다. Replica 가 처음 연결되면 Master 가 그 시점의 스냅샷을 통째로 넘겨요. 이게 전체 재동기화(full resync)입니다. Master 는 `BGSAVE` 로 자식 프로세스를 `fork` 해 RDB 를 만들고, 그걸 Replica 로 보낸 다음, 만드는 동안 새로 들어온 쓰기를 이어서 흘려보내요. 그다음부터는 들어오는 쓰기 명령을 복제 스트림으로 계속 전파합니다.

여기서 부분 재동기화(PSYNC)가 중요해요. 연결이 잠깐 끊겼다 붙으면 매번 전체를 다시 받는 건 낭비니까, Master 는 최근 복제 스트림을 **복제 백로그**라는 원형 버퍼에 담아둡니다. Replica 는 자기가 어디까지 받았는지(오프셋)를 들고 재접속해서, 백로그에 그 지점이 남아 있으면 차이만 받아요.

문제는 이 백로그가 유한하다는 겁니다. `repl-backlog-size` 기본값은 1MB 예요(Redis 기본값). Replica 가 끊겨 있던 시간에 Master 의 쓰기량을 곱한 값이 이 1MB 를 넘기면, 필요한 지점이 이미 버퍼에서 밀려나 부분 재동기화가 실패합니다. 그러면 전체 재동기화로 떨어져요. 여기가 운영에서 조용히 아픈 지점입니다. 네트워크가 잠깐 흔들려 여러 Replica 가 동시에 재접속했는데 전부 full resync 로 떨어지면, Master 는 fork 와 대용량 전송을 한꺼번에 감당하느라 휘청여요. 이걸 복제 폭풍이라고 부릅니다. 전송 부담을 줄이려고 RDB 를 디스크에 쓰지 않고 소켓으로 바로 흘리는 `repl-diskless-sync` 옵션도 있어요.

다만 여기에 더 큰 함정이 하나 있습니다. 기본 복제는 **비동기** 예요. Master 가 클라이언트에게 "저장했어"라고 답한 직후에 죽으면, 아직 Replica 로 넘어가지 않은 쓰기는 사라질 수 있습니다. `WAIT numreplicas timeout` 명령으로 "몇 개의 Replica 까지 전달되면 응답하라"고 요구할 수 있지만, 그만큼 쓰기 응답이 느려져요. 조금 더 구조적인 방어가 `min-replicas-to-write` 와 `min-replicas-max-lag` 입니다. "지정한 수 이상의 Replica 가 지정한 지연 안쪽에 붙어 있지 않으면 아예 쓰기를 거부하라"는 설정이에요. 유실 구간의 상한을 강제로 좁히는 대신, 조건이 깨지면 쓰기를 못 받는 걸 감수하는 겁니다.

그리고 복제만으로는 **자동 승격이 없습니다.** Master 가 죽어도 누군가 Replica 를 Master 로 올려줘야 하는데, 그 누군가가 다음 단계예요.

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

한 Sentinel 이 "얘 응답이 없네"라고 생각하는 건 아직 혼자만의 판단이라 S-DOWN(주관적 다운)입니다. 무엇을 기준으로 응답이 없다고 볼지는 `down-after-milliseconds` 로 정해요. 이 시간 동안 유효한 응답이 없으면 그 Sentinel 은 Master 를 의심하기 시작합니다. 여기서 Quorum, 즉 정해둔 정족수 이상의 Sentinel 이 같은 판단에 동의하면 그때 O-DOWN(객관적 다운)으로 확정돼요.

그런데 여기서 대부분이 헷갈리는 지점이 있습니다. **O-DOWN 을 판정하는 quorum 과, 실제 페일오버를 실행할 권한은 다른 문턱이에요.** quorum 은 "몇 명이 동의해야 죽었다고 인정할지"의 수입니다. 하지만 죽었다고 인정한 뒤 실제로 페일오버를 돌리려면, Sentinel 들이 리더를 하나 뽑아야 하고, 그 리더 선출에는 quorum 이 아니라 **전체 Sentinel 의 과반(majority)** 이 필요해요. 그래서 세 대 중 quorum 을 2 로 잡았는데 한 대만 남고 두 대가 같이 네트워크에서 고립되면, 남은 두 대는 O-DOWN 은 물론 리더 선출도 못 해서 페일오버가 안 돕니다. quorum 을 낮게 잡는다고 페일오버가 더 잘 되는 게 아니라는 뜻이에요. 이 과반 요건이 정족수를 홀수로, 넉넉히 두라는 조언의 진짜 이유입니다.

리더로 뽑힌 Sentinel 은 승격시킬 Replica 를 고르고(복제 지연이 적고 우선순위가 높은 쪽), 그 Replica 를 Master 로 올린 다음, 나머지 Replica 가 새 Master 를 바라보도록 재설정해요. 이 과정 전체에 상한을 두는 게 `failover-timeout` 이고, 누가 최신 결정을 내렸는지를 버전처럼 관리하는 게 config epoch(설정 세대)입니다. 세대 번호가 높은 설정이 항상 이겨요. 그래야 뒤늦게 살아 돌아온 노드가 옛 정보로 판을 뒤집지 못합니다.

바로 그 "살아 돌아온 노드"가 split-brain 입니다. 옛 Master 가 네트워크 단절 동안 죽은 게 아니라 격리만 됐다가, 페일오버로 새 Master 가 선 뒤에 복구되면, 잠깐 두 Master 가 공존해요. 그동안 옛 Master 에 들어온 쓰기는 강등되는 순간 버려집니다. 앞에서 본 `min-replicas-to-write` 가 여기서 완화책이 돼요. 격리된 옛 Master 는 Replica 를 잃은 상태라 조건이 깨지고, 그래서 쓰기를 거부하게 만들면 버려질 쓰기 자체를 줄일 수 있습니다. 이 승격이 도는 짧은 순간에 락이 어떻게 깨질 수 있는지가 [42번 글](/posts/42-redis-distributed-lock-fencing-token/)의 주제였어요.

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

모든 키는 `CRC16(key) mod 16384` 로 슬롯 번호가 정해지고, 그 슬롯을 어느 Master 가 맡는지에 따라 노드가 결정됩니다. 그런데 왜 하필 16384 일까요. 딱 떨어지는 65536(2의 16승)이 더 자연스러워 보이는데 말이죠. 이유는 노드끼리 주고받는 Gossip 메시지에 있어요. 각 노드는 하트비트마다 자기가 아는 슬롯 배치를 비트맵으로 실어 보내는데, 16384 비트는 2KB 이고 65536 비트는 8KB 입니다. 하트비트는 아주 잦으니 이 4배 차이가 상시 대역폭 낭비로 쌓여요. 게다가 Redis Cluster 는 현실적으로 수백에서 천 노드 규모를 넘기 어렵고, 그 규모라면 16384 슬롯으로도 노드당 슬롯이 충분히 잘게 나뉩니다. 큰 비트맵을 상시로 나르는 비용과 실제로 필요한 세분성을 저울질한 절충인 겁니다.

노드들은 이 Gossip 프로토콜로 서로의 상태와 슬롯 배치를 주고받아요. 클라이언트가 엉뚱한 노드에 물으면 두 가지로 갈립니다. 슬롯의 주인이 확정적으로 다른 노드면 `MOVED 슬롯 주소` 를 돌려주는데, 이건 "앞으로도 거기야"라는 영구 재지정이라 똑똑한 클라이언트는 슬롯맵 캐시를 갱신하고 다음부터 곧장 맞는 노드로 갑니다. 반면 슬롯이 마이그레이션 중이라 일부 키만 옮겨간 상태면 `ASK` 를 돌려줘요. 이건 "이 키만 잠깐 저쪽에 물어봐"라는 일시 안내라 슬롯맵을 갱신하지 않고, 대상 노드에 `ASKING` 을 먼저 보낸 뒤 그 명령만 다시 던집니다. 이 둘을 구별하지 못하면 마이그레이션 중에 클라이언트가 슬롯맵을 잘못 갱신해서 헤매요.

여기서 실무 함정이 하나 더 나옵니다. 여러 키를 함께 다루는 명령은 그 키들이 **같은 슬롯**에 있어야 해요. 아니면 `CROSSSLOT` 에러가 납니다. 그래서 같은 노드에 묶고 싶은 키들은 이름에 중괄호를 넣습니다. `user:{1000}:name` 과 `user:{1000}:age` 처럼요. 중괄호 안의 `1000` 만 해싱하기 때문에 두 키가 같은 슬롯으로 가고, 결과적으로 같은 노드에 배치됩니다. 이걸 해시태그라고 불러요. 여러 키를 다루는 Lua 스크립트도 이 제약을 그대로 받습니다.

가용성 쪽도 짚어야 해요. Cluster 에서 한 Master 가 죽으면 그 Master 의 Replica 가 승격하는데, 이 승격에는 **살아 있는 Master 들의 과반 동의** 가 필요합니다. Sentinel 이 하던 판정 역할을 Cluster 에서는 Master 노드들이 투표로 대신하는 셈이에요. 그래서 Master 절반 이상이 한꺼번에 고립되면 클러스터가 스스로를 지키려 쓰기를 멈춥니다. 이 판정의 타임아웃이 `cluster-node-timeout` 이고, `cluster-require-full-coverage` 는 슬롯 하나라도 담당 노드가 없으면 클러스터 전체를 멈출지(기본값 yes) 아니면 남은 슬롯만이라도 서빙할지를 정해요.

## [세 계층 정리 - 무엇을 푸는가]

비교 항목이 세 개라 표로 정리합니다.

| 계층 | 푸는 문제 | 대표 개념 |
| --- | --- | --- |
| 복제 | 읽기 확장, 데이터 사본 | Master-Replica, PSYNC, 복제 백로그 |
| Sentinel | 자동 페일오버로 가용성 | Quorum, 과반 리더 선출, S-DOWN, O-DOWN |
| Cluster | 쓰기와 용량의 수평 확장 | 16384 슬롯, Gossip, MOVED/ASK, 해시태그 |

여기서 한 가지를 다시 강조할게요. 이 셋은 앞 단계를 대체하지 않고 **얹는** 구조입니다. Cluster 안에서도 각 Master 는 자기 Replica 를 두고 복제를 써요. 그리고 어느 계층을 붙여도 비동기 복제라는 뿌리는 그대로라, 페일오버 순간에 이미 ack 된 쓰기가 사라질 수 있다는 사실은 변하지 않습니다. 다시 말해 이 계층들은 "안 죽는" 문제를 푸는 것이지 "한 건도 안 잃는" 문제를 푸는 게 아니에요. 후자는 [55번 글](/posts/55-redis-persistence-rdb-aof/)의 영속화, 그리고 `WAIT` 와 `min-replicas` 같은 장치가 부분적으로 담당합니다.

## [실무 적용 - 이 구조에서 나오는 규칙]

정리하면 규칙은 이렇게 나옵니다.

**1. Replica 읽기는 낡은 값을 각오하고 씁니다.** 비동기 복제라 Replica 는 항상 조금 뒤처져요. 방금 쓴 값을 곧바로 다시 읽어야 하는 경로는 Master 로 보내거나, `WAIT` 로 전달을 확인합니다.

**2. 스냅샷 부담은 Replica 로 넘깁니다.** `BGSAVE` 의 fork 부담이 큰 인스턴스라면 영속화를 Replica 에서 돌려 Master 의 지연을 지킵니다.

**3. 유실 상한을 설정으로 강제합니다.** 중요한 쓰기라면 `min-replicas-to-write` 와 `min-replicas-max-lag` 로 "사본이 충분히 붙어 있을 때만 쓰기를 받게" 만들어 split-brain 유실을 좁혀요.

**4. Sentinel 은 홀수로, 과반을 염두에 두고 배치합니다.** quorum 만 보지 말고 리더 선출에 필요한 과반을 계산해요. 한 가용영역이 통째로 빠져도 남은 쪽이 과반을 유지하도록 나눠 둡니다.

**5. 복제 백로그를 쓰기량에 맞춰 키웁니다.** 재접속 때마다 full resync 로 떨어진다면 `repl-backlog-size` 가 작다는 신호예요. 다만 무작정 키우면 메모리를 먹으니 실제 단절 시간과 쓰기율로 가늠합니다.

**6. Cluster 에서 같이 쓸 키는 해시태그로 묶습니다.** 트랜잭션이나 다중 키 명령, 여러 키를 만지는 Lua 는 같은 슬롯에 있어야 도니, 처음부터 키 이름 설계에 넣어요.

**7. 클라이언트가 슬롯맵을 캐싱하게 합니다.** MOVED 를 받을 때마다 매번 리다이렉트를 타면 왕복이 늘어요. 대신 ASK 는 갱신하지 않도록, 라이브러리가 둘을 구별하는지 확인합니다.

## [결론]

단일 인스턴스에서 세 번 갈아타는 여정이었습니다. 복제로 읽기와 사본을, Sentinel 로 자동 승격을, Cluster 로 수평 분할을 얻었어요. 하지만 갈아탈 때마다 따라오지 않은 것이 하나 있었습니다. 세 계층 전부 가용성을 높였을 뿐, 비동기 복제 위에 서 있는 한 페일오버 순간의 유실은 남아요. "안 죽음"과 "안 잃음"을 같은 것으로 묶었던 게 제 첫 오해였고, 이 글을 정리하고 나서야 둘을 따로 두고 각각 설계해야 한다는 걸 알았습니다.

남은 한계를 적어둘게요. 저는 이 구조들을 실제로 띄워 페일오버 시간을 재보지 않았고, 백로그가 넘칠 때 full resync 가 얼마나 걸리는지도 관찰하지 않았습니다. 그리고 quorum 과 과반의 상호작용은 노드 배치와 네트워크 분할 시나리오마다 결과가 달라서, 글로만 이해한 것과 직접 분할을 일으켜 본 것은 다를 거예요. 다음에는 `INFO replication` 의 `master_repl_offset` 과 Replica 의 오프셋 차이를 관찰해, 이 글의 비동기 이야기를 제가 잰 지연으로 보강하려고 합니다.

<!-- 측정 필요: 페일오버 소요 시간, INFO replication 의 master_repl_offset 지연 관찰, 백로그 초과 시 full resync 발생 재현 -->
