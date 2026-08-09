---
title: "12명이 병렬로 만든 서버에서 장애를 추적하려면 (AOP 자동 계측과 로그 표준화)"
description: "누가 만든 코드인지에 따라 로그 형식이 달랐습니다. 어노테이션을 붙이는 대신 레이어 전체를 포인트컷으로 잡았고, 그 대가로 민감값 마스킹이 문자열 검사에 걸렸어요."
date: 2026-08-09
project: "아올다 클라우드"
tags: ["관측성", "AOP", "Loki", "OpenTelemetry", "구조화 로깅"]
---

## [배경 - 로그가 사람 수만큼 다양했다]

아올다 클라우드는 OpenStack 위에 올린 콘솔입니다. 백엔드만 8명이 붙어서 병렬로 개발했어요.

문제는 로그였습니다. 각자 필요할 때 로그를 넣다 보니 형식이 제각각이었어요. 어떤 곳은 `log.info("Nova 호출 성공")` 이고 어떤 곳은 `log.info("call nova: {} ms", duration)` 입니다.

이러면 하나의 요청이 어떻게 흘러갔는지 재구성하려면 여러 로그를 눈으로 맞춰야 합니다. 그리고 외부 시스템 연동에서 문제가 생기면 **그 부분을 만든 사람에게 물어봐야** 했어요.

외부 컴포넌트가 일곱 개입니다. Keystone, Nova, Cinder, Glance, Neutron에 알림 시스템까지요. 어느 컴포넌트가 느린지 알려면 전부 뒤져야 했습니다.

## [문제 상황 분석 - 규칙을 두면 사람이 어긴다]

### 로그 규칙 문서는 안 지켜집니다

첫 시도는 문서였어요. "외부 API 호출 시 이런 형식으로 로그를 남긴다" 는 규칙을 정했습니다.

안 지켜졌습니다. 나쁜 뜻이 아니라, **기능을 만드는 중에 로그 형식까지 신경 쓰기 어렵기 때문**이에요. 마감이 있으면 로그는 뒷전이 됩니다.

그리고 지켜진 부분도 조금씩 달랐어요. 필드 이름이 `duration` 인 곳과 `durationMs` 인 곳이 섞이면 쿼리를 두 번 짜야 합니다.

### 어노테이션 방식도 사람에게 기댑니다

두 번째로 생각한 건 `@LogExternalCall` 같은 어노테이션이었어요. AOP로 잡되 대상은 개발자가 표시하는 방식입니다.

이것도 결국 사람이 기억해야 해요. **새로 만든 메서드에 어노테이션을 안 붙이면 그 호출만 로그에서 사라집니다.** 그리고 없는 걸 알아채기 어려워요. 로그가 없다는 걸 알려면 그 호출이 있다는 걸 알아야 하는데, 모르니까 추적하는 거니까요.

아주이벤트에서 [Executor마다 데코레이터를 붙여야 했던 문제](/posts/03-mdc-async-traceid/)와 같은 구조입니다.

### 레이어를 통째로 잡기로 했습니다

그래서 대상을 사람이 표시하지 않게 만들었어요.

```java
@Pointcut("execution(* com.acc.local.external.modules.*.*.*(..))")
public void externalModuleLayer() {}
```

`external.modules` 패키지 아래의 **모든 메서드**를 잡습니다. 어노테이션이 아니라 위치가 기준이에요.

이러면 새 컴포넌트를 붙일 때 그 패키지에 클래스를 만들기만 하면 계측이 따라옵니다. 개발자가 알 필요도 없어요.

대신 **패키지 구조가 규칙이 됩니다.** 외부 호출을 그 패키지 밖에 두면 안 잡혀요. 이건 문서로 지키는 규칙보다는 낫습니다. 위치는 코드 리뷰에서 눈에 띄니까요.

## [해결 방법 - 필드를 고정하고 값을 채운다]

### 공통 필드를 정합니다

로그를 문장이 아니라 필드로 남깁니다.

```java
MDC.put("type", "EXTERNAL");
MDC.put("targetSystem", targetSystem);
MDC.put("module", className);
MDC.put("method", methodName);
MDC.put("attempt", "1");
```

그리고 끝날 때 결과를 채워요.

```java
} finally {
    MDC.put("durationMs", String.valueOf(System.currentTimeMillis() - startTime));
    cleanupMdcKeys("type", "targetSystem", "module", "method", "statusCode",
                   "success", "exception", "errorMessage", "durationMs", "attempt");
}
```

`targetSystem`, `durationMs`, `success`, `statusCode` 가 모든 외부 호출에 똑같이 붙습니다. 그러면 이런 질문에 한 번의 쿼리로 답할 수 있어요.

- 지난 한 시간 동안 Nova 호출 중 실패한 것
- 컴포넌트별 평균 응답 시간
- 5xx가 난 호출의 요청 인자

`type` 필드도 중요합니다. 접근 로그는 `ACCESS`, 외부 호출은 `EXTERNAL` 이에요. 로그 종류를 필드로 구분해두면 검색할 때 섞이지 않습니다.

### 클래스 이름에서 대상 시스템을 뽑습니다

```java
String targetSystem = String.valueOf(SystemType.findByName(className.split("(?=[A-Z])")[0]));
```

`NovaServerModule` 같은 클래스 이름에서 첫 단어를 잘라 `Nova` 를 얻고, 그걸로 시스템 종류를 찾습니다.

```java
enum OpenstackComponents {
    NOVA, NEUTRON, CINDER, GLANCE, KEYSTONE, SWIFT, HORIZON, HEAT, TROVE, MANILA, MAGNUM, Ironic
}
```

OpenStack 컴포넌트는 전부 `OPENSTACK` 으로 묶고, Google이나 Keycloak은 따로 둡니다.

**설정 파일 없이 클래스 이름만으로 분류**하는 방식이에요. 새 컴포넌트를 붙일 때 매핑 테이블을 안 고쳐도 되지만, **이름 규칙을 어기면 조용히 `UNKNOWN` 이 됩니다.** 편의와 취약함을 맞바꾼 부분입니다.

### 상태 코드로 로그 레벨을 나눕니다

```java
if (response.getStatusCode().is4xxClientError()) {
    isSuccess = false;
    log.warn("[External] {} Client Error - {} {}", targetSystem, className, methodName, argsArg);
} else if (response.getStatusCode().is5xxServerError()) {
    isSuccess = false;
    log.error("[External] {} Server Error - {} {}", targetSystem, className, methodName, argsArg);
}
```

4xx는 `warn`, 5xx는 `error` 입니다.

이유는 **누구 잘못인가**가 달라서예요. 4xx는 저희가 잘못된 요청을 보낸 거고, 5xx는 상대 시스템 문제입니다. 알림을 걸 때 이 둘을 같은 레벨로 두면 노이즈가 심해져요.

예외도 같은 기준으로 나눕니다.

```java
if (ex instanceof WebClientResponseException webEx) {
    MDC.put("statusCode", String.valueOf(webEx.getStatusCode().value()));
    Object responseBodyArg = getResponseBodyArg(webEx.getResponseBodyAsString());

    if (webEx.getStatusCode().is4xxClientError()) {
        log.warn("[External] {} Client Exception - {} {}", targetSystem, className, methodName, responseBodyArg, argsArg);
    } else {
        log.error("[External] {} System Exception - {} {}", targetSystem, className, methodName, responseBodyArg, argsArg);
    }
}
```

응답 본문을 같이 남기는 게 실전에서 제일 유용했어요. OpenStack은 400을 주면서 이유를 본문에 적어 보냅니다. 이게 없으면 "400이 났다" 까지만 알고 왜인지는 몰라요.

본문이 JSON이면 통째로 넣지 않고 구조를 살려 넣습니다.

```java
if (trimmedBody.startsWith("{") && trimmedBody.endsWith("}")) {
    objectMapper.readTree(trimmedBody);
    return raw("responseBody", trimmedBody);
}
```

`readTree` 로 파싱해보는 건 유효성 확인이에요. 깨진 JSON을 그대로 넣으면 로그 레코드 전체가 깨집니다.

### 민감값은 파라미터 이름으로 가립니다

인자를 통째로 로그에 넣으면 비밀번호와 토큰이 나갑니다.

```java
for (int i = 0; i < args.length; i++) {
    String paramName = paramNames[i];
    Object argValue = args[i];

    if (isSensitive(paramName)) {
        safeArgs.put(paramName, "***");
    } else {
        safeArgs.put(paramName, argValue);
    }
}
```

파라미터 이름에 `password`, `token`, `secret`, `credential`, `key` 가 들어 있으면 가립니다.

이 방식은 명백한 한계가 있어요. **이름 규칙에 걸리지 않으면 그대로 나갑니다.** `authValue` 나 `pw` 같은 이름은 안 걸려요. 그리고 객체 안쪽에 든 값은 아예 못 봅니다. `LoginRequest` 라는 파라미터 안에 비밀번호가 있으면 통째로 직렬화돼서 나가요.

메일상자에서 [화이트리스트로 만든 것](/posts/26-mdc-across-rabbitmq/)과 정반대입니다. 여기는 블랙리스트예요. **기본이 통과**라 빠뜨리면 유출입니다.

### 로그, 트레이스, 메트릭을 한 곳으로 모읍니다

로그는 Loki로, 트레이스는 Tempo로, 메트릭은 Prometheus로 보냅니다.

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, info, metrics, prometheus
  tracing:
    sampling:
      probability: 1.0 # Trace everything for now (adjust for prod)
  otlp:
    tracing:
      endpoint: ${TEMPO_URL:http://localhost:4318/v1/traces}
  opentelemetry:
    resource-attributes:
      service.name: ACC-Backend
```

Loki로는 logback appender를 씁니다.

```xml
<appender name="LOKI" class="com.github.loki4j.logback.Loki4jAppender">
    <filter class="ch.qos.logback.classic.filter.ThresholdFilter">
        <level>INFO</level>
    </filter>
    <format>
        <label>
            <pattern>app=ACC-Backend,host=${HOSTNAME},level=%level</pattern>
        </label>
        <message class="net.logstash.logback.layout.LoggingEventCompositeJsonLayout">
            <!-- ... -->
            <mdc>
                <excludeMdcKeyName>type</excludeMdcKeyName>
            </mdc>
        </message>
    </format>
</appender>
```

**MDC가 통째로 JSON 필드가 됩니다.** Aspect에서 `MDC.put` 만 하면 Loki에서 그 이름으로 검색할 수 있어요. 로그 문장을 파싱할 필요가 없습니다.

라벨은 세 개(`app`, `host`, `level`)만 뒀어요. Loki에서 라벨은 인덱스라 값의 종류가 많아지면 비용이 급격히 늘어납니다. `userId` 같은 걸 라벨로 넣으면 안 돼요. 그건 JSON 필드에 두고 검색할 때 필터링합니다.

프로파일로 나눈 것도 실용적인 선택이었습니다.

```xml
<springProfile name="!logging">
    <root level="INFO"><appender-ref ref="CONSOLE"/></root>
</springProfile>
<springProfile name="logging">
    <root level="INFO">
        <appender-ref ref="CONSOLE"/>
        <appender-ref ref="LOKI"/>
    </root>
</springProfile>
```

로컬 개발에서는 Loki를 안 띄워도 서버가 뜹니다.

## [성과 - 개선 전후 비교]

| 항목 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 외부 호출 로그 형식 | 개발자마다 다름 | `targetSystem`, `durationMs`, `success`, `statusCode` 공통 |
| 계측 대상 지정 | 개발자가 직접 로그 작성 | 패키지 기준 포인트컷으로 자동 |
| 실패 원인 확인 | 상태 코드만 | 응답 본문 포함 |
| 로그 검색 | 문자열 grep | 필드 기반 쿼리 |
| 트레이스 | 없음 | OTLP로 Tempo 전송, 샘플링 100% |

수치가 없습니다. "장애 추적에 걸리는 시간이 줄었다" 를 재려면 개선 전 시간을 재놨어야 하는데 안 했어요.

<!-- 측정 필요:
     1) 동일 장애 상황 재현 후, 원인 파악까지 걸린 시간 (개선 전후)
     2) 외부 호출 중 로그가 남지 않는 비율 (external.modules 밖의 호출)
     3) Loki 저장량과 라벨 카디널리티 -->

## [결론]

정리하면 이렇습니다.

- 로그 규칙을 문서로 두면 안 지켜진다. 어노테이션도 사람에게 기댄다. 위치 기준 포인트컷이 그나마 자동이다
- 공통 필드를 고정하면 로그가 검색 가능한 데이터가 된다
- 4xx와 5xx는 책임이 다르니 로그 레벨도 달라야 한다

한계를 적어둘게요.

첫째, **민감값 마스킹이 블랙리스트입니다.** 파라미터 이름에 특정 단어가 있어야만 가려져요. 이름을 다르게 지으면 그대로 나가고, 객체 안쪽 필드는 아예 검사하지 않습니다. 인자를 통째로 직렬화하는 구조에서 이건 위험해요. 클래스에 마스킹 규칙을 붙이거나 직렬화 단계에서 거르는 쪽으로 가야 합니다.

둘째, **`attempt` 가 항상 1입니다.**

```java
MDC.put("attempt", "1");
```

재시도 횟수를 남기려고 만든 필드인데 상수가 들어가요. Resilience4j의 Retry가 재시도할 때 이 값이 안 바뀝니다. 필드는 있는데 정보가 없는 상태라, 오히려 있는 게 나쁠 수 있어요.

셋째, **샘플링이 100%입니다.** 주석에도 "adjust for prod" 라고 적혀 있어요. 트래픽이 늘면 Tempo 저장량이 그대로 늘어납니다.

넷째, **`MDC.clear()` 를 접근 로그 필터에서 부릅니다.** 필터가 끝날 때 전부 비우는데, 비동기 경계가 생기면 이 방식이 안 통해요. 메일상자에서는 이전 상태로 되돌리는 방식으로 바꿨는데, 여기는 아직 `clear()` 입니다.

다섯째, **`external.modules` 밖의 호출은 안 잡힙니다.** 자동이라고 적었지만 패키지 규칙을 지킬 때만 자동이에요. 이 규칙이 문서 어디에 있는지도 확인해봐야 합니다.

로그를 표준화하는 일은 기능이 아니라서 미루기 쉬웠습니다. 12명이 각자 만든 코드에서 하나의 요청을 따라가려니 그제야 필요해졌어요. 처음부터 형식을 정해뒀으면 훨씬 쌌을 겁니다.
