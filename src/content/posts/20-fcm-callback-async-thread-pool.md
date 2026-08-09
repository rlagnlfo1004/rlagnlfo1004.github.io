---
title: "비동기 SDK를 쓰는데 서블릿 스레드가 묶였습니다 (Future.get 제거와 콜백 풀 분리)"
description: "Firebase SDK는 이미 비동기였습니다. 블로킹을 만든 건 제 코드의 Future.get() 한 줄이었어요. 그리고 그걸 지운 뒤에 두 번째 병목이 나왔습니다."
date: 2026-08-09
project: "아주이벤트"
tags: ["FCM", "비동기", "스레드 풀", "부하 테스트"]
---

## [배경 - 공지 하나에 서버가 느려졌다]

아주이벤트는 학교 공지 게시판 50여 개를 크롤링해서 새 글이 올라오면 푸시로 알려주는 서비스입니다. 크롤러가 새 공지를 감지하면 웹훅으로 서버에 알리고, 서버는 그 게시판을 구독한 사람 전원에게 FCM 푸시를 보내요.

문제는 이 "전원"이 한 번에 나간다는 겁니다. 구독자가 많은 게시판이면 수백 건이 동시에 발송돼요. 그 순간에 다른 API 응답이 눈에 띄게 느려졌습니다.

처음에는 FCM이 느린 거라고 생각했어요. 외부 API니까 어쩔 수 없다고요. 그런데 스레드 덤프를 떠보니 그림이 달랐습니다. 서블릿 스레드와 Firebase 내부 스레드가 거의 1:1로 같이 늘어나 있었어요.

FCM이 느린 게 아니라, **제가 FCM을 기다리고 있었습니다.**

## [문제 상황 분석 - 비동기 SDK 위에 얹은 동기 코드]

### Firebase SDK는 원래 비동기입니다

`FirebaseMessaging` 이 제공하는 발송 메서드는 두 갈래예요.

| 메서드 | 반환 | 호출 스레드 |
| --- | --- | --- |
| `sendEach(...)` | `BatchResponse` | HTTP 응답까지 블로킹 |
| `sendEachAsync(...)` | `ApiFuture<BatchResponse>` | 즉시 반환 |

저는 `sendEachAsync` 를 쓰고 있었습니다. 그러니까 비동기 API를 쓴 게 맞아요. 문제는 그 다음 줄이었습니다.

```java
ApiFuture<BatchResponse> future = FirebaseMessaging.getInstance().sendEachAsync(messages);
BatchResponse response = future.get();   // 여기
// 결과를 보고 성공/실패 카운트를 갱신
```

`get()` 을 부르는 순간 비동기의 의미가 사라집니다. SDK 내부 스레드가 HTTP 요청을 처리하는 동안, 서블릿 스레드는 그 결과를 기다리며 그냥 서 있어요. 스레드를 하나 더 쓰면서 대기 시간은 그대로인 구조입니다.

```
[개선 전]
  http-nio-8080-exec-1 ──┐
                         │ future.get() 으로 대기
  firebase-internal-3  ──┴──> FCM HTTP ──> 응답 ──> 반환
       (실제 일하는 쪽)          (수백 ms ~ 수 초)

  서블릿 스레드는 이 구간 내내 점유된 상태
```

스레드 덤프에서 본 1:1 증가가 이거였어요. 발송 대상이 늘어날수록 대기 중인 서블릿 스레드가 같이 늘고, 톰캣 워커가 마르면 푸시와 상관없는 목록 조회 API까지 느려집니다.

### 콜백으로 바꿨는데 또 막혔습니다

그래서 `get()` 을 지우고 콜백으로 바꿨습니다. `ApiFutures.addCallback` 으로 결과 처리를 넘기면 서블릿 스레드는 바로 돌아갈 수 있어요.

여기까지는 예상대로였습니다. 그런데 부하를 올리니 이번에는 다른 곳이 밀렸어요.

콜백 안에서 하는 일이 가볍지 않았기 때문입니다. FCM 응답에는 토큰별 성공 여부가 배열로 들어 있고, 그걸 읽어서 토큰 상태를 갱신하고, 만료된 토큰은 soft delete 하고, 클러스터 단위 성공/실패 카운트를 증가시킵니다. 전부 DB 쓰기예요.

`addCallback` 에 Executor를 넘기지 않으면 콜백은 SDK가 관리하는 스레드에서 실행됩니다. 즉 **Firebase 응답을 받아야 할 스레드가 DB 트랜잭션을 기다리게 돼요.** 앞의 병목을 옮겨놓은 것에 가까웠습니다.

정확히는 이렇습니다. 첫 번째 병목은 "요청 스레드가 외부 API를 기다림"이었고, 두 번째 병목은 "외부 API 응답 스레드가 DB를 기다림"이었어요. 대기 대상만 바뀌었습니다.

### 왜 메시지 큐를 쓰지 않았나?

이 시점에 선택지가 셋이었어요.

첫째, DB Polling 기반 발송입니다. 발송 대상을 테이블에 넣고 스케줄러가 긁어서 보내는 방식이에요. 구조는 단순하지만 폴링 주기만큼 지연이 생깁니다. 공지 알림은 늦게 가면 가치가 떨어져서 버렸어요.

둘째, RabbitMQ 같은 외부 메시지 큐입니다. 지금 봐도 이게 정석이에요. 다만 그때 이 서비스는 단일 인스턴스였고, 브로커를 하나 더 띄우면 운영해야 할 게 늘어납니다. 가입자 466명 규모에서 감당할 이유를 못 찾았어요.

셋째, 애플리케이션 안에서 스레드 풀을 나누는 방법입니다. 인프라가 늘지 않고 실시간성도 유지돼요. 대신 프로세스가 죽으면 큐에 있던 작업이 같이 사라집니다.

셋째를 골랐습니다. 세 번째의 약점인 "프로세스가 죽으면 사라진다"는 별도로 풀어야 할 문제로 남겨뒀고, 그건 [Transactional Outbox 글](/posts/21-transactional-outbox-push-recovery/)에 따로 적었어요.

## [해결 방법 - 콜백 전용 Executor와 400건 batch]

### 콜백을 실행할 스레드를 지정합니다

`ApiFutures.addCallback` 은 세 번째 인자로 Executor를 받습니다. 여기에 전용 풀을 넘겼어요.

```java
@Service
@RequiredArgsConstructor
public class FcmPushService {

    private final Executor fcmCallbackExecutor;

    public void sendBatchAsync(List<Message> messages, ApiFutureCallback<BatchResponse> callback) {
        ApiFutures.addCallback(
            FirebaseMessaging.getInstance().sendEachAsync(messages),
            callback,
            fcmCallbackExecutor
        );
    }
    // ...
}
```

메서드가 이게 전부입니다. 짧지만 이 세 줄이 두 개의 경계를 만들어요. 요청 스레드와 발송 스레드가 갈라지고, 발송 스레드와 결과 처리 스레드가 다시 갈라집니다.

```
[개선 후]
  http-nio-8080-exec-1 ──> sendEachAsync 호출 후 즉시 반환

  firebase-internal-3  ──> FCM HTTP ──┐
                                      │ 완료 시 콜백 제출
  fcm-callback-2       <──────────────┘
       └─> 토큰 상태 갱신, 카운트 증가, 만료 토큰 정리 (DB)
```

### 풀 설정은 두 개로 나눴습니다

Executor는 `FcmConfig` 에서 두 개를 만듭니다.

```java
@Bean(name = "fcmCallbackExecutor")
public ThreadPoolTaskExecutor fcmCallbackExecutor() {
    FcmExecutorProperties.Pool pool = fcmExecutorProperties.getCallback();
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(pool.getCorePoolSize());
    executor.setMaxPoolSize(pool.getMaxPoolSize());
    executor.setQueueCapacity(pool.getQueueCapacity());
    executor.setThreadNamePrefix("fcm-callback-");
    executor.setWaitForTasksToCompleteOnShutdown(true);
    executor.setAwaitTerminationSeconds(pool.getAwaitTerminationSeconds());
    executor.setTaskDecorator(mdcTaskDecorator);
    executor.initialize();
    return executor;
}
```

값은 yml에 있어요.

```yaml
ajou:
  fcm:
    executor:
      callback:
        core-pool-size: 8
        max-pool-size: 32
        queue-capacity: 500
        await-termination-seconds: 30
      default-pool:
        core-pool-size: 32
        max-pool-size: 128
        queue-capacity: 50000
        await-termination-seconds: 30
```

두 풀의 성격이 다릅니다. 콜백 풀은 DB를 만지니까 커넥션 풀 크기를 넘어서면 의미가 없어요. 그래서 작게 잡았습니다. 기본 풀은 발송 작업을 담아두는 쪽이라 큐를 크게 뒀어요.

여기서 한 가지 짚고 갈 게 있습니다. `ThreadPoolTaskExecutor` 는 **큐가 먼저 차고 그다음에 스레드가 늘어납니다.** callback 풀은 큐 500이 가득 차기 전까지 스레드가 8개를 넘지 않아요. max 32는 큐까지 넘쳤을 때 비로소 의미가 생깁니다. 이걸 모르고 max만 키우면 아무 일도 일어나지 않습니다.

`setWaitForTasksToCompleteOnShutdown(true)` 도 일부러 넣었어요. 배포로 인스턴스를 내릴 때 큐에 남은 결과 처리가 그냥 날아가면 발송은 됐는데 상태만 PENDING으로 남습니다.

두 풀 모두에 `mdcTaskDecorator` 가 붙어 있는데, 이건 스레드가 갈라지면서 로그의 traceId가 끊긴 문제 때문입니다. 그 얘기는 [MDC와 TaskDecorator 글](/posts/03-mdc-async-traceid/)에 따로 적었어요.

### 400건씩 끊어 보냅니다

한 번에 전 대상을 밀어넣지 않고 400건 단위로 자릅니다.

```java
List<List<PushClusterToken>> batches = splitIntoBatches(clusterTokens, 400);
for (List<PushClusterToken> batch : batches) {
    fcmPushResultService.markBatchAsSendingAndSave(batch);
    List<Message> messages = fcmPushService.buildMessages(cluster.getId(), batch, command, unreadCountMap);
    sendFcmBatch(cluster, batch, messages);
}
```

배치로 자르는 이유는 세 가지예요.

첫째, FCM의 `sendEach` 계열은 한 요청에 담을 수 있는 메시지 수에 상한이 있습니다. 둘째, 콜백 하나가 처리할 DB 쓰기 양이 예측 가능해져요. 400건짜리 트랜잭션이 반복되는 편이 5,000건짜리 하나보다 다루기 쉽습니다. 셋째, 실패 단위가 배치로 좁아집니다. 한 배치가 실패해도 나머지 배치는 이미 나간 상태예요.

배치를 보내기 직전에 `markBatchAsSendingAndSave` 로 상태를 먼저 바꾸는 것도 의도가 있습니다. 이 표시가 없으면 서버가 중간에 죽었을 때 어디까지 보냈는지 알 수 없어요.

## [성과 - 개선 전후 비교]

k6로 200 VU 부하를 걸어 비교했습니다. 분당 10만 건 규모의 발송 시나리오예요.

| 지표 | 개선 전 | 개선 후 | 변화 |
| --- | --- | --- | --- |
| P95 응답 시간 | 5.24초 | 2.53초 | 약 51% 단축 |
| 최대 응답 시간 | 8.33초 | 3.51초 | 약 58% 감소 |

수치를 어떻게 읽어야 하는지 같이 적어둘게요.

이건 **사용자 API가 빨라졌다는 뜻이 아닙니다.** 대량 발송이 진행되는 동안 요청 처리 스레드가 얼마나 오래 묶여 있는지를 잰 값이에요. 평상시 응답 시간과는 다른 축입니다.

그리고 이 200 VU라는 숫자에는 근거가 없었습니다. 실제 서비스는 최근 90일 동안 75,000건을 보냈으니 하루 평균 830건이에요. 분당 10만 건은 실트래픽이 아니라 제가 임의로 잡은 시나리오입니다. 이 부분은 [따로 회고](/posts/07-retro-overengineering/)를 썼어요.

정직하게 정리하면, **구조적 결함은 실재했고 수정은 정당했지만 검증 규모는 근거 없이 컸습니다.**

## [결론]

배운 걸 세 줄로 줄이면 이렇습니다.

- 비동기 SDK를 쓴다고 비동기가 되지 않는다. `get()` 한 줄이 전부를 되돌린다
- 병목을 없앴다고 생각한 지점이 사실은 옮겨간 지점일 수 있다
- 스레드 풀을 나눌 때는 그 풀이 무엇을 기다리는지 기준으로 나눈다

남은 한계도 적어둘게요.

첫째, **프로세스가 죽으면 큐에 있던 작업이 사라집니다.** 애플리케이션 내부 큐를 선택한 대가예요. 이건 Outbox로 따로 막았지만, 그렇다고 큐가 안전해진 건 아닙니다. 복구 경로가 생겼을 뿐이에요.

둘째, **콜백 풀 크기와 커넥션 풀 크기를 연결해서 정하지 않았습니다.** core 8은 감으로 잡은 값이에요. 콜백이 전부 DB를 만지니 HikariCP 최대 커넥션 수를 기준으로 계산했어야 맞습니다.

셋째, **배치 크기 400도 근거가 약합니다.** FCM 상한과 트랜잭션 크기를 같이 고려해 정했지만, 실제로 200이나 800과 비교해보지는 않았어요.

넷째, **콜백 안에서 예외가 나면 어떻게 되는지를 오래 몰랐습니다.** `onFailure` 는 FCM 에러 코드가 아니라 네트워크 단절 같은 Java 레벨 예외로 들어와요. 이 둘을 같은 실패로 묶으면 재시도 정책이 엉킵니다.

`get()` 을 지우는 데는 1분이 걸렸고, 그게 왜 문제인지 이해하는 데는 훨씬 오래 걸렸습니다.
