---
title: "RabbitMQ는 메시지를 어디에 쌓는가 (큐 프로세스, 크레딧 흐름, prefetch)"
description: "prefetch를 3으로 잡은 이유를 설명하지 못했습니다. 브로커 안에서 큐가 Erlang 프로세스 하나라는 사실부터 크레딧 기반 흐름 제어까지, 설정값의 근거가 되는 내부 구조를 정리했어요."
date: 2026-08-10
project: "공통"
tags: ["RabbitMQ", "CS", "Erlang", "Backpressure", "면접"]
---

## [배경 - 왜 3이냐는 질문에 답하지 못했다]

메일상자에서 Gmail 변경 이벤트를 큐 여섯 개로 나눈 이야기를 [25번 글](/posts/25-rabbitmq-backpressure-failure-isolation/)에 썼습니다. 그 글의 설정은 이랬어요.

```yaml
message-added-concurrency: ${GMAIL_MESSAGE_ADDED_CONCURRENCY:3}
message-added-prefetch: ${GMAIL_MESSAGE_ADDED_PREFETCH:3}
state-concurrency: ${GMAIL_HISTORY_STATE_CONCURRENCY:5}
state-prefetch: ${GMAIL_HISTORY_STATE_PREFETCH:10}
```

"prefetch는 성능 손잡이가 아니라 유입 제어 손잡이"라고 정리하고 넘어갔습니다. 그런데 다시 물어보면 막히는 지점이 있었어요. **그 손잡이를 돌리면 브로커 안에서 정확히 무엇이 달라지는가**입니다.

메시지가 큐에 100건 쌓여 있고 prefetch가 3이면, 나머지 97건은 어디에 있나요. 메모리인가요 디스크인가요. 컨슈머가 느려지면 그 압력은 어떤 경로로 발행자까지 전달되나요. 큐를 여섯 개로 나눈 게 왜 처리량에 도움이 되나요.

답을 못 했습니다. 설정 문서를 읽고 값을 넣었을 뿐, 브로커가 무엇으로 만들어졌는지는 몰랐어요. 그래서 파봤습니다.

먼저 밝혀둘 게 있습니다. **이 글에는 제가 직접 잰 숫자가 없습니다.** 이 블로그의 다른 글과 달리 벤치마크를 돌리지 않았어요. 대신 나오는 수치는 전부 RabbitMQ와 Erlang/OTP가 문서와 소스에 명시한 기본값이고, 그 출처를 같이 적었습니다. 제 측정값이 아니라는 뜻이에요.

## [문제 상황 분석 - 브로커는 무엇으로 만들어졌는가]

### 큐 하나는 Erlang 프로세스 하나입니다

RabbitMQ는 Erlang/OTP 위에서 돕니다. 여기서 말하는 프로세스는 OS 프로세스가 아니라 Erlang의 경량 프로세스예요. 생성 비용이 수백 바이트 수준이라 수십만 개를 띄워도 됩니다.

브로커의 거의 모든 것이 이 프로세스로 만들어져 있어요.

```
 [ TCP 소켓 ]
      │
      ▼
 rabbit_reader   ← 커넥션 하나당 1개. 프레임을 읽어 파싱한다
      │
      ├──▶ rabbit_channel  (채널 1)   ┐
      ├──▶ rabbit_channel  (채널 2)   │ 커넥션 하나 위에 여러 개
      └──▶ rabbit_channel  (채널 N)   ┘
                 │
                 │  라우팅 결과에 따라 메시지 전달
                 ▼
        rabbit_amqqueue_process   ← 큐 하나당 1개 (classic queue)
                 │
                 ▼
        rabbit_writer   ← 커넥션 하나당 1개. 소켓에 쓴다
```

여기서 가장 중요한 사실이 나옵니다. **classic queue 하나는 Erlang 프로세스 하나이고, Erlang 프로세스 하나는 어느 순간에도 스케줄러 하나 위에서만 돕니다.** Erlang VM은 코어 수만큼 스케줄러 스레드를 띄우는데, 프로세스 하나가 그중 둘을 동시에 쓸 방법은 없어요.

따라서 큐 하나의 처리량 상한은 **코어 하나의 성능**입니다. 서버에 코어가 16개 있어도 큐가 하나면 15개는 그 큐를 위해 일하지 않아요.

25번 글에서 큐를 여섯 개로 나눈 이유는 실패 격리였는데, 결과적으로 처리량에도 이득이 있었습니다. 큐 프로세스가 여섯 개가 되면서 스케줄러 여섯 개에 흩어졌으니까요. 의도한 이득은 아니었고, 나중에 구조를 알고 나서 이해한 부분이에요.

이게 RabbitMQ 성능 튜닝에서 **큐 샤딩**이 반복해서 나오는 이유입니다. 큐 하나가 병목이면 설정을 아무리 만져도 코어 하나를 넘지 못해요. `rabbitmq-sharding` 플러그인이나 consistent hash exchange로 논리 큐 하나를 물리 큐 N개로 쪼개는 게 정공법입니다.

### 커넥션과 채널을 나눈 대가

TCP 커넥션은 비쌉니다. 핸드셰이크가 있고, TLS면 더 비싸고, 서버 쪽 파일 디스크립터도 먹어요. 그래서 AMQP 0-9-1은 커넥션 하나 위에 **채널**이라는 논리 연결을 여러 개 올립니다.

다만 다중화에는 대가가 따라옵니다.

첫째, **커넥션 하나에는 writer 프로세스가 하나뿐입니다.** 채널 열 개가 같은 소켓을 공유해요. 한 채널이 큰 메시지를 밀어넣는 동안 다른 채널의 프레임은 뒤에서 기다립니다. HTTP/1.1의 head-of-line blocking과 같은 구조예요.

이걸 완화하려고 AMQP는 메시지를 프레임 단위로 쪼갭니다. 기본 `frame_max`는 131072 바이트, 그러니까 128 KiB예요. 1 MB짜리 메시지는 body 프레임 여덟 개로 나뉘어 나갑니다. 그 사이사이에 다른 채널의 프레임이 끼어들 수 있어요. 그래도 프레임 하나 단위로는 여전히 막힙니다.

둘째, **채널은 스레드 안전하지 않습니다.** Java 클라이언트의 `Channel` 을 여러 스레드가 공유하면 프레임이 뒤섞여 커넥션이 통째로 끊길 수 있어요. Spring AMQP의 `CachingConnectionFactory` 가 채널을 캐싱해서 스레드마다 빌려주는 이유가 이겁니다.

기본 `channel_max` 는 2047입니다. 커넥션 하나에 채널을 그 이상 못 열어요. 그리고 채널 하나도 Erlang 프로세스 하나이니, 채널을 수천 개 여는 건 그 자체로 비용입니다.

### 익스체인지는 프로세스가 아닙니다

여기서 많이 오해합니다. 그림으로 그리면 익스체인지가 큐 앞에 있는 상자처럼 보이니까요.

실제로 익스체인지는 **프로세스가 아니라 라우팅 테이블 조회**입니다. 채널 프로세스가 `rabbit_exchange:route/2` 를 호출해서 바인딩 테이블을 뒤지고, 목적지 큐 목록을 받아 그 큐 프로세스들에 직접 메시지를 보내요. 익스체인지라는 이름의 프로세스는 존재하지 않습니다.

그래서 익스체인지가 병목이 되는 일은 거의 없습니다. 예외는 topic 익스체인지예요. topic 라우팅은 트라이(trie) 탐색이라 direct나 fanout보다 비쌉니다. 바인딩 패턴이 수만 개 수준으로 늘어나면 채널 프로세스의 CPU를 먹기 시작해요.

메타데이터 저장소도 알아둘 만합니다. 3.x 까지는 Mnesia에 큐와 바인딩 정보를 넣었는데, 4.0 부터 Khepri(Raft 기반)로 바뀌었어요. 네트워크 분단 뒤 수동 복구가 필요했던 Mnesia의 고질적인 문제를 정리하려는 변경입니다.

### 메시지는 어디에 쌓이는가

큐에 100건이 쌓여 있을 때 그게 메모리인지 디스크인지가 원래 질문이었습니다. 답은 버전에 따라 다릅니다.

3.11 까지의 classic queue는 메시지를 상태에 따라 네 단계로 관리했어요. 흔히 alpha, beta, gamma, delta로 부릅니다.

| 상태 | 메시지 본문 | 인덱스 |
| --- | --- | --- |
| alpha | 메모리 | 메모리 |
| beta | 디스크 | 메모리 |
| gamma | 디스크 | 메모리와 디스크 |
| delta | 디스크 | 디스크 |

평소에는 alpha로 메모리에 두고, 메모리 압박이 오면 beta 이후로 밀어냅니다. 문제는 이 페이징이 **압박이 온 뒤에** 일어난다는 점이었어요. 큐가 갑자기 길어지면 그 순간 대량의 디스크 쓰기가 몰리고, 브로커 전체가 출렁였습니다.

`lazy queue` 는 이 문제의 처방이었습니다. 처음부터 디스크에 쓰고 필요할 때만 읽어오는 모드예요. 처리량은 조금 손해 보지만 큐 길이에 따라 성능이 요동치지 않았습니다.

3.12 부터 정리됐어요. classic queue v2(CQv2)가 기본이 되면서 큐는 항상 디스크 우선으로 동작하고, `queue-mode=lazy` 설정은 사실상 아무 일도 하지 않습니다. 지금 lazy 설정을 넣고 있다면 그건 옛날 문서를 보고 쓴 값이에요.

한 가지 더. **아직 ack되지 않은 메시지는 큐 프로세스가 메모리에 붙들고 있습니다.** 컨슈머에게 보냈지만 ack를 못 받은 메시지는 재전송에 대비해 남겨둬야 하니까요. 이게 prefetch와 직결됩니다. 뒤에서 다시 볼게요.

## [크레딧 흐름 제어 - 압력이 전달되는 진짜 경로]

### 프로세스 사이에 크레딧이 있습니다

Erlang 프로세스 사이의 메시지 전송은 비동기이고, 기본적으로 **무한 버퍼**입니다. 보내는 쪽은 받는 쪽이 얼마나 밀렸는지 모른 채 계속 보낼 수 있어요. 받는 쪽 메일박스가 무한정 커지다가 VM이 메모리로 죽습니다.

RabbitMQ는 이걸 막으려고 `credit_flow` 라는 자체 메커니즘을 씁니다. 보내는 프로세스가 받는 프로세스에 대해 크레딧을 들고 있고, 한 번 보낼 때마다 1씩 깎여요. 0이 되면 보내는 쪽이 **스스로 멈춥니다.** 받는 쪽이 처리를 진행해서 크레딧을 다시 부여하면 그때 재개해요.

기본값은 `{credit_flow_default_credit, {400, 200}}` 입니다. 초기 크레딧 400, 그리고 200건을 처리하면 크레딧을 더 준다는 뜻이에요. `advanced.config` 에서 바꿀 수 있습니다.

### 이 크레딧이 사슬을 이룹니다

핵심은 크레딧이 한 쌍이 아니라 **사슬**이라는 점이에요.

<svg class="diagram" viewBox="0 0 720 268" role="img" aria-label="큐 프로세스가 느려지면 크레딧 고갈이 채널을 거쳐 리더까지 전파되고 결국 TCP 수신 버퍼가 차서 발행자가 막힌다">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">느린 큐 하나가 발행자를 멈추는 경로</text>
  <rect x="0" y="34" width="120" height="46" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="60" y="55" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">발행자</text>
  <text x="60" y="71" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">publish</text>
  <rect x="150" y="34" width="120" height="46" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="210" y="55" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">TCP 수신 버퍼</text>
  <text x="210" y="71" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">OS 커널</text>
  <rect x="300" y="34" width="120" height="46" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="360" y="55" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">rabbit_reader</text>
  <text x="360" y="71" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">커넥션당 1개</text>
  <rect x="450" y="34" width="120" height="46" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="510" y="55" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">rabbit_channel</text>
  <text x="510" y="71" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">채널당 1개</text>
  <rect x="600" y="34" width="120" height="46" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="660" y="55" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)" text-anchor="middle">큐 프로세스</text>
  <text x="660" y="71" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">느려진 지점</text>
  <path d="M120 57 L146 57" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#a41)"/>
  <path d="M270 57 L296 57" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#a41)"/>
  <path d="M420 57 L446 57" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#a41)"/>
  <path d="M570 57 L596 57" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#a41)"/>
  <defs>
    <marker id="a41" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="b41" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="360" y="112" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)" text-anchor="middle">크레딧 고갈은 반대 방향으로 번진다</text>
  <path d="M596 134 L454 134" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#b41)"/>
  <text x="525" y="128" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">①</text>
  <path d="M446 158 L304 158" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#b41)"/>
  <text x="375" y="152" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">②</text>
  <path d="M296 182 L154 182" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#b41)"/>
  <text x="225" y="176" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">③</text>
  <path d="M146 206 L4 206" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#b41)"/>
  <text x="75" y="200" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">④</text>
  <line x1="0" y1="226" x2="720" y2="226" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="243" font-size="11" fill="var(--ink-3, #8B9099)">① 큐가 채널에 크레딧을 안 준다   ② 채널이 멈추고 리더에 크레딧을 안 준다   ③ 리더가 소켓 읽기를 멈춘다</text>
  <text x="0" y="260" font-size="11" fill="var(--ink-3, #8B9099)">④ 수신 버퍼가 차고 TCP 윈도가 0이 되어 발행자의 write 가 블로킹된다</text>
</svg>

큐 프로세스가 느려지면 채널의 크레딧이 마릅니다. 채널이 멈추면 리더의 크레딧이 마르고, 리더는 소켓에서 읽기를 멈춰요. 그러면 커널의 수신 버퍼가 차고, TCP 윈도가 0으로 광고됩니다. 발행자 쪽 `write()` 가 결국 블로킹돼요.

**RabbitMQ의 backpressure는 애플리케이션 프로토콜이 아니라 TCP까지 내려가서 완성됩니다.** 관리 UI에서 커넥션 상태가 `flow` 로 뜨는 게 이 상태예요. 에러가 아니라 "지금 밀려서 속도를 늦추고 있다"는 신호입니다.

여기서 25번 글의 결론이 다시 설명됩니다. 느린 큐 하나가 있으면, **그 큐로 발행하는 채널이 속한 커넥션 전체가 막힙니다.** 같은 커넥션의 다른 채널이 멀쩡한 큐를 향하고 있어도 리더가 소켓을 안 읽으니 소용이 없어요. 큐를 나누는 것만으로는 부족하고 커넥션까지 나눠야 완전한 격리입니다. 저는 그때 커넥션을 나누지 않았어요.

### 알람은 크레딧과 다른 메커니즘입니다

혼동하기 쉬운데, 메모리와 디스크 알람은 크레딧 흐름과 별개입니다.

- `vm_memory_high_watermark` 기본값은 0.4입니다. 브로커가 쓸 수 있다고 판단한 메모리의 40%를 넘으면 알람이 뜹니다
- `disk_free_limit` 기본값은 50MB입니다. 남은 디스크가 이보다 적으면 알람이 뜹니다

알람이 뜨면 **발행하는 모든 커넥션이 통째로 블로킹됩니다.** 특정 큐가 아니라 노드 전체 차원의 조치예요. 소비는 계속되니 큐가 비면 알람이 풀립니다.

크레딧 흐름은 "이 사슬이 밀렸다"에 반응하는 국소적인 제동이고, 알람은 "노드가 위험하다"에 반응하는 전면 차단입니다. 로그에서 `memory resource limit alarm set` 을 봤다면 튜닝할 곳이 다르다는 뜻이에요.

## [prefetch - 손잡이의 정체]

### basic.qos가 하는 일

`basic.qos(prefetch_count)` 는 **ack되지 않은 채로 컨슈머에게 나가 있을 수 있는 메시지의 최대 개수**를 정합니다. 그게 전부예요. 컨슈머가 잡고 있는 미확인 메시지가 그 수에 도달하면 브로커는 더 보내지 않습니다.

prefetch를 지정하지 않으면 값은 0, 그러니까 무제한입니다. 브로커가 큐에 있는 걸 전부 컨슈머 소켓으로 밀어넣어요. 결과는 두 가지입니다.

첫째, 컨슈머 프로세스의 메모리가 터집니다. 둘째, 컨슈머가 여럿이어도 먼저 붙은 하나가 다 가져가서 나머지가 논다는 문제가 생겨요. RabbitMQ 3.3 이전에 `basic.qos` 없이 라운드로빈만 믿었다가 겪는 전형적인 함정입니다.

### 그렇다고 1이 정답은 아닙니다

prefetch를 1로 두면 분배는 완벽하게 공평합니다. 대신 처리량 상한이 생겨요.

컨슈머는 메시지 하나를 처리하고 ack를 보낸 다음, 브로커가 다음 메시지를 보내줄 때까지 **기다립니다.** 이 왕복 시간 동안 컨슈머는 놀아요. 처리 시간이 1ms이고 왕복이 1ms라면 절반을 노는 셈입니다.

그래서 나오는 어림 공식이 이겁니다.

```
적정 prefetch ≈ (왕복 지연 + 처리 시간) / 처리 시간
```

처리가 오래 걸리는 작업일수록 작은 값이면 충분해요. 메시지 하나에 500ms 걸리는 작업이면 prefetch 1이나 2로도 컨슈머가 쉴 틈이 없습니다. 반대로 0.1ms 만에 끝나는 작업이면 수백이 필요해요.

Spring AMQP의 기본값은 250입니다. 짧은 작업 기준으로 잡힌 값이에요. **처리가 무거운 컨슈머라면 이 기본값은 너무 큽니다.**

### 제가 3과 10으로 나눈 이유가 여기 있었습니다

이제 25번 글의 설정을 다시 읽을 수 있습니다.

`message-added` 는 Gmail API를 부르고 본문을 저장하는 무거운 작업입니다. 메시지 하나에 걸리는 시간이 길고, 외부 API 쿼터도 걸려 있어요. prefetch 3이면 컨슈머 3개 × 3 = 최대 9건이 동시에 물려 있습니다. Gmail 쪽으로 나가는 동시 호출이 그만큼으로 제한돼요.

`state` 계열은 DB 플래그만 바꾸는 가벼운 작업입니다. 처리 시간이 짧으니 왕복 지연 비중이 커요. prefetch 10이 합리적입니다.

그때는 "무거운 건 작게, 가벼운 건 크게" 라는 감으로 잡았는데, 공식에 넣어봐도 방향은 같았습니다. 우연히 맞은 건 아니었어요. 다만 정확한 값을 왕복 지연과 처리 시간을 재서 정한 건 아니니, 3과 10이 최적이라는 근거는 여전히 없습니다.

### global 플래그의 함정

`basic.qos` 에는 `global` 이라는 불리언이 하나 더 있습니다. 그리고 RabbitMQ는 여기서 AMQP 0-9-1 명세와 다르게 동작해요.

| global | AMQP 0-9-1 명세 | RabbitMQ 구현 |
| --- | --- | --- |
| false | 채널 단위 | **컨슈머 단위** |
| true | 커넥션 단위 | **채널 단위** |

명세대로 읽으면 틀립니다. RabbitMQ에서 `global=false` 는 컨슈머 하나하나에 개별 한도를 겁니다. 채널에 컨슈머가 다섯 개 붙어 있고 prefetch가 10이면 총 50건이 나갈 수 있어요.

Spring AMQP는 `global=false` 로 설정합니다. 그러니 `concurrency` 를 올리면 **동시에 물리는 메시지 총량이 곱으로 늘어납니다.** concurrency 5에 prefetch 10이면 50건이에요. concurrency만 올리고 prefetch를 그대로 두면 유입량이 조용히 배로 뛰는 셈입니다.

### 그리고 unacked는 브로커 메모리입니다

앞에서 미뤄둔 이야기입니다. 컨슈머에게 보냈지만 ack가 안 온 메시지는 큐 프로세스가 메모리에 들고 있어요. 재전송에 대비해야 하니까요.

그래서 prefetch는 컨슈머 쪽 메모리만이 아니라 **브로커 쪽 메모리도 결정합니다.**

```
브로커가 붙들고 있는 메모리 ≈ prefetch × 컨슈머 수 × 메시지 평균 크기
```

메시지가 1 MB이고 prefetch 250에 컨슈머 20개면 5 GB입니다. Spring Boot 기본값을 그대로 두고 큰 메시지를 다루면 이렇게 됩니다. `vm_memory_high_watermark` 알람이 뜨고 발행이 전부 멈추는 사고의 흔한 원인이에요.

## [큐 종류 - classic, quorum, stream]

3.8 이후로 선택지가 세 개입니다. 여기서 잘못 고르면 위의 튜닝이 무의미해져요.

### classic queue

앞에서 본 그 구조입니다. Erlang 프로세스 하나가 큐 하나를 소유해요. 가장 빠르고 가장 가볍습니다.

복제가 필요하면 예전에는 mirrored queue를 썼는데, **4.0에서 완전히 제거됐습니다.** 마스터가 죽었을 때 미러가 승격되는 과정에서 메시지가 유실될 수 있고, 네트워크 분단 복구가 까다로웠기 때문이에요. 3.x 에서 `ha-mode` 정책을 쓰고 있다면 4.0 업그레이드 전에 반드시 정리해야 합니다.

### quorum queue

Raft 합의 프로토콜로 복제하는 큐입니다. 리더 하나와 팔로워 여럿이 로그를 복제하고, 과반이 기록해야 커밋돼요.

대가는 지연입니다. **Raft 로그는 항상 디스크에 기록됩니다.** classic queue의 transient 메시지처럼 메모리에만 두고 빠르게 처리하는 모드가 없어요. 발행 지연이 classic보다 확실히 큽니다.

얻는 건 안전성이에요. 리더가 죽어도 커밋된 메시지는 남습니다. 그리고 실무에서 의외로 큰 이점이 `x-delivery-limit` 입니다. 처리에 실패해서 requeue되기를 무한 반복하는 포이즌 메시지를 배달 횟수로 잘라내고 DLQ로 보낼 수 있어요. classic queue에는 이 기능이 없어서 애플리케이션에서 재시도 횟수를 직접 세야 했습니다. 4.0 부터는 quorum queue에 기본 배달 한도가 걸립니다.

판단 기준은 단순해요. **메시지를 잃으면 돈이나 신뢰가 깎이는가**입니다. 결제 이벤트나 포인트 적립이면 quorum, 조회수 집계나 캐시 무효화 신호면 classic으로 충분합니다.

### stream

3.9에서 추가된 append-only 로그입니다. Kafka와 성격이 비슷해요. 메시지를 소비해도 지워지지 않고, 컨슈머가 오프셋을 들고 원하는 지점부터 다시 읽습니다.

같은 메시지를 여러 컨슈머 그룹이 각자 읽어야 하거나, 과거 이벤트를 재생해야 하면 stream입니다. 작업 큐로 쓰기에는 맞지 않아요.

## [성능 튜닝 - 어디를 만질 것인가]

내부 구조를 알고 나면 튜닝 순서가 정해집니다. 위에서부터가 효과가 큰 순서예요.

**1. 큐를 나눈다.** 큐 하나는 코어 하나입니다. 이걸 안 고치고 다른 걸 만져봐야 상한이 그대로예요. 라우팅 키나 샤딩 플러그인으로 쪼갭니다.

**2. 커넥션도 나눈다.** 발행용과 소비용 커넥션을 분리합니다. 크레딧 고갈은 커넥션 단위로 리더를 막으니, 섞어 쓰면 소비 지연이 발행을 멈춰요. 컴포넌트별로 나누면 더 좋습니다.

**3. publisher confirm은 비동기로 받는다.** `waitForConfirms()` 를 매 발행마다 부르면 왕복 시간이 그대로 처리량 상한이 됩니다. `ConfirmListener` 로 비동기 수신하고, 미확인 시퀀스 번호를 애플리케이션이 관리하는 쪽이 맞아요.

**4. auto ack를 쓰지 않는다.** `autoAck=true` 는 브로커가 보내는 순간 확인 처리합니다. 빠르지만 prefetch가 의미를 잃고 backpressure가 사라져요. 컨슈머가 죽으면 물고 있던 메시지가 전부 증발합니다.

**5. 큰 메시지를 브로커에 넣지 않는다.** 본문을 S3나 DB에 두고 큐에는 식별자만 흘리는 claim check 패턴입니다. 크레딧, 프레임 분할, unacked 메모리 문제가 한 번에 줄어들어요.

**6. prefetch는 마지막에 만진다.** 위 다섯 개를 안 고친 상태에서 prefetch만 올리면 브로커 메모리만 먹습니다.

**7. 인프라도 본다.** 큐 프로세스가 디스크에 쓰는 게 병목이면 디스크를 바꾸는 게 설정보다 낫습니다. Erlang 스케줄러 수는 기본이 코어 수인데, 컨테이너에서 CPU 제한을 걸었다면 VM이 호스트 코어를 보고 잘못 잡을 수 있어요. `RABBITMQ_IO_THREAD_POOL_SIZE` 와 스케줄러 설정을 컨테이너 할당량에 맞추는 게 좋습니다.

## [결론]

설정 문서만 읽고 값을 넣었을 때와, 그 값이 브로커 안에서 무엇을 바꾸는지 알고 넣었을 때는 다른 일이었습니다.

세 가지가 남았어요.

**큐 하나는 코어 하나입니다.** 처리량이 안 나오면 제일 먼저 볼 곳이 여기예요. 설정으로 넘을 수 있는 벽이 아닙니다.

**backpressure는 크레딧 사슬을 타고 TCP까지 내려갑니다.** 그래서 격리 단위는 큐가 아니라 커넥션이에요. 큐만 나누고 커넥션을 공유하면 격리가 절반만 됩니다. 25번 글에서 제가 놓친 부분이고, 지금 보면 거기가 다음에 고칠 자리입니다.

**prefetch는 브로커 메모리를 결정합니다.** 컨슈머 쪽 손잡이라고만 생각했는데 아니었어요. `prefetch × 컨슈머 수 × 메시지 크기` 가 큐 프로세스에 그대로 쌓입니다.

한계도 적어둘게요.

첫째, **이 글에는 측정이 없습니다.** 위의 공식과 기본값은 문서와 소스에서 확인한 것이지 제가 잰 값이 아니에요. prefetch 3과 10이 저희 워크로드에서 최적인지는 왕복 지연과 처리 시간을 재봐야 압니다. 다음에 그걸 해볼 생각이에요.

둘째, **quorum queue를 실제로 운영해본 적이 없습니다.** 메일상자의 큐는 전부 classic이에요. 메일 동기화 이벤트는 유실돼도 다음 동기화에서 복구되니 그렇게 정했는데, 이 판단이 맞았는지는 실제로 노드가 죽어봐야 압니다.

셋째, **Khepri 전환의 실제 영향을 모릅니다.** 4.0의 메타데이터 저장소 변경은 문서로만 읽었어요. 운영 중인 클러스터를 올려보지 않았으니 여기서 더 말하지 않겠습니다.

라이브러리를 붙이는 것과 그게 무엇을 세고 있는지 아는 것이 다른 일이라는 걸 [1번 글](/posts/01-circuit-breaker-retry-order/)에서 배웠는데, 미들웨어도 똑같았습니다. 설정값 하나에 브로커의 구조가 통째로 들어 있었어요.
