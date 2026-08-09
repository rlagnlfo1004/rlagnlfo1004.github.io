---
title: "브로커를 건너가면 로그가 남남이 됩니다 (RabbitMQ 헤더와 AOP로 MDC 잇기)"
description: "스레드 경계는 TaskDecorator로 넘겼는데 프로세스 경계는 그게 안 됩니다. 메시지 헤더에 실어 보내고 Consumer에서 복원하면서, 아무 키나 실으면 안 된다는 것도 같이 알았어요."
date: 2026-08-09
project: "메일상자"
tags: ["MDC", "RabbitMQ", "AOP", "관측성", "Reflection"]
---

## [배경 - 컨슈머 로그만 고아가 됐다]

메일상자의 Gmail 동기화는 RabbitMQ를 거칩니다. 앞단 서버가 이벤트를 발행하고 워커가 소비하는 구조예요.

문제를 발견한 건 장애를 추적할 때였습니다. 특정 계정의 메일이 하나 누락됐다는 얘기를 듣고 로그를 뒤졌는데, 앞단 로그와 워커 로그가 이어지지 않았어요.

앞단에는 요청 단위 식별자가 붙어 있습니다. 워커 로그에는 아무것도 없어요. "이 이벤트가 어느 요청에서 나온 건지" 를 알 방법이 없었습니다.

전에 아주이벤트에서 [비동기 경계 때문에 MDC가 끊기는 문제](/posts/03-mdc-async-traceid/)를 겪은 적이 있어요. `TaskDecorator` 로 스레드 경계를 넘겼습니다. 이번에도 같은 방법이면 되겠거니 했는데, 이건 성격이 달랐습니다.

## [문제 상황 분석 - 스레드 경계와 프로세스 경계는 다르다]

### ThreadLocal은 프로세스를 못 넘습니다

MDC는 내부적으로 `ThreadLocal` 입니다. 그래서 스레드가 바뀌면 끊겨요.

`TaskDecorator` 는 이걸 이렇게 풉니다. 작업을 제출하는 시점에 현재 스레드의 MDC를 복사해두고, 워커 스레드에서 그 스냅샷을 복원합니다. **같은 JVM 안에서 메모리를 통해 넘기는** 방식이에요.

RabbitMQ는 다릅니다.

```
[스레드 경계]
  요청 스레드 ──(메모리에 스냅샷)──> 워커 스레드
                    같은 JVM

[프로세스 경계]
  core 프로세스 ──(직렬화)──> RabbitMQ ──(역직렬화)──> worker 프로세스
                          다른 JVM, 다른 서버
```

메모리를 공유하지 않으니 스냅샷을 넘길 수 없어요. **메시지에 실어 보내는 것 말고는 방법이 없습니다.**

### 페이로드에 넣을 수는 없었습니다

가장 먼저 떠오른 건 메시지 본문에 `workId` 필드를 추가하는 거였어요. 그런데 이건 안 됩니다.

메시지 DTO는 전부 `record` 이고, 종류가 여러 개예요. 초기 동기화 메시지, 히스토리 이벤트 메시지, 라벨 재분류 메시지, Watch 갱신 메시지가 전부 다른 record입니다. 여기에 추적용 필드를 하나씩 넣으면 **도메인 데이터와 추적 데이터가 섞여요.**

그리고 새 메시지 타입을 추가할 때마다 사람이 기억해야 합니다. 아주이벤트에서 Executor마다 데코레이터를 붙여야 했던 것과 같은 문제예요. 한 번 겪었으니 이번엔 다르게 하고 싶었습니다.

AMQP에는 메시지 헤더가 따로 있어요. 본문과 분리된 자리입니다. 여기를 쓰기로 했습니다.

## [해결 방법 - 발행할 때 헤더에 싣고, 소비할 때 AOP로 복원]

### 발행: RabbitTemplate에 후처리기를 답니다

Spring AMQP의 `MessagePostProcessor` 는 메시지가 나가기 직전에 끼어들 수 있는 지점입니다. 여기에 MDC를 헤더로 옮기는 처리를 넣었어요.

```java
public MessagePostProcessor rabbitHeaders() {
    return message -> {
        Map<String, Object> headers = message.getMessageProperties().getHeaders();
        for (String key : PROPAGATED_KEYS) {
            String value = MDC.get(key);
            if (!isBlank(value)) {
                headers.put(key, value);
            }
        }
        return message;
    };
}
```

`RabbitTemplate` 에 한 번 등록하면 끝입니다.

```java
rabbitTemplate.setBeforePublishPostProcessors(observabilitySupport.rabbitHeaders());
```

이 한 줄이 중요해요. **발행 코드는 아무것도 몰라도 됩니다.** Publisher가 `convertAndSend` 를 부르든 어디서 부르든 헤더가 자동으로 붙습니다.

### 아무 키나 싣지 않습니다

여기서 그냥 `MDC.getCopyOfContextMap()` 을 통째로 헤더에 넣을 수도 있었어요. 그렇게 하지 않은 이유가 있습니다.

MDC에는 코드 어디서든 값을 넣을 수 있어요. 누군가 디버깅한다고 메일 제목이나 발신자 주소를 잠깐 넣어두면, 그게 **브로커 헤더로 나가서 브로커 로그와 관리 콘솔에 남습니다.** 메일 서비스에서 이건 사고예요.

그래서 나갈 수 있는 키를 명시적으로 열거했습니다.

```java
private static final List<String> PROPAGATED_KEYS = List.of(
        WORK_ID,
        USER_ID,
        MAIL_ACCOUNT_ID,
        JOB_ID,
        GMAIL_THREAD_ID,
        GMAIL_MESSAGE_ID,
        HISTORY_ID,
        EVENT_TYPE
);
```

전부 식별자입니다. 내용이 없어요. 메일 제목이나 본문 같은 건 목록에 없으니 실릴 수 없습니다.

화이트리스트로 만든 게 핵심이에요. 블랙리스트였다면 새로 추가되는 키가 기본으로 통과합니다. 화이트리스트는 기본이 차단이에요.

### 소비: 어노테이션 하나로 전부 걸립니다

받는 쪽은 AOP를 씁니다.

```java
@Aspect
@Component
@RequiredArgsConstructor
public class RabbitListenerObservabilityAspect {

    private final ObservabilitySupport observabilitySupport;

    @Around("@annotation(org.springframework.amqp.rabbit.annotation.RabbitListener)")
    public Object openRabbitListenerScope(ProceedingJoinPoint joinPoint) throws Throwable {
        Message rawMessage = findRawMessage(joinPoint.getArgs());
        if (rawMessage == null) {
            return joinPoint.proceed();
        }

        Object payload = findPayload(joinPoint.getArgs());
        try (ObservabilitySupport.Scope ignored = observabilitySupport.openRabbitScope(rawMessage, payload)) {
            return joinPoint.proceed();
        }
    }
    // ...
}
```

포인트컷이 `@RabbitListener` 어노테이션 자체입니다. 특정 클래스나 패키지가 아니라요.

이게 처음에 원했던 겁니다. **새 Listener를 추가하면 자동으로 걸려요.** 추적 코드를 쓸 필요가 없습니다. 아주이벤트에서 "Executor를 새로 만들 때마다 사람이 기억해야 한다" 고 적었던 한계를, 여기서는 어노테이션 기준 포인트컷으로 풀었습니다.

### 헤더가 없으면 페이로드에서 꺼냅니다

헤더만 믿을 수는 없었어요. 스케줄러가 직접 발행한 메시지처럼 앞단 MDC가 비어 있는 경로가 있습니다. 그래서 두 군데를 봅니다.

```java
public Scope openRabbitScope(Message rawMessage, Object payload) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.putAll(extractHeaders(rawMessage));
    values.putAll(extractPayloadValues(payload));
    values.put(ROUTING_KEY, rawMessage.getMessageProperties().getReceivedRoutingKey());
    values.put(QUEUE, rawMessage.getMessageProperties().getConsumerQueue());
    values.putIfAbsent(WORK_ID, currentWorkIdOrNew());
    return openScope(values);
}
```

순서가 의미를 가집니다. 헤더를 먼저 넣고 페이로드를 나중에 넣으니 **페이로드 값이 헤더를 덮어씁니다.** 페이로드는 그 메시지가 실제로 다루는 대상이라 더 정확하다고 봤어요.

`putIfAbsent(WORK_ID, ...)` 는 마지막 방어선입니다. 헤더에도 페이로드에도 `workId` 가 없으면 새로 만들어요. **추적 ID가 없는 로그는 남기지 않겠다**는 뜻입니다.

`routingKey` 와 `queue` 를 넣는 것도 유용했어요. 같은 Listener 메서드가 여러 큐를 처리하는 경우가 있어서, 로그만 보고는 어느 큐에서 온 건지 알 수 없었습니다.

### 페이로드는 리플렉션으로 읽습니다

메시지 record는 종류마다 필드가 달라요. 공통 인터페이스를 만들어 강제하는 방법도 있었지만, 그러면 모든 메시지 타입이 추적 인터페이스를 구현해야 합니다.

리플렉션으로 갔습니다.

```java
private Map<String, String> extractPayloadValues(Object payload) {
    Map<String, String> values = new LinkedHashMap<>();
    if (payload == null) {
        return values;
    }

    Class<?> payloadType = payload.getClass();
    for (String key : PAYLOAD_KEYS) {
        try {
            Method method = payloadType.getMethod(key);
            if (method.getParameterCount() == 0) {
                Object value = method.invoke(payload);
                if (value != null) {
                    values.put(key, toMdcValue(value));
                }
            }
        } catch (ReflectiveOperationException ignored) {
            // Payloads are heterogeneous records; missing observability fields are expected.
        }
    }
    return values;
}
```

record는 필드명과 같은 이름의 접근자를 만들어줍니다. `mailAccountId` 필드가 있으면 `mailAccountId()` 메서드가 자동으로 생겨요. 그래서 키 이름으로 메서드를 찾으면 됩니다.

예외를 삼키는 게 마음에 걸렸는데, 여기서는 의도한 동작이에요. `gmailThreadId` 가 없는 메시지 타입도 있으니 `NoSuchMethodException` 은 정상입니다. 다만 이 판단을 주석으로 남겨두지 않으면 나중에 읽는 사람이 버그로 볼 수 있어서 한 줄 적었어요.

### 스코프는 지우지 않고 되돌립니다

정리하는 방식도 아주이벤트 때와 달라졌습니다.

```java
public static final class Scope implements AutoCloseable {

    private final Map<String, String> previousContext;

    @Override
    public void close() {
        if (previousContext == null) {
            MDC.clear();
            return;
        }
        MDC.setContextMap(previousContext);
    }
}
```

`MDC.clear()` 가 아니라 **이전 상태로 복원**합니다. 스코프가 중첩될 수 있기 때문이에요. 바깥 스코프가 열려 있는데 안쪽이 끝나면서 전부 지워버리면 바깥 로그의 컨텍스트가 사라집니다.

`AutoCloseable` 로 만들어서 `try-with-resources` 로 쓰게 한 것도 의도예요. `finally` 를 사람이 쓰게 두면 언젠가 빠뜨립니다.

## [성과 - 개선 전후 비교]

저장소에 이 동작을 검증하는 테스트가 세 개 있습니다.

| 테스트 | 확인하는 것 |
| --- | --- |
| `openScope_allowedKeys만Mdc에넣고종료시이전값을복원한다` | 허용되지 않은 키(`emailAddress`)는 MDC에 안 들어가고, 스코프 종료 시 이전 값이 복원된다 |
| `rabbitHeaders_mdc의허용된키만메시지헤더로복사한다` | MDC에 있던 `subject` 가 헤더로 나가지 않는다 |
| `openRabbitScope_헤더와Payload에서식별자를복원한다` | 헤더의 `workId` 와 페이로드의 `mailAccountId` 가 함께 복원되고, 종료 후 비워진다 |

두 번째 테스트가 제일 중요합니다. `subject` 라는 키에 `"secret subject"` 를 넣고 헤더에 안 실리는지 확인해요. 화이트리스트가 실제로 막고 있는지를 검증하는 테스트입니다.

직접 돌려봤습니다.

```
./gradlew :test --tests "com.mailsangja.worker.common.observability.ObservabilitySupportTest"

tests="3" skipped="0" failures="0" errors="0" time="0.055"
```

3건 전부 통과하고 0.055초가 걸렸어요. 외부 의존이 없는 순수 단위 테스트라 빠릅니다. Redis도 RabbitMQ도 안 띄우고 `MessageProperties` 객체만 만들어서 확인하는 구조예요.

로그 쪽 변화는 이렇습니다.

| 항목 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 앞단과 워커 로그 연결 | 불가 | `workId` 로 연결 |
| 워커 로그의 컨텍스트 | 없음 | 계정, 메시지, 스레드, 이벤트 종류, 큐 |
| 새 Listener 추가 시 | (해당 없음) | 추가 코드 없이 자동 적용 |
| 민감 정보 유출 경로 | (해당 없음) | 화이트리스트로 차단 |

## [결론]

정리하면 이렇습니다.

- 스레드 경계는 메모리로 넘기고, 프로세스 경계는 메시지에 실어야 한다
- 실어 보낼 키는 화이트리스트로 정한다. 기본이 차단이어야 한다
- 어노테이션 기준 포인트컷으로 걸면 새 Listener가 자동으로 포함된다

한계도 적어둘게요.

첫째, **Listener 시그니처에 `Message` 가 있어야 동작합니다.** Aspect가 인자에서 원본 메시지를 찾는데, 없으면 아무것도 안 하고 그냥 통과해요. 페이로드만 받는 Listener를 만들면 그 경로만 조용히 추적이 끊깁니다. 자동 적용이라고 했지만 완전하지는 않아요.

둘째, **리플렉션 비용을 안 쟀습니다.** 메시지 하나마다 최대 7번 `getMethod` 를 부릅니다. 캐싱이 없어요. 지금 처리량에서는 문제가 안 되겠지만 근거는 없습니다.

셋째, **DLQ로 간 메시지의 헤더가 유지되는지 확인 안 했습니다.** 재시도를 소진하고 DLQ로 넘어갈 때 원본 헤더가 그대로 가는지, 아니면 브로커가 새로 만드는지를 안 봤어요. 장애 추적이 가장 필요한 순간이 DLQ인데 정작 거기를 확인 안 했습니다.

넷째, **`workId` 만으로는 인과 관계를 못 봅니다.** 같은 ID가 붙은 로그를 모을 수는 있는데, 그 안에서 뭐가 뭘 유발했는지는 순서로 추측해야 해요. OpenTelemetry의 span 개념이 필요한 지점입니다.

같은 문제를 두 번째로 만나니 처음보다 나은 구조가 나왔어요. 첫 번째 때 남겨둔 한계가 이번 설계의 출발점이었습니다.
