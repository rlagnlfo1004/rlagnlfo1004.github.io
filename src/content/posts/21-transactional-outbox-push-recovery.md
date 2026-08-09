---
title: "서버를 강제로 죽였더니 49,600건이 사라졌습니다 (Transactional Outbox와 6단계 상태 머신)"
description: "공지 저장은 트랜잭션으로 지키는데 발송은 못 지킵니다. 어디까지 보냈는지 알 수 없는 상태를 없애려고 상태를 테이블에 적기 시작했어요."
date: 2026-08-09
project: "아주이벤트"
tags: ["Outbox", "At-Least-Once", "상태 머신", "Exponential Backoff", "ShedLock"]
featured: true
---

## [배경 - 배포 중에 알림이 안 갔다는 제보]

FCM 발송을 비동기로 바꾸고 나서 한동안 잘 돌아갔습니다. 그러다 배포를 하나 했는데, 그 시간대에 올라온 공지의 알림을 못 받았다는 얘기를 들었어요.

원인은 금방 짐작이 갔습니다. 발송 작업이 애플리케이션 안의 스레드 풀 큐에 들어 있었고, 인스턴스를 내리면서 그 큐가 통째로 없어진 겁니다.

문제는 그 다음이었어요. **누구에게 갔고 누구에게 안 갔는지 알 방법이 없었습니다.** 로그를 뒤져도 "발송 시작" 만 있고 결과가 없어요. 다시 보내려면 대상자를 처음부터 다시 계산해야 하는데, 그러면 이미 받은 사람에게 두 번 갑니다.

재현을 해봤습니다. 10만 건 발송 시나리오를 돌리다가 250개 배치 중 127번째를 처리하기 직전에 서버를 강제 종료했어요. 남은 대상이 약 **49,600건**이었고, 그 49,600건이 어떤 상태인지 서버는 아무것도 모르는 상태였습니다.

## [문제 상황 분석 - 트랜잭션이 닿지 않는 구간]

### 저장은 지키는데 발송은 못 지킵니다

공지 저장은 DB 트랜잭션이 보장합니다. 커밋되면 남고, 롤백되면 없어요. 그런데 FCM 발송은 외부 HTTP 호출입니다. 여기에는 트랜잭션이 걸리지 않아요.

즉 이런 조합이 가능합니다.

| 공지 저장 | FCM 발송 | 결과 |
| --- | --- | --- |
| 성공 | 성공 | 정상 |
| 성공 | 실패 | 공지는 있는데 알림이 없음 |
| 성공 | 결과 모름 | 재발송해야 할지 판단 불가 |
| 롤백 | 성공 | 없는 공지의 알림이 나감 |

세 번째가 제일 나빴어요. 실패는 재시도하면 되는데, "모름"은 아무 판단도 못 합니다.

### Exactly-Once 는 포기했습니다

정확히 한 번만 보내는 걸 먼저 노려봤어요. 결론부터 말하면 안 됩니다.

FCM은 멱등키를 받지 않습니다. 같은 메시지를 두 번 보내면 두 번 도착해요. 서버가 "이 토큰에는 이미 보냈다" 를 기록하려 해도, 기록하는 순간과 실제로 전송된 순간 사이에는 항상 틈이 있습니다. 그 틈에서 죽으면 판단이 어긋나요.

그래서 방향을 바꿨습니다. **중복 발송과 알림 유실 중 무엇이 더 나쁜가**를 정하는 문제로요.

공지 알림 서비스에서는 답이 명확했어요. 같은 알림이 두 번 오면 사용자는 짜증을 내지만, 안 오면 마감을 놓칩니다. 그래서 At-Least-Once를 선택했습니다. 중복은 허용하고 유실은 막는 쪽이에요.

이건 서비스 성격에 따라 완전히 뒤집힐 수 있는 판단입니다. 결제 알림이었다면 반대로 갔을 거예요.

## [해결 방법 - 발송 대상을 테이블에 적는다]

### 공지 저장과 같은 트랜잭션에서 대상을 확정합니다

핵심은 단순합니다. 발송 대상을 메모리 큐가 아니라 DB에 적어두는 거예요. 공지를 저장하는 그 트랜잭션 안에서요.

테이블은 두 층입니다.

```
push_clusters            발송 건 하나 (공지 1개 = 클러스터 1개)
  ├─ job_status          클러스터 전체 상태
  ├─ total_count         대상 토큰 수
  ├─ success_count / fail_count              초기 발송 결과
  └─ retry_success_count / retry_fail_count  재시도 결과

push_cluster_tokens      대상 토큰 하나하나 (클러스터 1개 = N행)
  ├─ job_status          이 토큰의 상태
  ├─ retry_count         재시도 횟수
  └─ retry_after         언제 이후에 다시 시도할지
```

토큰 단위로 행을 만드는 게 이 구조의 값입니다. 클러스터 단위로만 상태를 두면 "절반쯤 실패" 를 표현할 수 없어요. 49,600건을 다시 계산해야 했던 이유가 정확히 이거였습니다.

```java
private void savePushClusterTokens(PushCluster cluster, List<Token> activeTokens) {
    List<PushClusterToken> clusterTokens = activeTokens.stream()
        .map(token -> PushClusterToken.builder()
            .pushCluster(cluster)
            .member(token.getMember())
            .tokenValue(token.getTokenValue())
            .jobStatus(JobStatus.PENDING)
            .requestTime(LocalDateTime.now())
            .build())
        .collect(Collectors.toList());
    pushClusterTokenRepositoryPort.bulkSaveAll(clusterTokens);
}
```

`@Transactional` 이 붙은 `createTopicPushCluster` 안에서 클러스터와 토큰 행이 같이 저장됩니다. 커밋이 되면 발송 대상이 DB에 남고, 롤백되면 둘 다 없어요. 여기까지가 Outbox 패턴이 하는 일입니다.

### 상태를 여섯 개로 나눴습니다

토큰 행이 가질 수 있는 상태는 여섯 개예요.

| 상태 | 의미 | 다음 |
| --- | --- | --- |
| `PENDING` | 대상으로 등록됨. 아직 안 보냄 | 발송 시도 |
| `IN_PROGRESS` | FCM에 요청을 보냈고 결과 대기 중 | 성공 또는 실패 판정 |
| `SUCCESS` | FCM이 접수함 | 끝 |
| `RETRY_PENDING` | 일시적 실패. `retry_after` 이후 재시도 | 다시 발송 |
| `FAIL` | 재시도해도 같은 결과인 실패 | 끝 |
| `PERMANENT_FAIL` | 재시도 한도 초과 또는 설정 오류 | 끝 (사람이 봐야 함) |

`FAIL` 과 `PERMANENT_FAIL` 을 나눈 게 처음에는 과하다고 생각했어요. 지금은 이 구분이 제일 쓸모 있습니다. `FAIL` 은 토큰이 죽은 정상적인 결과고, `PERMANENT_FAIL` 은 시스템에 뭔가 잘못됐다는 신호예요. 대시보드에서 봐야 할 건 후자입니다.

상태 전이는 엔티티가 직접 갖고 있습니다.

```java
public void markAsRetryPending(LocalDateTime retryAfter) {
    this.jobStatus = JobStatus.RETRY_PENDING;
    this.retryCount++;
    this.retryAfter = retryAfter;
    this.processedTime = LocalDateTime.now();
}
```

`retryCount++` 가 상태 전이 안에 들어 있는 게 중요해요. 카운터를 밖에서 올리면 언젠가 빠뜨립니다.

### 에러 코드마다 다음 상태가 다릅니다

FCM이 돌려주는 에러 코드를 전부 같은 실패로 묶으면 재시도가 낭비가 됩니다. 코드별로 갈랐어요.

```java
switch (errorCode) {
    case INTERNAL:
    case UNAVAILABLE:
        // FCM 서버 일시 오류 — 클라이언트 요청 자체에는 문제 없음. 재시도 대기
        markAsRetryPendingOrPermanentFail(token, false);
        return 0;

    case QUOTA_EXCEEDED:
        // 프로젝트 전송 속도 제한 초과 — 쿼터 회복 여유를 위해 대기 시간 2배 적용
        markAsRetryPendingOrPermanentFail(token, true);
        return 0;

    case UNREGISTERED:
        // 앱 삭제 또는 토큰 만료 — 재시도해도 동일 실패. 즉시 영구 실패 + 토큰 삭제
        token.markAsFail();
        invalidTokenValues.add(token.getTokenValue());
        return 1;
    // ...
}
```

`UNREGISTERED` 를 재시도하는 건 의미가 없어요. 앱을 지운 사람에게 몇 번을 보내도 결과는 같습니다. 그래서 여기서는 토큰 자체를 지웁니다. 이 정리를 안 하면 죽은 토큰이 계속 쌓여서 발송 대상 수만 부풀어요.

`SENDER_ID_MISMATCH` 는 조금 다르게 다룹니다. 이건 Firebase 프로젝트 설정이 어긋났다는 뜻이라 사람이 봐야 해요. 그래서 `PERMANENT_FAIL` 로 표시하고 Discord로 알림을 보냅니다.

### 대기 시간은 2의 거듭제곱입니다

재시도 간격은 실패 횟수에 따라 늘어납니다.

```java
private void markAsRetryPendingOrPermanentFail(PushClusterToken token, boolean quotaExceeded) {
    if (token.getRetryCount() >= pushProperties.getMaxRetryCount()) {
        token.markAsPermanentFail();
        return;
    }
    long delayMinutes = (long) Math.pow(2, token.getRetryCount());
    if (quotaExceeded) {
        delayMinutes *= 2;
    }
    token.markAsRetryPending(LocalDateTime.now().plusMinutes(delayMinutes));
}
```

`max-retry-count` 는 3입니다. 그러니까 실제 간격은 이렇게 됩니다.

```
1회차 실패 → 1분 뒤   (2^0)
2회차 실패 → 2분 뒤   (2^1)
3회차 실패 → 4분 뒤   (2^2)
4회차       → PERMANENT_FAIL
```

`QUOTA_EXCEEDED` 만 여기에 2배를 겁니다. 쿼터가 찬 상태에서 같은 간격으로 두드리면 쿼터가 회복될 틈을 안 주니까요.

### 죽어서 남은 상태를 되살립니다

여기가 처음에 빠뜨렸던 부분이에요. 재시도 대상은 `RETRY_PENDING` 만이 아닙니다.

서버가 `IN_PROGRESS` 상태에서 죽으면 그 토큰은 영원히 `IN_PROGRESS` 로 남아요. FCM 응답을 받아서 상태를 바꿔줄 스레드가 없어졌기 때문입니다. `PENDING` 상태에서 죽은 것도 마찬가지고요.

그래서 세 상태를 같이 긁습니다.

```java
public List<PushClusterToken> findRecoverableTokens() {
    LocalDateTime now = LocalDateTime.now();
    LocalDateTime staleThreshold = now.minusMinutes(pushProperties.getStaleThresholdMinutes());
    return pushClusterTokenRepositoryPort.findRecoverableTokens(
        staleThreshold, now, pushProperties.getMaxRetryCount());
}
```

`stale-threshold-minutes` 는 10입니다. 10분이 지나도록 `PENDING` 이나 `IN_PROGRESS` 에 머물러 있으면 정상적인 처리 중이 아니라고 보는 거예요. 이 값이 너무 짧으면 아직 처리 중인 걸 중복 발송하고, 너무 길면 복구가 늦습니다.

그 다음이 제가 좋아하는 부분이에요. 세 상태를 긁어온 뒤에는 **상태를 구분하지 않습니다.**

```java
// 상태(PENDING/IN_PROGRESS/RETRY_PENDING)는 "왜 여기 왔는가"만 다를 뿐,
// 앞으로의 처리는 retryCount 하나로 결정된다.
for (PushClusterToken token : recoverableTokens) {
    if (token.getRetryCount() >= pushProperties.getMaxRetryCount()) {
        token.markAsPermanentFail();
        toPermanentFail.add(token);
    } else {
        if (token.getJobStatus() != JobStatus.RETRY_PENDING) {
            token.markAsStaleRecovered();
            staleConverted.add(token);
        }
        toRetry.add(token);
    }
}
```

과거 상태는 진단에만 쓰고, 앞으로 뭘 할지는 `retryCount` 하나로 정합니다. 분기를 여기서 한 번에 접어두니 이후 코드가 단순해졌어요.

### 즉시 경로와 복구 경로를 나눴습니다

정상 흐름에서는 커밋 직후 바로 발송합니다. 폴링을 기다리지 않아요. 스케줄러는 **실패한 것만** 줍습니다.

```java
@Scheduled(cron = "0 */5 9-21 * * MON-FRI")
@SchedulerLock(name = "pushPollingPublisher")
public void run() {
    recoverAndRetry();
}
```

5분마다, 평일 9시부터 21시까지만 돕니다. 공지가 올라오는 시간대가 그 구간이라서요. 새벽에 5분마다 빈 쿼리를 날릴 이유가 없습니다.

`@SchedulerLock` 은 ShedLock이에요. 인스턴스가 여러 대일 때 스케줄러가 동시에 돌면 같은 토큰을 두 번 보냅니다. 다만 솔직히 적으면, 지금 이 서비스는 단일 인스턴스라 이 락은 아직 아무 일도 하지 않아요. 미리 넣어둔 겁니다.

## [성과 - 개선 전후 비교]

같은 조건으로 다시 돌렸습니다. 10만 건 시나리오, 250개 배치 중 127번째 직전에 강제 종료입니다.

| 항목 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 종료 후 미완료 대상 식별 | 불가 | 약 49,600건이 Outbox 상태로 남음 |
| 재발송 시 대상자 재계산 | 필요 | 불필요 (`retry_after` 기준 조회) |
| 재처리 후 FCM 요청 성공 전환율 | 측정 불가 | 100% |

"성공 전환율 100%" 는 오해를 부를 수 있어서 정확히 적을게요. **FCM이 요청을 접수했다는 뜻이지 사용자 기기에 도착했다는 뜻이 아닙니다.** FCM은 접수와 배달을 분리하고, 배달 결과는 서버가 알 수 없어요. 이 지표가 보장하는 건 "서버 쪽에서 할 일은 다 했다" 까지입니다.

그리고 49,600건이 남았다는 것도 성과라기보다는 **상태가 관측 가능해졌다**는 쪽에 가까워요. 유실을 0으로 만든 게 아니라, 유실인지 아닌지 판단할 수 있게 된 겁니다.

## [결론]

정리하면 세 줄입니다.

- 외부 호출은 트랜잭션에 못 들어가니, 호출하겠다는 사실만 트랜잭션에 넣는다
- 상태는 잘게 나눌수록 재시도 정책을 세밀하게 쓸 수 있다
- 정상 경로와 복구 경로를 분리하면 실시간성과 복구 안정성을 같이 가져간다

한계도 적어둘게요.

첫째, **중복 발송을 막지 않습니다.** 이건 선택의 결과예요. `IN_PROGRESS` 인 토큰이 사실은 FCM에 도착했는데 응답만 못 받은 경우, 10분 뒤 스케줄러가 한 번 더 보냅니다. 사용자는 같은 알림을 두 번 받아요.

둘째, **stale 판정이 시간 기반입니다.** 10분이라는 값에 근거가 약해요. 배치 하나가 10분 넘게 걸리는 상황이 생기면 정상 처리 중인 걸 중복 발송합니다. 인스턴스 식별자를 같이 적어두고 그 인스턴스가 살아 있는지 보는 쪽이 정확할 텐데, 아직 안 했어요.

셋째, **`push_cluster_tokens` 행이 계속 쌓입니다.** 발송 한 번에 구독자 수만큼 행이 생겨요. 90일에 75,000건이면 아직 감당되지만 정리 정책은 필요합니다.

넷째, **`PERMANENT_FAIL` 을 아무도 안 봅니다.** Discord 알림은 `SENDER_ID_MISMATCH` 에만 걸려 있고, 재시도 한도 초과로 쌓인 건 로그에만 남아요. 상태를 나눈 이유가 사람이 보기 위해서였는데 정작 보는 경로를 안 만들었습니다.

"유실을 막았다" 고 말하고 싶었는데, 실제로 한 일은 **모르는 상태를 없앤 것**이었어요. 이 둘을 구분하는 데 시간이 좀 걸렸습니다.
