---
title: "비동기로 바꾸자 로그가 끊겼습니다 (MDC와 TaskDecorator)"
description: "비동기로 바꾸자 traceId가 200건 전부 끊겼습니다. 그리고 오염을 막는 장치가 제가 생각한 코드가 아니었어요."
date: 2026-08-06
project: "아주이벤트"
tags: ["MDC", "비동기", "관측성"]
---

## [배경 - 콜백 로그에 traceId가 없다]

아주이벤트의 FCM 발송을 비동기로 바꾼 직후였습니다.

바꾼 이유는 응답 지연이었어요. 발송 대상이 늘어날수록 서블릿 스레드가 Firebase 응답을 기다리며 묶였고, 스레드 덤프를 보니 서블릿 스레드와 Firebase 내부 스레드가 같이 늘어나고 있었습니다. 그래서 `Future.get()` 을 걷어내고 콜백 방식으로 전환했어요.

```java
public void sendBatchAsync(List<Message> messages, ApiFutureCallback<BatchResponse> callback) {
    ApiFutures.addCallback(
        FirebaseMessaging.getInstance().sendEachAsync(messages),
        callback,
        fcmCallbackExecutor
    );
}
```

응답 시간은 확실히 좋아졌습니다. 그런데 며칠 뒤 발송 실패 건을 추적하다가 이상한 걸 발견했어요.

요청 로그에는 traceId가 찍히는데, **발송 결과 로그에는 없었습니다.** 어떤 요청이 어떤 결과로 이어졌는지 이을 수가 없었어요. 하필 비동기로 바꾸면서 가장 알고 싶어진 부분이 딱 안 보이게 된 겁니다.

## [문제 상황 분석 - MDC는 스레드에 묶여 있습니다]

### MDC의 저장 위치

MDC(Mapped Diagnostic Context)는 로그에 문맥 정보를 얹는 장치입니다. traceId를 한 번 넣어두면 그 뒤의 모든 로그에 자동으로 따라붙어요.

문제는 저장 위치입니다. MDC는 내부적으로 `ThreadLocal` 을 씁니다. **이름 그대로 스레드에 종속적**이에요.

<svg class="diagram" viewBox="0 0 720 320" role="img" aria-label="MDC 는 ThreadLocal 이라 스레드 경계를 넘지 못한다">
  <defs>
    <marker id="d4-x" markerWidth="8" markerHeight="8" refX="6.5" refY="4" orient="auto">
      <path d="M0,0.5 L7,4 L0,7.5" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1.2"/>
    </marker>
    <marker id="d4-c" markerWidth="8" markerHeight="8" refX="6.5" refY="4" orient="auto">
      <path d="M0,0.5 L7,4 L0,7.5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1.2"/>
    </marker>
  </defs>
  <!-- without -->
  <text x="0" y="14" font-size="12.5" font-weight="700" fill="var(--ink-2, #63605A)">데코레이터 없음</text>
  <rect x="0" y="28" width="300" height="84" rx="8" fill="var(--surface, #fff)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="18" y="50" font-size="11.5" font-weight="700" fill="var(--ink-3, #9A958B)">서블릿 스레드</text>
  <rect x="18" y="60" width="150" height="38" rx="5" fill="var(--sunk, #F1EDE3)"/>
  <text x="32" y="76" font-size="11" fill="var(--ink-3, #9A958B)">MDC</text>
  <text x="32" y="92" font-size="11.5" fill="var(--ink, #221F1B)">traceId = abc123</text>
  <rect x="420" y="28" width="300" height="84" rx="8" fill="var(--surface, #fff)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="438" y="50" font-size="11.5" font-weight="700" fill="var(--ink-3, #9A958B)">fcm-callback 스레드</text>
  <rect x="438" y="60" width="150" height="38" rx="5" fill="var(--sunk, #F1EDE3)"/>
  <text x="452" y="76" font-size="11" fill="var(--ink-3, #9A958B)">MDC</text>
  <text x="452" y="92" font-size="11.5" fill="var(--clay, #BF5F3B)">비어 있음</text>
  <text x="602" y="84" font-size="11.5" fill="var(--clay, #BF5F3B)">로그에 traceId 없음</text>
  <path d="M300,70 L416,70" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" stroke-dasharray="4 4" marker-end="url(#d4-x)"/>
  <text x="358" y="62" font-size="10.5" fill="var(--ink-3, #9A958B)" text-anchor="middle">전달 안 됨</text>
  <!-- with -->
  <text x="0" y="160" font-size="12.5" font-weight="700" fill="var(--clay, #BF5F3B)">MdcTaskDecorator 적용</text>
  <rect x="0" y="174" width="300" height="98" rx="8" fill="var(--surface, #fff)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="18" y="196" font-size="11.5" font-weight="700" fill="var(--ink-3, #9A958B)">서블릿 스레드</text>
  <rect x="18" y="206" width="150" height="38" rx="5" fill="var(--sunk, #F1EDE3)"/>
  <text x="32" y="222" font-size="11" fill="var(--ink-3, #9A958B)">MDC</text>
  <text x="32" y="238" font-size="11.5" fill="var(--ink, #221F1B)">traceId = abc123</text>
  <text x="180" y="224" font-size="11" fill="var(--ink-2, #63605A)">decorate() 에서</text>
  <text x="180" y="240" font-size="11" fill="var(--ink-2, #63605A)">스냅샷을 뜬다</text>
  <rect x="420" y="174" width="300" height="98" rx="8" fill="var(--surface, #fff)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="438" y="196" font-size="11.5" font-weight="700" fill="var(--ink-3, #9A958B)">fcm-callback 스레드</text>
  <rect x="438" y="206" width="150" height="38" rx="5" fill="var(--sunk, #F1EDE3)"/>
  <text x="452" y="222" font-size="11" fill="var(--ink-3, #9A958B)">MDC</text>
  <text x="452" y="238" font-size="11.5" fill="var(--ink, #221F1B)">traceId = abc123</text>
  <text x="602" y="216" font-size="11" fill="var(--ink-2, #63605A)">실행 전 : 무조건 덮어씀</text>
  <text x="602" y="234" font-size="11" fill="var(--ink-2, #63605A)">실행 후 : clear()</text>
  <path d="M300,220 L416,220" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1.2" marker-end="url(#d4-c)"/>
  <line x1="0" y1="292" x2="720" y2="292" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="310" font-size="11.5" fill="var(--ink-3, #9A958B)">실측 · 작업 200건 · 데코레이터 없음 0/200 연결 (0%)  →  적용 후 200/200 연결 (100%)</text>
</svg>

콜백은 `fcmCallbackExecutor` 위에서 실행됩니다. 요청을 받은 서블릿 스레드와 다른 스레드예요. 스레드가 다르니 `ThreadLocal` 도 다르고, 따라서 MDC가 비어 있습니다.

### 동기 코드에서는 왜 문제가 없었나?

`Future.get()` 을 쓰던 시절에는 호출자 스레드가 결과를 받을 때까지 기다렸습니다. 결과 처리도 같은 스레드에서 일어났으니 MDC가 그대로 살아 있었어요.

비동기로 바꾸면서 **실행 스레드가 바뀐 것**이 원인이었습니다. 성능을 위한 변경이 관측성을 깨뜨린 거죠. 이 둘이 연결되어 있다는 걸 그때 처음 의식했습니다.

### 스레드 풀이면 더 나쁩니다

일회성 스레드라면 그냥 비어 있기만 할 텐데, 스레드 풀은 스레드를 재사용합니다.

여기서 두 번째 위험이 생겨요. 앞선 작업이 스레드에 남긴 MDC를 다음 작업이 물려받을 수 있습니다. **엉뚱한 요청의 traceId가 찍히는** 상황이에요. 로그가 비는 것보다 이쪽이 더 나쁩니다. 없으면 없는 줄 알지만, 틀린 값은 잘못된 추적으로 이어지니까요.

이 오염이 정확히 어떤 조건에서 생기는지는 뒤에서 측정으로 확인합니다. 저도 처음에는 원인을 잘못 짚고 있었어요.

## [해결 방법 - TaskDecorator로 스레드 경계를 넘기기]

Spring의 `TaskDecorator` 는 Executor에 제출되는 작업을 감쌀 수 있는 인터페이스입니다. 여기에 MDC 복사를 넣으면 됩니다.

동작 순서가 핵심이에요.

```
[호출자 스레드]
  decorate(runnable) 호출 시점에 MDC 스냅샷을 뜬다
        │
        ▼
[워커 스레드]
  실행 직전  : 스냅샷을 이 스레드의 MDC 에 넣는다
  작업 실행  : 로그에 traceId 가 찍힌다
  실행 직후  : MDC 를 비운다  ← 재사용 대비
```

`decorate` 가 **제출하는 쪽 스레드에서** 불린다는 점이 중요합니다. 그 시점에는 아직 원본 MDC가 살아 있어요. 그래서 여기서 값을 떠 놓고, 워커 스레드에서 풀어놓는 구조가 성립합니다.

프로젝트에 들어간 구현은 이렇습니다.

```java
@Component
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        Map<String, String> contextMap = MDC.getCopyOfContextMap();
        return () -> {
            try {
                MDC.setContextMap(contextMap != null ? contextMap : Collections.emptyMap());
                runnable.run();
            } finally {
                MDC.clear();
            }
        };
    }
}
```

`contextMap` 이 null일 때 빈 맵을 넣는 삼항 연산자가 눈에 띌 거예요. 저는 이걸 그냥 방어 코드라고 생각했는데, 나중에 측정해보니 오염을 막는 진짜 장치가 이쪽이었습니다.

### Executor에 붙이기

`FcmConfig` 에서 두 Executor 모두에 데코레이터를 걸었습니다.

```java
@Bean(name = "fcmCallbackExecutor")
public ThreadPoolTaskExecutor fcmCallbackExecutor() {
    FcmExecutorProperties.Pool pool = fcmExecutorProperties.getCallback();
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(pool.getCorePoolSize());
    executor.setMaxPoolSize(pool.getMaxPoolSize());
    executor.setQueueCapacity(pool.getQueueCapacity());
    executor.setThreadNamePrefix("fcm-callback-");
    executor.setWaitForTasksToCompleteOnShutdown(true);
    executor.setAwaitTerminationSeconds(pool.getAwaitTerminationSeconds());
    executor.setTaskDecorator(mdcTaskDecorator);   // 여기
    executor.initialize();
    return executor;
}
```

`fcmDefaultExecutor` 에도 같은 설정을 넣었어요. **비동기 경계가 생기는 곳마다 붙여야 합니다.** 하나라도 빠뜨리면 그 경로만 조용히 끊깁니다.

풀 설정은 이렇습니다.

| 항목 | 값 |
| --- | --- |
| corePoolSize | 4 |
| maxPoolSize | 16 |
| queueCapacity | 100 |
| awaitTerminationSeconds | 30 |

여기서 하나 짚고 갈 게 있어요. `ThreadPoolTaskExecutor` 는 큐가 먼저 차고 그다음에 스레드가 늘어납니다. queueCapacity 100이 가득 차기 전까지는 스레드가 4개를 넘지 않아요. maxPoolSize 16은 큐까지 넘쳤을 때 비로소 의미가 생깁니다.

### 지표도 같이 노출했습니다

로그를 이었으니 숫자도 보기로 했어요.

```java
@Bean
public MeterBinder fcmCallbackExecutorMetrics(
        @Qualifier("fcmCallbackExecutor") ThreadPoolTaskExecutor executor) {
    return registry -> new ExecutorServiceMetrics(
        executor.getThreadPoolExecutor(),
        "fcm_callback_executor",
        List.of(Tag.of("pool", "fcm-callback"))
    ).bindTo(registry);
}
```

큐 길이와 활성 스레드 수가 Prometheus로 나갑니다. 풀 크기를 감으로 정했더라도 지표가 남으면 나중에 검증할 수 있어요. 실제로 큐가 얼마나 차는지 보고 나서 값을 조정할 생각입니다.

## [성과 - 개선 전후 비교]

`fcmCallbackExecutor` 와 같은 설정(core 4, max 16, queue 100)으로 하네스를 만들어 작업 200건을 흘렸습니다.

### 실험 1. traceId가 콜백까지 전달되는가

| 설정 | 연결된 작업 | 누락 |
| --- | --- | --- |
| 데코레이터 없음 | 0/200건 (0%) | 200건 |
| 실제 구현 적용 | 200/200건 (100%) | 0건 |

부분 유실이 아니라 **전부 끊깁니다.** 스레드가 바뀌는 순간 `ThreadLocal` 이 통째로 달라지니 당연한 결과예요. 데코레이터를 붙이면 200건 전부 연결되고, traceId가 뒤바뀐 경우도 없었습니다.

### 실험 2. 스레드 재사용 시 MDC 오염

여기서 제 예상이 빗나갔어요. 풀의 스레드를 traceId가 있는 작업으로 먼저 오염시킨 뒤, traceId 없는 작업 20건을 넣어 이전 값이 보이는지 확인했습니다.

| 데코레이터 구현 | 남의 traceId를 물려받은 작업 |
| --- | --- |
| 빈 값이면 설정을 생략 | **20/20건** |
| `finally` 의 `MDC.clear()` 를 뺌 | 0/20건 |
| 실제 구현 | 0/20건 |

`clear()` 를 빼도 오염이 0건입니다. 저는 마지막 정리가 오염을 막는 장치라고 설명해왔는데 틀렸어요.

이유는 이렇습니다. `clear()` 를 빼도 작업 시작 시점에 `setContextMap(빈 맵)` 이 **무조건** 실행돼요. 이전 값이 그 순간 덮어써집니다. 반대로 `if (contextMap != null)` 로 감싸서 빈 값일 때 설정을 건너뛰면, 스레드에 남아 있던 값이 그대로 다음 작업에 노출됩니다. 20건 전부가 남의 traceId를 달고 실행됐어요.

즉 오염을 막는 건 **뒤에서 비우는 동작이 아니라 앞에서 무조건 덮어쓰는 동작**입니다. `finally` 의 `clear()` 는 이중 안전장치이고, 이 Executor를 벗어난 뒤 스레드가 다른 용도로 쓰일 때를 대비하는 쪽에 가까워요.

## [결론]

성능 개선과 관측성은 같이 움직입니다. **실행 스레드를 바꾸는 순간 `ThreadLocal` 에 얹힌 모든 것이 끊깁니다.** MDC가 대표적이고, 보안 컨텍스트나 요청 스코프 빈도 같은 성질을 가져요.

정리하면 이렇습니다.

- 비동기 경계가 생기면 MDC는 자동으로 넘어가지 않는다
- `TaskDecorator` 로 제출 시점에 스냅샷을 떠서 워커 스레드에 복원한다
- **복원은 조건 없이 한다.** 빈 값이어도 빈 맵으로 덮어써야 오염이 없다
- 작업이 끝나면 비운다. 다만 이건 이중 안전장치이지 오염을 막는 핵심은 아니다
- Executor를 여러 개 만들면 전부에 붙인다

세 번째 항목이 이번에 배운 것입니다. 코드를 쓸 때는 삼항 연산자를 습관적인 null 방어라고 생각했는데, 측정해보니 그게 오염을 막는 실제 장치였어요. 반대로 제가 중요하다고 믿었던 `clear()` 는 이 시나리오에서 아무 차이를 만들지 않았습니다.

남은 한계를 적어둘게요.

첫째, **Executor를 새로 만들 때마다 사람이 기억해야 합니다.** 지금은 두 개뿐이라 관리되지만, 누군가 세 번째 Executor를 추가하면서 데코레이터를 빠뜨리면 그 경로만 조용히 끊겨요. 실패가 눈에 안 띄는 종류의 실수라 더 위험합니다. `BeanPostProcessor` 로 모든 `ThreadPoolTaskExecutor` 에 자동으로 붙이는 방법을 다음에 검토해보려고 해요.

둘째, **`CompletableFuture` 계열은 별도입니다.** 기본 `ForkJoinPool.commonPool()` 로 넘어가는 경로에는 이 설정이 적용되지 않아요. 명시적으로 Executor를 넘겨야 합니다.

셋째, **Micrometer Tracing과의 역할 구분을 정리해둘 필요가 있습니다.** Micrometer가 traceId를 관리하고 로깅 연동으로 MDC에 넣어주는데, 여기에 직접 손대는 것과 겹치는 지점이 있어요. 지금은 문제없이 동작하지만 어느 쪽이 어디까지 책임지는지 명확히 해두는 게 좋겠습니다.

비동기 전환을 하면서 응답 시간만 봤는데, 정작 그 변경이 만든 사각지대는 나중에야 발견했어요. 성능을 고친 뒤에는 그 변경이 무엇을 깨뜨렸는지도 같이 봐야 한다는 걸 배웠습니다.
