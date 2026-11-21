---
title: "푸시 10만 건을 1분 안에 보내기까지 (FCM 발송 구조 다섯 번의 버전업)"
description: "동기 발송에서 시작해 콜백, 콜백 풀, 전송 풀 증설, 그리고 Semaphore와 행 잠금까지 왔습니다. 버전마다 병목이 한 칸씩 옮겨 갔어요."
date: 2026-11-21
project: "아주이벤트"
tags: ["FCM", "스레드 풀", "Semaphore", "Backpressure", "Little's Law", "SELECT FOR UPDATE"]
---

## [배경 - 공지 하나, 구독자 10만 명]

아주이벤트는 학교 공지가 올라오면 그 게시판을 구독한 사람에게 FCM 푸시를 보내는 서비스입니다. 크롤러가 새 공지를 찾으면 웹훅으로 서버에 알리고, 서버가 구독자 전원에게 발송해요.

처음 목표는 "느려지지 않게"였고, 마지막 목표는 **"구독자 10만 명 공지를 1분 안에 다 보내기"**였습니다. 그 사이에 구조를 다섯 번 바꿨어요. 버전마다 병목 하나를 없애면 다음 병목이 드러났습니다.

| 버전 | 바꾼 것 | 드러난 병목 | 결과 |
| --- | --- | --- | --- |
| v1 | 동기 발송 | 요청 스레드가 FCM 응답을 기다림 | Tomcat 스레드와 Firebase 스레드가 1:1로 늘어남 |
| v2 | 콜백 전환 | 콜백의 DB 저장이 Firebase 스레드에서 실행 | 웹훅 P95 5,240ms |
| v3 | 콜백 전용 풀 | 전송 스레드 수 | P95 2,530ms |
| v4 | 400건 배치, 전송 풀 core 16 → 32 | 큐 50,000이 넘치면 거절, 재발송 중복 | 실제 FCM 136.9 → 317.5건/s |
| v5 | 역할별 풀 3개, Semaphore, 행 잠금 | 토큰 10만 행 생성 | 발송 구간 374초 → 56초, 중복 208명 → 0명 |

이 글은 다섯 버전을 순서대로 따라가고, 가장 많이 바뀐 마지막 v5를 깊게 다룹니다.

## [v1 → v3 - 기다리는 스레드 없애기]

### v1: Future.get() 한 줄

Firebase Admin SDK의 `sendEachAsync()`는 원래 비동기입니다. 그런데 결과를 DB에 저장하려고 바로 `get()`을 불렀어요. 그러면 요청 스레드가 FCM 응답이 올 때까지 멈춥니다.

스레드 덤프를 떠 보면 `Future.get()`에서 `WAITING`인 Tomcat 스레드와, 실제 HTTP를 보내는 Firebase 스레드가 같은 수만큼 늘어나 있었습니다. 발송 1건이 스레드 2개를 잡고 있었던 거예요. FCM이 느려지면 발송과 상관없는 API까지 같이 느려집니다.

### v2: 콜백으로 바꿨더니 또 막힘

`ApiFutures.addCallback()`으로 바꿔 요청 스레드는 바로 돌려보냈습니다. 그런데 콜백을 실행할 스레드를 지정하지 않으니, 콜백이 FCM 응답을 받은 Firebase 스레드에서 그대로 돌았어요. 그 콜백 안에 DB 저장이 있었습니다.

전송 스레드가 DB 커넥션을 기다리는 동안 다음 메시지를 못 보냅니다. k6 200 VU에서 웹훅 API P95가 **5,240ms**까지 올랐어요.

### v3: 콜백이 돌 스레드를 따로 지정

```java
ApiFutures.addCallback(future, callback, fcmCallbackExecutor);
```

세 번째 인자 하나로 DB 저장을 전용 풀로 옮겼습니다. 같은 조건에서 P95가 **2,530ms**로 내려갔어요.

## [v4 - 스레드 수가 곧 처리량]

### 실제 FCM으로 재 봤습니다

2026년 5월, 실제 FCM 토큰 20,000건을 로컬 서버 한 대에서 보내 처리량을 쟀습니다. 발송은 400건씩 묶었어요.

| SDK 전송 풀 core | 처리량 |
| --- | --- |
| 16 | 136.9건/s |
| 32 | 317.5건/s |

스레드를 두 배로 늘리니 처리량도 거의 두 배가 됐습니다. 메시지 1건이 응답이 올 때까지 스레드 1개를 잡는 블로킹 구조라는 뜻이에요. 그래서 core를 32로 올렸습니다.

### 이 숫자에서 응답 시간을 거꾸로 구했습니다

Little's Law는 `L = λ × W`입니다. 동시에 처리 중인 작업 수(L)는 처리량(λ)에 작업 하나가 머무는 시간(W)을 곱한 값이에요. 스레드가 전부 차 있다면 L은 스레드 수이니, W를 거꾸로 구할 수 있습니다.

```
core 32: W = 32 ÷ 317.5 ≈ 0.101초
core 16: W = 16 ÷ 136.9 ≈ 0.117초
```

FCM 왕복이 약 **100ms**라는 값을 여기서 얻었습니다. 다만 처리량에서 역산했으니 **평균**이에요. P50이나 P95처럼 요청별 분포를 잰 값은 아닙니다.

## [v5 - 10만 건을 넣었더니 생긴 일]

### 큐 50,000의 함정

v4 설정은 core 32, max 128, 큐 50,000이었습니다. 숫자만 보면 128개까지 늘어날 것 같지만 그렇지 않아요.

`ThreadPoolExecutor`는 core 스레드가 다 차면 **먼저 큐에 쌓고**, 큐가 꽉 차야 max까지 스레드를 늘립니다. 큐가 50,000이니 평소에는 사실상 32개로만 돌았어요.

10만 건을 넣으면 그 큐마저 넘칩니다. 그리고 여기서 중복이 생겼어요.

1. 배치 400건을 `IN_PROGRESS`로 저장합니다.
2. `sendEachAsync()`를 부르면 SDK가 메시지 400건을 전송 풀에 **한 건씩 따로** 제출합니다.
3. 큐가 차는 순간 배치 **중간에서** `RejectedExecutionException`이 납니다.
4. 예외 앞쪽 메시지는 이미 큐에 들어가 **실제로 나갑니다.** 그런데 예외가 `sendEachAsync()` 안에서 바로 터져서 콜백 등록까지 가지 못해요.
5. 결과를 기록할 주체가 없으니 400건 전부 `IN_PROGRESS`로 남습니다.
6. 5분 주기 폴링 릴레이가 오래된 `IN_PROGRESS`를 발견해 배치를 통째로 다시 보냅니다.

4번에서 이미 받은 사람이 한 번 더 받습니다. **보냈는데 기록이 없는 상태**를 시스템이 "안 보냈다"로 해석한 거예요.

### 중복은 모의 FCM에서 직접 셌습니다

실제 FCM으로는 사용자가 몇 번 받았는지 알 수 없습니다. 그래서 SDK의 `HttpTransport`를 모의 구현으로 바꿔 모든 발송 요청을 받아 봤어요. 요청마다 110ms를 기다린 뒤 성공을 돌려주게 했습니다. 110ms는 v4 실측 범위의 가운데 값이에요.

요청 본문에서 토큰과 알림 ID(`push_cluster_id`)를 꺼내 `토큰|알림ID`를 키로 세고, 두 번 이상 들어온 토큰 수를 셌습니다. 본문 전체로 비교하지 않은 이유가 있어요. 안 읽은 알림 수(`unread_count`)가 발송할 때마다 달라서, 같은 알림을 다시 보내도 본문이 달라지거든요.

10만 건 단일 공지에서 기존 구조의 결과는 이랬습니다.

- `RejectedExecutionException` 1회, 웹훅 응답 500
- 릴레이 재발송 48,800건
- **중복 208명**

48,800건을 다시 보냈는데 중복이 208명뿐인 이유도 같은 흐름에서 나옵니다. 재발송 대부분은 거절돼서 원래 한 번도 안 나간 토큰이었어요. 중복은 거절이 난 배치 안에서 예외 전에 이미 나간 메시지뿐입니다.

### 풀을 역할별로 셋으로 나눴습니다

<div class="diagram-scroll" style="--diagram-min-w: 720px">
<svg class="diagram" viewBox="0 0 720 400" role="img" aria-label="웹훅 요청 스레드가 dispatch 풀에 넘기고, dispatch가 Semaphore 허가를 얻어 전송 풀에 제출하고, 응답을 callback 풀이 DB에 저장한 뒤 허가를 반납하는 구조">
  <defs>
    <marker id="d63a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3, #8B9099)"/></marker>
    <marker id="d63b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--clay, #3182F6)"/></marker>
  </defs>
  <text x="0" y="16" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">요청은 바로 돌려보내고, 진행 중인 배치는 3개까지만 둔다</text>

  <rect x="0" y="50" width="120" height="84" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="12" y="74" font-size="12" font-weight="700" fill="var(--ink, #16181A)">웹훅 요청</text>
  <text x="12" y="94" font-size="10.5" fill="var(--ink-2, #545A64)">Tomcat 스레드</text>
  <text x="12" y="116" font-size="10.5" fill="var(--ink-2, #545A64)">넘기고 바로 응답</text>
  <line x1="120" y1="92" x2="154" y2="92" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>

  <rect x="158" y="40" width="160" height="150" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="170" y="62" font-size="12" font-weight="700" fill="var(--ink, #16181A)">fcm-dispatch</text>
  <text x="170" y="80" font-size="10.5" font-family="var(--font-mono)" fill="var(--ink-2, #545A64)">2 / queue 100</text>
  <rect x="170" y="92" width="136" height="24" rx="4" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)"/>
  <text x="178" y="108" font-size="10.5" fill="var(--clay-text, #1B64DA)">① 허가 얻기 (최대 300초)</text>
  <rect x="170" y="122" width="136" height="24" rx="4" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="178" y="138" font-size="10.5" fill="var(--ink-2, #545A64)">② 토큰 행 잠금 선점</text>
  <rect x="170" y="152" width="136" height="24" rx="4" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="178" y="168" font-size="10.5" fill="var(--ink-2, #545A64)">③ sendEachAsync</text>
  <line x1="318" y1="164" x2="356" y2="164" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>
  <text x="322" y="156" font-size="10" fill="var(--ink-3, #8B9099)">400건</text>

  <rect x="360" y="40" width="200" height="170" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="372" y="62" font-size="12" font-weight="700" fill="var(--ink, #16181A)">fcm-default (SDK 전송)</text>
  <text x="372" y="80" font-size="10.5" font-family="var(--font-mono)" fill="var(--ink-2, #545A64)">core=max 200 / queue 2,000</text>
  <g fill="var(--clay, #3182F6)">
    <circle cx="380" cy="102" r="5"/><circle cx="396" cy="102" r="5"/><circle cx="412" cy="102" r="5"/><circle cx="428" cy="102" r="5"/><circle cx="444" cy="102" r="5"/><circle cx="460" cy="102" r="5"/><circle cx="476" cy="102" r="5"/><circle cx="492" cy="102" r="5"/><circle cx="508" cy="102" r="5"/><circle cx="524" cy="102" r="5"/><circle cx="540" cy="102" r="5"/>
    <circle cx="380" cy="118" r="5"/><circle cx="396" cy="118" r="5"/><circle cx="412" cy="118" r="5"/><circle cx="428" cy="118" r="5"/><circle cx="444" cy="118" r="5"/><circle cx="460" cy="118" r="5"/><circle cx="476" cy="118" r="5"/><circle cx="492" cy="118" r="5"/><circle cx="508" cy="118" r="5"/><circle cx="524" cy="118" r="5"/><circle cx="540" cy="118" r="5"/>
  </g>
  <text x="372" y="146" font-size="10.5" fill="var(--ink-2, #545A64)">메시지 1건이 응답까지</text>
  <text x="372" y="162" font-size="10.5" fill="var(--ink-2, #545A64)">스레드 1개를 잡는다</text>
  <text x="372" y="192" font-size="10.5" font-family="var(--font-mono)" fill="var(--ink-2, #545A64)">1,700/s × 0.1s ≈ 170</text>

  <rect x="600" y="70" width="120" height="100" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="644" y="116" font-size="12" font-weight="700" fill="var(--ink, #16181A)">FCM</text>
  <text x="624" y="136" font-size="10.5" fill="var(--ink-2, #545A64)">왕복 약 100ms</text>
  <line x1="560" y1="104" x2="596" y2="104" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>
  <line x1="596" y1="140" x2="564" y2="140" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>

  <rect x="360" y="262" width="200" height="90" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="372" y="284" font-size="12" font-weight="700" fill="var(--ink, #16181A)">fcm-callback (결과 저장)</text>
  <text x="372" y="302" font-size="10.5" font-family="var(--font-mono)" fill="var(--ink-2, #545A64)">4 / queue 100</text>
  <text x="372" y="324" font-size="10.5" fill="var(--ink-2, #545A64)">DB 커넥션 10개 중</text>
  <text x="372" y="340" font-size="10.5" fill="var(--ink-2, #545A64)">웹 요청 몫을 남긴다</text>
  <line x1="460" y1="210" x2="460" y2="258" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>
  <text x="468" y="238" font-size="10" fill="var(--ink-3, #8B9099)">addCallback(…, callbackExecutor)</text>

  <rect x="158" y="272" width="140" height="70" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))"/>
  <text x="212" y="304" font-size="12" font-weight="700" fill="var(--ink, #16181A)">DB</text>
  <text x="172" y="324" font-size="10.5" fill="var(--ink-2, #545A64)">토큰 결과 상태</text>
  <line x1="360" y1="307" x2="302" y2="307" stroke="var(--ink-3, #8B9099)" marker-end="url(#d63a)"/>

  <path d="M560 340 C 640 340, 650 390, 560 390 L 250 390 C 210 390, 200 360, 238 194" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#d63a)"/>
  <text x="340" y="384" font-size="10.5" fill="var(--clay-text, #1B64DA)">④ 저장이 끝나면 허가 반납 → 다음 배치</text>
</svg>
</div>

<p class="diagram-note">파란 점선이 Semaphore 허가입니다. dispatch 스레드가 얻고 callback 스레드가 돌려줍니다.</p>

일의 성격이 다른 세 가지를 각자의 풀로 나눴습니다.

| 풀 | 하는 일 | 스레드 / 큐 | 근거 |
| --- | --- | --- | --- |
| `fcm-dispatch` | 발송 루프, 허가 대기 | 2 / 100 | 큰 공지를 보내는 동안 다른 공지도 진행 |
| `fcm-default` | FCM HTTP 전송 (블로킹) | 200 / 2,000 | Little's Law 170 + 여유 |
| `fcm-callback` | 결과 DB 저장 | 4 / 100 | DB 커넥션 10개를 웹 요청과 나눠 씀 |

전송 풀은 10만 건을 60초에 보내려면 초당 약 1,700건이 필요합니다. 여기에 v4에서 구한 100ms를 곱하면 동시에 170건이 진행 중이어야 해요. 여유를 둬 200으로 잡았고, **core와 max를 같게** 맞췄습니다. 앞에서 본 것처럼 둘이 다르면 큐가 차기 전에는 max가 동작하지 않으니까요.

전송 풀은 `FirebaseOptions.setThreadManager()`로 SDK에 직접 넣어 줬습니다. FCM HTTP 타임아웃도 명시했어요(연결 10초, 읽기 30초). SDK 기본값 0은 무한 대기라, 응답이 끝나지 않는 요청 하나가 스레드와 허가를 영원히 잡을 수 있습니다.

### Semaphore: 거절 대신 기다리게

중복의 뿌리는 "큐가 넘쳐 거절된다"였습니다. 큐를 무제한으로 늘리면 거절은 없어지지만 10만 건이 메모리에 쌓이고 지연이 끝없이 늘어요. 그래서 **넣는 쪽에서 속도를 맞추기로** 했습니다. Backpressure입니다.

`java.util.concurrent.Semaphore`는 입장권 N장을 가진 카운터예요. `tryAcquire()`로 한 장 가져가고, 남은 게 없으면 누가 `release()`로 반납할 때까지 기다립니다. 락과 달리 N명까지 들어갈 수 있고, **받은 스레드와 반납하는 스레드가 달라도** 됩니다. 이 구조에서는 dispatch 스레드가 받고 callback 스레드가 반납해요.

```java
public boolean sendBatchAsync(Supplier<PreparedBatch> prepare) throws InterruptedException {
    if (!inFlightBatches.tryAcquire(acquireTimeoutSeconds, TimeUnit.SECONDS)) {
        return false;                      // 300초 넘게 못 얻으면 알림 후 중단
    }
    boolean permitHandedOver = false;
    PreparedBatch batch = null;
    try {
        batch = prepare.get();             // 허가를 얻은 뒤에 토큰 선점
        if (batch == null || batch.messages().isEmpty()) {
            return true;
        }
        ApiFuture<BatchResponse> future = FirebaseMessaging.getInstance().sendEachAsync(batch.messages());
        ApiFutures.addCallback(future, releasingPermit(batch.callback()), fcmCallbackExecutor);
        permitHandedOver = true;           // 반납 책임이 콜백으로 넘어감
        return true;
    } catch (RejectedExecutionException e) {
        if (batch != null) {
            batch.callback().onFailure(e); // 콜백이 등록되지 않은 경로도 실패 처리로 합류
        }
        return true;
    } finally {
        if (!permitHandedOver) {
            inFlightBatches.release();
        }
    }
}
```

허가 하나가 살아 있는 구간은 **허가 획득 → 토큰 선점 → 전송 → FCM 응답 → DB 저장 → 반납**입니다. 전송만 끝나고 반납하면 DB 저장이 밀리는 동안 다음 배치가 계속 들어와 callback 풀이 넘쳐요. 콜백이 거절되면 결과가 기록되지 않아 같은 중복 경로가 다시 생깁니다.

`permitHandedOver` 플래그는 어떤 경로로 빠져나가도 반납이 **정확히 한 번** 일어나게 합니다. 콜백 등록 전에 예외가 나면 `finally`가 돌려주고, 등록 뒤에는 콜백의 `finally`가 돌려줘요.

### 허가는 왜 3장인가

3은 아래쪽 한계와 위쪽 한계 사이에서 골랐습니다.

**아래쪽: 전송 스레드 200개가 놀지 않게.** 배치 하나만 돌리면 그 배치 끝부분에서 남은 메시지가 200건 아래로 떨어지고, DB 저장 중에는 전송 스레드가 전부 놉니다. 허가 3장이면 진행 중인 메시지가 최대 1,200건으로 스레드 수의 6배라, 한 배치가 저장 중이어도 다른 배치가 스레드를 채워요.

**위쪽: 전송 풀이 절대 거절하지 않게.** 앱이 뜰 때 아래 식을 `Assert.state()`로 검사합니다.

```
(허가 수 + 토큰 검증 배치 1) × 500 ≤ 스레드 200 + 큐 2,000

허가 3: 4 × 500 = 2,000 ≤ 2,200  통과
허가 4: 5 × 500 = 2,500 > 2,200  기동 실패
```

500은 `sendEach` 한 번의 최대 메시지 수입니다. 실제 배치는 400건이지만 최악을 가정했어요. **+1은 매주 일요일 새벽에 도는 토큰 정리 작업**입니다. 앱을 지운 기기의 토큰을 찾으려고 FCM에 dryRun으로 400건씩 보내 보는데, 같은 전송 풀을 쓰면서 Semaphore는 거치지 않아요. 대신 배치를 하나씩 순서대로 보내서 풀에 올라가는 건 한 번에 1개뿐입니다.

정리하면 3은 **이 풀 크기에서 거절이 구조적으로 불가능한 가장 큰 값**이에요. 설정을 잘못 바꾸면 앱이 아예 뜨지 않습니다. 2나 4와 따로 비교 측정하지는 않았습니다. 대신 결과에서 근거를 찾았어요. 10만 건 × 0.11초 ÷ 200 = 55초가 이론값인데 실측이 56초였습니다. 3장으로도 스레드 200개가 거의 쉬지 않았다는 뜻입니다.

이 Semaphore를 Bulkhead라고 부를 수도 있어요. 구현 도구는 같거든요. 하지만 Bulkhead는 의존 대상마다 자원을 나눠 한쪽 장애가 번지지 않게 막는 **격리**가 목적이고, 꽉 차면 보통 바로 거절합니다. 여기서는 대상이 FCM 하나라 나눌 칸이 없고, 거절을 없애는 게 목적이라 **기다리게** 했어요. 그래서 Backpressure라고 부릅니다.

### 행 잠금 선점: 두 경로가 같은 토큰을 집지 않게

Semaphore가 생기니 새 문제가 보였습니다. dispatch 스레드가 허가를 최대 300초까지 기다릴 수 있게 됐어요. 그동안 토큰은 `PENDING`으로 오래 남고, 폴링 릴레이가 이걸 "멈춘 발송"으로 보고 먼저 보낼 수 있습니다. 그 뒤 dispatch가 허가를 받아 같은 토큰을 또 보내면 중복이에요.

그래서 허가를 얻은 **뒤에** 토큰을 잠그고, 아직 아무도 손대지 않은 토큰만 가져가게 했습니다.

```sql
SELECT id, job_status FROM push_cluster_tokens
WHERE id IN (...) ORDER BY id FOR UPDATE
```

1. `FOR UPDATE`로 배치 토큰 행에 배타 락을 겁니다. 트랜잭션이 끝날 때까지 다른 트랜잭션은 이 행을 잠그거나 고칠 수 없어요.
2. 현재 상태가 기대한 값(즉시 발송은 `PENDING`, 재발송은 `RETRY_PENDING`)인 토큰만 고릅니다.
3. 고른 토큰만 `IN_PROGRESS`로 바꾸고 커밋한 뒤, **그 토큰으로만** 메시지를 만들어 보냅니다.

폴링 쪽도 같은 쿼리로 잠근 뒤, 조회했을 때와 상태가 그대로인 행만 처리합니다. 어느 쪽이 먼저 오든 한쪽만 성공해요. `ORDER BY id`는 잠그는 순서를 PK 오름차순 하나로 맞춰 두 경로가 서로 반대 순서로 잠가 데드락이 나는 걸 막습니다.

순서도 중요했습니다. v4는 허가 같은 대기 없이 바로 `IN_PROGRESS`로 표시했어요. v5에서 대기가 생긴 뒤에도 표시를 먼저 했다면, 기다리는 동안 그 표시가 오래돼 폴링이 "멈췄다"고 오판했을 겁니다.

## [성과 - 모의 FCM 10만 건]

2026년 10월 21일, 로컬 MacBook에 앱 한 대, Docker MySQL과 Redis로 쟀습니다. 웹훅 API부터 토큰 생성, 발송, 콜백 저장까지 실제 앱 경로를 그대로 쓰고, FCM HTTP 전송만 110ms 모의 응답으로 바꿨어요. 측정을 위해 폴링 주기는 5분, 멈춘 발송 판단 기준은 2분으로 줄였습니다.

| 지표 | v4 (1회) | v5 (3회) |
| --- | --- | --- |
| 모의 FCM 최대 동시 요청 | 128 | 200 / 200 / 200 |
| 발송 구간 | 374.2초 | 56.5 / 56.5 / 56.3초 |
| 발송 구간 처리량 | 267.8건/s | 약 1,771건/s |
| 웹훅 응답 | 500 | 200 |
| 큐 거절 | 1회 | 0 |
| 중복 | 208명 | 0 / 0 / 0 |

v4의 최대 동시 요청이 128인 것도 앞의 설명과 맞습니다. 평소엔 32개로 돌다가 큐 50,000이 꽉 찬 순간에만 max 128까지 늘어났어요.

발송 구간은 1분 목표를 넘지 않았습니다. 다만 웹훅을 받은 순간부터 마지막 결과 저장까지는 **94~98초**예요. 토큰 10만 행을 만드는 데 32~38초가 걸렸습니다. 다음 병목은 발송이 아니라 대량 INSERT입니다.

## [한계 - 아직 남은 것]

**정확히 한 번이 아닙니다.** FCM이 메시지를 받은 뒤 결과를 DB에 저장하기 전에 서버가 죽으면 토큰이 `IN_PROGRESS`로 남고, 폴링이 다시 보냅니다. FCM의 수락과 우리 DB 커밋을 한 트랜잭션으로 묶을 방법은 없어요. 보장 수준은 at-least-once이고, 208명 → 0명은 **큐 거절 경로**의 중복을 없앤 결과입니다. 이 구간을 줄이려면 앱 쪽에서 같은 알림을 한 번만 보여 주는 중복 제거가 함께 필요합니다.

**ABA가 가능합니다.** 선점은 상태값만 비교해요. 그 사이 `RETRY_PENDING → IN_PROGRESS → 실패 → RETRY_PENDING`으로 한 바퀴 돌아오면 오래된 릴레이도 선점에 성공할 수 있습니다. 세대 번호나 claim token을 같이 비교하는 보강이 남았어요.

**웹훅이 몰리면 dispatch가 넘칩니다.** 웹훅 1,000건이 21초 안에 들어오는 시나리오에서는 dispatch 큐(2 + 100)가 약 500건을 거절했습니다. 그 공지들은 `PENDING`으로 남아 폴링이 복구했고 중복은 0이었지만, 폴링 주기만큼 늦어져 처리량이 약 420건/s로 떨어졌어요.

**모의 FCM은 평균 하나만 재현합니다.** 실제 FCM의 지연 분포, 오류, 할당량은 이 실험에 없습니다. 운영에서는 FCM 호출 지연을 히스토그램으로 모아, 꼬리 지연이 늘면 풀 크기를 다시 계산해야 합니다. 200은 상수가 아니라 측정값으로 다시 구할 설정값이에요.

## [결론]

다섯 번 바꾸는 동안 한 일은 결국 하나였습니다. **스레드가 어디서 기다리는지 찾아서, 기다릴 필요 없는 곳에서는 없애고, 기다려야 하는 곳에는 그만큼의 스레드를 주는 것.**

- 요청 스레드는 FCM을 기다릴 이유가 없어서 콜백으로 풀어 줬습니다.
- 전송 스레드는 DB를 기다릴 이유가 없어서 콜백 풀을 나눴습니다.
- 전송 스레드는 FCM은 기다려야 해서 Little's Law로 필요한 만큼 늘렸습니다.
- 넣는 쪽은 받는 쪽이 감당할 만큼만 넣도록 Semaphore로 기다리게 했습니다.

그리고 버전을 올릴 때마다 새 대기가 생기지 않았는지 다시 봐야 했어요. Semaphore가 만든 300초 대기가 폴링과의 경합을 불러온 것처럼요.
