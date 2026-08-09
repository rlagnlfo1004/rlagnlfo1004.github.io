---
title: "429를 맞고 나서야 쿼터를 세기 시작했습니다 (Redis Lua 토큰 버킷과 1000배 스케일)"
description: "Gmail API는 호출 수가 아니라 연산별 가중치로 쿼터를 셉니다. 컨슈머 여러 개가 같은 계정을 동시에 두드리는 걸 막으려고 Redis Lua로 토큰 버킷을 짰어요."
date: 2026-08-09
project: "메일상자"
tags: ["Rate Limit", "Redis", "Lua", "Token Bucket", "Gmail API"]
---

## [배경 - 계정 하나에 컨슈머 둘이 붙었다]

메일상자에서 Gmail을 새로 연결하면 초기 동기화가 돕니다. 스레드 목록을 훑고 하나씩 본문을 받아오는 작업이에요.

그런데 이게 도는 동안에도 새 메일은 계속 옵니다. Pub/Sub 푸시가 들어오고 실시간 동기화 컨슈머가 같은 계정의 Gmail API를 부릅니다.

컨슈머는 여러 개예요. 초기 동기화용 컨슈머가 3개, 스레드 배치용이 5개, 히스토리 이벤트용이 여러 개입니다. 이들이 **같은 사용자의 Gmail API를 동시에 두드립니다.**

429가 나기 시작했어요. 그제야 Gmail API 쿼터 문서를 제대로 읽었습니다.

## [문제 상황 분석 - 호출 수를 세면 안 되는 이유]

### 쿼터는 호출 수가 아니라 가중치입니다

처음에는 "분당 몇 번" 으로 제한하면 되겠다고 생각했어요. 그런데 Gmail API는 그렇게 세지 않습니다.

메서드마다 **quota unit** 이라는 비용이 다르게 매겨져 있어요. 저희가 쓰는 두 개는 이렇습니다.

```java
public static final long THREAD_LIST_QUOTA_UNITS = 10;
public static final long THREAD_GET_QUOTA_UNITS = 40;
```

목록 조회는 10, 스레드 본문 조회는 40입니다. **네 배 차이예요.**

호출 수로 제한하면 이 차이가 사라집니다. 목록 조회 100번과 본문 조회 100번을 같은 것으로 취급하게 되는데, 실제 소모량은 4배가 나요. 그러면 제한을 느슨하게 잡으면 429가 나고, 빡빡하게 잡으면 가벼운 호출까지 막힙니다.

그래서 **호출마다 비용을 다르게 매기는 구조**가 필요했어요. 토큰 버킷이 여기에 맞습니다.

### 애플리케이션에서 세면 경쟁이 생깁니다

토큰 버킷은 단순합니다. 버킷에 토큰이 차 있고, 요청이 오면 비용만큼 빼고, 시간이 지나면 다시 채워요.

문제는 이걸 어디서 계산하느냐입니다. Redis에 값을 저장한다고 해도 순서가 이렇게 되면 안 돼요.

```
컨슈머 A: HGET tokens → 45
컨슈머 B: HGET tokens → 45      ← 아직 A가 안 썼다
컨슈머 A: 45 - 40 = 5,  HSET 5
컨슈머 B: 45 - 40 = 5,  HSET 5  ← 80을 썼는데 40만 빠졌다
```

읽고, 계산하고, 쓰는 사이에 다른 컨슈머가 끼어듭니다. 고전적인 read-modify-write 경쟁이에요.

락을 걸어서 풀 수도 있습니다. 다만 그러면 락 획득과 해제, 만료 처리가 따라붙어요. Redis에는 더 단순한 답이 있습니다.

### 왜 Lua인가

**Redis는 Lua 스크립트를 원자적으로 실행합니다.** 스크립트가 도는 동안 다른 명령이 끼어들지 못해요. 읽기와 계산과 쓰기를 한 덩어리로 묶을 수 있습니다.

락을 따로 두는 것보다 이게 낫다고 봤어요. 락 만료나 해제 실패 같은 상태를 관리할 필요가 없습니다.

## [해결 방법 - 스크립트 하나로 판정한다]

### 스크립트 전문

```lua
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_minute = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])
local millis_per_minute = tonumber(ARGV[6])

local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local updated_at = tonumber(redis.call('HGET', key, 'updatedAtMillis'))

if tokens == nil or updated_at == nil then
    tokens = capacity
    updated_at = now_ms
end

if now_ms < updated_at then
    updated_at = now_ms
end

local elapsed_ms = now_ms - updated_at
local refill = math.floor((elapsed_ms * refill_per_minute) / millis_per_minute)
tokens = math.min(capacity, tokens + refill)

local allowed = 0
if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'updatedAtMillis', tostring(now_ms))
redis.call('PEXPIRE', key, ttl_ms)

return allowed
```

여기서 짚을 부분이 몇 개 있어요.

**리필을 스케줄러로 하지 않습니다.** 백그라운드에서 주기적으로 토큰을 채우는 방식도 있는데, 그러면 그 스케줄러가 또 하나의 움직이는 부품이 돼요. 대신 **마지막 갱신 시각을 저장해두고 요청이 올 때 경과 시간만큼 계산합니다.** 아무도 안 부르면 아무것도 안 돌아요.

**시계 역행을 방어합니다.**

```lua
if now_ms < updated_at then
    updated_at = now_ms
end
```

서버가 여러 대면 시계가 완전히 같지 않아요. NTP 보정으로 시간이 뒤로 갈 수도 있습니다. 이 방어가 없으면 `elapsed_ms` 가 음수가 되고 리필이 음수가 돼서 토큰이 줄어듭니다. 없는 요청 때문에 쿼터가 깎이는 셈이에요.

**시각을 Redis가 아니라 애플리케이션이 넘깁니다.** Redis의 `TIME` 명령을 쓸 수도 있는데, 그러면 스크립트가 비결정적이 돼요. 복제 환경에서 문제가 될 수 있습니다. 그래서 `clock.millis()` 를 인자로 넘깁니다.

### 1000배로 스케일하는 이유

이게 처음에 이해 못 했던 부분입니다.

```java
private static final long UNIT_SCALE = 1000;
```

용량과 리필률과 비용을 전부 1000배로 만들어서 넘겨요. 왜 그런지는 리필 계산식을 보면 나옵니다.

```lua
local refill = math.floor((elapsed_ms * refill_per_minute) / millis_per_minute)
```

`math.floor` 가 있습니다. 정수로 내려요. 그러면 경과 시간이 짧을 때 리필이 0이 됩니다.

분당 12,000 유닛을 채운다고 해봅시다. 1밀리초가 지났으면 이렇게 됩니다.

```
스케일 없이:  floor((1 × 12000) / 60000)      = floor(0.2)   = 0
1000배 스케일: floor((1 × 12000000) / 60000)  = floor(200)   = 200  (= 0.2 유닛)
```

스케일이 없으면 **1밀리초 간격으로 계속 호출하는 상황에서 리필이 영원히 0**입니다. 소수점이 매번 버려지니까요. 1000배로 올려두면 0.001 유닛 단위까지 살아남습니다.

정수 연산만 쓰면서 소수점을 다루는 흔한 방법인데, 왜 필요한지는 위 계산을 해보고서야 알았어요.

### 설정값과 TTL의 관계

```java
private boolean enabled = true;
private boolean failOpen = true;
private long perUserCapacityUnits = 12000;
private long perUserRefillUnitsPerMinute = 12000;
private Duration keyTtl = Duration.ofMinutes(2);
```

용량과 분당 리필이 같은 값입니다. 그러니까 **빈 버킷이 가득 차는 데 정확히 1분**이 걸려요.

TTL이 2분인 게 여기에 걸립니다. 키가 만료되면 다음 호출에서 `tokens = capacity` 로 초기화돼요. 즉 **TTL이 지나면 버킷이 공짜로 가득 찹니다.**

이게 문제가 되지 않는 이유는 TTL이 채우는 시간보다 길기 때문이에요. 2분을 기다리면 어차피 1분 만에 가득 차 있습니다. 만료가 이득을 주지 않아요.

반대로 **TTL을 30초로 줄이면 구멍이 생깁니다.** 버킷을 비우고 30초 기다렸다 다시 부르면 가득 찬 상태로 시작하니까, 실질 한도가 두 배가 돼요. TTL은 반드시 `용량 ÷ 리필률` 보다 커야 합니다. 이 관계를 놓치면 조용히 제한이 풀립니다.

### Redis가 죽으면 통과시킵니다

```java
private void handleRedisFailure(RuntimeException e) {
    if (properties.isFailOpen()) {
        log.warn("Gmail API rate limit Redis check failed. failOpen=true", e);
        return;
    }
    throw new MailPushException(MailPushErrorCode.GMAIL_RATE_LIMIT_UNAVAILABLE);
}
```

기본값이 `failOpen = true` 입니다. Redis가 안 되면 제한 없이 통과시켜요.

이건 명백한 트레이드오프입니다. 두 방향을 놓고 보면 이렇습니다.

| | fail open | fail closed |
| --- | --- | --- |
| Redis 장애 시 | 메일 동기화 계속됨 | 동기화 전면 중단 |
| 위험 | Gmail 429 발생 가능 | 서비스 기능 정지 |

메일 동기화는 이 서비스의 본체입니다. Redis가 죽었다고 인박스가 멈추면 사용자 입장에서는 서비스가 죽은 거예요. 반면 429는 Gmail이 잠깐 거절하는 것이고 재시도로 복구됩니다.

그래서 fail open을 골랐습니다. 다만 이건 **레이트 리밋의 성격에 따라 반대가 맞을 수도 있어요.** 결제 한도였다면 fail closed가 맞습니다. 설정으로 뺀 것도 그래서예요.

### Redis 키에 이메일을 그대로 쓰지 않습니다

```java
private String redisKey(String accountKey) {
    String encodedAccountKey = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(accountKey.getBytes(StandardCharsets.UTF_8));
    return KEY_PREFIX + encodedAccountKey;
}
```

계정 키를 Base64로 인코딩해서 넣어요. 이유가 두 개입니다.

첫째, **구분자 충돌**입니다. Redis 키는 콜론으로 계층을 나누는 관례가 있는데, 이메일 주소에 특수문자가 섞이면 키 구조가 흔들려요.

둘째, **키 스페이스에 이메일이 남습니다.** `KEYS` 나 `SCAN` 을 돌리면 이메일 주소가 그대로 보여요. 모니터링 도구나 slowlog에도 남습니다. Base64는 암호화가 아니라 되돌릴 수 있지만, 적어도 눈으로 훑을 때 바로 읽히지는 않아요.

## [성과 - 개선 전후 비교]

단위 테스트가 여섯 개 있습니다. 직접 돌렸어요.

```
./gradlew :test --tests "com.mailsangja.worker.service.google.GmailApiRateLimitServiceTest"

tests="6" skipped="0" failures="0" errors="0" time="0.79"
```

여섯 개가 다루는 시나리오입니다.

| 시나리오 | 기대 동작 |
| --- | --- |
| 토큰 충분 | 통과, 스케일된 인자로 스크립트 호출 |
| 토큰 부족 | `GMAIL_RATE_LIMIT_EXCEEDED` |
| `enabled = false` | Redis를 아예 호출하지 않음 |
| Redis 장애 + fail open | 통과 |
| Redis 장애 + fail closed | `GMAIL_RATE_LIMIT_UNAVAILABLE` |
| 설정값 오류 (용량 0) | `GMAIL_RATE_LIMIT_CONFIG_INVALID` |

첫 번째 테스트가 스케일 변환까지 검증합니다. 용량 12,000이 `"12000000"` 으로, 비용 40이 `"40000"` 으로 넘어가는지 확인해요. 스케일 로직은 눈으로 봐서는 틀린 걸 못 찾으니 이런 검증이 필요했습니다.

정직하게 적으면, **이건 로직 검증이지 효과 측정이 아닙니다.** Redis는 목이고 실제 동시 요청도 없어요. 429가 실제로 줄었는지는 확인하지 못했습니다.

<!-- 측정 필요: 실제 효과 검증.
     1) 레이트 리밋 적용 전후 Gmail API 429 응답 건수 (동일 기간 비교)
     2) 실제 Redis에 컨슈머 8개를 동시에 붙여 토큰 초과 발급이 없는지
        (스크립트 원자성은 embedded redis 또는 testcontainers 로 검증 가능)
     3) 스크립트 실행 지연 (Redis SLOWLOG) -->

## [결론]

정리하면 이렇습니다.

- 외부 API 쿼터가 가중치 기반이면 호출 수가 아니라 비용으로 세야 한다
- read-modify-write를 원자적으로 묶는 데는 락보다 Lua가 단순하다
- 정수 연산에서 버림이 생기는 지점은 스케일을 올려 막는다
- TTL은 버킷이 가득 차는 시간보다 길어야 한다. 아니면 제한이 조용히 풀린다

한계도 적어둘게요.

첫째, **거부된 요청을 어떻게 처리할지가 약합니다.** 토큰이 없으면 예외를 던지고, 그 예외는 메시지 재시도 흐름으로 흘러갑니다. 30초 뒤 재시도인데 그때도 토큰이 없으면 또 실패해요. 남은 토큰이 채워질 시각을 계산해서 그만큼만 기다리는 편이 정확한데, 지금 스크립트는 허용 여부만 돌려주고 대기 시간을 안 알려줍니다.

둘째, **12,000이라는 값에 근거가 약합니다.** 발표된 사용자당 한도보다 낮게 잡긴 했는데, 얼마나 낮게 잡아야 안전한지는 실측하지 않았어요.

셋째, **실제 쿼터와 제 카운터가 어긋날 수 있습니다.** 429가 이미 나서 실패한 호출도 저희 버킷에서는 토큰을 소모한 걸로 잡혀요. 반대로 재시도로 다시 부르면 또 소모됩니다. Gmail이 세는 값과 제가 세는 값이 정확히 같지는 않습니다.

넷째, **버킷이 사용자 단위입니다.** Gmail에는 프로젝트 전체 한도도 따로 있어요. 사용자가 늘어나면 개별 사용자는 다 통과하는데 프로젝트 한도에서 막히는 상황이 생길 수 있습니다.

429를 보고 나서야 쿼터 문서를 읽었다는 게 이번 일의 요약이에요. 외부 API를 붙일 때 제한 조건부터 읽는 습관이 아직 없습니다.
