---
title: "재고를 확인하고 차감하면 늦습니다 (Lua 한 덩어리와 Redis가 앞서간 뒤의 문제)"
description: "GET으로 확인하고 DECR로 깎으면 그 사이에 다른 요청이 들어옵니다. Lua로 묶으면 초과 발급은 막히는데, Redis는 깎였고 DB 저장은 실패한 상태가 새로 생겨요."
date: 2026-08-09
project: "선착순예매"
tags: ["Redis", "Lua", "동시성", "재고", "원자성"]
---

## [배경 - 100장인데 103장이 나갔다]

선착순 예매에서 제일 무서운 건 **정해진 수보다 많이 파는 것**입니다. 100석짜리 상영에 103장을 팔면 세 명은 자리가 없어요. 환불로 끝나지 않고 신뢰 문제가 됩니다.

재고를 Redis에 두기로 한 건 자연스러웠어요. [대기열](/posts/38-redis-zset-waiting-queue-admission/)로 유입을 조절해도 입장한 사람들끼리는 여전히 동시에 들어옵니다. DB로 다 받으면 잠금 경합이 생겨요.

문제는 Redis에 재고를 둔다고 저절로 안전해지지 않는다는 겁니다.

## [문제 상황 분석 - 확인과 차감 사이의 틈]

### 두 번 부르면 그 사이에 끼어듭니다

가장 먼저 떠오르는 코드는 이렇습니다.

```
1. GET inventory        → 1 (한 장 남음)
2. 1 > 0 이니까 발급 가능
3. DECR inventory       → 0
```

두 요청이 동시에 오면 이렇게 됩니다.

```
요청 A: GET  → 1
요청 B: GET  → 1        ← A가 아직 안 깎았다
요청 A: 발급 가능 판정
요청 B: 발급 가능 판정
요청 A: DECR → 0
요청 B: DECR → -1       ← 한 장인데 두 장이 나갔다
```

Redis 자체는 단일 스레드라 명령 하나하나는 원자적이에요. 하지만 **명령 두 개 사이는 원자적이지 않습니다.** 애플리케이션이 판단하는 그 순간에 다른 클라이언트가 끼어들어요.

`DECR` 이 음수를 돌려주는 걸 보고 되돌리는 방법도 있습니다. 다만 그러면 **이미 발급 가능하다고 판정한 뒤**라 응답을 어떻게 처리할지가 복잡해져요.

### 락은 여기서 과합니다

분산 락으로 감쌀 수도 있어요. 재고 키마다 락을 잡고 확인과 차감을 하는 방식입니다.

안 했습니다. 락은 획득, 해제, 만료, 소유권 확인이 따라붙어요. 그리고 **선착순 예매는 그 락에 모든 요청이 몰리는 구조**입니다. 락 자체가 병목이 돼요.

Redis에는 더 단순한 답이 있습니다.

## [해결 방법 - 판정 전체를 Lua 한 덩어리로]

### 스크립트가 상태를 보고 결정합니다

```lua
local inventory = KEYS[1]
local issued = KEYS[2]
local ttlMillis = tonumber(ARGV[1])
if redis.call('EXISTS', issued) == 1 then
  return 1
end
local current = redis.call('GET', inventory)
if current == false then
  return 2
end
local remaining = tonumber(current)
if remaining == nil or remaining <= 0 then
  return 2
end
redis.call('DECR', inventory)
redis.call('SET', issued, '1', 'PX', ttlMillis)
return 0
```

**Redis는 Lua 스크립트를 원자적으로 실행합니다.** 이 스크립트가 도는 동안 다른 명령이 끼어들지 못해요. 확인과 차감 사이의 틈이 사라집니다.

반환값이 세 가지입니다.

```java
return switch (result == null ? 2 : result.intValue()) {
    case 0 -> TicketInventoryResult.ISSUED;
    case 1 -> TicketInventoryResult.DUPLICATE_TOKEN;
    default -> TicketInventoryResult.SOLD_OUT;
};
```

| 값 | 의미 |
| --- | --- |
| 0 | 발급 성공 |
| 1 | 이 토큰은 이미 발급받았다 |
| 2 | 매진 또는 재고 키 없음 |

### 중복 발급을 같은 스크립트에서 막습니다

이 스크립트가 하는 일이 하나가 아니에요. **재고 차감과 1인 1매 제한을 같이 합니다.**

```lua
if redis.call('EXISTS', issued) == 1 then
  return 1
end
```

발급하면 토큰별 키를 만들어요.

```lua
redis.call('SET', issued, '1', 'PX', ttlMillis)
```

키 이름은 이렇게 생겼습니다.

```java
private String issuedTokenKey(String screeningId, String queueToken) {
    return keyPrefix + ":" + screeningId + ":issued-token:" + queueToken;
}
```

두 검사를 한 스크립트에 넣은 게 핵심이에요. 나눠두면 **"중복 확인은 통과했는데 그 사이에 같은 토큰이 발급받는"** 경쟁이 생깁니다. 같은 사람이 두 창에서 동시에 누르는 건 흔한 일이에요.

순서도 의미가 있습니다. **중복 검사가 재고 검사보다 먼저**예요. 이미 받은 사람이 다시 요청하면 재고를 건드리지 않고 돌려보냅니다. 반대 순서면 중복 요청이 재고를 깎을 수 있어요.

### 재고 없음과 매진을 구분하지 않습니다

```lua
local current = redis.call('GET', inventory)
if current == false then
  return 2
end
```

재고 키가 아예 없을 때도 `2` 를 돌려줍니다. 매진과 같은 값이에요.

의도한 선택입니다. 키가 없다는 건 초기화가 안 됐거나 TTL로 사라졌다는 뜻인데, **어느 쪽이든 발급하면 안 됩니다.** 없으면 무제한이라고 해석하는 게 최악이에요. 모르면 거절하는 쪽으로 기울였습니다.

### 초기화는 덮어쓰지 않는 버전을 따로 둡니다

```java
@Override
public void initialize(String screeningId, int quantity) {
    redisTemplate.opsForValue().set(inventoryKey(screeningId), Integer.toString(quantity));
}

@Override
public boolean initializeIfAbsent(String screeningId, int quantity) {
    Boolean initialized = redisTemplate.opsForValue().setIfAbsent(inventoryKey(screeningId), Integer.toString(quantity));
    return Boolean.TRUE.equals(initialized);
}
```

두 개를 나눈 이유가 있어요.

`initialize` 는 무조건 덮어씁니다. 운영자가 재고를 다시 세팅할 때 쓰는 거예요.

`initializeIfAbsent` 는 없을 때만 씁니다. **서버가 뜰 때 부르는 경로**가 이걸 써야 해요. 그냥 `initialize` 를 부르면 인스턴스가 재시작할 때마다 **이미 팔린 재고가 원래대로 돌아갑니다.** 배포 한 번에 초과 발급이 나는 거예요.

이름으로 구분해둔 게 좋았습니다. 어느 쪽을 쓸지 호출하는 쪽에서 판단하게 되니까요.

### Redis와 DB의 역할을 나눕니다

Redis가 재고를 판정하고, DB가 이력을 남깁니다.

```java
TicketInventoryResult inventoryResult = inventoryRepository.decrementOne(screeningId, token);
if (inventoryResult == TicketInventoryResult.DUPLICATE_TOKEN) {
    throw new ReservationApiException(ReservationErrorCode.DUPLICATE_TICKET_ISSUANCE, screeningId, key);
}
if (inventoryResult == TicketInventoryResult.SOLD_OUT) {
    throw new ReservationApiException(ReservationErrorCode.TICKET_SOLD_OUT, screeningId, key);
}

try {
    return TicketIssuanceResponse.from(commandService.saveSuccess(screeningId, token, key, request.quantity()));
} catch (ScreeningNotFoundException exception) {
    throw new ReservationApiException(ReservationErrorCode.SCREENING_NOT_FOUND, screeningId, key);
} catch (DataIntegrityViolationException exception) {
    throw new ReservationApiException(ReservationErrorCode.DUPLICATE_TICKET_ISSUANCE, screeningId, key);
} catch (RuntimeException exception) {
    commandService.savePersistencePending(screeningId, token, key, request.quantity(), exception.getMessage());
    throw new ReservationApiException(ReservationErrorCode.TICKET_ISSUANCE_PERSISTENCE_FAILED, screeningId, key);
}
```

**매진 판정은 Redis, 최종 이력은 DB**입니다. 빠른 판단이 필요한 쪽과 오래 남아야 하는 쪽을 나눈 거예요.

### Redis가 앞서간 상태를 기록합니다

여기서 새 문제가 생깁니다. **Redis에서는 이미 깎였는데 DB 저장이 실패하면?**

그 티켓은 재고에서 빠졌지만 아무 기록도 없습니다. 사라진 한 장이 되는 거예요.

그래서 실패를 별도 테이블에 남깁니다.

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public PersistencePendingIssuance savePersistencePending(
        String screeningId,
        String queueToken,
        String idempotencyKey,
        int quantity,
        String failureReason
) {
    return persistencePendingIssuanceRepository.saveAndFlush(
            new PersistencePendingIssuance(screeningId, queueToken, idempotencyKey, quantity, failureReason)
    );
}
```

`Propagation.REQUIRES_NEW` 가 중요합니다. **원래 트랜잭션은 이미 실패한 상태**라, 같은 트랜잭션에서 저장하면 같이 롤백돼요. 새 트랜잭션을 열어야 실패 기록이 남습니다.

`failureReason` 을 같이 넣는 것도 필요했어요. DB 연결 문제인지 제약 위반인지에 따라 재처리 방식이 다릅니다.

상태도 나눠뒀습니다.

```java
public enum PersistencePendingStatus {
    PENDING, REPROCESSING, RESOLVED, FAILED
}
```

**Redis와 DB가 어긋난 상태를 "없는 일" 로 두지 않고 테이블에 남기는** 구조예요. 아주이벤트에서 [발송 상태를 Outbox로 남긴 것](/posts/21-transactional-outbox-push-recovery/)과 같은 발상입니다.

## [성과 - 개선 전후 비교]

| 항목 | GET + DECR | Lua 스크립트 |
| --- | --- | --- |
| 확인과 차감 사이 경쟁 | 초과 발급 가능 | 원자적으로 차단 |
| 1인 1매 검사 | 별도 호출 (경쟁 존재) | 같은 스크립트에서 처리 |
| 재고 키 없음 | 해석이 갈림 | 매진과 동일하게 거절 |
| Redis 왕복 | 최소 3회 | 1회 |
| DB 저장 실패 | 티켓 유실 | `persistence_pending` 에 기록 |

저장소의 테스트를 실제 Redis에 붙여서 돌렸습니다.

```
./gradlew test   (Redis 7 컨테이너 기동 상태)

storage           테스트 25건, 실패 0건
reservation-api   테스트 31건, 실패 0건
waiting-api       테스트 51건, 실패 0건
```

`RedisTicketInventoryRepositoryTest` 9건이 목이 아니라 **진짜 Redis에 Lua를 보내서** 확인합니다. 원자성은 Redis가 보장하는 성질이라 목으로는 검증할 수 없으니 이 선택이 맞아요. Redis가 안 떠 있으면 이 테스트는 통째로 실패합니다.

그중 이 글의 주장을 직접 확인하는 게 하나 있습니다.

```java
@Test
void concurrentDeductionNeverIssuesMoreThanInitialStock() throws Exception {
    repository.initialize(screeningId, 100);
    int attempts = 1_000;
    ExecutorService executor = Executors.newFixedThreadPool(32);
    CountDownLatch start = new CountDownLatch(1);
    // ... 1,000개 작업을 모두 제출한 뒤 래치를 한 번에 푼다
    assertThat(resultCounts.getOrDefault(TicketInventoryResult.ISSUED, 0L)).isEqualTo(100);
    assertThat(resultCounts.getOrDefault(TicketInventoryResult.SOLD_OUT, 0L)).isEqualTo(900);
    assertThat(resultCounts.getOrDefault(TicketInventoryResult.DUPLICATE_TOKEN, 0L)).isZero();
    assertThat(repository.remaining(screeningId)).isZero();
}
```

**재고 100장에 32스레드로 1,000회를 동시에 밀어넣어 발급이 정확히 100건**입니다. 매진 900건, 잔여 0. 클래스 전체가 0.554초에 끝났어요.

`CountDownLatch` 로 시작을 맞춘 게 중요합니다. 작업을 제출하는 대로 실행하면 자연스럽게 시차가 생겨서 경쟁이 안 만들어져요. 래치를 한 번에 풀어야 진짜 동시 요청이 됩니다.

이제 이 글의 주장이 실행으로 확인됐습니다. 다만 **비교군이 없어요.** GET + DECR 방식으로 같은 시나리오를 돌렸을 때 실제로 몇 장이 초과 발급되는지는 안 재봤습니다.

<!-- 측정 필요:
     1) GET + DECR 방식으로 같은 조건(재고 100, 32스레드, 1,000회) 실행 시 초과 발급 건수
     2) Lua 스크립트 실행 지연 (Redis SLOWLOG)
     3) 스크립트 없이 분산 락으로 감쌌을 때의 처리량 비교 -->

## [결론]

정리하면 이렇습니다.

- Redis의 명령 하나는 원자적이지만 명령 사이는 아니다
- 락으로 감싸는 대신 판정 전체를 스크립트로 옮기면 락 관리가 사라진다
- 검사 순서에도 의미가 있다. 중복 검사가 재고 검사보다 앞이어야 한다
- 초기화 함수는 덮어쓰는 것과 없을 때만 쓰는 것을 나눠야 한다
- 빠른 저장소와 영구 저장소를 나누면 그 사이가 어긋나는 상태가 새로 생긴다

한계를 적어둘게요.

첫째, **재고를 되돌리는 경로가 없습니다.** DB 저장이 실패하면 `persistence_pending` 에 기록은 남는데, Redis 재고는 깎인 채예요. 그 한 장은 아무도 못 사는 상태로 남습니다. 재처리가 성공하면 정상이 되지만, 최종 실패하면 재고를 복구해야 하는데 그 코드가 안 보여요.

둘째, **`persistence_pending` 을 재처리하는 스케줄러가 안 보입니다.** 상태 enum에 `REPROCESSING` 과 `RESOLVED` 가 있는 걸 보면 재처리를 염두에 뒀는데, 그걸 도는 코드를 못 찾았습니다. 상태만 있고 전이시키는 주체가 없으면 전부 `PENDING` 에 머물러요.

셋째, **발급 토큰 키의 TTL이 30분입니다.**

```java
@Value("${ticket.inventory.issued-token-ttl:PT30M}")
private Duration issuedTokenTtl;
```

30분이 지나면 중복 검사 키가 사라집니다. 그러면 **같은 큐 토큰으로 한 장을 더 받을 수 있어요.** 큐 토큰의 수명이 30분보다 짧으면 문제가 안 되는데, 두 값이 코드상 연결돼 있지 않습니다.

넷째, **수량이 1로 고정입니다.**

```java
if (request == null || request.quantity() == null || request.quantity() != 1) {
    throw new ReservationApiException(ReservationErrorCode.INVALID_TICKET_QUANTITY, screeningId, idempotencyKey);
}
```

스크립트도 `DECR` 로 한 장씩만 깎아요. 여러 장 예매를 지원하려면 `DECRBY` 로 바꾸고 잔여량 비교도 고쳐야 합니다.

다섯째, **Redis가 죽으면 예매가 멈춥니다.** [Gmail 레이트 리밋에서는 fail open](/posts/27-gmail-rate-limit-redis-lua-token-bucket/)을 골랐는데, 여기서는 그러면 안 돼요. 재고 판정을 건너뛰면 무제한 발급입니다. 다만 그 판단이 코드에 드러나 있지 않습니다. 예외가 그냥 위로 올라갈 뿐이에요.

동시성을 막는 코드는 잘 짰는데, **막고 난 뒤에 생기는 어긋남**에는 절반만 대비했습니다. 기록은 남기고 되돌리지는 않아요.
