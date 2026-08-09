---
title: "예매 시작 1초에 다 들어오게 두지 않습니다 (ZSET 대기열과 입장 제어)"
description: "티켓 100장에 만 명이 몰리면 만 명이 다 DB까지 갑니다. 줄을 세우고 초당 몇 명씩만 통과시키는 구조와, popMin이 되돌릴 수 없다는 문제."
date: 2026-08-09
project: "선착순예매"
tags: ["Redis", "ZSET", "대기열", "분산 락", "스케줄러"]
---

## [배경 - 100장을 사려고 만 명이 들어온다]

선착순 예매는 트래픽 모양이 특이합니다. 평소에는 아무도 안 오다가 **예매 시작 시각에 전부 한꺼번에** 들어와요.

문제는 그 사람들이 전부 실패한다는 겁니다. 티켓이 100장이면 100명만 성공하고 나머지는 매진 응답을 받아요. 그런데 **그 실패를 판정하기 위해 만 개의 요청이 전부 서버와 DB까지 도달합니다.**

성공할 100명을 위해 만 명분의 자원을 쓰는 구조예요. 그리고 그 부하 때문에 성공해야 할 100명도 느려집니다.

## [문제 상황 분석 - 어디서 걸러낼 것인가]

### 재고 확인만으로는 부족합니다

"재고가 0이면 바로 거절하면 되지 않나" 싶었어요. 그런데 이건 매진 이후에만 통합니다.

**시작 직후 1초 동안은 재고가 남아 있습니다.** 그 순간에 만 명이 동시에 재고를 확인하고 차감을 시도해요. Redis는 빠르지만 애플리케이션 스레드는 그만큼 안 됩니다.

즉 걸러내야 할 지점이 재고 확인보다 **앞**이어야 했어요.

### 순서를 정해야 합니다

선착순이라는 말은 순서가 있다는 뜻입니다. 그런데 동시에 도착한 요청에 순서를 매기는 건 간단하지 않아요.

필요한 건 이겁니다.

- 도착 순서대로 줄을 세운다
- 각자 자기가 몇 번째인지 알 수 있다
- 앞에서부터 정해진 수만큼 꺼낸다
- 같은 사람이 두 번 줄 서면 안 된다

Redis의 Sorted Set이 이 네 가지를 다 합니다.

## [해결 방법 - 줄을 세우고 조금씩 들여보낸다]

### 등록은 addIfAbsent 로 합니다

```java
public QueueEntry register(String screeningId, String token, long score) {
    String key = queueKey(screeningId);
    boolean inserted = queueStore.addIfAbsent(key, token, score);
    Double storedScore = queueStore.score(key, token);
    long effectiveScore = storedScore == null ? score : storedScore.longValue();

    return new QueueEntry(screeningId, token, effectiveScore, true, inserted);
}
```

`addIfAbsent` 는 Redis의 `ZADD NX` 입니다. **이미 있으면 점수를 안 바꿔요.**

이게 중요합니다. 그냥 `ZADD` 를 쓰면 사용자가 새로고침할 때마다 점수가 갱신되고, 그러면 **줄 뒤로 밀려납니다.** 새로고침했다고 순번이 밀리면 사용자는 계속 새로고침을 안 하게 되고, 그게 또 다른 문제를 만들어요.

그리고 등록 후에 저장된 점수를 다시 읽습니다.

```java
Double storedScore = queueStore.score(key, token);
long effectiveScore = storedScore == null ? score : storedScore.longValue();
```

내가 넣으려던 점수가 아니라 **실제로 저장된 점수**를 돌려줘요. 이미 줄을 선 사람이 다시 요청하면 원래 순번을 그대로 알려줍니다. 응답에 `inserted` 플래그를 따로 두는 것도 신규인지 재조회인지 구분하기 위해서예요.

### 순번은 rank로 봅니다

```java
public Long rank(String screeningId, String token) {
    return queueStore.rank(queueKey(screeningId), token);
}
```

`ZRANK` 는 점수 순서에서 몇 번째인지 돌려줍니다. 0부터 시작해요.

```java
Long zeroBasedRank = queueRepository.rank(screeningId, token);
```

변수 이름에 `zeroBased` 를 넣어둔 게 좋았습니다. 사용자에게 보여줄 때는 1을 더해야 하는데, 이름이 그냥 `rank` 면 어디서 더했는지 헷갈려요.

전체 인원은 `ZCARD` 로 봅니다. 순번과 전체 수가 있으면 "1,234번째 / 총 9,876명" 을 보여줄 수 있어요. **기다리는 사람에게 진행 상황을 보여주는 게 대기열의 절반**입니다. 아무 정보 없이 기다리게 하면 새로고침을 누릅니다.

### 입장은 스케줄러가 시킵니다

줄에서 꺼내는 건 요청이 아니라 스케줄러가 합니다.

```java
@Scheduled(fixedDelayString = "${waiting.queue.admission.scheduler-interval:5000}")
public void run() {
    for (String screeningId : properties.getScreeningIds()) {
        try {
            admissionService.admit(screeningId);
        } catch (RuntimeException exception) {
            log.error("Queue admission scheduler failed screeningId={}", screeningId, exception);
        }
    }
}
```

5초마다 돌면서 입장시킵니다. **유입 속도와 무관하게 처리 속도를 서버가 정하는** 구조예요.

이게 대기열의 핵심입니다. 요청이 밀려들어도 뒷단으로 나가는 양은 일정해요. 만 명이 동시에 들어와도 예매 API는 정해진 수만큼만 받습니다.

### 남은 자리만큼만 꺼냅니다

```java
AdmissionBatch selectBatch(String screeningId) {
    long activeCount = activeAdmissionRepository.countActive(screeningId);
    int remainingCapacity = (int) Math.max(0L, properties.getMaxActiveUsers() - activeCount);
    int selectionCount = Math.min(properties.getBatchSize(), remainingCapacity);
    List<QueueEntry> entries = selectionCount <= 0
            ? List.of()
            : queueRepository.popEarliest(screeningId, selectionCount);
    return new AdmissionBatch(screeningId, properties.getBatchSize(), remainingCapacity, entries);
}
```

두 값이 함께 작동합니다.

```java
private int batchSize = 10;
private Duration activeTtl = Duration.ofMinutes(5);
private int maxActiveUsers = 100;
private Duration lockTtl = Duration.ofSeconds(10);
```

- `maxActiveUsers` 100: 동시에 예매를 진행 중일 수 있는 최대 인원
- `batchSize` 10: 한 번에 최대 몇 명을 들여보낼지
- `activeTtl` 5분: 입장한 사람이 얼마나 오래 유효한지

**남은 자리를 먼저 계산하고 그만큼만 꺼냅니다.** 자리가 다 찼으면 아무도 안 꺼내요.

`activeTtl` 이 자리를 비우는 장치입니다. 입장했는데 예매를 안 하고 사라진 사람이 있어도 5분 뒤에 자리가 반납돼요. 명시적인 퇴장 신호에 기대지 않습니다. **브라우저를 닫는 건 서버에 알려지지 않으니** 시간으로 회수하는 게 맞습니다.

입장 중인 사람은 만료 시각을 점수로 하는 ZSET에 넣습니다.

```java
redisTemplate.opsForZSet().add(indexKey, token, expiresAtMillis);
```

이러면 `ZCARD` 로 인원을 세고 `rangeByScore` 로 만료된 사람을 골라낼 수 있어요. 같은 ZSET을 대기열은 순서용으로, 입장자 목록은 만료용으로 쓰는 셈입니다.

### 인스턴스가 여럿이어도 한 번만 돕니다

```java
boolean lockAcquired = lockRepository.acquire(screeningId, instanceId, properties.getLockTtl());
if (!lockAcquired) {
    lockMissCounter.increment();
    return result(screeningId, false, 0, 0, SkipReason.LOCK_NOT_ACQUIRED, startedAt);
}

try {
    // ... 입장 처리
} finally {
    lockRepository.release(screeningId, instanceId);
}
```

상영 단위로 락을 잡습니다. 서버가 여러 대여도 한 인스턴스만 입장을 처리해요.

락이 없으면 두 인스턴스가 각각 `countActive` 를 읽고 각각 10명을 꺼냅니다. 그러면 `maxActiveUsers` 를 넘어요.

락에 `instanceId` 를 같이 넘기는 게 중요합니다. 해제할 때 **내가 잡은 락인지 확인**하기 위해서예요. TTL이 만료돼서 다른 인스턴스가 락을 가져갔는데 내가 해제하면 남의 락을 푸는 게 됩니다.

`lockTtl` 이 10초인데 스케줄러 주기가 5초예요. 처리가 5초 넘게 걸리면 다음 주기가 돌아오는데, 그때는 아직 락이 살아 있어서 건너뜁니다.

### 실패한 이유를 남깁니다

```java
public enum SkipReason {
    NO_VALID_SCREENING, LOCK_NOT_ACQUIRED, ACTIVE_CAPACITY_REACHED, QUEUE_EMPTY
}
```

입장을 못 시킨 이유를 네 가지로 나눠 기록합니다. 그리고 지표로도 셉니다.

```java
this.runCounter = meterRegistry.counter("waiting.admission.runs");
this.successCounter = meterRegistry.counter("waiting.admission.success");
this.failureCounter = meterRegistry.counter("waiting.admission.failure");
this.lockMissCounter = meterRegistry.counter("waiting.admission.lock.miss");
this.capacityHitCounter = meterRegistry.counter("waiting.admission.capacity.hit");
```

**"입장이 안 되고 있다" 는 현상은 같은데 원인이 다릅니다.** 자리가 없어서인지, 줄이 비어서인지, 락을 못 잡아서인지를 구분해야 대응이 달라요. 대기열은 겉으로는 아무 일도 안 일어나는 것처럼 보이는 시스템이라 지표가 없으면 진단이 불가능합니다.

## [성과 - 개선 전후 비교]

| 항목 | 대기열 없음 | 대기열 있음 |
| --- | --- | --- |
| 예매 API에 도달하는 요청 | 유입량 전체 | 최대 `maxActiveUsers` (100) |
| 순서 보장 | 없음 (경쟁) | 등록 시각 기준 |
| 새로고침 시 순번 | 해당 없음 | 유지 (`ZADD NX`) |
| 사용자에게 보이는 정보 | 성공 또는 실패 | 내 순번과 전체 인원 |
| 이탈자 자리 회수 | 해당 없음 | `activeTtl` 5분 |
| 다중 인스턴스 | 해당 없음 | 상영별 락으로 직렬화 |

저장소의 테스트는 돌렸습니다.

```
./gradlew test

waiting-api   테스트 51건, 실패 0건
  ├─ QueueAdmissionServiceTest                 7건
  ├─ QueueAdmissionSchedulerTest               3건
  ├─ QueueRegistrationConcurrencyTest          1건
  └─ QueueRegistrationControllerConcurrencyTest 1건
```

전부 통과하지만 이건 **입장 로직이 의도대로 동작하는지**를 본 것이고, 대기열이 실제 부하에서 무엇을 막아주는지는 아닙니다.

부하 쪽은 `load-test/` 에 k6 시나리오와 결과 요약이 남아 있었어요. 대기열 등록부터 폴링, 티켓 발급까지 전 과정을 도는 시나리오입니다.

```
executor: shared-iterations, VU 5,000, iterations 30,000, maxDuration 15m

http_reqs              4,592,687건 (초당 4,938건)
http_req_duration      avg 10.33ms, p95 18.68ms, max 4,093ms
http_req_failed        0.03%
tickets_issued         1,000
tickets_sold_out       1,277
iterations (완료)      7,000
dropped_iterations     19,000
```

**제일 중요한 줄은 `tickets_issued` 가 정확히 1,000이라는 겁니다.** 재고만큼만 나갔어요. 시나리오의 임계값도 여기에 걸려 있습니다.

```js
thresholds: {
  // 핵심: 1000장이 모두 발급되어야 한다
  'tickets_issued':        ['count>=1000'],
```

실패율 0.03%도 뜯어보면 실패가 아니에요. 실패로 잡힌 1,277건과 `tickets_sold_out` 1,277건이 정확히 같습니다. **매진 응답을 k6가 HTTP 실패로 센 것**이지 오류가 아닙니다.

다만 정정할 게 있어요. 이력서에는 "초당 30,000건 규모의 요청 상황에서도 재고 정합성 유지 검증" 이라고 적었는데, 이 결과와 맞지 않습니다.

- 30,000은 **초당 요청 수가 아니라 목표 iteration 수**입니다
- 그중 실제로 완료된 건 **7,000건**이고 19,000건은 드롭됐어요 (15분 안에 못 끝남)
- 실측 처리량은 **초당 약 4,938 요청**입니다

즉 "30,000 VU가 몰려도 버텼다" 가 아니라 **"30,000건을 목표로 걸었고 7,000건이 완료되는 동안 재고는 정확히 지켜졌다"** 가 맞습니다. 검증된 건 처리량이 아니라 정합성이에요.

<!-- 측정 필요:
     1) 대기열 유무별 예매 API 도달 요청 수 비교 (대기열 없는 구성으로 같은 시나리오)
     2) 입장 처리량이 실제로 (batchSize / schedulerInterval) 에 수렴하는지
        현재 설정 기준 초당 2명. 위 결과의 7,000 완료와 맞춰볼 것
     3) dropped_iterations 19,000 의 원인 (대기열 지연인지 부하 생성기 한계인지)
     4) waiting.admission.* 지표의 실제 분포 -->

계산으로만 적으면, 현재 설정에서 입장 처리량은 **5초에 10명, 초당 2명**입니다. 티켓 100장을 다 소진하는 데 최소 50초가 걸려요. 이게 적절한지는 실제 예매 소요 시간을 재봐야 알 수 있습니다.

## [결론]

정리하면 이렇습니다.

- 걸러내는 지점은 자원을 쓰기 전이어야 한다. 재고 확인은 이미 늦다
- 유입 속도와 처리 속도를 분리하는 게 대기열의 본질이다
- 퇴장은 신호가 아니라 시간으로 회수해야 한다
- 대기열은 겉으로 조용해서, 지표가 없으면 고장을 모른다

한계를 적어둘게요. 첫 번째가 제일 큽니다.

첫째, **`popMin` 은 되돌릴 수 없습니다.**

```java
List<QueueEntry> entries = queueRepository.popEarliest(screeningId, selectionCount);
// ...
for (QueueEntry entry : batch.selectedEntries()) {
    try {
        if (activeAdmissionRepository.activate(screeningId, entry.token(), properties.getActiveTtl())) {
            successCount++;
        } else {
            failureCount++;
        }
    } catch (RuntimeException exception) {
        failureCount++;
        // ...
    }
}
```

줄에서 꺼낸 다음에 입장 등록을 합니다. 그런데 **꺼내는 순간 그 사람은 대기열에서 사라져요.** 등록이 실패하면 그 사용자는 줄에도 없고 입장자 목록에도 없습니다.

`failureCount` 를 세고 로그를 남기지만 **줄에 되돌려놓지 않습니다.** 그 사용자는 조회할 때 순번도 없고 입장도 안 된 상태로 남아요.

꺼내기와 등록을 Lua로 묶거나, 실패 시 원래 점수로 다시 넣는 처리가 필요합니다. 원래 점수는 `QueueEntry` 에 들고 있으니 복구할 재료는 있어요.

둘째, **상영 ID를 설정에 하드코딩합니다.**

```java
@NotEmpty
private Set<String> screeningIds = new LinkedHashSet<>(Set.of("1"));
```

스케줄러가 설정에 적힌 상영만 처리해요. 새 상영이 열릴 때마다 배포해야 합니다.

셋째, **모든 상영을 한 스케줄러가 순회합니다.** 상영이 늘어나면 한 주기 안에 다 못 돌 수 있고, 앞의 상영에서 오래 걸리면 뒤가 밀려요.

넷째, **입장 후 실제로 예매했는지 추적하지 않습니다.** `activeTtl` 5분이 지나면 자리가 반납되는데, 3초 만에 예매를 끝낸 사람의 자리도 5분 동안 잡혀 있어요. 예매 완료 시 즉시 반납하면 처리량이 올라갑니다.

다섯째, **`load-test` 를 만들어두고 결과를 안 남겼습니다.** 대기열은 부하 상황을 위해 만든 구조인데 정작 부하를 걸어본 기록이 없어요. 이건 다음에 제일 먼저 할 일입니다.
