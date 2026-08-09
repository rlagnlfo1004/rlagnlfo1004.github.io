---
title: "같은 키인데 다른 요청이면 어떻게 하죠 (Filter에서 막는 멱등키와 fingerprint)"
description: "중복 클릭을 컨트롤러 앞에서 끊으려고 Filter에 멱등키를 넣었습니다. 키만 보면 안 되고 요청 내용까지 봐야 했고, 그러려면 JSON을 정규화해야 했어요."
date: 2026-08-09
project: "선착순예매"
tags: ["멱등성", "Servlet Filter", "Redis", "SHA-256", "JSON"]
---

## [배경 - 버튼을 두 번 누르는 건 기본 동작이다]

선착순 예매에서 사용자는 버튼을 한 번만 누르지 않습니다. 응답이 조금이라도 늦으면 다시 누르고, 안 되는 것 같으면 또 눌러요.

브라우저와 클라이언트도 마찬가지입니다. 타임아웃이 나면 자동으로 재시도하는 경우가 있어요.

그러면 같은 사람이 같은 예매를 여러 번 요청합니다. 이게 그대로 통과하면 재고가 여러 번 깎이고 예매 기록이 여러 개 생겨요.

[Lua 스크립트로 재고 차감을 원자적으로 만들었지만](/posts/39-redis-lua-atomic-inventory/), 그건 **비즈니스 로직까지 들어온 뒤**의 이야기입니다. 중복 요청은 거기까지 갈 필요도 없어요.

## [문제 상황 분석 - 어디서, 무엇을 기준으로 막을까]

### 서비스 계층에서 막으면 이미 늦습니다

멱등 처리를 서비스 안에 넣을 수도 있어요. 그런데 그러면 요청이 이미 여기까지 온 상태입니다.

- 컨트롤러가 요청 본문을 역직렬화했고
- 검증이 돌았고
- 트랜잭션이 열렸을 수도 있고
- DB 커넥션을 잡았을 수도 있습니다

중복이라고 판단할 거면 **그 전에** 해야 자원을 안 씁니다. 예매 시작 순간에는 이 차이가 커요.

그래서 Servlet Filter에 넣었습니다. 컨트롤러 앞이고, Spring MVC 처리가 시작되기 전이에요.

### 키만 보면 위험합니다

처음에는 `Idempotency-Key` 헤더만 보면 된다고 생각했어요. 같은 키면 중복이라고요.

그런데 이러면 구멍이 생깁니다. **클라이언트가 키를 재사용하면서 내용을 바꾸면** 어떻게 될까요?

```
요청 1: Idempotency-Key: abc,  body: { "quantity": 1 }   → 처리됨
요청 2: Idempotency-Key: abc,  body: { "quantity": 5 }   → ?
```

키만 보면 "중복" 이라고 판단하고 첫 번째 결과를 돌려줍니다. 그런데 두 번째는 **다른 요청**이에요. 클라이언트 버그일 수도 있고 의도적인 시도일 수도 있습니다.

이건 조용히 넘어가면 안 되는 상황이에요. **키가 같은데 내용이 다르면 잘못된 사용**이니 에러로 알려줘야 합니다.

즉 키와 함께 **요청 내용의 지문**이 필요했습니다.

### JSON은 같은 내용도 다르게 생깁니다

내용 지문을 만들려면 본문을 해시하면 됩니다. 그런데 JSON은 문자열이 달라도 내용이 같을 수 있어요.

```json
{"quantity":1,"seatType":"A"}
{"seatType":"A","quantity":1}
```

키 순서만 다릅니다. 그대로 해시하면 **다른 지문**이 나오고, 같은 요청인데 충돌로 판정돼요.

## [해결 방법 - 정규화하고, 합치고, 선점한다]

### JSON을 정렬해서 정규화합니다

```java
String canonicalize(byte[] body) {
    try {
        Object value = objectMapper.readValue(body, Object.class);
        return objectMapper.writeValueAsString(sort(value));
    } catch (IOException exception) {
        throw new IllegalArgumentException("Request body must be valid JSON", exception);
    }
}

private Object sort(Object value) {
    if (value instanceof Map<?, ?> map) {
        TreeMap<String, Object> sorted = new TreeMap<>();
        map.forEach((key, item) -> sorted.put(String.valueOf(key), sort(item)));
        return sorted;
    }
    if (value instanceof List<?> list) {
        return list.stream().map(this::sort).toList();
    }
    return value;
}
```

파싱해서 `TreeMap` 에 넣고 다시 직렬화합니다. `TreeMap` 은 키를 정렬해서 담으니 **키 순서가 항상 같아져요.** 공백이나 들여쓰기 차이도 재직렬화하면서 사라집니다.

객체 안에 객체가 있어도 되도록 재귀로 돌립니다.

**배열은 정렬하지 않습니다.** 배열은 순서가 의미를 가질 수 있어요. `[1, 2]` 와 `[2, 1]` 은 다른 요청일 수 있으니 원소만 재귀 처리하고 순서는 그대로 둡니다. 이 구분을 안 하면 정규화가 의미를 바꿔버려요.

### 네 가지를 합쳐 지문을 만듭니다

```java
public String build(HttpServletRequest request, String queueToken, byte[] body) {
    String canonicalBody = jsonCanonicalizer.canonicalize(body);
    String bodyHash = sha256(canonicalBody);
    String source = request.getMethod()
            + "\n" + request.getRequestURI()
            + "\n" + queueToken.trim()
            + "\n" + bodyHash;
    return sha256(source);
}
```

메서드, URI, 큐 토큰, 본문 해시를 이어붙여 다시 해시합니다.

각각이 필요한 이유가 있어요.

| 요소 | 없으면 |
| --- | --- |
| 메서드 | 같은 경로의 다른 동작이 같은 지문이 된다 |
| URI | 다른 상영의 예매가 같은 지문이 된다 |
| 큐 토큰 | 다른 사용자의 요청이 같은 지문이 된다 |
| 본문 해시 | 내용이 달라도 같은 지문이 된다 |

**큐 토큰이 들어간 게 중요합니다.** 이게 없으면 사용자 A와 B가 우연히 같은 멱등키를 쓸 때 서로의 요청이 중복으로 판정돼요. 멱등키는 클라이언트가 만드는 값이라 충돌할 수 있습니다.

구분자로 개행을 쓴 것도 이유가 있어요. 그냥 이어붙이면 `("ab", "c")` 와 `("a", "bc")` 가 같은 문자열이 됩니다. 값에 안 나오는 문자를 사이에 넣어야 해요.

본문을 먼저 해시하고 그 결과를 다시 합치는 것도 같은 맥락입니다. 본문은 길고 무엇이든 들어갈 수 있으니, 고정 길이 해시로 바꾼 뒤 합치면 구분자 문제가 안 생겨요.

### 본문을 두 번 읽을 수 있게 감쌉니다

Filter에서 본문을 읽으면 컨트롤러가 못 읽습니다. `getInputStream()` 은 한 번만 읽을 수 있어요.

```java
public class IdempotencyRequestWrapper extends HttpServletRequestWrapper {

    private final byte[] body;

    public IdempotencyRequestWrapper(HttpServletRequest request) throws IOException {
        super(request);
        this.body = StreamUtils.copyToByteArray(request.getInputStream());
    }

    byte[] body() {
        return body.clone();
    }

    @Override
    public ServletInputStream getInputStream() {
        ByteArrayInputStream inputStream = new ByteArrayInputStream(body);
        // ...
    }
}
```

생성자에서 통째로 읽어 배열에 담고, `getInputStream()` 은 그 배열로 새 스트림을 만들어 돌려줍니다. 그래서 여러 번 읽을 수 있어요.

`body()` 가 `clone()` 을 돌려주는 것도 신경 쓴 부분입니다. 원본 배열을 그대로 주면 호출한 쪽이 바꿀 수 있어요.

체인에 넘길 때 감싼 요청을 넘겨야 합니다.

```java
filterChain.doFilter(wrapped, response);
```

원본을 넘기면 컨트롤러에서 빈 본문을 받습니다. 이건 실수하기 쉬운 부분이에요.

### 선점은 SET NX로 합니다

```java
Boolean claimed = redisTemplate.opsForValue().setIfAbsent(key, value, ttl);
if (Boolean.TRUE.equals(claimed)) {
    return IdempotencyClaimResult.CLAIMED;
}
String existingValue = redisTemplate.opsForValue().get(key);
if (existingValue == null) {
    return IdempotencyClaimResult.STORE_UNAVAILABLE;
}
IdempotencyRecord existing = IdempotencyRecord.deserialize(existingValue);
if (Objects.equals(existing.fingerprint(), fingerprint)) {
    return IdempotencyClaimResult.DUPLICATE_IN_PROGRESS;
}
return IdempotencyClaimResult.FINGERPRINT_CONFLICT;
```

`SET NX EX` 로 **원자적으로 선점**합니다. 확인하고 쓰는 게 아니라 한 번에 해요.

성공하면 이 요청이 처음입니다. 실패하면 이미 누가 잡은 거고, 그때 저장된 지문과 비교합니다.

결과가 네 가지예요.

| 결과 | 의미 | 응답 |
| --- | --- | --- |
| `CLAIMED` | 처음 들어온 요청 | 통과 |
| `DUPLICATE_IN_PROGRESS` | 같은 키, 같은 내용 | 진행 중 |
| `FINGERPRINT_CONFLICT` | 같은 키, 다른 내용 | 충돌 |
| `STORE_UNAVAILABLE` | Redis 문제 | 사용 불가 |

**두 번째와 세 번째를 나눈 게 이 설계의 핵심**입니다. 앞의 것은 정상적인 재시도고, 뒤의 것은 잘못된 사용이에요. 클라이언트가 다르게 대응해야 합니다.

### Redis가 죽으면 막습니다

```java
} catch (IllegalArgumentException | RedisConnectionFailureException | RedisSystemException exception) {
    return IdempotencyClaimResult.STORE_UNAVAILABLE;
} catch (RuntimeException exception) {
    return IdempotencyClaimResult.STORE_UNAVAILABLE;
}
```

Redis 장애 시 통과시키지 않고 `STORE_UNAVAILABLE` 로 거절합니다.

[Gmail 레이트 리밋에서는 fail open](/posts/27-gmail-rate-limit-redis-lua-token-bucket/)을 골랐는데 여기서는 반대예요. 이유는 **막지 못했을 때의 손해가 다르기 때문**입니다. 레이트 리밋을 못 걸면 429가 나고 재시도로 복구돼요. 멱등을 못 걸면 중복 예매가 확정됩니다.

같은 "Redis 장애" 인데 판단이 다른 게 맞다고 봤습니다.

### 대상 경로만 걸러냅니다

```java
private static final Pattern TICKET_PATH = Pattern.compile("^/api/v1/screenings/([^/]+)/tickets/?$");

Matcher matcher = TICKET_PATH.matcher(request.getRequestURI());
if (!"POST".equals(request.getMethod()) || !matcher.matches()) {
    filterChain.doFilter(request, response);
    return;
}
```

티켓 발급 POST만 처리하고 나머지는 그냥 넘깁니다. 모든 요청의 본문을 읽어 버퍼에 담으면 낭비니까요.

정규식에서 상영 ID를 캡처해 그대로 쓰는 것도 편했어요. Redis 키를 상영별로 나눌 수 있습니다.

## [성과 - 개선 전후 비교]

| 항목 | 멱등 처리 없음 | Filter 멱등 처리 |
| --- | --- | --- |
| 중복 요청 차단 지점 | 없음 | 컨트롤러 진입 전 |
| 같은 키 + 같은 내용 | 두 번 처리 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` |
| 같은 키 + 다른 내용 | 두 번 처리 | `IDEMPOTENCY_KEY_CONFLICT` |
| JSON 키 순서 차이 | 해당 없음 | 정규화로 동일 취급 |
| Redis 장애 시 | 해당 없음 | 거절 (fail closed) |

저장소의 테스트를 실제 Redis에 붙여 돌렸습니다.

```
./gradlew test   (Redis 7 컨테이너 기동 상태)

IdempotencyFilterTest                  6건, 실패 0건
IdempotencyFingerprintTest             2건, 실패 0건
RedisIdempotencyRecordRepositoryTest   4건, 실패 0건
```

`RedisIdempotencyRecordRepositoryTest` 는 진짜 Redis에 붙어서 `SET NX` 선점과 네 가지 반환값을 확인합니다.

다만 이건 **로직 검증이지 효과 측정이 아닙니다.** 같은 키로 동시 요청을 여러 개 밀어넣어 정확히 하나만 통과하는지는 확인하지 않았어요. [재고 차감 쪽](/posts/39-redis-lua-atomic-inventory/)에는 32스레드 1,000요청짜리 동시성 테스트가 있는데, 멱등키 쪽에는 그게 없습니다. 선점 자체가 `SET NX` 라 원자적이긴 하지만, 확인한 것과 확인하지 않은 것은 구분해야죠.

<!-- 측정 필요:
     1) 동일 키로 동시 100요청 시 CLAIMED 가 정확히 1건인지
        (RedisTicketInventoryRepositoryTest 의 CountDownLatch 패턴을 그대로 쓸 수 있음)
     2) Filter 차단과 서비스 차단의 요청당 처리 비용 차이 (본문 버퍼링 비용 포함) -->

## [결론]

정리하면 이렇습니다.

- 중복은 자원을 쓰기 전에 끊어야 한다. Filter가 그 자리다
- 멱등키만 보면 안 된다. 같은 키에 다른 내용이 오는 경우를 구분해야 한다
- JSON 지문을 만들려면 정규화가 먼저다. 다만 배열 순서는 건드리면 안 된다
- 여러 값을 합쳐 해시할 때는 구분자가 필요하다
- 같은 저장소 장애라도 기능에 따라 열지 닫을지가 갈린다

한계를 적어둘게요.

첫째, **응답을 저장하지 않습니다.** 표준적인 멱등 처리는 첫 요청의 응답을 보관했다가 재시도에 그대로 돌려줍니다. 여기서는 `DUPLICATE_IN_PROGRESS` 라는 에러를 줘요. 클라이언트가 결과를 알려면 조회 API를 따로 불러야 합니다.

레코드에 `inProgress` 라는 표현이 있는 걸 보면 완료 상태도 염두에 둔 것 같은데, 완료로 바꾸는 코드가 안 보입니다. **처리가 끝나도 레코드는 계속 진행 중**이에요.

둘째, **키가 TTL로 사라집니다.** TTL이 지나면 같은 멱등키로 다시 요청할 수 있어요. 큐 토큰별 발급 제한이 뒤에서 막아주긴 하는데, [그것도 30분 TTL](/posts/39-redis-lua-atomic-inventory/)이라 두 값이 맞물려 있습니다.

셋째, **본문 전체를 메모리에 올립니다.** 크기 제한이 없어요. 예매 요청은 작지만, 큰 본문을 보내는 요청으로 메모리를 압박할 수 있습니다.

넷째, **JSON이 아니면 400이 납니다.**

```java
} catch (IllegalArgumentException exception) {
    writeError(response, new ReservationApiException(ReservationErrorCode.INVALID_TICKET_QUANTITY, screeningId, null));
}
```

본문 파싱 실패를 `INVALID_TICKET_QUANTITY` 로 돌려줍니다. 수량 문제가 아닌데 수량 오류라고 알려줘요. 에러 코드가 원인을 안 가리킵니다.

다섯째, **선점만 하고 해제하지 않습니다.** 요청 처리가 실패해도 키는 TTL까지 남아요. 그러면 사용자가 같은 키로 다시 시도할 수 없고, 새 키를 만들어야 합니다. 실패 시 키를 지우면 재시도가 쉬워지지만, 그러면 "실패한 것처럼 보였는데 사실 성공한" 경우에 중복이 나요. 지금은 안전한 쪽을 골랐는데 이 선택이 코드에 적혀 있지 않습니다.

멱등키를 만들 때 제일 오래 걸린 게 "같은 키에 다른 내용" 을 어떻게 다룰지였습니다. 처음에는 생각도 안 했던 경우인데, 그걸 구분하기 시작하니 지문이 필요해지고 지문 때문에 정규화가 필요해졌어요. 하나를 정확히 하려니 세 개가 딸려왔습니다.
