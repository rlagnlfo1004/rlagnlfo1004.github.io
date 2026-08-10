---
title: "Spring AOP는 왜 자기 호출에서 안 먹는가 (JDK 동적 프록시와 CGLIB의 차이)"
description: "@Transactional, @Async, @CircuitBreaker가 전부 프록시로 동작합니다. 프록시가 어떻게 만들어지고 무엇을 못 감싸는지 알면, 애노테이션이 조용히 사라지는 네 가지 상황이 전부 같은 원인이라는 게 보여요."
date: 2026-08-10
project: "공통"
tags: ["Spring", "AOP", "CS", "프록시", "CGLIB", "면접"]
---

## [배경 - 애노테이션이 조용히 사라지는 순간들]

[45번 글](/posts/45-external-api-call-resilience-layers/)의 마지막에 이렇게 적었습니다.

> `@CircuitBreaker` 와 `@Retry` 는 프록시로 동작합니다. 같은 클래스 안에서 메서드를 직접 부르면 아무 일도 안 일어나요.

이 문장을 쓰면서 생각해보니, 제가 겪었거나 들었던 문제들이 전부 같은 뿌리였습니다.

- `@Transactional` 을 붙였는데 롤백이 안 된다
- `@Async` 를 붙였는데 같은 스레드에서 돈다
- `@Cacheable` 을 붙였는데 매번 실제 메서드가 불린다
- `private` 메서드에 애노테이션을 붙였는데 아무 일도 안 일어난다

**전부 프록시 때문입니다.** 그리고 이것들이 왜 실패하는지 설명하려면 프록시가 어떻게 만들어지는지부터 알아야 해요.

[26번 글](/posts/26-mdc-across-rabbitmq/)에서 `@RabbitListener` 를 `@Around` 로 감싸 MDC를 복원했고, [35번 글](/posts/35-observability-loki-tempo-aop/)에서는 외부 호출 패키지 전체를 포인트컷으로 잡아 자동 계측했습니다. 둘 다 잘 동작했는데, **왜 동작했는지**를 정확히 설명할 수 있는 상태는 아니었어요. 그래서 정리했습니다.

이 글에는 제가 잰 성능 수치가 없습니다. 대신 Spring 소스에서 확인할 수 있는 동작을 씁니다.

## [문제 상황 분석 - Spring AOP는 프록시다]

### 위빙 방식이 다릅니다

AOP를 구현하는 방법은 크게 셋입니다. 언제 코드를 끼워 넣느냐로 갈려요.

| 방식 | 시점 | 대표 |
| --- | --- | --- |
| 컴파일 타임 위빙 | 컴파일할 때 바이트코드를 고친다 | AspectJ (ajc) |
| 로드 타임 위빙 | 클래스 로딩할 때 고친다 | AspectJ + 자바 에이전트 |
| **런타임 프록시** | **원본은 그대로 두고 감싼 객체를 만든다** | **Spring AOP** |

Spring AOP는 세 번째입니다. **원본 클래스의 바이트코드를 건드리지 않아요.** 대신 그 클래스를 감싼 다른 객체를 만들어서, 컨테이너가 그 객체를 대신 주입합니다.

이 선택이 Spring AOP의 능력과 한계를 한꺼번에 정합니다. 자바 에이전트도 빌드 플러그인도 필요 없이 순수 자바로 동작하는 대신, **감쌀 수 있는 것만 감쌀 수 있어요.**

그래서 Spring AOP의 조인 포인트는 **메서드 실행 하나뿐**입니다. 필드 접근, 생성자 호출, 예외 핸들러 진입은 못 잡아요. AspectJ는 전부 잡습니다. 바이트코드를 직접 고치니까요.

### 프록시를 만드는 두 가지 방법

Spring이 프록시 객체를 만드는 방법은 두 가지이고, 이게 면접에서 가장 많이 물어보는 지점이에요.

**JDK 동적 프록시**는 자바 표준입니다. `java.lang.reflect.Proxy` 가 런타임에 클래스를 만들어요.

```java
Object proxy = Proxy.newProxyInstance(
        classLoader,
        new Class<?>[]{ MyService.class },   // 인터페이스 배열
        invocationHandler                     // 호출을 가로챌 핸들러
);
```

**인터페이스가 필수입니다.** 이름 그대로 인터페이스를 구현한 클래스를 만들어내는 거라, 인터페이스가 없으면 만들 수가 없어요. 그리고 생성된 프록시는 그 인터페이스 타입이지 원본 클래스 타입이 아닙니다.

**CGLIB**은 원본 클래스를 **상속한 서브클래스**를 만듭니다. 각 메서드를 오버라이드해서 그 안에서 인터셉터를 부르고, 필요하면 `super` 를 호출해요. 인터페이스가 필요 없습니다.

원래는 외부 라이브러리였는데 Spring 3.2부터 `spring-core` 안에 `org.springframework.cglib` 로 재패키징돼서 들어왔어요. 그래서 의존성을 따로 추가할 필요가 없습니다.

### 차이를 정리하면

| | JDK 동적 프록시 | CGLIB |
| --- | --- | --- |
| 만드는 방식 | 인터페이스 구현 | 클래스 상속 |
| 인터페이스 | **필수** | 불필요 |
| `final` 클래스 | 무관 | **프록시 불가** |
| `final` 메서드 | 인터페이스에 없으니 무관 | **어드바이스가 안 걸린다** |
| `private` 메서드 | 안 걸린다 | 안 걸린다 |
| 인터페이스에 없는 public 메서드 | **안 걸린다** | 걸린다 |
| 디스패치 | 리플렉션 (`Method.invoke`) | `FastClass` 인덱스 기반 |
| 생성 비용 | 낮다 | 높다 (바이트코드 생성) |
| 호출 비용 | 상대적으로 높다 | 상대적으로 낮다 |

CGLIB이 호출은 더 빠릅니다. `FastClass` 라는 걸 같이 만들어서 메서드마다 인덱스를 붙이고, 리플렉션 대신 `switch` 문으로 분기해요. 대신 클래스를 두 개씩 만드니 생성 비용과 메모리를 더 씁니다.

### CGLIB의 생성자 문제와 Objenesis

CGLIB은 서브클래스를 만드니, 프록시 객체를 만들려면 원칙적으로 부모 생성자가 불려야 합니다. 예전에 CGLIB 프록시 대상에 기본 생성자가 필요하다거나 생성자가 두 번 호출된다는 말이 있었던 게 이 때문이에요.

Spring 4.0부터 **Objenesis**를 씁니다. 생성자를 부르지 않고 객체를 만들어내는 라이브러리예요. `ObjenesisCglibAopProxy` 가 그걸 담당합니다. 덕분에 기본 생성자가 없어도 되고 생성자가 두 번 불리지도 않아요.

다만 부작용이 하나 남습니다. **프록시 인스턴스의 필드는 초기화되지 않습니다.** 전부 `null` 이나 기본값이에요.

보통은 문제가 안 됩니다. 프록시는 모든 호출을 실제 대상 객체에 위임하니 자기 필드를 쓸 일이 없어요. 그런데 **필드에 직접 접근하면** 그때 드러납니다.

```java
@Service
public class OrderService {
    public String region = "KR";     // public 필드
}

// 프록시를 통해 접근하면
orderService.region   // null 이 나올 수 있다
```

필드 접근은 메서드 호출이 아니라 프록시가 가로챌 수 없습니다. 앞에서 "Spring AOP의 조인 포인트는 메서드 실행뿐"이라고 한 게 여기서 실제 결과로 나타나요. **빈의 상태는 필드가 아니라 메서드로 노출해야 한다**는 규칙에 이런 근거도 있습니다.

### Spring이 둘 중 무엇을 고르는가

결정은 `DefaultAopProxyFactory` 에 있습니다. 골자만 옮기면 이래요.

```java
public AopProxy createAopProxy(AdvisedSupport config) {
    if (config.isOptimize()
            || config.isProxyTargetClass()
            || hasNoUserSuppliedProxyInterfaces(config)) {

        Class<?> targetClass = config.getTargetClass();
        // 대상 자체가 인터페이스이거나 이미 프록시면 JDK 로
        if (targetClass.isInterface() || Proxy.isProxyClass(targetClass)) {
            return new JdkDynamicAopProxy(config);
        }
        return new ObjenesisCglibAopProxy(config);
    }
    return new JdkDynamicAopProxy(config);
}
```

읽어보면 규칙이 단순합니다.

- `proxyTargetClass` 가 `true` 면 CGLIB
- 대상 클래스가 구현한 인터페이스가 없으면 CGLIB
- 그 외에는 JDK 동적 프록시

그리고 **Spring Boot 2.0부터 `spring.aop.proxy-target-class` 기본값이 `true` 입니다.** 그러니까 요즘 Boot 애플리케이션은 인터페이스가 있어도 기본적으로 CGLIB을 씁니다.

### 왜 기본값을 CGLIB으로 바꿨을까

JDK 동적 프록시가 표준인데도 기본을 바꾼 데는 이유가 있어요. 실무에서 사고가 잦았습니다.

**첫째, 구체 클래스로 주입받으면 실패합니다.**

```java
public interface OrderService { void place(); }

@Service
public class OrderServiceImpl implements OrderService { ... }

@Autowired
private OrderServiceImpl orderService;   // JDK 프록시면 주입 실패
```

JDK 프록시는 `OrderService` 인터페이스를 구현할 뿐 `OrderServiceImpl` 을 상속하지 않아요. 타입이 안 맞습니다. 구현체가 하나뿐이라 인터페이스를 안 거치고 바로 주입받는 코드는 흔한데, 그게 깨져요.

**둘째, 인터페이스에 없는 public 메서드는 프록시되지 않습니다.**

인터페이스에 세 개를 선언하고 구현체에 편의 메서드를 하나 더 만들었다고 해봅시다. 그 메서드는 프록시에 아예 존재하지 않아요. `@Transactional` 을 붙여도 무시됩니다.

**셋째, 구현체가 하나뿐인 인터페이스가 너무 많았습니다.** 프록시를 만들려고 인터페이스를 유지하는 게 목적이 되어버렸어요. CGLIB이 기본이면 그럴 필요가 없습니다.

정리하면 **표준성보다 예측 가능성을 골랐다**고 볼 수 있어요. 어떤 클래스든 같은 방식으로 프록시되니 헷갈릴 일이 줄어듭니다.

### 프록시는 언제 만들어지는가

빈 생성 과정에 끼어들어 만들어집니다. `AbstractAutoProxyCreator` 가 `BeanPostProcessor` 이고, 빈 초기화가 끝난 다음 단계에서 개입해요.

```
빈 인스턴스 생성
   ↓
의존성 주입
   ↓
@PostConstruct, InitializingBean
   ↓
postProcessAfterInitialization()        ← 여기서
   └ AnnotationAwareAspectJAutoProxyCreator
        ├ 이 빈에 적용될 어드바이저가 있는지 찾는다
        ├ 있으면 ProxyFactory 로 프록시를 만든다
        └ 컨테이너에는 원본 대신 프록시가 등록된다
```

**여기서 `@PostConstruct` 의 위치를 보면 중요한 게 하나 나옵니다.** 초기화 콜백이 프록시 생성보다 **먼저** 일어나요. 그러니 `@PostConstruct` 안에서 자기 메서드를 부르면 프록시를 거치지 않습니다. `@PostConstruct` 에 `@Transactional` 을 기대하는 코드가 안 먹는 이유예요.

호출이 들어오면 인터셉터 체인이 순서대로 돕니다. `ReflectiveMethodInvocation.proceed()` 가 다음 인터셉터를 부르고, 마지막에 실제 메서드를 호출해요. 45번 글에서 본 Resilience4j 애스펙트들이 겹치는 것도 이 체인 위에서 일어납니다.

## [프록시가 만드는 네 가지 함정]

### 1. 자기 호출

가장 유명하고 가장 자주 물리는 문제입니다.

<svg class="diagram" viewBox="0 0 720 296" role="img" aria-label="외부에서 부르면 프록시를 거치지만 내부에서 this 로 부르면 프록시를 건너뛴다">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같은 메서드인데 어디서 부르느냐로 갈린다</text>
  <text x="0" y="46" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">외부에서 호출</text>
  <rect x="0" y="58" width="330" height="150" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="16" y="80" font-size="11" fill="var(--clay-text, #1B64DA)">컨트롤러</text>
  <rect x="16" y="90" width="298" height="46" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="165" y="109" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)" text-anchor="middle">프록시</text>
  <text x="165" y="126" font-size="10.5" fill="var(--clay-text, #1B64DA)" text-anchor="middle">어드바이스가 여기서 돈다</text>
  <rect x="16" y="146" width="298" height="46" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="165" y="165" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">실제 객체 (target)</text>
  <text x="165" y="182" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">outer() 실행</text>
  <text x="390" y="46" font-size="12" font-weight="700" fill="var(--ink-2, #545A64)">내부에서 this 로 호출</text>
  <rect x="390" y="58" width="330" height="150" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1" stroke-dasharray="4 3"/>
  <rect x="406" y="90" width="298" height="46" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8" stroke-dasharray="3 3"/>
  <text x="555" y="109" font-size="11.5" font-weight="700" fill="var(--ink-3, #8B9099)" text-anchor="middle">프록시</text>
  <text x="555" y="126" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">지나가지 않는다</text>
  <rect x="406" y="146" width="298" height="46" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="555" y="165" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)" text-anchor="middle">실제 객체 (target)</text>
  <text x="555" y="182" font-size="10.5" fill="var(--ink-3, #8B9099)" text-anchor="middle">outer() 안에서 this.inner()</text>
  <path d="M666 194 C 702 194, 702 160, 670 160" fill="none" stroke="var(--ink-2, #545A64)" stroke-width="1.2" marker-end="url(#a46)"/>
  <defs>
    <marker id="a46" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-2, #545A64)"/>
    </marker>
  </defs>
  <line x1="0" y1="230" x2="720" y2="230" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="250" font-size="11.5" fill="var(--ink-2, #545A64)">프록시는 target 을 감싸고 있을 뿐, target 안의 this 는 여전히 target 자신이다.</text>
  <text x="0" y="270" font-size="11.5" fill="var(--ink-2, #545A64)">target 은 자기가 감싸여 있다는 사실을 모른다. 그래서 내부 호출은 어드바이스를 건너뛴다.</text>
  <text x="0" y="290" font-size="11" fill="var(--ink-3, #8B9099)">@Transactional, @Async, @Cacheable, @CircuitBreaker 가 전부 같은 이유로 조용히 사라진다.</text>
</svg>

```java
@Service
public class OrderService {

    public void place() {
        validate();
        save();          // ← this.save() 다. 프록시를 안 거친다
    }

    @Transactional
    public void save() { ... }   // 트랜잭션이 안 걸린다
}
```

`place()` 는 외부에서 프록시를 통해 불렸지만, 그 안의 `save()` 는 **target 객체의 `this` 로 호출**됩니다. target은 자기를 감싼 프록시의 존재를 모르니 어드바이스가 실행될 방법이 없어요.

해결책이 몇 가지 있는데 우선순위가 있습니다.

**1순위. 클래스를 나눕니다.** `save()` 를 다른 빈으로 옮기고 주입받아 부르면 프록시를 거칩니다. 가장 단순하고, 대개 설계상으로도 맞아요. 한 클래스 안에서 트랜잭션 경계가 두 개로 나뉜다는 건 책임이 둘이라는 신호인 경우가 많습니다.

**2순위. 자기 자신을 주입받습니다.**

```java
@Service
public class OrderService {
    @Autowired @Lazy
    private OrderService self;      // 프록시가 주입된다

    public void place() {
        self.save();
    }
}
```

동작은 하는데 순환 참조라 `@Lazy` 가 필요하고, 코드를 읽는 사람이 왜 이렇게 했는지 모릅니다. 주석이 필수예요.

**3순위. `AopContext` 를 씁니다.**

```java
@EnableAspectJAutoProxy(exposeProxy = true)   // 이게 있어야 한다

((OrderService) AopContext.currentProxy()).save();
```

`ThreadLocal` 에 담긴 현재 프록시를 꺼내 씁니다. Spring API에 직접 묶이고 캐스팅이 들어가서 저라면 마지막에 고려하겠어요.

**4순위. AspectJ로 갑니다.** 바이트코드를 고치니 내부 호출도 잡힙니다. 다만 이 문제 하나 때문에 로드 타임 위빙을 도입하는 건 비용이 커요.

### 2. private, final, static

프록시가 감쌀 수 없는 메서드들입니다.

| | JDK 프록시 | CGLIB | 이유 |
| --- | --- | --- | --- |
| `private` | 안 됨 | 안 됨 | 오버라이드 대상이 아니다 |
| `final` 메서드 | 무관 | 안 됨 | 오버라이드 불가 |
| `final` 클래스 | 무관 | **프록시 자체가 불가** | 상속 불가 |
| `static` | 안 됨 | 안 됨 | 인스턴스 메서드가 아니다 |

Kotlin을 쓴다면 세 번째가 특히 중요해요. **Kotlin의 클래스와 메서드는 기본이 `final`** 입니다. `allopen` 컴파일러 플러그인이 없으면 CGLIB 프록시가 아예 안 만들어져요. Spring Boot의 Kotlin 지원에 그 플러그인이 들어 있는 이유입니다.

그리고 조용히 실패한다는 게 문제예요. `private` 메서드에 `@Transactional` 을 붙여도 컴파일 에러가 안 납니다. 그냥 아무 일도 안 일어나요.

### 3. 초기화 시점

앞에서 본 것처럼 프록시는 `@PostConstruct` 다음에 만들어집니다. 그러니 생성자나 `@PostConstruct` 안에서는 프록시가 없어요.

```java
@Service
public class WarmupService {
    @PostConstruct
    public void init() {
        loadCache();        // @Cacheable 이 안 먹는다
    }

    @Cacheable("meta")
    public Meta loadCache() { ... }
}
```

자기 호출이기도 하고 시점 문제이기도 합니다. 초기화 시점에 어드바이스가 필요하면 `ApplicationRunner` 나 `ApplicationReadyEvent` 로 미루는 게 맞아요.

### 4. 타입과 애노테이션 조회

프록시는 원본과 다른 클래스입니다. Spring 6 기준으로 CGLIB 프록시의 클래스 이름은 `OrderService$$SpringCGLIB$$0` 같은 형태예요.

여기서 리플렉션을 쓰는 코드가 깨집니다.

```java
bean.getClass().getAnnotation(MyAnnotation.class);   // null 일 수 있다
```

클래스 애노테이션은 `@Inherited` 가 없으면 서브클래스로 안 내려와요. JDK 프록시면 아예 다른 타입이고요.

Spring이 헬퍼를 줍니다.

```java
Class<?> real = AopProxyUtils.ultimateTargetClass(bean);  // 원본 클래스
Class<?> target = AopUtils.getTargetClass(bean);
boolean isProxy = AopUtils.isAopProxy(bean);
```

26번 글에서 `@RabbitListener` 를 잡는 애스펙트를 만들 때 리플렉션을 썼는데, 그때 이 문제를 안 만난 건 애노테이션을 **메서드**에서 조회했기 때문입니다. 메서드 애노테이션은 `JoinPoint` 에서 원본 메서드를 통해 가져오니 프록시의 영향을 안 받아요.

## [프록시로 동작한다는 것의 의미]

### @Transactional

트랜잭션 경계가 **프록시를 통과하는 지점**입니다. 여기서 여러 가지가 따라나와요.

**`REQUIRES_NEW` 는 자기 호출로 안 됩니다.** 새 트랜잭션을 열려면 프록시를 다시 지나야 하는데, `this` 호출은 안 지나가니까요. "로그는 실패해도 본 작업은 커밋되게" 같은 요구를 한 클래스 안에서 처리하려다 실패하는 흔한 사례입니다.

**기본 롤백 규칙은 `RuntimeException` 과 `Error` 뿐입니다.** 체크 예외는 던져도 커밋돼요. `rollbackFor = Exception.class` 를 명시해야 합니다. 이건 프록시 때문은 아니고 Spring의 규약인데, 같이 알아둘 만해요.

**트랜잭션은 프록시 안쪽에서만 유효합니다.** [10번 글](/posts/10-transactional-external-call/)에서 트랜잭션 안 외부 호출을 다뤘는데, 반대로 트랜잭션 밖에서 무언가를 해야 한다면 그건 프록시를 나온 다음이어야 해요. `TransactionSynchronizationManager.registerSynchronization` 이나 `@TransactionalEventListener(phase = AFTER_COMMIT)` 이 그 자리를 만들어줍니다.

### @Async

`@Async` 는 프록시가 호출을 받아서 **다른 스레드의 실행기에 넘기고 즉시 반환**합니다. 그러니 자기 호출이면 그냥 동기 실행이에요.

그리고 스레드가 바뀌니 `ThreadLocal` 이 안 넘어갑니다. [3번 글](/posts/03-mdc-async-traceid/)에서 MDC가 비동기 경계에서 끊긴 게 정확히 이 지점이었어요. **프록시가 스레드를 바꾸는 그 한 줄에서 컨텍스트가 끊깁니다.**

`@Async` 메서드의 반환 타입도 제약이 있어요. `void` 나 `Future` 계열이어야 합니다. 다른 타입이면 프록시가 즉시 반환할 값을 만들 수 없으니 `null` 이 돌아옵니다.

### @Configuration

덜 알려진 사례인데 재밌습니다. `@Configuration` 클래스도 CGLIB으로 프록시됩니다.

```java
@Configuration
public class AppConfig {
    @Bean public A a() { return new A(b()); }   // b() 를 직접 부르고 있다
    @Bean public B b() { return new B(); }
}
```

`a()` 안에서 `b()` 를 직접 부르는데도 B가 두 개 생기지 않아요. 프록시가 `b()` 호출을 가로채서 이미 만들어진 싱글턴을 돌려주기 때문입니다.

Spring 5.2부터 `@Configuration(proxyBeanMethods = false)` 로 이걸 끌 수 있어요. 프록시를 안 만드니 기동이 빨라지지만, 위 코드는 B를 두 개 만들게 됩니다. 메서드끼리 직접 부르지 않는 설정 클래스에서만 써야 해요.

### 어드바이스가 여럿일 때의 순서

여러 애스펙트가 같은 메서드에 걸리면 순서가 문제가 됩니다. `@Order` 나 `Ordered` 로 정하고, **값이 작을수록 바깥**이에요.

`@Transactional` 의 인터셉터는 기본이 `Ordered.LOWEST_PRECEDENCE` 입니다. 가장 안쪽이라는 뜻이에요. 그래서 직접 만든 애스펙트는 대개 트랜잭션보다 바깥에서 돕니다.

이게 실무에서 의미가 있어요. 35번 글의 계측 애스펙트가 트랜잭션 바깥에 있다면, 재는 시간에 커밋 시간이 포함됩니다. 안쪽이면 빠지고요. **무엇을 재고 싶은지에 따라 순서를 정해야 합니다.**

45번 글에서 본 Resilience4j 애스펙트 순서도 정확히 같은 메커니즘이에요. `circuitBreakerAspectOrder` 같은 속성이 결국 이 값을 정하는 겁니다.

## [실무 적용 - 어디까지 AOP로 할 것인가]

### 제가 AOP를 쓴 두 곳

**26번 글, MDC 복원.** RabbitMQ 컨슈머에서 헤더의 traceId를 MDC로 복원했습니다.

```java
@Around("@annotation(org.springframework.amqp.rabbit.annotation.RabbitListener)")
```

애노테이션 기반 포인트컷이에요. `@RabbitListener` 가 붙은 메서드만 잡습니다.

**35번 글, 외부 호출 자동 계측.** 패키지 기반으로 잡았습니다.

```java
@Pointcut("execution(* com.acc.local.external.modules.*.*.*(..))")
```

두 방식의 성격이 다릅니다. 애노테이션 기반은 **명시적**이에요. 개발자가 표시한 것만 걸립니다. 패키지 기반은 **자동**입니다. 규칙에 맞는 위치에 코드를 두면 알아서 걸려요.

35번 글에서 애노테이션 대신 패키지를 고른 이유는 그 글에 적었는데, 12명이 병렬로 개발하는 상황에서 "붙이는 걸 잊는" 실패를 없애려는 판단이었습니다. 대신 **패키지 구조가 곧 계약이 됩니다.** 누가 패키지를 옮기면 계측이 조용히 사라져요. 그게 이 선택의 대가입니다.

### 규칙 세 가지

**1. 횡단 관심사에만 씁니다.** 로깅, 계측, 트랜잭션, 보안, 재시도처럼 여러 곳에 반복되는 것들이요. 비즈니스 분기를 AOP에 넣으면 코드를 읽어도 무슨 일이 일어나는지 알 수 없게 됩니다.

**2. 포인트컷을 좁게 잡습니다.** `execution(* com..*.*(..))` 같은 걸 쓰면 프록시가 필요 이상으로 많이 생기고, 디버깅할 때 스택 트레이스가 프록시 프레임으로 채워져요.

**3. 자기 호출을 전제하지 않습니다.** 어드바이스가 걸린 메서드는 항상 다른 빈에서 부르게 설계합니다.

### 그리고 확인하는 법

애노테이션이 실제로 동작하는지 확인하는 게 중요해요. 조용히 실패하니까요.

```java
// 프록시가 만들어졌는지
System.out.println(AopUtils.isAopProxy(bean));
System.out.println(bean.getClass().getName());

// 트랜잭션이 실제로 열려 있는지
System.out.println(TransactionSynchronizationManager.isActualTransactionActive());
```

로그 레벨을 올려서 보는 방법도 있습니다.

```yaml
logging:
  level:
    org.springframework.transaction.interceptor: TRACE
```

**동작한다고 믿지 말고 한 번은 확인하는 게 맞습니다.** 45번 글에서 애스펙트 순서를 로그로 확인하겠다고 쓴 것과 같은 이야기예요.

## [결론]

애노테이션이 조용히 사라지는 네 가지 상황이 전부 하나에서 나왔습니다. **Spring AOP는 원본을 고치지 않고 감싸는 방식이고, 감싼 바깥에서 들어오는 호출만 가로챌 수 있어요.**

여기서 나머지가 따라옵니다. 자기 호출이 안 되는 것도, `private` 과 `final` 이 안 되는 것도, `@PostConstruct` 에서 안 되는 것도 전부 같은 이유예요. 각각을 따로 외우고 있었는데 하나로 묶였습니다.

JDK 동적 프록시와 CGLIB의 차이는 **인터페이스 구현이냐 클래스 상속이냐** 하나입니다. 나머지 차이는 여기서 파생돼요. 인터페이스가 필수인 것도, `final` 이 걸리는 것도, 구체 클래스 주입이 되고 안 되고도 전부 이 한 줄에서 나옵니다. Spring Boot가 CGLIB을 기본으로 바꾼 것도 예측 가능성 때문이었고요.

한계를 적어둘게요.

첫째, **성능 차이를 재보지 않았습니다.** CGLIB이 `FastClass` 로 리플렉션을 피한다는 건 구조상 사실인데, 실제로 얼마나 차이 나는지는 모릅니다. 대부분의 애플리케이션에서 무시할 수준일 거라고 짐작만 하고 있어요.

둘째, **AspectJ 로드 타임 위빙을 써본 적이 없습니다.** 자기 호출 문제를 푸는 방법으로 언급했지만 운영에서 도입해본 게 아니라 문서로 아는 수준이에요.

셋째, **35번 글의 패키지 기반 포인트컷이 지금도 맞는지 확인이 필요합니다.** 이 글을 쓰면서 "패키지 구조가 곧 계약이 된다"는 대가를 명확히 알게 됐는데, 그 후 패키지가 옮겨졌는지는 확인 안 했어요. 계측이 조용히 빠져 있을 수 있습니다. 다음에 볼 일이에요.

넷째, **`@Configuration(proxyBeanMethods = false)` 를 적용해보지 않았습니다.** 기동 시간에 얼마나 영향이 있는지 재보면 재밌을 것 같은데 아직 안 했습니다.

라이브러리가 무엇을 세고 있는지 아는 것이 중요하다고 [1번 글](/posts/01-circuit-breaker-retry-order/)에서 배웠다면, 이번에는 **프레임워크가 내 코드를 어떻게 붙잡고 있는지** 아는 게 필요하다는 걸 알았습니다. 애노테이션 한 줄이 실제로는 객체 하나를 사이에 끼워 넣는 일이었어요.
