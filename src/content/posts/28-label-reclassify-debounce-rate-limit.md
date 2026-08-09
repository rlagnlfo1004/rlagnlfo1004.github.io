---
title: "규칙 한 줄 고칠 때마다 전체 메일을 다시 분류했습니다 (Debounce, Rate Limit, Stale Skip 세 겹)"
description: "저장 버튼을 다섯 번 누르면 전체 재분류가 다섯 번 돕니다. 막는 지점을 진입, 발행, 소비 셋으로 나눈 이야기와, 그러고도 남은 경쟁 하나."
date: 2026-08-09
project: "메일상자"
tags: ["Debounce", "Rate Limit", "Redis", "RabbitMQ", "동시성"]
---

## [배경 - 저장을 누를 때마다 큐가 부풀었다]

메일상자에는 라벨 규칙이 있습니다. "발신자에 `@github.com` 이 들어가면 개발 라벨" 같은 조건을 사용자가 직접 만들어요.

규칙을 저장하면 기존 메일에도 적용해야 합니다. 안 그러면 규칙을 만든 시점 이후 메일에만 라벨이 붙으니까요. 그래서 저장할 때마다 **그 사용자의 전체 스레드를 다시 분류하는 작업**을 큐에 넣었습니다.

문제는 사용자가 규칙을 한 번에 완성하지 않는다는 겁니다. 조건을 넣고 저장하고, 결과를 보고 고치고 저장하고, 또 고치고 저장해요. 1분에 다섯 번 저장하는 건 흔한 일입니다.

그때마다 전체 재분류가 발행됐습니다. 스레드가 3,000개면 배치 메시지가 60개씩(배치 크기 50 기준) 다섯 번, 총 300개가 큐에 쌓여요. **그중 앞의 240개는 이미 낡은 규칙으로 도는 작업**입니다.

## [문제 상황 분석 - 막을 지점이 하나가 아니었다]

### Rate Limit만으로는 안 됩니다

처음 떠오른 건 요청 제한이었어요. 1분에 몇 번 이상 저장하면 막는 겁니다.

두 가지 이유로 부족했습니다.

**첫째, 정상 편집을 막습니다.** 규칙을 다듬느라 다섯 번 저장하는 건 비정상 사용이 아니에요. 여기서 429를 뱉으면 기능이 불편해집니다.

**둘째, 이미 만들어진 작업을 못 지웁니다.** 제한에 걸리기 전에 통과한 네 번의 요청은 이미 큐에 들어가 있어요. Rate Limit은 들어오는 걸 막지, 들어간 걸 되돌리지 않습니다.

### 낭비가 생기는 지점이 셋이었습니다

정리해보니 시점이 세 개였어요.

```
사용자 저장  ──①──>  발행  ──②──>  큐  ──③──>  컨슈머 처리
             진입              쌓임              소비
```

① 비정상적으로 잦은 요청이 들어오는 지점
② 짧은 시간 안의 여러 요청이 각각 별도 작업으로 발행되는 지점
③ 이미 낡은 작업이 큐에 남아서 처리되는 지점

**하나의 장치로 셋을 다 막을 수 없습니다.** 그래서 세 개를 따로 뒀어요.

## [해결 방법 - 세 겹으로 나눈다]

### 1층. 진입에서 Rate Limit

비정상적인 반복만 걸러냅니다.

```java
private static final DefaultRedisScript<Long> RATE_LIMIT_SCRIPT = new DefaultRedisScript<>("""
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
            redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return count
        """, Long.class);
```

`INCR` 과 `EXPIRE` 를 Lua로 묶었어요. 두 명령을 따로 보내면 `INCR` 직후 프로세스가 죽었을 때 TTL 없는 키가 영원히 남습니다. 그 사용자는 다시는 저장을 못 하게 돼요.

`count == 1` 일 때만 만료를 거는 것도 의미가 있습니다. 매번 걸면 요청할 때마다 창이 뒤로 밀려서, 계속 요청하는 사용자는 영원히 만료되지 않아요.

한도는 60초에 20회입니다.

```java
private int debounceSeconds = 60;
private int schedulerFixedDelaySeconds = 10;
private int rateLimitWindowSeconds = 60;
private int rateLimitMaxRequests = 20;
```

20회로 잡은 이유는 **정상 편집을 절대 막지 않기 위해서**예요. 사람이 1분에 20번 넘게 규칙을 저장하는 건 손으로 하는 조작이 아닙니다. 이 층의 목표는 낭비를 줄이는 게 아니라 비정상 요청만 끊는 거예요.

거절할 때 남은 시간을 같이 줍니다.

```java
if (count > labelDebounceProperties.getRateLimitMaxRequests()) {
    Long ttl = stringRedisTemplate.getExpire(key);
    long retryAfter = (ttl != null && ttl > 0) ? ttl : labelDebounceProperties.getRateLimitWindowSeconds();
    throw new LabelException(LabelErrorCode.LABEL_RECLASSIFY_RATE_LIMITED, retryAfter);
}
```

"나중에 다시 시도하세요" 만 주면 클라이언트가 언제 다시 시도할지 몰라 폴링합니다. 남은 초를 알려주면 정확히 그때 한 번만 부를 수 있어요.

### 2층. 발행 전에 Debounce

여기가 실제로 낭비를 줄이는 층입니다.

저장할 때 바로 발행하지 않고 **사용자별 대기 작업에 합칩니다.**

```java
public void mergePendingJob(UUID userId, UUID labelId) {
    String key = PENDING_KEY_PREFIX + userId;

    String existing = (String) stringRedisTemplate.opsForHash().get(key, FIELD_LABEL_IDS);
    Set<String> labelIdSet = new HashSet<>();
    if (existing != null && !existing.isBlank()) {
        labelIdSet.addAll(Arrays.asList(existing.split(",")));
    }
    labelIdSet.add(labelId.toString());

    String merged = String.join(",", labelIdSet);
    String nowMs = String.valueOf(Instant.now().toEpochMilli());

    stringRedisTemplate.opsForHash().put(key, FIELD_LABEL_IDS, merged);
    stringRedisTemplate.opsForHash().put(key, FIELD_LAST_UPDATED_AT, nowMs);
    stringRedisTemplate.expire(key, PENDING_TTL);
}
```

핵심은 두 가지예요.

**`labelIds` 는 합집합으로 쌓입니다.** 사용자가 라벨 A, B, C를 연달아 고치면 대기 작업 하나에 세 개가 다 담겨요. 나중에 발행할 때 한 번에 처리됩니다.

**`lastUpdatedAt` 은 매번 덮어씁니다.** 이게 debounce의 본체예요. 저장할 때마다 타이머가 처음부터 다시 시작합니다.

발사는 스케줄러가 합니다.

```java
@Scheduled(fixedDelayString = "${mailsangja.label.debounce.scheduler-fixed-delay-seconds}000")
public void tick() {
    List<LabelReclassifyPendingJob> jobs =
            pendingJobStore.getPendingJobsReadyToFire(labelDebounceProperties.getDebounceSeconds());
    // ...
}
```

10초마다 돌면서 **마지막 갱신 후 60초가 지난** 작업을 찾아 발행합니다.

```
[사용자 편집 흐름]
  0초   저장 → 대기 작업 생성, lastUpdatedAt = 0
  12초  저장 → 병합, lastUpdatedAt = 12
  25초  저장 → 병합, lastUpdatedAt = 25
  40초  저장 → 병합, lastUpdatedAt = 40
  ...
  100초 스케줄러 tick → 40 + 60 = 100 도달, 발행 (1회)
```

저장 4회가 발행 1회로 접힙니다. 그리고 **발행되는 건 최신 규칙 기준**이에요. 중간 상태로 도는 작업이 아예 안 생깁니다.

대가는 지연입니다. 편집을 멈춘 뒤 최대 60초, 스케줄러 주기까지 더하면 70초쯤 뒤에 재분류가 시작돼요. 이걸 받아들일 수 있었던 건 **재분류가 즉시성이 필요한 기능이 아니기 때문**입니다. 규칙을 저장한 사용자는 새 메일에 규칙이 적용되는 걸 바로 보고, 과거 메일 정리는 조금 늦어도 됩니다.

### 3층. 소비할 때 Stale Skip

2층까지 했는데도 구멍이 남습니다.

발행은 한 번이지만, 발행된 배치 메시지는 여러 개예요. 스레드 3,000개면 배치 60개입니다. **그 60개가 처리되는 동안 사용자가 또 규칙을 고칠 수 있어요.** 그러면 새 작업이 발행되고, 큐에는 낡은 배치와 새 배치가 섞입니다.

그래서 발행할 때 라벨별로 최신 작업 ID를 Redis에 적어둡니다.

```java
public void publish(UUID userId, Set<UUID> labelIds, String jobId) {
    for (UUID labelId : labelIds) {
        stringRedisTemplate.opsForValue().set(
                LATEST_JOB_ID_KEY_PREFIX + labelId,
                jobId,
                LATEST_JOB_ID_TTL
        );
    }
    // ... threadBatchSize 단위로 분할 발행
}
```

컨슈머는 처리 직전에 이걸 확인해요.

```java
Set<UUID> targetLabelIds = message.labelIds().stream()
        .filter(labelId -> {
            String latestJobId = labelReclassifyJobStore.getLatestJobId(labelId);
            boolean stale = latestJobId != null && !latestJobId.equals(messageJobId);
            if (stale) {
                log.info("Stale reclassify job skipped for labelId={}: jobId={} latestJobId={}",
                        labelId, messageJobId, latestJobId);
            }
            return !stale;
        })
        .collect(Collectors.toSet());

if (targetLabelIds.isEmpty()) {
    log.info("All labels stale, skipping batch: jobId={} userId={}", messageJobId, userId);
    return;
}
```

메시지의 `jobId` 가 최신이 아니면 그 라벨은 건너뜁니다. 라벨 전부가 낡았으면 배치 자체를 통째로 넘겨요.

**라벨 단위로 판정하는 게 중요합니다.** 작업 단위로 하면, 라벨 A와 B를 함께 재분류하다가 A만 다시 수정했을 때 B까지 버려집니다. 라벨별로 보면 B는 그대로 처리돼요.

큐에서 메시지를 지우는 게 아니라 **꺼내서 버린다**는 점도 짚고 갈 부분입니다. RabbitMQ는 특정 메시지만 골라 삭제하는 기능이 없어요. 그래서 소비 자체는 하되 무거운 작업(DB 조회, 규칙 컴파일, 라벨 적용)을 건너뜁니다.

### 세 층이 각각 무엇을 막는가

| 층 | 위치 | 막는 것 | 못 막는 것 |
| --- | --- | --- | --- |
| Rate Limit | 진입 | 비정상 반복 요청 | 정상 편집으로 생기는 중복 |
| Debounce | 발행 전 | 짧은 시간의 여러 요청이 별도 작업이 되는 것 | 발행 후 규칙이 또 바뀌는 경우 |
| Stale Skip | 소비 시 | 낡은 작업의 무거운 처리 | 메시지 소비 자체 |

셋 다 필요했던 이유가 이 표에 있습니다. 각각이 못 막는 걸 다음 층이 받아요.

## [성과 - 개선 전후 비교]

구조 변화는 이렇습니다.

| 항목 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 저장 N회 시 발행 | N회 | 1회 (편집 종료 후) |
| 발행되는 규칙 상태 | 매 저장 시점 | 최신 상태 |
| 큐에 남은 낡은 배치 | 전부 정상 처리 | 라벨 단위로 건너뜀 |
| 반복 요청 차단 | 없음 | 60초 20회 |
| 재분류 시작까지 지연 | 즉시 | 최대 약 70초 |

숫자로 적을 수 있는 건 여기까지예요. **실제로 큐 적재량이 얼마나 줄었는지는 측정하지 않았습니다.**

<!-- 측정 필요: 효과 정량화.
     1) 라벨 규칙 저장 5회를 60초 안에 수행했을 때, 개선 전후 발행 메시지 수 비교
        (스레드 3,000건 / batchSize 50 기준 예상: 300개 → 60개)
     2) Stale Skip으로 건너뛴 배치 비율 (로그의 "Stale reclassify job skipped" 카운트)
     3) 편집 종료부터 재분류 완료까지 실제 소요 시간 -->

## [결론]

정리하면 이렇습니다.

- 낭비가 생기는 지점이 여러 개면 장치도 여러 개여야 한다
- Rate Limit은 비정상 요청을 끊고, Debounce는 정상 요청을 합친다. 역할이 다르다
- 큐에서 메시지를 지울 수 없으면, 꺼내서 버리는 게 차선이다

한계를 적어둘게요. 첫 번째가 제일 큽니다.

첫째, **`mergePendingJob` 에 경쟁이 있습니다.** 같은 파일 안에서 Rate Limit은 Lua로 원자성을 확보해놓고, 정작 병합은 `HGET` 으로 읽고 `HSET` 으로 쓰는 구조예요.

```
저장 A: HGET labelIds → "L1"
저장 B: HGET labelIds → "L1"      ← A가 아직 안 썼다
저장 A: HSET "L1,L2"
저장 B: HSET "L1,L3"              ← L2가 사라졌다
```

사용자가 두 라벨을 거의 동시에 저장하면 하나가 유실됩니다. 그러면 그 라벨은 재분류가 안 돼요. **조용히 안 되는 종류의 버그**입니다. Redis Set 자료구조를 쓰거나(`SADD` 는 원자적입니다) 병합도 Lua로 옮기면 해결되는데, 아직 안 고쳤습니다.

둘째, **고정 윈도우 Rate Limit이라 경계에서 두 배가 통과합니다.** 창의 마지막 1초에 20회, 다음 창의 첫 1초에 20회를 보내면 2초 안에 40회가 통과해요. 슬라이딩 윈도우로 바꾸면 정확해지지만, 이 층의 목적이 "비정상만 끊기" 라 지금은 감수하고 있습니다.

셋째, **스케줄러에 분산 락이 없습니다.** 인스턴스가 여러 대가 되면 같은 대기 작업을 동시에 발행할 수 있어요. Stale Skip이 뒤에서 일부를 걸러주긴 하는데, 같은 `jobId` 가 아니라 서로 다른 `jobId` 로 발행되니 중복이 그대로 남습니다.

넷째, **`SCAN` 으로 대기 작업을 찾습니다.** 10초마다 `LabelReclassify:pending:*` 패턴을 훑어요. 지금은 대기 작업이 적어서 괜찮지만, 동시 편집 사용자가 늘면 이 비용이 커집니다. 발사 예정 시각을 점수로 하는 ZSET을 쓰면 스캔 없이 꺼낼 수 있는데, 그때 가서 바꾸려고 미뤄뒀어요.

세 겹으로 막았다고 적었지만, 정작 제일 안쪽에서 값을 합치는 코드에 경쟁이 남아 있었습니다. 바깥을 정교하게 만드는 동안 안쪽을 다시 안 봤어요.
