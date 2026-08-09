---
title: "결제는 됐는데 서버는 모릅니다 (클라이언트 완료 API에서 웹훅 확정으로)"
description: "결제 직후 브라우저를 닫으면 돈은 나가고 플랜은 그대로였습니다. 완료를 누가 선언하는지 바꾸면서 배운 것과, 멱등성을 지탱하는 제약이 놓인 자리."
date: 2026-08-09
project: "메일상자"
tags: ["결제", "웹훅", "멱등성", "PortOne", "비관적 잠금"]
---

## [배경 - 운영자가 손으로 맞추던 일]

메일상자에는 유료 플랜이 있습니다. PortOne으로 결제하면 그 사용자의 플랜이 PRO로 올라가요.

처음 구조는 이랬습니다.

```
1. 클라이언트가 PortOne 결제창을 띄운다
2. 사용자가 결제한다
3. 클라이언트가 서버의 "결제 완료" API를 부른다
4. 서버가 플랜을 올린다
```

3번이 문제였어요. **결제를 끝낸 사용자가 항상 3번까지 도달하지 않습니다.**

결제창이 닫히는 순간 브라우저를 닫는 사람이 있고, 모바일에서 앱 전환 중에 네트워크가 끊기기도 합니다. 그러면 돈은 나갔는데 서버는 아무것도 모르는 상태가 돼요.

이런 건이 생기면 운영자가 PortOne 관리 콘솔과 DB를 나란히 놓고 손으로 맞춰야 했습니다. 결제 건수가 늘면 감당이 안 되는 방식이에요.

## [문제 상황 분석 - 완료를 누가 선언하는가]

### 클라이언트는 완료를 선언할 자격이 없습니다

정리해보니 문제는 신뢰의 문제였어요.

**결제가 됐다는 사실을 아는 주체는 PortOne입니다.** 클라이언트는 그걸 전달하는 심부름꾼일 뿐인데, 저는 그 심부름꾼을 유일한 통보 경로로 삼았어요.

심부름꾼은 사라질 수 있습니다. 그리고 사라져도 결제는 이미 일어났어요.

이건 [케이톡 인앱결제에서 겪은 것](/posts/12-why-payment-webhook/)과 같은 문제입니다. 결제 수단은 다른데(인앱결제 대 PG사) 구조는 똑같아요. **앱에서 서버로 오는 경로 하나만으로는 결제를 확정할 수 없습니다.**

### 클라이언트를 못 믿는 이유는 하나 더 있습니다

이탈만 문제가 아니에요. 클라이언트가 보내는 값을 그대로 믿을 수도 없습니다.

"결제 완료, 금액 9,900원" 이라는 요청이 왔을 때, 그 금액이 실제 승인 금액인지 서버는 모릅니다. 요청을 조작하면 100원 결제하고 9,900원짜리 플랜을 받을 수 있어요.

즉 **완료 사실과 금액을 둘 다 서버가 직접 확인해야 합니다.**

## [해결 방법 - 웹훅으로 받고, 다시 물어보고, 잠근다]

### 웹훅을 완료 판정의 기준으로 삼습니다

PortOne은 결제 상태가 바뀌면 서버로 웹훅을 보냅니다. 이걸 기준으로 바꿨어요.

```java
public void handleWebhook(PortOneWebhookRequest request) {
    if (!PAID_WEBHOOK_TYPE.equals(request.type())) {
        log.debug("Ignored webhook type={}. webhookId={}", request.type(), request.webhookId());
        return;
    }

    if (paymentProcessingService.isWebhookAlreadyProcessed(request.webhookId())) {
        log.info("Duplicate webhook ignored. webhookId={}", request.webhookId());
        return;
    }

    PortOnePaymentResult result = portOneApiService.fetchPayment(request.data().paymentId());
    paymentProcessingService.process(request.webhookId(), result);
    // ...
}
```

흐름이 네 단계예요.

1. 관심 있는 타입(`Transaction.Paid`)인지 확인
2. 이미 처리한 웹훅인지 확인
3. **PortOne에 결제 정보를 다시 조회**
4. 처리

3번이 중요합니다. **웹훅 본문의 값을 쓰지 않고 결제 ID만 꺼내서 다시 물어봐요.**

웹훅은 인터넷에서 들어오는 HTTP 요청입니다. 누구나 흉내 낼 수 있어요. 본문에 적힌 금액을 믿으면 위조된 웹훅으로 무료 업그레이드가 가능합니다.

**웹훅은 "뭔가 일어났으니 확인해보라" 는 신호로만 씁니다.** 실제 값은 PortOne API로 직접 가져와요. 이러면 위조 웹훅이 와도 조회 결과가 실제 상태를 알려줍니다.

### 금액을 서버가 대조합니다

```java
private void validatePaymentAmount(PortOnePaymentResult result, Order order) {
    if (result.amount() != order.getAmount()) {
        log.warn("Amount mismatch. paymentId={} expected={} actual={}",
                result.paymentId(), order.getAmount(), result.amount());
        throw new PaymentException(PaymentErrorCode.PAYMENT_AMOUNT_MISMATCH);
    }
}
```

주문은 결제 전에 서버가 미리 만들어둡니다. 그러니까 **서버는 "얼마여야 하는지" 를 이미 알고 있어요.** 여기에 PortOne이 알려준 실제 승인 금액을 대조합니다.

두 값이 다르면 예외를 던지고 플랜을 안 올려요. 로그에 기대값과 실제값을 같이 남기는 것도 의도입니다. 이건 사람이 봐야 하는 사건이에요.

`paymentId` 를 주문 ID로 쓰는 것도 짚고 갈 부분입니다.

```java
private UUID parseOrderId(String paymentId) {
    // ...
    return UUID.fromString(paymentId);
}
```

결제를 시작할 때 서버가 만든 주문 ID를 PortOne의 `paymentId` 로 넘겨요. 그러면 웹훅이 왔을 때 별도 매핑 테이블 없이 주문을 찾을 수 있습니다. 매핑이 하나 줄면 어긋날 곳도 하나 줄어요.

### 중복은 세 겹으로 막습니다

웹훅은 한 번만 오지 않습니다. 응답이 늦으면 PortOne이 다시 보내요. 그리고 재시도는 정상 동작입니다.

같은 웹훅으로 플랜을 두 번 올리면 안 되니 세 겹을 뒀습니다.

**1층. 처리 여부 조회**

```java
if (paymentProcessingService.isWebhookAlreadyProcessed(request.webhookId())) {
    log.info("Duplicate webhook ignored. webhookId={}", request.webhookId());
    return;
}
```

가장 흔한 경우를 싸게 걸러냅니다. 다만 이것만으로는 **동시에 두 개가 들어오면 둘 다 통과합니다.** 조회와 저장 사이에 틈이 있어요.

**2층. 비관적 잠금과 상태 확인**

```java
Order order = orderRepositoryPort.findByIdWithLock(orderId)
        .orElseThrow(() -> new PaymentException(PaymentErrorCode.ORDER_NOT_FOUND, "orderId=" + orderId));

if (OrderStatus.COMPLETED.equals(order.getStatus())) {
    log.info("Order already completed, skipping. orderId={} webhookId={}", orderId, webhookId);
    return;
}
```

주문 행을 잠그고 상태를 봅니다. 잠금 안에서 확인하니 **두 웹훅이 동시에 들어와도 한쪽은 반드시 기다렸다가 `COMPLETED` 를 보게 돼요.**

여기서 [메일상자의 다른 글](/posts/04-lock-table-insert-race/)에서 다룬 것과 차이가 있습니다. 그때는 행이 아직 없어서 잠글 대상이 없었어요. 여기서는 **주문이 결제 전에 이미 만들어져 있습니다.** 잠글 행이 있으니 비관적 잠금이 제 역할을 합니다.

사용자 행도 같이 잠급니다.

```java
User user = userRepositoryPort.findByIdWithLock(userId)
        .orElseThrow(() -> new PaymentException(PaymentErrorCode.PAYMENT_USER_NOT_FOUND, "userId=" + userId));

user.updatePlan(order.getPlan());
```

한 사용자가 서로 다른 주문 두 개를 거의 동시에 결제하면 플랜 갱신이 겹칠 수 있어서요. 다만 주문 잠금과 사용자 잠금을 순서대로 잡으니 **잠금 순서가 항상 같아야 데드락이 안 납니다.** 지금은 항상 주문 먼저인데, 다른 곳에서 사용자를 먼저 잠그는 코드가 생기면 위험해요.

**3층. DB 제약**

마지막은 DB입니다.

```sql
CONSTRAINT uq_orders_webhook_id UNIQUE (webhook_id),
```

`webhook_id` 에 UNIQUE가 걸려 있어요. 앞의 두 층이 다 뚫려도 같은 웹훅 ID로 두 번 저장할 수 없습니다.

`Order.complete` 를 보면 상태 전이와 ID 기록이 한 번에 일어납니다.

```java
public void complete(String webhookId, String paymentId) {
    this.webhookId = webhookId;
    this.paymentId = paymentId;
    this.status = OrderStatus.COMPLETED;
}
```

**"완료됐다" 와 "어느 웹훅으로 완료됐다" 가 분리되지 않습니다.** 상태만 바꾸고 ID를 나중에 넣는 구조였다면 UNIQUE가 보호하지 못하는 구간이 생겨요.

## [성과 - 개선 전후 비교]

| 항목 | 클라이언트 완료 API | 웹훅 확정 |
| --- | --- | --- |
| 완료를 선언하는 주체 | 클라이언트 | PortOne (서버가 재조회로 확인) |
| 결제 직후 이탈 시 | 플랜 미반영, 수동 복구 | 웹훅으로 반영 |
| 금액 검증 | 없음 (클라이언트 값 신뢰) | 주문 금액과 대조 |
| 중복 처리 방지 | 없음 | 조회, 비관적 잠금, UNIQUE 제약 |
| 위조 요청 | 통과 가능 | 재조회로 무력화 |

수치는 없습니다. 이 변경은 **일어나면 안 되는 일을 막는 것**이라 개선 폭을 재려면 사고 건수를 세야 하는데, 이전 구조의 사고 건수를 기록해두지 않았어요.

<!-- 측정 필요:
     1) 결제 시작 대비 완료 비율 (변경 전후). orders 테이블의 PENDING/COMPLETED 비율
     2) PENDING 상태로 24시간 이상 남은 주문 수 (실제 유실 건)
     3) 동일 webhookId 중복 수신 빈도 (로그의 "Duplicate webhook ignored" 카운트) -->

## [결론]

정리하면 이렇습니다.

- 사실을 아는 주체와 그걸 전달하는 주체를 구분해야 한다. 전달자는 사라질 수 있다
- 웹훅 본문은 신호로만 쓰고 값은 다시 조회한다
- 중복 방지는 싼 것부터 확실한 것까지 겹쳐 둔다. 마지막 층은 DB여야 한다

한계를 적어둘게요. 첫 번째가 제일 신경 쓰입니다.

첫째, **UNIQUE 제약이 엔티티에 없습니다.** `schema.sql` 에는 있는데 `Order` 엔티티에는 없어요.

```java
@Entity
@Table(name = "orders")
public class Order extends BaseEntity {

    @Column(name = "webhook_id", nullable = true, length = 255)
    private String webhookId;
```

`@Table` 에 `uniqueConstraints` 가 없고 `@Column` 에도 `unique = true` 가 없습니다. 클래스 주석에는 "webhookId를 UNIQUE 제약으로 관리합니다" 라고 적혀 있는데 코드에는 없어요.

그리고 운영 설정이 `ddl-auto: update` 입니다. 이 모드는 엔티티를 보고 스키마를 맞추는데, **엔티티에 없는 제약은 만들지 않습니다.** 즉 `schema.sql` 이 적용되지 않은 환경에서 Hibernate가 테이블을 만들면 **UNIQUE 제약 없이 생성됩니다.**

3층이 통째로 사라지는 경우가 생길 수 있는 거예요. 그리고 없어져도 평소에는 아무 증상이 없습니다. 동시 웹훅이 들어오는 순간에만 드러나요. 엔티티에 제약을 명시해서 두 경로가 어긋날 여지를 없애야 합니다.

둘째, **웹훅 서명 검증이 안 보입니다.** 재조회로 값은 지키지만, 서명을 검증하면 위조 요청을 조회 전에 걸러낼 수 있어요. 지금은 아무나 웹훅 엔드포인트를 두드려서 PortOne API 조회를 유발할 수 있습니다.

셋째, **금액 불일치 이후가 없습니다.** 예외를 던지고 로그를 남기는데, 그 로그를 사람이 보는 경로가 없어요. 금액이 어긋나는 건 사고이거나 공격 시도인데 조용히 로그에만 남습니다.

넷째, **주문 ID가 CHAR(36) 입니다.** [PostgreSQL에서 UUID를 CHAR(36)으로 저장하면 손해라는 글](/posts/08-uuid-char36-vs-native/)을 써놓고, 이 테이블은 여전히 `CHAR(36)` 이에요. 글로 정리한 걸 코드에 적용하지 않은 상태입니다.

다섯째, **결제 취소와 환불 웹훅을 처리하지 않습니다.** `Transaction.Paid` 만 봐요. 취소되면 플랜을 내려야 하는데 그 경로가 없습니다.

같은 문제를 두 서비스에서 만났는데, 두 번째에는 조금 더 빨리 알아봤습니다. 대신 이번엔 제약이 놓인 자리를 확인하지 않았어요. 매번 다른 곳을 놓칩니다.
