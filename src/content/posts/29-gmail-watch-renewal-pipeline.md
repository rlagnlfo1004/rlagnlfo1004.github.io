---
title: "구독은 7일 뒤에 조용히 끊깁니다 (Gmail Watch 갱신을 만료 하루 전부터 하는 이유)"
description: "Gmail의 watch는 최대 7일입니다. 만료되면 에러가 나는 게 아니라 아무 일도 안 일어나요. 만료 당일이 아니라 하루 전부터, 시간당 50개씩 나눠 갱신한 이야기입니다."
date: 2026-08-09
project: "메일상자"
tags: ["Gmail API", "스케줄러", "RabbitMQ", "OAuth", "장애 대응"]
---

## [배경 - 실패가 소리를 내지 않는 종류의 기능]

메일상자가 새 메일을 실시간으로 받아오는 건 Gmail의 `users.watch()` 덕분입니다. 이걸 호출해두면 그 계정에 변화가 생길 때 Google Pub/Sub이 저희 서버로 알려줘요.

문제는 이 구독에 유효기간이 있다는 겁니다. **최대 7일**이에요. 그 안에 다시 호출하지 않으면 만료됩니다.

만료되면 어떻게 되냐면, **아무 일도 안 일어납니다.** 에러 응답이 오는 것도 아니고 예외가 던져지는 것도 아니에요. 그냥 푸시가 안 옵니다.

사용자 입장에서는 인박스가 갱신되지 않는 걸로 보여요. 새 메일이 안 온다고 느끼는데, 서버 로그에는 아무 흔적도 없습니다. 실패가 소리를 내지 않는 종류의 기능이라 자동 갱신이 필수였어요.

## [문제 상황 분석 - 만료 당일에 하면 왜 안 되나]

### 첫 설계는 만료 당일 일괄 갱신이었습니다

가장 단순한 건 매일 한 번 돌면서 오늘 만료되는 계정을 전부 갱신하는 거예요. 코드도 짧습니다.

이게 왜 위험한지는 실패를 가정해보면 나옵니다.

**갱신은 외부 API 호출입니다.** 게다가 하나가 아니라 둘이에요. Google OAuth로 액세스 토큰을 새로 받고, 그다음 Gmail watch를 호출해야 합니다. 어느 쪽이든 실패할 수 있어요.

만료 당일에 실패하면 **다음 기회가 없습니다.** 그날 자정이 지나면 구독이 끊기고, 그때부터 그 계정은 조용히 멈춰요.

워커가 잠깐 죽어 있거나 배포 중이었으면 그 시간대에 걸린 계정이 통째로 날아갑니다.

### 만료 시각이 몰립니다

두 번째 문제는 분포예요.

`watch` 를 부른 시점부터 7일이 계산되니, **같은 시각에 갱신한 계정은 같은 시각에 만료됩니다.** 한 번 몰리면 그 뒤로 계속 몰려요. 첫 배포 때 전체 계정을 한꺼번에 갱신했다면 그 시각이 영구히 피크가 됩니다.

몰린 시각에 수백 개를 한 번에 처리하면 Gmail API 쿼터에 걸리고, 그러면 또 실패하고, 실패한 계정은 만료됩니다.

### 스케줄러가 직접 갱신하면 안 되는 이유

세 번째는 실패 격리예요.

스케줄러 안에서 반복문을 돌며 갱신하면, 중간에 하나가 예외를 던졌을 때 뒤의 계정이 처리되지 않습니다. `try-catch` 로 감싸면 되긴 하는데, 그러면 재시도가 없어요. 다음 스케줄까지 기다려야 합니다.

## [해결 방법 - 미리, 나눠서, 큐로]

### 대상 선정과 실제 갱신을 분리합니다

스케줄러는 **누구를 갱신할지 고르는 일만** 합니다.

```java
@Scheduled(cron = "${mailsangja.gmail.watch-renewal.cron}")
public void scheduleRenewalTargets() {
    if (!gmailWatchRenewalProperties.isEnabled()) {
        return;
    }

    validateSchedulerProperties();

    LocalDateTime renewalThreshold = mailAccountQueryService.getKstNow()
            .plus(gmailWatchRenewalProperties.getRenewalWindow());

    List<MailAccount> targetMailAccounts = mailAccountQueryService.findRenewalTargetGmailAccounts(
            renewalThreshold,
            gmailWatchRenewalProperties.getBatchSize()
    );

    for (MailAccount targetMailAccount : targetMailAccounts) {
        watchRenewalPublisher.publish(WatchRenewalMessage.from(targetMailAccount));
    }
    // ...
}
```

DB 조회 한 번과 메시지 발행이 전부예요. 외부 API를 부르지 않습니다.

실제 갱신은 컨슈머가 합니다.

```java
public void handle(WatchRenewalMessage message) {
    MailAccount mailAccount = mailAccountQueryService.findSyncableMailAccountById(message.mailAccountId());
    GoogleOAuthTokenResult tokenResult = refreshAccessToken(mailAccount);
    GoogleMailWatchResult watchResult = gmailWatchApiService.watch(tokenResult.accessToken());

    mailAccountCommandService.renewGoogleWatch(
            RenewGoogleWatchCommand.of(mailAccount.getId(), tokenResult, watchResult)
    );
    sendReauthorizationRequestPush(mailAccount);
    // ...
}
```

이렇게 나누면 **계정 하나의 실패가 계정 하나의 실패로 끝납니다.** 재시도와 DLQ도 메시지 단위로 붙어요. 큐 설정은 컨슈머 2개에 prefetch 2입니다. 갱신은 급한 작업이 아니라서 낮게 잡았어요.

### 만료 하루 전부터 대상에 넣습니다

```java
private Duration renewalWindow = Duration.ofDays(1);
private int batchSize = 50;
private String cron = "0 0 * * * *";
```

`renewalWindow` 가 1일입니다. **지금부터 24시간 안에 만료되는 계정**을 대상으로 잡아요.

이 값이 실질적인 재시도 예산입니다. 7일짜리 구독을 6일째에 갱신하면, 실패하더라도 만료까지 24시간이 남아요. 크론이 매시 정각이니 그 안에 **24번 더 기회가 있습니다.**

워커가 몇 시간 죽어 있어도, 배포로 잠깐 끊겨도, Gmail이 일시적으로 5xx를 뱉어도 복구할 시간이 있어요. 만료 당일 방식과의 차이가 여기입니다.

### 시간당 50개로 끊습니다

`batchSize` 가 50이고 크론이 매시 정각이니 **시간당 최대 50개**를 갱신합니다.

이게 앞에서 말한 "만료 시각이 몰리는" 문제를 다룹니다. 300개가 같은 시각에 만료돼도 한 번에 300번을 부르지 않아요. 시간당 50개씩 여섯 시간에 걸쳐 나눠 부릅니다.

그리고 이게 **갱신 시각을 자연스럽게 흩뜨립니다.** 몰려 있던 계정들이 서로 다른 시각에 갱신되니, 다음 만료 시각도 흩어져요. 한 번 분산되면 그 상태가 유지됩니다.

여기서 조심할 게 있어요. **시간당 50개는 하루 1,200개가 상한**입니다. 갱신 대상 계정이 그보다 많아지면 24시간짜리 여유 안에 다 처리하지 못해요. 지금 서비스 규모(가입자 322명)에서는 한참 여유가 있지만, 이 두 값은 서로 묶여 있습니다.

```
안전 조건:  (renewalWindow / 크론 주기) × batchSize  >  갱신 대상 계정 수
현재 값:    (24시간 / 1시간) × 50 = 1,200
```

### 리프레시 토큰이 죽으면 지웁니다

```java
private GoogleOAuthTokenResult refreshAccessToken(MailAccount mailAccount) {
    try {
        return googleOAuthApiService.refreshAccessToken(mailAccount.getRefreshToken());
    } catch (MailPushException e) {
        mailAccountCommandService.clearRefreshToken(mailAccount.getId());
        throw e;
    }
}
```

리프레시 토큰은 사용자가 Google 계정 설정에서 권한을 철회하면 무효가 됩니다. 이건 재시도로 살아나지 않아요.

그래서 실패하면 토큰을 지웁니다. 지우면 그 계정은 `findSyncableMailAccountById` 의 조건을 통과하지 못해서 **다음 갱신 대상에서 빠져요.**

실패를 상태로 남기는 방식입니다. 안 그러면 죽은 토큰으로 매시간 재시도하면서 로그만 쌓입니다.

예외를 다시 던지는 것도 의도예요. 토큰만 지우고 조용히 넘어가면 DLQ에 안 남습니다. 지우기는 하되 실패는 실패로 기록해야 나중에 셀 수 있어요.

### 알림 실패는 갱신을 막지 않습니다

```java
private void sendReauthorizationRequestPush(MailAccount mailAccount) {
    try {
        fcmPushCommandService.sendGmailReauthorizationRequestPush(mailAccount);
    } catch (Exception e) {
        log.warn("Gmail reauthorization request push skipped after watch renewal. ...", e);
    }
}
```

FCM 발송을 `try-catch` 로 감쌌습니다. 이건 아주이벤트에서 배운 걸 적용한 부분이에요.

**갱신은 이미 성공했습니다.** DB에도 반영됐어요. 여기서 알림 발송이 실패했다고 예외를 던지면 메시지가 재시도되고, 그러면 **이미 성공한 갱신을 또 합니다.** 부수 작업의 실패가 본 작업을 되돌리게 두면 안 됩니다.

## [성과 - 개선 전후 비교]

설계 차이를 정리하면 이렇습니다.

| 항목 | 만료 당일 일괄 | 현재 구조 |
| --- | --- | --- |
| 갱신 시점 | 만료 당일 | 만료 24시간 전부터 |
| 실패 시 재시도 기회 | 사실상 없음 | 매시간, 최대 24회 |
| 처리 단위 | 전체 루프 | 계정 1개 = 메시지 1개 |
| 1건 실패 영향 | 뒤 계정이 밀림 | 그 계정만 재시도 |
| 만료 몰림 대응 | 없음 | 시간당 50개로 분산 |
| 무효 토큰 처리 | 매번 재시도 | 토큰 삭제 후 대상 제외 |

수치는 없습니다. 이 기능은 **실패가 안 일어나는 것을 목표로 하는 구조**라, 개선 전후를 비교할 지표를 만들려면 일부러 실패를 만들어야 해요. 아직 안 했습니다.

<!-- 측정 필요:
     1) watch_expires_at 분포 조회. 만료 시각이 실제로 흩어져 있는지
        SELECT date_trunc('hour', watch_expires_at), count(*) FROM mail_account
        WHERE provider='GMAIL' AND is_active GROUP BY 1 ORDER BY 1;
     2) 워커를 N시간 정지시킨 뒤 재기동했을 때 만료된 계정이 0인지
     3) 갱신 성공률 (로그의 "Completed Gmail watch renewal" 대 DLQ 건수) -->

## [결론]

정리하면 이렇습니다.

- 실패가 소리를 내지 않는 기능은 재시도 여유를 설계에 넣어야 한다
- 대상 선정과 실제 처리를 나누면 실패 단위가 작아진다
- 재시도해도 소용없는 실패는 상태로 남겨서 대상에서 빼야 한다

한계를 적어둘게요.

첫째, **기본값이 꺼져 있습니다.**

```java
private boolean enabled = false;
```

`enabled` 의 기본값이 `false` 예요. 운영 환경 설정에서 켜지 않으면 이 스케줄러는 아무 일도 안 합니다. 안전 장치이긴 한데, 켜졌는지 확인하는 방법이 로그뿐이라 위험합니다. 만료 임박 계정 수를 메트릭으로 노출해두면 꺼져 있을 때 숫자가 계속 늘어나는 걸로 알 수 있는데, 아직 안 했어요.

둘째, **성공한 갱신 뒤에도 재인증 요청 푸시를 보냅니다.** 코드를 읽다가 걸린 부분이에요. `sendReauthorizationRequestPush` 가 갱신 성공 경로에 있습니다. 리프레시 토큰이 있는 계정에만 보내긴 하는데, 갱신이 잘 된 사용자에게 "다시 인증해주세요" 알림이 가는 게 의도인지 확실하지 않아요.

<!-- 확인 필요: sendGmailReauthorizationRequestPush 를 갱신 성공 시에도 호출하는 것이 의도인지.
     의도라면 어떤 조건에서 사용자 재동의가 필요한지, 아니라면 실패 경로로 옮겨야 함 -->

셋째, **스케줄러에 분산 락이 없습니다.** 인스턴스가 두 대면 같은 계정을 두 번 발행합니다. `watch` 를 두 번 부르는 게 치명적이진 않지만(마지막 호출이 이깁니다) 쿼터를 두 배로 씁니다.

넷째, **만료 시각을 KST 기준으로 다룹니다.** `getKstNow()` 로 현재 시각을 만들어 비교하는데, Gmail이 돌려주는 만료 시각은 에폭 밀리초예요. 저장할 때 변환이 한 번 들어가니 시간대가 어긋나면 조용히 어긋납니다. 여기가 틀리면 갱신이 너무 이르거나 너무 늦게 도는데, 둘 다 로그로는 정상으로 보여요.

가장 오래 고민한 건 `renewalWindow` 를 얼마로 잡을지였습니다. 짧으면 재시도 여유가 없고, 길면 불필요하게 자주 갱신해요. 24시간은 "하루쯤 장애가 나도 복구된다" 를 기준으로 정했는데, 이 기준 자체는 근거라기보다 감입니다.
