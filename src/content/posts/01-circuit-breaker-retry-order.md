---
title: "Circuit Breaker와 Retry, 어느 쪽을 바깥에 둘 것인가 (Resilience4j 중첩 순서)"
description: "Resilience4j에서 CB와 Retry의 중첩 순서를 바꿔 실측했습니다. 재시도로 살아나는 오류 50건 중 32건이 차단기 때문에 실패했어요."
date: 2026-08-06
project: "아올다 클라우드"
tags: ["Resilience4j", "CircuitBreaker", "Retry"]
---

## [배경 - 두 줄짜리 코드에서 멈춰 선 이유]

아올다 클라우드는 OpenStack 위에 올린 콘솔입니다. 프론트엔드가 OpenStack API를 직접 부르지 않도록 BFF 계층을 두고, 인증(Keystone)과 컴퓨트(Nova), 볼륨(Cinder), 이미지(Glance) 호출을 중계해요.

문제는 컴포넌트 하나가 느려질 때 생겼습니다. 그 호출을 기다리는 요청들이 공통 서블릿 스레드 풀을 전부 점유했고, 장애와 무관한 기능까지 같이 멈췄어요. 전형적인 Cascading Failure 입니다.

처방은 명확했습니다. 컴포넌트별로 Circuit Breaker를 나누고, 일시적인 네트워크 오류는 Retry로 흡수하기로 했어요. Resilience4j를 쓰기로 했고 여기까지는 막힘이 없었습니다.

그런데 막상 코드를 쓰려니 손이 멈췄어요. 둘을 어떤 순서로 겹쳐야 하는지 확신이 없었습니다.

```java
// 이렇게?
Retry.decorateSupplier(retry, CircuitBreaker.decorateSupplier(cb, supplier));

// 아니면 이렇게?
CircuitBreaker.decorateSupplier(cb, Retry.decorateSupplier(retry, supplier));
```

처음에는 별 차이 없을 거라고 생각했어요. 어차피 둘 다 실행되니까요. 그런데 뜯어보니 완전히 다른 동작이었습니다.

## [문제 상황 분석 - 중첩 순서가 바꾸는 것]

### 데코레이터는 안에서 밖으로 감싸집니다

`decorateSupplier` 는 이름 그대로 데코레이터 패턴이에요. 인자로 받은 Supplier를 감싼 새 Supplier를 돌려줍니다. 따라서 **나중에 감싼 쪽이 바깥**이 됩니다.

```
CircuitBreaker.decorateSupplier(cb, Retry.decorateSupplier(retry, supplier))
                                    └─────── 안쪽 ────────┘
└──────────────────────── 바깥 ────────────────────────────┘
```

호출이 들어오면 바깥부터 안쪽으로 들어갔다가 다시 나옵니다. 이 순서가 두 컴포넌트의 관계를 결정해요.

![중첩 순서에 따라 CB가 세는 것이 달라진다](/diagrams/01-decorator-order.png)

### Retry가 바깥일 때

CB가 호출마다 개입하므로 실패가 **3회** 기록됩니다. 실패율이 빠르게 차오르니 장애 감지는 확실히 빨라요.

문제는 CB가 OPEN 된 다음입니다. 바깥의 Retry는 그 사실을 모르고 계속 재시도해요. OPEN 상태에서는 `CallNotPermittedException` 이 바로 떨어지는데, Retry 입장에서는 이것도 그냥 실패입니다. 그래서 또 시도합니다.

정확히는 예외 타입을 걸러내면 막을 수 있어요. 다만 그건 별도 설정을 얹어야 성립하는 이야기이고, 기본 조합만 놓고 보면 무의미한 재시도가 남습니다.

### Circuit Breaker가 바깥일 때

CB는 재시도가 전부 끝난 뒤의 **최종 결과 하나만** 봅니다. 3회를 다 소진하고도 실패했을 때 비로소 1회로 집계돼요.

CB가 OPEN 되면 그 안쪽의 Retry는 아예 실행되지 않습니다. 차단이 재시도보다 앞에 있으니까요.

### 왜 이 차이가 중요한가?

두 배치에서 CB가 보는 실패율의 의미가 달라집니다.

| | Retry 바깥 | CB 바깥 |
| --- | --- | --- |
| CB가 세는 것 | 개별 호출 실패율 | 재시도해도 안 되는 비율 |
| 장애 감지 속도 | 빠름 | 재시도 시간만큼 늦음 |
| OPEN 이후 재시도 | 발생함 | 발생하지 않음 |
| 일시적 오류 반응 | 민감 | 둔감 |

핵심은 **CB가 세는 실패율의 정의가 바뀐다**는 점이에요. Retry가 바깥이면 CB는 "요청이 얼마나 실패하는가"를 봅니다. CB가 바깥이면 "재시도해도 못 살리는 요청이 얼마나 되는가"를 봐요.

Circuit Breaker의 목적을 생각하면 후자가 맞습니다. 차단기는 일시적인 딸꾹질이 아니라 지속적인 장애에 반응해야 하니까요. 200ms 뒤 재시도로 살아나는 오류까지 실패로 세면, 멀쩡한 컴포넌트를 끊어버리는 오탐이 늘어납니다.

## [해결 방법 - CB를 바깥에 두기]

`OpenstackResilienceExecutor` 에 다음처럼 넣었습니다.

```java
Supplier<T> decorated = CircuitBreaker.decorateSupplier(
        cb,
        Retry.decorateSupplier(retry, supplier)
);

try {
    return decorated.get();
} catch (CallNotPermittedException e) {
    log.warn("[CB-OPEN] component={} port={} method={} cb={} state={}",
            component, port, method, cb.getName(), cb.getState());
    throw new ServiceUnavailableException(
            CommonErrorCode.OPENSTACK_INFRA_UNAVAILABLE, component + " 임시 오류");
}
```

OPEN 상태에서는 캐시된 데이터를 주는 대신 어느 컴포넌트가 막혔는지 밝히고 503을 던집니다. 오래된 상태를 보여주는 것보다 솔직한 실패가 낫다고 판단했어요.

### 재시도는 GET에만 허용했습니다

순서를 정하고 나니 다음 질문이 따라왔습니다. 어떤 요청에 재시도를 걸 것인가입니다.

VM 생성 요청이 네트워크 오류로 실패했을 때 재시도하면, 서버 쪽에는 이미 만들어졌는데 응답만 못 받은 경우 VM이 두 대 생깁니다. 그래서 화이트리스트 방식으로 갔어요.

```yaml
retry:
  configs:
    default-off:  { maxAttempts: 1, waitDuration: 0ms }
    default-get:  { maxAttempts: 3, waitDuration: 200ms }
    default-post: { maxAttempts: 1, waitDuration: 0ms }

  instances:
    retry-default-get:    { baseConfig: default-off }
    retry-default-post:   { baseConfig: default-off }
    retry-default-delete: { baseConfig: default-off }

    retry-keystone-get: { baseConfig: default-get }
    retry-nova-get:     { baseConfig: default-get }
```

모든 `retry-default-*` 가 `default-off` 입니다. 컴포넌트가 명시적으로 매칭된 GET만 `default-get` 을 받아서 3회 재시도해요. 기본값이 "재시도 안 함"이고, 안전하다고 판단한 것만 올리는 구조입니다.

`retry-default-get` 조차 `default-off` 인 게 눈에 띌 수 있어요. 컴포넌트를 식별하지 못해 기본값으로 떨어진 호출은 성격을 모르니 재시도하지 않겠다는 뜻입니다.

### 임계값은 컴포넌트 성격에 따라 나눴습니다

```yaml
circuitbreaker:
  configs:
    default-config:
      slidingWindowType: COUNT_BASED
      slidingWindowSize: 50
      minimumNumberOfCalls: 20
      failureRateThreshold: 50
      waitDurationInOpenState: 5s
      permittedNumberOfCallsInHalfOpenState: 5
      automaticTransitionFromOpenToHalfOpenEnabled: true
```

여기서 인스턴스별로 값을 덮어썼어요.

| 인스턴스 | failureRateThreshold | waitDurationInOpenState | 성격 |
| --- | --- | --- | --- |
| cb-keystone | 40 | 3s | 인증, 가장 민감 |
| cb-glance | 45 | 3s | 이미지 |
| cb-nova | 55 | 5s | 컴퓨트 |
| cb-cinder | 55 | 5s | 볼륨 |
| cb-discord | 80 | 30s | 알림, 부가 기능 |
| cb-email | 70 | 60s | 메일, 부가 기능 |

세 계층으로 나뉩니다. 인증은 40%로 가장 예민하게, 리소스 계열은 55%로, 사용자 요청 경로가 아닌 부가 기능은 70%와 80%로 관대하게 잡았어요. 대신 부가 기능은 한 번 OPEN 되면 30초와 60초로 오래 쉽니다. 자주 끊지 않되 끊으면 확실히 쉬게 하는 쪽입니다.

`minimumNumberOfCalls: 20` 도 의도가 있어요. 호출이 20건 모이기 전에는 CB가 열리지 않습니다. 트래픽이 적은 새벽에 두세 번 실패했다고 차단되는 상황을 막아줍니다.

## [성과 - 개선 전후 비교]

`cb-keystone` 과 `retry-keystone-get` 설정을 그대로 옮긴 하네스를 만들어 두 배치를 비교했습니다. Resilience4j 2.3.0, `slidingWindowSize=50`, `minimumNumberOfCalls=20`, `failureRateThreshold=40%`, `maxAttempts=3`, `waitDuration=200ms` 입니다.

### 실험 1. 지속 장애에서 CB가 OPEN 되기까지

호출이 항상 실패하는 상황을 만들고, CB가 OPEN으로 바뀔 때까지 요청을 흘렸어요.

| 배치 | 요청 수 | 실제 호출 수 | 소요 시간 |
| --- | --- | --- | --- |
| CB 바깥 (실제 코드) | 20건 | 60회 | 8,158ms |
| Retry 바깥 | 7건 | 20회 | 2,855ms |

예상대로 Retry가 바깥일 때 감지가 빠릅니다. 2.9배 차이이고 절대 시간으로는 5.3초가 벌어졌어요.

호출 수를 보면 이유가 분명합니다. 두 배치 모두 **실제 호출 20회 지점에서 판정이 나야 하는데**, CB가 바깥이면 그 20회가 요청 20건으로 흩어져요. 재시도 3회가 CB에는 1회로 접히니까요.

### 실험 2. CB가 OPEN 된 뒤 10건을 더 보냈을 때

| 배치 | 실제 호출 | 차단 예외 | 소요 시간 |
| --- | --- | --- | --- |
| CB 바깥 (실제 코드) | 0회 | 10회 | 0ms |
| Retry 바깥 | 5회 | 8회 | 4,072ms |

여기서 차이가 큽니다. CB가 바깥이면 10건을 **0ms에** 쳐냅니다. 차단기가 앞에 있으니 재시도가 아예 실행되지 않아요.

Retry가 바깥이면 같은 10건에 4초를 씁니다. 차단 예외를 받고도 재시도를 걸기 때문이에요. 게다가 **실제 호출이 5회 나갔습니다.** 대기하는 동안 `waitDurationInOpenState` 3초가 지나 half-open으로 넘어갔고, 그 틈에 죽어 있는 서버로 다시 요청이 간 겁니다. 장애 컴포넌트를 쉬게 하려고 켠 차단기인데 오히려 두드리고 있었어요.

### 실험 3. 재시도로 살아나는 일시적 오류 50건

각 요청의 1회차만 실패하고 2회차부터 성공하는 상황입니다. 재시도가 제 역할을 하면 전부 성공해야 해요.

| 배치 | 성공 | CB 상태 | 실패율 |
| --- | --- | --- | --- |
| CB 바깥 (실제 코드) | 50/50건 | CLOSED | 0.0% |
| Retry 바깥 | 18/50건 | **OPEN** | 60.0% |

이게 가장 중요한 결과입니다. CB가 바깥이면 재시도가 살려낸 결과만 보므로 실패율이 0%예요. 차단기는 닫힌 채로 있고 50건이 전부 성공합니다.

Retry가 바깥이면 CB가 개별 시도를 하나씩 셉니다. 1회차 실패와 2회차 성공이 각각 기록되니 실패율이 40% 임계값을 넘고, 차단기가 열려요. **결과적으로 32건이 실패했습니다.** 재시도만 있었으면 전부 성공했을 요청들이에요.

정리하면 이렇습니다. Retry를 바깥에 두면 **회복 가능한 오류를 장애로 오인해서, 차단기가 스스로 장애를 만들어냅니다.**

## [결론]

Circuit Breaker와 Retry를 같이 쓸 때 순서는 취향 문제가 아니었습니다. **CB가 집계하는 실패율의 정의 자체가 바뀝니다.**

CB를 바깥에 두면 차단기는 "재시도해도 살아나지 않는 비율"에 반응해요. 측정으로 확인한 이득은 두 가지입니다. 회복 가능한 오류에서 차단기가 열리지 않았고(50건 전부 성공), OPEN 이후 낭비되는 호출이 0회였습니다.

대가는 감지 지연이에요. 같은 장애를 감지하는 데 2,855ms 대신 8,158ms가 걸렸습니다. 5.3초 늦은 셈이고, 그동안 요청 20건이 실패를 겪어요. 이 지연을 받아들일지는 서비스 성격에 달렸습니다. 다만 실험 3의 32건 실패와 비교하면, 저희 상황에서는 감지가 늦더라도 오탐을 피하는 쪽이 나았어요.

남은 한계도 적어둘게요.

첫째, **재시도 간격에 jitter가 없습니다.** 고정 200ms라서 과부하 상황에서 여러 요청이 같은 시점에 재시도하면 부하가 몰릴 수 있어요. 지금 규모에서는 문제가 안 됐지만 트래픽이 늘면 손봐야 할 부분입니다.

둘째, **Keystone이 OPEN 되면 사실상 전체 서비스가 멈춥니다.** 인증이 막히면 다른 컴포넌트가 멀쩡해도 아무것도 못 하니까요. 컴포넌트별 격리의 실효성이 여기서 약해집니다. `waitDurationInOpenState` 를 3초로 짧게 잡은 게 부분적인 완화이긴 하지만, 근본적으로는 토큰 캐싱으로 인증 장애를 견디는 구조가 필요해요.

셋째, **임계값의 근거가 측정이 아니라 판단입니다.** 40%와 55%, 80%라는 계층 구분은 컴포넌트 성격에서 나온 합리적인 구분이라고 보지만, 숫자 자체는 실측으로 검증하지 않았어요. 이건 솔직히 인정하고 다음 과제로 남겨둡니다.

넷째, **근본 처방은 따로 있습니다.** 원인이 공통 서블릿 스레드 풀 고갈이라면 Bulkhead로 풀을 격리하는 쪽이 더 직접적이에요. CB는 빠른 실패로 점유 시간을 줄여 간접적으로 같은 효과를 낼 뿐입니다. 컴포넌트 수만큼 풀을 나누는 운영 비용 때문에 미뤘는데, 이 판단이 맞았는지는 트래픽이 늘어야 알 수 있겠죠.

라이브러리를 붙이는 것과 그 라이브러리가 무엇을 세고 있는지 아는 것은 다른 일이라는 걸 이번에 배웠습니다. 두 줄짜리 코드에서 멈춰 선 게 결과적으로는 다행이었어요.
