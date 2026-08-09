---
title: "메일 하나 읽었을 뿐인데 전체가 재처리됐습니다 (큐를 이벤트 타입마다 나눈 이유)"
description: "Pub/Sub 푸시 하나에 Gmail 조회, DB 저장, 알림 전송을 다 넣었더니 하나가 실패하면 전부 다시 왔습니다. 이벤트 종류별로 큐를 여섯 개로 나눈 과정입니다."
date: 2026-08-09
project: "메일상자"
tags: ["RabbitMQ", "Backpressure", "DLQ", "실패 격리", "Pub/Sub"]
featured: true
---

## [배경 - ACK를 못 보내면 같은 게 또 온다]

메일상자는 Gmail 계정을 연결해두면 새 메일이나 읽음 처리 같은 변화를 실시간으로 반영합니다. 구조는 이렇습니다.

Gmail의 `users.watch()` 로 변경을 구독하면 Google Pub/Sub이 저희 서버로 푸시를 보냅니다. 서버는 그 푸시를 받아서 Gmail History API로 "그 사이에 뭐가 바뀌었는지" 를 조회하고, 결과를 DB에 반영하고, 필요하면 앱에 알림을 보내요.

처음에는 이걸 전부 **푸시를 받은 그 요청 안에서** 처리했습니다. 조회하고, 저장하고, 알림 보내고, 그다음에 200을 돌려주는 식이었어요.

문제가 생긴 건 Gmail API가 느려졌을 때였습니다. 요청이 길어지니 Pub/Sub이 ACK를 못 받고 같은 푸시를 다시 보냅니다. 그런데 그 푸시 하나에는 변경 이벤트가 여러 개 들어 있어요. **한 건이 실패해서 재전송되면 이미 성공한 나머지도 전부 다시 처리됩니다.**

메일 하나를 읽음 처리했을 뿐인데 그 계정의 다른 변경까지 전부 다시 도는 상황이었어요.

## [문제 상황 분석 - 하나의 요청에 세 가지 성격이 섞여 있었다]

### 실패의 성격이 다릅니다

푸시 하나를 처리하는 동안 하는 일을 늘어놓아 보니 성격이 셋이었습니다.

| 작업 | 실패하면 | 재시도하면 |
| --- | --- | --- |
| OIDC 토큰 검증 | 요청 자체가 잘못됨 | 계속 실패한다 |
| Gmail API 조회 | 외부 지연 또는 쿼터 | 나중에 성공할 수 있다 |
| DB 반영 | 데이터 문제 또는 경쟁 | 경우에 따라 다르다 |

이 셋이 한 트랜잭션 안에 있으면 재시도 정책을 하나로만 쓸 수 있어요. 그런데 첫 번째는 재시도가 무의미하고 두 번째는 재시도가 답입니다.

### Pub/Sub의 재전송 단위가 너무 큽니다

더 큰 문제는 단위였어요. Pub/Sub은 **푸시 하나**를 단위로 재전송합니다. 그 안에 이벤트가 다섯 개 들어 있어도 쪼개서 보내주지 않아요.

```
[개선 전]
  Pub/Sub 푸시 1건
    ├─ 메일 추가    → 성공
    ├─ 읽음 처리    → 성공
    ├─ 휴지통 이동  → 실패 (Gmail API 타임아웃)
    ├─ 읽음 처리    → 성공
    └─ 복구         → 성공
                          ↓
              ACK 못 보냄 → 푸시 전체 재전송
                          ↓
              성공했던 4건도 다시 처리
```

즉 **실패의 폭발 반경이 푸시 단위**입니다. 이걸 이벤트 단위로 줄이는 게 목표가 됐어요.

### 왜 스레드 풀이 아니라 메시지 큐인가?

아주이벤트에서는 같은 종류의 문제를 애플리케이션 안의 스레드 풀로 풀었어요. 그때는 브로커를 하나 더 띄우는 비용이 아까웠습니다. 여기서는 반대로 갔는데, 이유가 세 개였습니다.

첫째, **작업이 죽으면 안 됩니다.** 스레드 풀 큐는 프로세스가 내려가면 사라져요. 메일 동기화는 유실되면 사용자 인박스가 실제와 어긋난 채로 남습니다.

둘째, **유입 속도를 제어해야 합니다.** Gmail API에는 사용자별 분당 쿼터가 있어요. 스레드 풀은 큐가 차면 스레드를 늘리는 방향으로 움직이는데, 여기서는 반대로 **덜 부르는** 게 맞습니다.

셋째, **실패한 것만 따로 모아야 합니다.** DLQ 같은 장치를 직접 만들면 결국 브로커를 다시 구현하게 돼요.

## [해결 방법 - 앞단은 분류만, 뒷단은 이벤트 단위로]

### 요청 안에서는 분류하고 발행만 합니다

푸시를 받는 쪽은 이 순서로만 움직입니다.

```java
public void handlePush(String authorizationHeader, GooglePubsubPushRequest request) {
    googlePubsubOidcApiService.validateAuthorization(authorizationHeader);
    GoogleMailPushNotificationResult notification = request.decode(objectMapper);
    List<MailAccount> mailAccounts =
        mailAccountQueryService.findSyncableGoogleMailAccountsByEmailAddress(notification.emailAddress());

    for (MailAccount rawAccount : mailAccounts) {
        processAccountPush(notification, rawAccount);
    }
}

private void processAccountPush(GoogleMailPushNotificationResult notification, MailAccount rawAccount) {
    MailAccount mailAccount = googleAccessTokenEnsureService.ensureValidGoogleAccessToken(rawAccount);

    GoogleMailHistoryListResult historyResult = gmailHistoryApiService.getHistory(
            mailAccount.getAccessToken(),
            mailAccount.resolveStartHistoryId(notification.historyId())
    );

    List<GmailHistoryEvent> historyEvents = gmailHistoryEventClassifier.classify(mailAccount, historyResult);
    gmailHistoryEventPublisher.publishAll(historyEvents);
    mailAccountCommandService.updateSyncHistoryId(mailAccount, historyResult.historyId());
    // ...
}
```

History 조회는 여전히 요청 안에 있습니다. 이건 뺄 수 없었어요. Gmail의 History API는 "어느 historyId 이후" 를 물어봐야 하는데, 그 시작점을 관리하는 게 이 계정의 상태라서요. 대신 **조회 결과를 처리하는 일**은 전부 큐 뒤로 넘어갔습니다.

### 이벤트를 여섯 종류로 나눕니다

분류기가 History 응답을 읽어서 이벤트로 바꿔요. 종류는 여섯 개입니다.

```java
classifyMessagesAdded(deduplicatedEvents, mailAccount, historyId, messagesAdded, draftMessageIds);
classifyLabelChanges(deduplicatedEvents, mailAccount, historyId, labelsRemoved, MESSAGE_READ, UNREAD_LABEL_ID);
classifyLabelChanges(deduplicatedEvents, mailAccount, historyId, labelsAdded,   MESSAGE_UNREAD, UNREAD_LABEL_ID);
classifyLabelChanges(deduplicatedEvents, mailAccount, historyId, labelsAdded,   MESSAGE_TRASHED, TRASH_LABEL_ID);
classifyLabelChanges(deduplicatedEvents, mailAccount, historyId, labelsRemoved, MESSAGE_RESTORED, TRASH_LABEL_ID);
classifyPermanentlyDeletedMessages(deduplicatedEvents, mailAccount, historyId, messagesDeleted);
```

Gmail의 History 응답은 사실 라벨 변경 목록입니다. `UNREAD` 라벨이 빠지면 읽은 거고, `TRASH` 라벨이 붙으면 휴지통으로 간 거예요. 이걸 도메인 이벤트로 번역하는 게 분류기의 일입니다.

`deduplicatedEvents` 가 `LinkedHashMap` 인 것도 이유가 있어요. 같은 메시지에 대해 같은 종류의 변경이 여러 History 항목에 걸쳐 나올 수 있습니다. 키가 같으면 나중 것이 앞의 것을 덮어써요. 순서는 유지되고 중복만 접힙니다.

### 종류마다 큐를 따로 팝니다

여기가 이 글의 핵심입니다. 여섯 종류를 하나의 큐에 넣지 않고 **큐를 여섯 개** 만들었어요.

```
mailsangja.event.gmail.message-added
mailsangja.event.gmail.message-read
mailsangja.event.gmail.message-unread
mailsangja.event.gmail.message-trashed
mailsangja.event.gmail.message-restored
mailsangja.event.gmail.message-permanently-deleted
```

각각에 DLQ가 하나씩 더 붙으니 실제로는 열두 개입니다. 처음에는 과하다고 생각했어요. 지금은 이게 맞다고 봅니다.

이유는 **처리 비용과 실패 확률이 종류마다 다르기 때문**이에요.

`message-added` 는 새 메일이라 Gmail Thread API를 다시 불러 본문을 가져와야 합니다. 무겁고 외부 호출이 있어요. 반면 `message-read` 는 DB의 플래그 하나를 바꾸는 일입니다. 가볍고 외부 호출이 없어요.

이 둘을 한 큐에 넣으면 무거운 쪽이 밀릴 때 가벼운 쪽도 같이 밀립니다. 읽음 표시가 안 되는 건 사용자에게 바로 보이는 문제예요.

설정도 다르게 잡았습니다.

```yaml
gmail-history:
  message-added-concurrency: ${GMAIL_MESSAGE_ADDED_CONCURRENCY:3}
  message-added-prefetch: ${GMAIL_MESSAGE_ADDED_PREFETCH:3}
  state-concurrency: ${GMAIL_HISTORY_STATE_CONCURRENCY:5}
  state-prefetch: ${GMAIL_HISTORY_STATE_PREFETCH:10}
```

`message-added` 는 컨슈머 3개에 prefetch 3, 상태 변경 계열은 컨슈머 5개에 prefetch 10입니다. **prefetch가 backpressure의 손잡이예요.** 컨슈머가 한 번에 쥐고 있을 메시지 수를 제한하니, 큐에 100건이 쌓여도 서버가 동시에 붙잡는 건 그 숫자만큼입니다.

상태 변경 계열 다섯 개는 처리 성격이 같아서 ContainerFactory 하나를 공유합니다. 큐는 나누되 설정은 묶은 거예요.

### 재시도는 늘려가며, 소용없는 예외는 빼고

각 큐마다 재시도 정책이 붙습니다.

```java
static MethodInterceptor createRetryInterceptor(MailTaskRabbitProperties properties, MessageRecoverer recoverer) {
    return RetryInterceptorBuilder.stateless()
            .configureRetryPolicy(policy -> policy
                    .maxRetries(MAX_RETRIES)
                    .excludes(MailAccountNotFoundException.class)
                    .delay(Duration.ofMillis(properties.getRetryInitialInterval()))
                    .multiplier(properties.getRetryMultiplier())
                    .maxDelay(Duration.ofMillis(properties.getRetryMaxInterval())))
            .recoverer(recoverer)
            .build();
}
```

값은 yml에 있어요.

```yaml
retry-initial-interval: ${MAIL_TASK_RETRY_INITIAL_INTERVAL:30000}
retry-multiplier: ${MAIL_TASK_RETRY_MULTIPLIER:2.0}
retry-max-interval: ${MAIL_TASK_RETRY_MAX_INTERVAL:300000}
```

30초에서 시작해 두 배씩 늘어나고 5분에서 멈춥니다. 최대 3회예요. 그러니까 30초, 60초, 120초 간격으로 세 번 더 시도합니다.

`excludes(MailAccountNotFoundException.class)` 가 중요합니다. 계정이 지워졌으면 몇 번을 시도해도 결과가 같아요. 이런 예외는 재시도 없이 바로 DLQ로 보냅니다. **재시도할 가치가 있는 실패와 없는 실패를 코드에 적어둔 셈**이에요.

`stateless()` 를 쓴 것도 짚고 갈 부분입니다. stateful 재시도는 브로커에 메시지를 되돌려놓고 다시 받는 방식인데, 그러면 재시도 간격 동안 그 메시지가 큐 앞을 막습니다. stateless는 컨슈머 스레드가 붙잡고 기다려요. 대기 시간만큼 스레드를 쓰는 대신 큐가 막히지 않습니다.

### 재시도를 다 쓰면 DLQ로 보내고 알립니다

```java
return (message, cause) -> {
    log.warn(
            "Gmail message-added retries exhausted. routingKey={} messageId={} payloadSize={}B",
            properties.getDeadLetterRoutingKey(EVENT_TYPE),
            message.getMessageProperties().getMessageId(),
            message.getBody().length,
            cause
    );
    discordAlertService.sendDlqAlert(message, cause);
    throw new AmqpRejectAndDontRequeueException("Gmail message-added retries exhausted", cause);
};
```

Discord로 알림이 갑니다. 이게 없으면 DLQ는 아무도 안 보는 무덤이 돼요. 아주이벤트에서 상태를 잘게 나눠놓고 정작 보는 경로를 안 만들었던 실수를 여기서는 안 하려고 했습니다.

`factory.setDefaultRequeueRejected(false)` 도 같이 봐야 합니다. 이게 `true` 면 실패한 메시지가 큐 맨 앞으로 돌아가서 무한 루프가 돼요. 처음에 이걸 몰라서 같은 메시지가 초당 수십 번 처리되는 걸 본 적이 있습니다.

## [성과 - 개선 전후 비교]

구조가 이렇게 바뀌었습니다.

| 항목 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 재처리 단위 | Pub/Sub 푸시 1건 (이벤트 N개) | 이벤트 1건 |
| 실패 전파 | 1건 실패 시 전체 재처리 | 해당 이벤트만 재시도 |
| 응답 시점 | 모든 처리 완료 후 | 큐 발행 직후 |
| 유입 제어 | 없음 | prefetch 3 / 10 |
| 재시도 정책 | 단일 | 예외 종류별 분기, 30초 시작 지수 증가 |
| 실패 보관 | 없음 (로그만) | 큐별 DLQ + Discord 알림 |

수치로 적을 수 있는 건 여기까지입니다. 처리량이나 지연 시간을 개선 전후로 비교한 값은 없어요. 구조를 바꾸면서 부하 테스트를 안 돌렸습니다.

<!-- 측정 필요: 동일 조건 부하 비교.
     1) 이벤트 100건 유입 시 Pub/Sub 요청 응답 시간 P95 (개선 전후)
     2) 1건 강제 실패 시 실제로 재처리되는 이벤트 수
     3) prefetch 3 vs 10 에서 Gmail API 429 발생률 -->

솔직하게 적으면, 이 변경은 **성능 개선이 아니라 실패 범위 축소**입니다. 빨라진 게 아니라 하나가 넘어져도 나머지가 서 있게 된 거예요.

## [결론]

정리하면 셋입니다.

- 요청 안에서 외부 API와 DB를 다 처리하면 재전송 단위가 요청 전체가 된다
- 큐를 나누는 기준은 도메인이 아니라 처리 비용과 실패 확률이다
- prefetch는 성능 손잡이가 아니라 유입 제어 손잡이다

한계도 적어둘게요.

첫째, **순서 보장이 없습니다.** 큐를 나눈 대가예요. "메일 수신 → 읽음 → 휴지통" 이 서로 다른 큐로 흩어지니 처리 순서가 뒤집힐 수 있습니다. 지금은 각 이벤트에 `historyId` 를 실어 보내지만, 이 값을 비교해서 과거 상태를 무시하는 처리는 아직 안 넣었어요. 컨슈머 concurrency를 올리면 바로 드러날 문제입니다.

둘째, **historyId 갱신 시점이 위험합니다.** 이벤트를 발행한 직후에 계정의 `syncHistoryId` 를 갱신하는데, 발행은 됐지만 컨슈머가 전부 실패해서 DLQ로 갈 수도 있어요. 그러면 서버는 "여기까지 동기화했다" 고 기록해뒀는데 실제로는 반영이 안 된 상태가 됩니다. 발행 성공과 처리 성공을 같은 것으로 취급하고 있는 셈이에요.

셋째, **큐가 열두 개라 운영 부담이 있습니다.** 큐 하나를 추가하려면 Properties, Config, Listener를 다 손봐야 해요. 그래서 등록 절차를 문서로 고정해뒀는데, 문서로 막는 건 결국 사람에 기대는 방법입니다.

넷째, **DLQ에서 되돌리는 경로가 없습니다.** 알림은 오는데, 고친 뒤 그 메시지를 다시 흘려보내려면 수동으로 옮겨야 해요.

큐를 여섯 개로 나눌 때 과하다고 생각했는데, 실제로 겪어보니 **하나로 합쳐두면 문제가 생겼을 때 나눌 수가 없다**는 게 더 큰 비용이었습니다.
