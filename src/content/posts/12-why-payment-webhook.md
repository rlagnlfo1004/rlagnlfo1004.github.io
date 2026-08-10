---
title: "결제에 웹훅이 왜 필요한가 (앱이 죽어도 포인트는 들어와야 한다)"
description: "앱→서버 충전 요청만으로는 결제가 유실됩니다. 스토어 웹훅을 두 번째 경로로 붙이면서 정리한 도착 순서 여섯 가지와, 웹훅이 대체재가 아닌 이유."
date: 2026-08-07
project: "케이톡"
tags: ["웹훅", "결제", "RTDN", "App Store Server Notification", "Spring"]
---

## [배경 - 돈은 나갔는데 포인트가 없다]

인앱결제 흐름을 처음 그리면 대개 이렇게 됩니다.

1. 앱이 스토어에 결제를 요청한다
2. 스토어가 결제를 처리하고 영수증을 준다
3. 앱이 그 영수증을 서버로 보낸다
4. 서버가 스토어에 영수증을 검증하고 포인트를 지급한다

깔끔합니다. 그런데 2번과 3번 사이가 위험해요.

**결제는 스토어에서 이미 끝났습니다.** 사용자 카드에서 돈이 빠져나갔어요. 그런데 3번을 실행할 주체는 앱입니다. 여기서 앱이 죽거나, 네트워크가 끊기거나, 사용자가 앱을 강제 종료하면 서버는 결제 사실 자체를 모릅니다.

사용자 입장에서는 "결제했는데 포인트가 안 들어왔다"가 되고, 서버 로그에는 아무것도 남지 않습니다. 조사할 단서조차 없어요.

이 구간을 앱이 아닌 **스토어가 직접 알려주게** 만든 것이 웹훅입니다. Google은 RTDN(Real-time Developer Notifications)을 Pub/Sub push로, Apple은 App Store Server Notification V2를 HTTPS POST로 보냅니다.

<div class="diagram-scroll" style="--diagram-min-w: 700px">
<svg class="diagram" viewBox="0 0 720 372" role="img" aria-label="결제 직후 앱이 죽어도 스토어 웹훅이 충전을 완료하는 흐름">
  <defs>
    <marker id="ar-wh" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-2, #63605A)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">앱이 결제 직후 죽은 경우</text>
  <rect x="15" y="26" width="130" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="80" y="45" font-size="11.5" font-weight="600" text-anchor="middle" fill="var(--ink-2, #63605A)">앱</text>
  <rect x="200" y="26" width="130" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="265" y="45" font-size="11.5" font-weight="600" text-anchor="middle" fill="var(--ink-2, #63605A)">스토어</text>
  <rect x="385" y="26" width="140" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="455" y="45" font-size="11.5" font-weight="600" text-anchor="middle" fill="var(--ink-2, #63605A)">케이톡 서버</text>
  <rect x="575" y="26" width="130" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="640" y="45" font-size="11.5" font-weight="600" text-anchor="middle" fill="var(--ink-2, #63605A)">공통 지갑</text>
  <line x1="80" y1="56" x2="80" y2="132" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <line x1="80" y1="152" x2="80" y2="344" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1" stroke-dasharray="3 4"/>
  <line x1="265" y1="56" x2="265" y2="344" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <line x1="455" y1="56" x2="455" y2="344" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <line x1="640" y1="56" x2="640" y2="344" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <line x1="80" y1="80" x2="259" y2="80" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="170" y="74" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">결제 요청</text>
  <line x1="265" y1="110" x2="86" y2="110" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="170" y="104" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">결제 완료 · 영수증</text>
  <line x1="70" y1="132" x2="90" y2="152" stroke="var(--clay, #BF5F3B)" stroke-width="1.6"/>
  <line x1="90" y1="132" x2="70" y2="152" stroke="var(--clay, #BF5F3B)" stroke-width="1.6"/>
  <text x="103" y="147" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">앱 크래시</text>
  <text x="103" y="163" font-size="10.5" fill="var(--ink-3, #9A958B)">충전 API 를 못 부른다</text>
  <line x1="265" y1="196" x2="449" y2="196" stroke="var(--clay, #BF5F3B)" stroke-width="1.2" marker-end="url(#ar-wh)"/>
  <text x="357" y="190" font-size="11" font-weight="600" text-anchor="middle" fill="var(--clay, #BF5F3B)">웹훅 (RTDN / ASSN)</text>
  <line x1="455" y1="226" x2="271" y2="226" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="357" y="220" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">영수증 재조회</text>
  <line x1="265" y1="256" x2="449" y2="256" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="357" y="250" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">구매 확정 · 계정 식별자</text>
  <line x1="455" y1="290" x2="634" y2="290" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="547" y="284" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">충전 (멱등키 동봉)</text>
  <line x1="640" y1="320" x2="461" y2="320" stroke="var(--ink-2, #63605A)" stroke-width="1" marker-end="url(#ar-wh)"/>
  <text x="547" y="314" font-size="11" text-anchor="middle" fill="var(--ink-2, #63605A)">지급 완료</text>
  <line x1="0" y1="352" x2="720" y2="352" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="368" font-size="11" fill="var(--ink-3, #9A958B)">앱이 사라진 뒤에도 지급이 완료된다. 앱이 나중에 다시 켜져 충전 API 를 불러도 같은 멱등키라 중복 지급되지 않는다.</text>
</svg>
</div>

## [문제 상황 분석 - 경로를 늘리면 순서가 문제가 된다]

웹훅을 붙이는 건 어렵지 않았습니다. 어려운 건 그다음이었어요.

이제 같은 결제에 대해 **지급을 시도할 수 있는 주체가 둘**입니다. 그리고 둘의 도착 순서는 보장되지 않아요. 앱이 먼저일 수도, 웹훅이 먼저일 수도, 정확히 동시일 수도 있습니다.

경우를 하나씩 적어보니 여섯 가지가 나왔습니다. 이걸 코드 주석에 그대로 박아뒀어요.

| 도착 순서 | 무슨 일이 일어나나 |
| --- | --- |
| 앱만 도착 (정상 흐름) | 앱 요청이 지급까지 끝낸다. 뒤따라온 웹훅은 멱등키 조회에 그 주문이 잡혀 조용히 끝난다 |
| 웹훅만 도착 | 앱이 결제 직후 죽은 경우. **이 경로가 존재하는 이유**이고, 웹훅이 주문과 원장을 모두 만든다 |
| 웹훅 → 앱 | 앱 요청은 영수증 재검증도 주문 재삽입도 없이 기존 주문으로 응답한다 (201 + 정확한 잔액) |
| 앱 → 웹훅 | 위와 대칭. 웹훅이 멱등키 조회에서 기존 주문을 보고 아무것도 하지 않는다 |
| 완전 동시 | 둘 다 조회에서 없음을 보고 INSERT → 유니크 제약에 걸려 뒤늦은 쪽이 롤백된다 |
| 계정 식별자 없는 결제 | 웹훅이 회원을 특정하지 못해 포기한다. **앱 경로가 유일한 지급 수단**이 된다 |

마지막 줄이 이 글에서 가장 하고 싶은 이야기입니다. 뒤에서 다시 다룰게요.

### "완전 동시"는 예외 상황이 아닙니다

다섯 번째 줄을 처음에는 "이론적으로 가능하지만 거의 안 일어나는 경합"으로 취급했습니다. 틀렸어요.

앱은 결제 직후 곧바로 충전 API를 부르고, 스토어는 같은 시각에 웹훅을 쏩니다. 그리고 두 경로 모두 지급 전에 **스토어로 영수증을 재조회**해요. 이게 왕복 수 초, 5xx면 재시도까지 붙습니다. 겹칠 창이 넓습니다.

그래서 유니크 제약 충돌을 "버그"가 아니라 정상 동작으로 다루기로 했습니다. 이 부분은 [멱등성 글](/posts/11-payment-idempotency-four-layers/)에 자세히 적었어요.

## [해결 방법]

### 알림 본문은 지급 근거로 쓰지 않습니다

웹훅 바디에는 상품 코드도, 구매 상태도 들어 있습니다. 그대로 믿고 지급하면 편해요. 그렇게 하지 않았습니다.

웹훅 URL은 스토어가 부르는 머신 엔드포인트라 사용자 JWT가 없습니다. 인증은 서명뿐이고, 서명 검증에는 한계가 있어요. **알림 본문에서 꺼내 쓰는 것은 식별자뿐이고, 지급 근거는 그 식별자로 스토어에 되물어본 결과만 씁니다.**

```java
@Transactional("ktalkTransactionManager")
public void chargeFromGoogleRtdnInTx(String purchaseToken, String sku) {
    Optional<Prize> prizeOpt = prizeService.getForStoreCode(sku);
    if (prizeOpt.isEmpty()) {
        log.info("Google RTDN 결제 알림 - 우리 충전 상품이 아님(sku: {}), 무시", sku);
        return;
    }
    Prize prize = prizeOpt.get();

    // 알림 본문은 신뢰하지 않는다 — purchaseToken을 스토어에 재조회한 결과만 지급 근거로 쓴다(위조 알림 차단).
    GoogleVerifiedPurchase verified = googleReceiptVerifier.verify(purchaseToken, prize.getPrStoreCode());
    if (!verified.valid()) {
        log.info("Google RTDN 결제 알림 - 구매 확정 상태가 아님(sku: {}, purchaseState: {}), 무시",
            sku, verified.purchaseState());
        return;
    }
    ...
}
```

Apple 쪽에는 더 구체적인 이유가 있습니다.

```java
// 웹훅 JWS는 리프 인증서 서명만 검증해(AppleJwsVerifier의 알려진 한계) 지급 근거로 쓸 수 없다
// — App Store Server API 재조회 결과를 쓴다.
AppleVerifiedTransaction verified = appleReceiptVerifier.verify(transactionId, prize.getPrStoreCode());
```

JWS 체인 검증을 완전히 구현하지 못했다는 걸 인정하고, 대신 **재조회를 필수 단계로 못 박은** 겁니다. 검증기의 한계를 문서가 아니라 코드 흐름으로 막았어요.

### 내 알림인지부터 확인합니다

같은 URL로 남의 알림이 들어올 수 있습니다. 샌드박스 결제 알림이 운영 서버로 오거나, 다른 앱의 알림이 우리 Pub/Sub 구독으로 흘러들어오는 경우예요.

```java
@Override
public void handleAppleNotification(String signedPayload) {
    VerifiedNotification notification = appleNotificationVerifier.verify(signedPayload);

    // 샌드박스 결제 알림이 운영 서버로 들어오면(또는 그 반대) 무시한다 — 테스트 결제로 실제 포인트가 지급되는 것을 막는다.
    if (!isExpectedAppleEnvironment(notification.environment())) {
        log.warn("Apple 알림 - 환경 불일치로 무시(알림: {}, 서버 설정: {})", notification.environment(), appleEnvironment);
        return;
    }

    if (notification.isRefund()) {
        refundUseCase.reflectAppleRefundNotification(notification);
        return;
    }
    if (notification.isOneTimeCharge()) {
        String transactionId = notification.transactionInfo().getClaim("transactionId").asString();
        String productId = notification.transactionInfo().getClaim("productId").asString();
        pointUseCase.chargeFromAppleNotification(transactionId, productId);
        return;
    }
    log.debug("Apple 알림 - 처리 대상 아님(notificationType: {}), 무시", notification.notificationType());
}
```

샌드박스 알림을 그대로 처리하면 테스트 결제로 실제 포인트가 나갑니다. 환경 대조를 빼먹으면 조용히 재화가 새는 구멍이 돼요.

### 관심 없는 알림에도 200을 돌려줍니다

스토어 웹훅은 알림 종류가 아주 많습니다. 구독 갱신, 구독 취소, 보류, 가격 변경… 우리가 처리하는 건 결제와 환불 두 가지뿐이에요.

나머지에 404나 400을 내면 어떻게 될까요. 스토어는 전달 실패로 보고 재전송을 시작합니다. Apple은 사흘간 재시도해요. 처리할 생각도 없는 알림 때문에 재전송 폭탄을 맞습니다.

그래서 **모르는 알림은 로그만 남기고 200**입니다. 엔드포인트 주석에도 이 원칙을 적어뒀어요.

```java
/**
 * 결제/환불 웹훅 엔드포인트(FRD-PAY-0019). 스토어 발신(머신)이라 사용자 JWT 없이 서명/JWS로 인증하며
 * SecurityConfig.PERMIT_ALL에 등록된다. 각 URL은 단일 진입점 + usecase 내부 타입 디스패치다
 * — 관심 없는 알림 타입은 예외 없이 조용히 200을 반환한다(재전송 방지).
 */
```

같은 이유로 "이미 지급된 건"에도 200을 줍니다. 멱등 충돌로 진 쪽이 웹훅이면 로그만 남기고 정상 종료해요. 5xx를 내면 스토어가 무의미하게 재전송할 뿐입니다.

### 파싱과 서명 검증은 한 번만

Apple은 환불과 충전이 **같은 URL**로 들어옵니다. 각 유스케이스가 원문을 따로 파싱하면 무거운 JWS 검증이 두 번 돌아요. 그래서 디스패처를 하나 두고 거기서만 검증합니다.

```java
/**
 * 스토어 웹훅 디스패처 구현. 파싱/서명검증을 여기서 한 번만 수행하고 결과를 아래 usecase로 넘긴다
 * — 환불과 충전이 같은 URL로 들어오는데 각자 원문을 다시 파싱하면 JWS 검증이 두 번 돌기 때문이다.
 * <p>
 * 트랜잭션은 분기 대상 usecase가 각자 연다. 디스패처 자체는 상태를 바꾸지 않고,
 * 환불/충전 중 하나만 타므로 한 트랜잭션으로 묶을 이유가 없다.
 */
```

디스패처에 트랜잭션을 걸지 않은 것도 의도입니다. 분기 중 하나만 타는데 바깥에서 트랜잭션을 열면 JWS 검증과 스토어 재조회(수 초)가 전부 트랜잭션 안에 들어가요. 커넥션을 그만큼 오래 잡습니다.

## [웹훅은 대체재가 아니라 보완재입니다]

여기까지 오면 이런 생각이 듭니다. **웹훅이 어차피 다 해주는데 앱 경로를 없애면 안 되나?**

안 됩니다. 웹훅이 회원을 특정하지 못하는 경우가 있어요.

웹훅에는 "누가 샀는지"가 직접 들어 있지 않습니다. 앱이 결제할 때 계정 식별자를 심어두면(Google은 `obfuscatedExternalAccountId`, Apple은 `appAccountToken`) 스토어가 그걸 돌려주는 구조예요.

```java
Long mbNo = resolveMbNo(verified.obfuscatedExternalAccountId(), "Google RTDN");
if (mbNo == null) {
    return;
}
```

구버전 앱이거나 프로필 UUID가 비어 있으면 이 값이 없습니다. 그러면 웹훅은 회원을 못 찾고 포기해요. **이때는 앱 경로가 유일한 지급 수단입니다.**

반대로 앱이 죽은 경우에는 웹훅이 유일한 수단이고요. 두 경로는 서로의 실패를 덮는 관계이고, 어느 쪽도 다른 쪽을 대신할 수 없습니다.

### 그래서 세 번째 그물을 하나 더 걸었습니다

두 경로가 모두 실패하는 조합도 있습니다. 주문은 만들어졌는데 공통 지갑 서버 호출이 실패한 경우예요. 케이톡 DB에는 결제가 남았는데 원장에는 안 들어간 상태입니다.

이건 주문 행만 봐도 식별할 수 있습니다. 원장 기록 ID가 비어 있으니까요.

```java
/**
 * 미반영 결제 자동 복구(FRD-PAY-0002 §1.4). 결제 성공 + 공통 서버 미반영(oh_common_pmr_idx null) 건을
 * 주기 스캔해 같은 멱등키로 POST /point/charge를 재호출한다. 공통 서버가 멱등 재생하므로 안전(이중 적립 없음).
 */
@Transactional("ktalkTransactionManager")
public void recoverUnreflectedCharges() {
    List<OrderHistory> pending = orderHistoryRepository.findAllByOhCommonPmrIdxIsNull();
    for (OrderHistory orderHistory : pending) {
        try {
            ChargeResult result = platformWalletClient.charge(new ChargeRequest(
                orderHistory.getMbNo(), orderHistory.getOhPlatform(), orderHistory.getPrIdx(),
                orderHistory.getOhChargedPoint(), orderHistory.getOhPaymentMoney(),
                orderHistory.getOhIdempotencyKey(), orderHistory.getOhNickname()));
            orderHistory.markCommonPmrIdx(result.pmrIdx());
            orderHistoryRepository.save(orderHistory);
        } catch (RuntimeException e) {
            log.warn("[pay] 미반영 결제 자동 복구 실패 - ohIdx: {}, idempotencyKey: {}",
                orderHistory.getOhIdx(), orderHistory.getOhIdempotencyKey(), e);
        }
    }
}
```

핵심은 **같은 멱등키로 다시 부른다**는 점입니다. 이미 반영된 건이 섞여 있어도 공통 서버가 멱등 재생으로 처리하니 이중 적립이 없어요. 멱등성이 있으니까 복구 스케줄러를 겁 없이 돌릴 수 있는 겁니다. 순서가 반대예요 — 멱등성이 먼저고 복구는 그 위에 얹힙니다.

<svg class="diagram" viewBox="0 0 720 252" role="img" aria-label="지급을 보장하는 세 개의 경로">
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">지급을 보장하는 세 경로와 각자가 메우는 구멍</text>
  <rect x="0" y="30" width="720" height="60" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="18" y="52" font-size="12" font-weight="700" fill="var(--clay, #BF5F3B)">1 · 앱 → 충전 API</text>
  <text x="18" y="70" font-size="11" fill="var(--ink-2, #63605A)">정상 흐름. 즉시 지급되고 사용자가 바로 잔액을 본다.</text>
  <text x="18" y="84" font-size="11" fill="var(--ink-3, #9A958B)">못 메우는 구멍 — 결제 직후 앱이 죽으면 호출 자체가 없다</text>
  <rect x="0" y="102" width="720" height="60" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="18" y="124" font-size="12" font-weight="700" fill="var(--ink-2, #63605A)">2 · 스토어 웹훅</text>
  <text x="18" y="142" font-size="11" fill="var(--ink-2, #63605A)">앱이 사라져도 스토어가 알려준다. 재조회로 사실을 확인한 뒤 지급한다.</text>
  <text x="18" y="156" font-size="11" fill="var(--ink-3, #9A958B)">못 메우는 구멍 — 계정 식별자가 없으면 회원을 특정하지 못한다</text>
  <rect x="0" y="174" width="720" height="60" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="18" y="196" font-size="12" font-weight="700" fill="var(--ink-2, #63605A)">3 · 미반영 결제 복구 스케줄러</text>
  <text x="18" y="214" font-size="11" fill="var(--ink-2, #63605A)">주문은 있는데 원장에 안 들어간 건을 주기 스캔해 같은 멱등키로 재호출한다.</text>
  <text x="18" y="228" font-size="11" fill="var(--ink-3, #9A958B)">못 메우는 구멍 — 주문 자체가 안 만들어졌으면 스캔 대상이 아니다</text>
  <text x="0" y="250" font-size="11" fill="var(--ink-3, #9A958B)">세 경로 모두 같은 멱등키를 쓴다. 그래서 몇 번을 겹쳐 시도해도 지급은 한 번이다.</text>
</svg>

## [남은 문제]

**첫째, 세 경로를 다 뚫는 구멍이 아직 있습니다.** 앱이 죽고, 계정 식별자도 없는 결제는 어디에도 안 잡혀요. 주문 행 자체가 안 생기니 복구 스케줄러의 스캔 대상도 아닙니다. 지금은 문의가 들어오면 어드민에서 수동 지급하는 방식으로 처리하고 있어요. 근본 해결은 구버전 앱 지원을 끊는 것인데, 그건 제품 판단이라 제 선에서 정할 수 없습니다.

**둘째, 복구 스케줄러가 전체 스캔입니다.** `oh_common_pmr_idx IS NULL` 조건으로 전건을 훑어요. 미반영 건이 항상 소수라 지금은 괜찮지만, 공통 서버가 길게 죽으면 대상이 쌓이고 스캔이 무거워집니다. 상태 컬럼과 인덱스를 나누거나 시도 횟수 상한을 두는 편이 안전해요.

**셋째, 복구 실패가 로그로만 남습니다.** `catch`에서 `log.warn`만 하고 다음 건으로 넘어가요. 계속 실패하는 건이 있어도 아무도 모릅니다. 알림을 붙여야 하는데 아직 안 했습니다.

**넷째, Apple JWS 검증이 리프 인증서까지만입니다.** 재조회로 실질적인 위험은 막았지만, 검증 자체를 완성한 것은 아니에요. 체인 검증을 제대로 붙이는 게 남은 숙제입니다.

## [결론]

웹훅을 붙이기 전에는 "결제 처리"를 하나의 요청-응답으로 생각했습니다. 앱이 부르면 서버가 처리하는 흐름이요.

붙이고 나서는 관점이 바뀌었어요. **결제는 스토어에서 이미 확정된 사실이고, 우리 서버가 할 일은 그 사실을 언젠가는 반드시 원장에 반영하는 것**입니다. 누가 알려주든 상관없어요. 앱이 알려주면 빠르고, 웹훅이 알려주면 앱이 죽어도 되고, 둘 다 놓치면 스케줄러가 줍습니다.

이 관점으로 옮기니 설계가 단순해졌습니다. 경로를 늘리는 게 부담이 아니라 안전망이 되려면 **경로 수와 무관하게 결과가 같아야** 하는데, 그걸 보장하는 게 결정적 멱등키였어요. 멱등성이 먼저 있었기 때문에 웹훅도 스케줄러도 얹을 수 있었습니다.

그리고 하나 더. 웹훅이 만능처럼 보여도 앱 경로를 지운다는 선택지는 없었습니다. 계정 식별자가 없는 결제 하나 때문이에요. **두 경로 중 어느 쪽도 상대의 상위 호환이 아니라는 것**, 이게 이번에 제일 늦게 이해한 부분입니다.
