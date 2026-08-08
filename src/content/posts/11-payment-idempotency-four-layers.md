---
title: "결제 멱등성을 네 겹으로 막았습니다 (결정적 멱등키부터 원장 UK까지)"
description: "앱과 스토어 웹훅이 같은 결제를 거의 동시에 밀어넣습니다. 중복 지급을 어디서 어떻게 끊었는지, 네 겹의 역할을 나눠 정리했어요."
date: 2026-08-07
project: "케이톡"
tags: ["멱등성", "결제", "Spring", "JPA", "동시성"]
featured: true
---

## [배경 - 중복 요청이 예외가 아니라 기본 동작이었다]

케이톡은 인앱결제로 K포인트를 충전합니다. 사용자가 스토어에서 결제를 마치면 앱이 서버로 충전 API를 부르고, 서버는 영수증을 검증한 뒤 포인트를 지급해요.

여기까지는 흔한 구조입니다. 문제는 지급 경로가 하나가 아니라는 점이었어요.

앱만 믿을 수는 없습니다. 결제가 끝난 직후 앱이 죽으면 충전 API 호출이 영영 안 옵니다. 돈은 빠져나갔는데 포인트가 없는 상태죠. 그래서 스토어가 직접 쏘는 웹훅(Google RTDN, Apple App Store Server Notification)도 같은 지급을 할 수 있게 열어뒀습니다.

경로를 둘로 늘리는 순간 질문이 바뀝니다. **"중복이 오면 어떡하지"가 아니라 "중복은 항상 온다, 어디서 끊을까"** 가 됩니다.

실제로 두 경로는 거의 동시에 도착해요. 앱은 결제 직후 곧바로 충전 API를 부르고, 스토어는 같은 시각에 웹훅을 쏩니다. 그 사이에 서버가 스토어로 영수증을 재조회하는 왕복이 수 초씩 끼어들어요. 5xx가 나면 재시도까지 붙습니다. 겹칠 창이 넓습니다.

이건 드물게 터지는 경합이 아니라 정상 결제의 기본 동작이었습니다.

## [문제 상황 분석 - 멱등키를 누가 만드느냐]

### 요청마다 UUID를 발급하면 안 됩니다

처음 떠올린 방법은 흔한 패턴이에요. 클라이언트가 요청마다 `X-Idempotency-Key`에 UUID를 넣어 보내고, 서버는 그 키를 저장해 두 번째 요청을 걸러내는 방식입니다.

이 방식은 **같은 클라이언트의 재시도**만 막습니다. 앱이 만든 UUID와 스토어 웹훅이 만든 UUID는 당연히 다르니까요. 두 경로가 같은 결제를 밀어넣는 상황에서는 아무 역할도 못 합니다.

그래서 키를 **결제 사실 자체에서 유도**하기로 했어요. 앱이 알고 있는 값도, 서버가 발급한 값도 아니고, 스토어가 그 결제에 붙인 식별자에서 뽑습니다.

```java
/**
 * 결제/환불 멱등키 생성(형식: {service}:{platform}:{type}:{store-id}[:{event-id}]).
 * 결정적 생성이라 같은 결제/환불 이벤트의 재시도는 항상 같은 키가 되어 공통 서버에서 자동으로 수렴한다.
 */
@UtilityClass
public class PayIdempotencyKeys {

    private static final String SERVICE = "ktalk";

    public static String googleCharge(String orderId) {
        return SERVICE + ":google:charge:" + orderId;
    }

    public static String appleCharge(String transactionId) {
        return SERVICE + ":apple:charge:" + transactionId;
    }

    /** Apple 환불(웹훅). transactionId 기준이라 재전송으로 notificationUUID가 바뀌어도 같은 키로 수렴한다. */
    public static String appleRefund(String transactionId) {
        return SERVICE + ":apple:refund:" + transactionId;
    }
}
```

Google은 `orderId`, Apple은 `transactionId`입니다. 앱이 부르든 웹훅이 부르든 같은 결제라면 같은 키가 나와요.

Apple 환불 주석이 이 설계의 요점을 잘 보여줍니다. 웹훅이 재전송되면 `notificationUUID`는 매번 바뀌지만 `transactionId`는 그대로예요. 알림의 ID가 아니라 **결제의 ID**를 키로 삼아야 재전송이 자동으로 수렴합니다.

### 그래도 동시 도착은 남습니다

키가 같아졌으니 이제 "이미 처리했나?" 를 조회해서 걸러내면 될 것 같습니다. 하지만 조회와 삽입 사이에는 틈이 있어요.

두 경로가 정확히 같은 순간에 들어오면 둘 다 조회에서 "없음"을 보고, 둘 다 삽입으로 넘어갑니다. 고전적인 check-then-act 레이스입니다.

여기서 방어를 한 겹 더 쌓아야 했고, 결국 네 겹이 됐습니다.

<svg class="diagram" viewBox="0 0 720 366" role="img" aria-label="결제 멱등성 네 겹 방어 구조">
  <defs>
    <marker id="ar-idem" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">같은 결제가 두 경로로 들어와도 지급은 한 번</text>

  <rect x="40" y="30" width="250" height="34" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="165" y="51" font-size="11.5" text-anchor="middle" fill="var(--ink-2, #63605A)">앱 → 충전 API</text>
  <rect x="430" y="30" width="250" height="34" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="555" y="51" font-size="11.5" text-anchor="middle" fill="var(--ink-2, #63605A)">스토어 → 웹훅</text>
  <line x1="165" y1="66" x2="165" y2="86" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-idem)"/>
  <line x1="555" y1="66" x2="555" y2="86" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-idem)"/>

  <rect x="40" y="88" width="640" height="44" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="58" y="108" font-size="11.5" font-weight="700" fill="var(--clay, #BF5F3B)">1겹 · 결정적 멱등키</text>
  <text x="58" y="124" font-size="11" fill="var(--ink-3, #9A958B)">두 경로가 스토어 식별자로 같은 키를 만든다</text>
  <text x="662" y="118" font-size="10.5" text-anchor="end" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">ktalk:google:charge:{orderId}</text>

  <rect x="40" y="144" width="640" height="44" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="58" y="164" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">2겹 · 서비스 DB 유니크 제약</text>
  <text x="58" y="180" font-size="11" fill="var(--ink-3, #9A958B)">주문 원본을 두 번 만들지 못하게 한다</text>
  <text x="662" y="174" font-size="10.5" text-anchor="end" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">oh_idempotency_key</text>

  <rect x="40" y="200" width="640" height="44" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="58" y="220" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">3겹 · 회원 행 비관적 락</text>
  <text x="58" y="236" font-size="11" fill="var(--ink-3, #9A958B)">같은 회원의 동시 요청을 줄 세워 레이스를 없앤다</text>
  <text x="662" y="230" font-size="10.5" text-anchor="end" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">SELECT ... FOR UPDATE</text>

  <rect x="40" y="256" width="640" height="44" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="58" y="276" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">4겹 · 원장 유니크 제약</text>
  <text x="58" y="292" font-size="11" fill="var(--ink-3, #9A958B)">앞이 다 뚫려도 원장에는 한 번만 쓰인다</text>
  <text x="662" y="286" font-size="10.5" text-anchor="end" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">pmr_idempotency_key</text>

  <line x1="360" y1="302" x2="360" y2="320" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-idem)"/>
  <text x="360" y="342" font-size="14" font-weight="700" text-anchor="middle" fill="var(--clay, #BF5F3B)">포인트 지급 1회</text>
  <text x="360" y="360" font-size="11" text-anchor="middle" fill="var(--ink-3, #9A958B)">진 쪽은 기존 결과를 그대로 돌려받는다</text>
</svg>

## [해결 방법 - 네 겹이 각자 다른 것을 막는다]

### 2겹. 서비스 DB의 주문 유니크 제약

케이톡은 결제가 들어오면 주문 원본(`hama_order_history`)을 먼저 씁니다. 이 테이블의 멱등키 컬럼에 유니크 제약을 걸었어요.

```java
@Table(name = "hama_order_history", comment = "결제 내역(서비스 소유, 충전 원본)",
    uniqueConstraints = @UniqueConstraint(name = "uk_hama_order_history_idempotency_key",
        columnNames = {"oh_idempotency_key"}),
    indexes = @Index(name = "idx_hama_order_history_mb_created", columnList = "mb_no, created_at"))
```

지급 로직 앞에서 조회로 한 번 거르고, 조회를 통과한 경우에도 제약이 최종 판정을 합니다.

```java
@Transactional("ktalkTransactionManager")
public SingleResult<PointChargeResponse> chargeGoogleInTx(Long mbNo, PointChargeGoogleRequest request) {
    String idempotencyKey = PayIdempotencyKeys.googleCharge(request.orderId());
    Optional<OrderHistory> existing = orderHistoryRepository.findByOhIdempotencyKey(idempotencyKey);
    // 클라이언트 재진입(크래시 복구)이거나 RTDN 웹훅이 먼저 충전을 끝낸 경우.
    if (existing.isPresent()) {
        return finishCharge(rejectIfPrizeMismatch(existing.get(), request.prIdx()), false);
    }
    ...
}
```

이미 있으면 영수증 재검증도, 주문 재삽입도 하지 않고 기존 주문으로 응답합니다. 앱 입장에서는 자기가 방금 충전한 것과 구분되지 않아요. 201과 정확한 잔액을 그대로 받습니다.

### 제약 위반은 트랜잭션 바깥에서 잡아야 합니다

여기가 이번에 가장 많이 헤맨 부분입니다.

동시 도착으로 유니크 제약에 걸리면 `DataIntegrityViolationException`이 납니다. 처음에는 이걸 트랜잭션 **안에서** 잡아 "그럼 기존 주문을 다시 조회하자"고 짰어요. 동작하지 않았습니다.

제약 위반이 난 트랜잭션은 이미 오염된 상태(rollback-only)라 그 안에서 재조회로 복구할 수 없습니다. 그래서 예외를 트랜잭션 경계 밖으로 흘려보내고, 바깥에서 잡아 **새 트랜잭션으로 본문을 다시 태웁니다.**

```java
@Override
public SingleResult<PointChargeResponse> chargeGoogle(Long mbNo, PointChargeGoogleRequest request) {
    try {
        return self.getObject().chargeGoogleInTx(mbNo, request);
    } catch (DataIntegrityViolationException e) {
        // RTDN 웹훅과 완전 동시 도착. 사유와 복구 방식은 chargeApple과 같다.
        log.info("Google 충전 - 웹훅과 멱등키 충돌, 기존 주문으로 응답(mbNo: {}, orderId: {})", mbNo, request.orderId());
        return self.getObject().chargeGoogleInTx(mbNo, request);
    }
}
```

두 번째 호출에서는 멱등키 조회에 상대가 만든 주문이 잡히므로 정상 응답으로 끝나요. `self.getObject()`로 프록시를 통해 부르는 이유는 같은 빈 안에서 직접 호출하면 `@Transactional`이 걸리지 않기 때문입니다.

**진 쪽이 무엇을 하느냐는 경로마다 다릅니다.** 앱 경로는 사용자에게 돌려줄 응답이 있으니 다시 태우고, 웹훅 경로는 돌려줄 값이 없으니 로그만 남기고 끝냅니다.

```java
@Override
public void chargeFromGoogleRtdn(String purchaseToken, String sku) {
    try {
        self.getObject().chargeFromGoogleRtdnInTx(purchaseToken, sku);
    } catch (DataIntegrityViolationException e) {
        // 앱 충전 요청과 완전 동시 도착으로 멱등키 UK에서 졌다 = 앱 쪽이 이미 지급을 끝냈다.
        // 예외를 그대로 올리면 5xx가 나가 Pub/Sub이 무의미하게 재전송한다.
        log.info("Google RTDN - 앱 충전 요청과 멱등키 충돌, 이미 지급됨(sku: {})", sku);
    }
}
```

웹훅에서 5xx를 내면 스토어가 재전송을 시작합니다. Apple은 사흘씩 재시도해요. 이미 지급이 끝난 건에 대해 사흘간 두들겨 맞을 이유가 없으니 조용히 200을 돌려줍니다.

### 3겹. 회원 행 비관적 락

포인트 원장은 공통 지갑 서버가 가지고 있습니다. 이 서버는 지급/차감 전에 **회원 행을 먼저 잠급니다.**

```java
@Transactional
public PointChargeResponse charge(
        Long mbNo, PointChargeRequest request, PtSourceApp sourceApp, String idempotencyKey) {
    memberService.getByIdForUpdate(mbNo);
    PmrSourceApp paymentSourceApp = PmrSourceApp.valueOf(sourceApp.name());

    Optional<PaymentRecordEntity> existing = paymentRecordService.findByIdempotencyKey(
            idempotencyKey, mbNo, paymentSourceApp, PmrType.CHARGE);
    if (existing.isPresent()) {
        PaymentRecordEntity pmr = existing.get();
        PointTransactionEntity tx = pointService.getByPtIdx(pmr.getPmrPtIdx());
        return PointChargeResponse.of(pmr.getPmrIdx(), tx, true);
    }
    ...
}
```

락이 먼저, 멱등키 조회가 그다음입니다. 순서가 중요해요. 같은 회원의 동시 요청은 락에서 줄을 서고, 앞선 요청이 커밋을 끝낸 뒤에야 뒤 요청이 조회를 합니다. 그래서 뒤 요청은 반드시 기존 기록을 봅니다. check-then-act 레이스가 여기서 사라져요.

응답의 마지막 인자 `true`가 `duplicated` 플래그입니다. 원장을 새로 쓰지 않고 **기존 결과를 재생**해서 돌려준다는 뜻이에요. 호출한 서비스 서버는 이 값으로 "내가 지급한 건지, 이미 되어 있던 건지"를 구분할 수 있습니다.

### 4겹. 원장의 유니크 제약

락까지 있는데 제약이 또 필요한가 싶었는데, 필요했습니다. 락은 **같은 회원** 안에서만 직렬화하니까요.

```java
// pmr_idempotency_key(UK) 위반은 정상 재시도라면 findByIdempotencyKey 사전 조회+회원 행
// 락으로 이미 걸러진다. 그럼에도 저장 시점에 위반이 발생하면 서로 다른 mbNo가 같은 멱등키로
// 동시에 들어온 레이스(버그 상황)이므로, 다른 회원의 결제 데이터를 반환하지 않도록 -808만 던진다.
@Transactional
public PaymentRecordEntity recordCharge(
        String idempotencyKey, Long mbNo, PmrSourceApp sourceApp, PmrPlatform platform,
        Long ptIdx, int chargedPoint, BigDecimal paymentMoney, Long prizeRef) {
    try {
        return paymentRecordRepository.save(PaymentRecordEntity.createCharge(
                idempotencyKey, mbNo, sourceApp, platform, ptIdx, chargedPoint, paymentMoney, prizeRef,
                LocalDateTime.now()));
    } catch (DataIntegrityViolationException e) {
        throw new CustomException(ErrorCode.POINT_APPLY_ALREADY_PROCESSED, e);
    }
}
```

서로 다른 회원이 같은 멱등키를 들고 오는 건 정상 흐름에서는 불가능합니다. 발생했다면 버그이거나 공격이에요. 이때 "이미 처리됨"이라며 **남의 결제 데이터를 돌려주면 안 되니까** 조회 결과 대신 에러만 던집니다.

같은 방어가 조회 쪽에도 있어요.

```java
public Optional<PaymentRecordEntity> findByIdempotencyKey(
        String idempotencyKey, Long mbNo, PmrSourceApp sourceApp, PmrType type) {
    Optional<PaymentRecordEntity> record =
            paymentRecordRepository.findByPmrIdempotencyKey(idempotencyKey);
    record.filter(existing -> existing.getPmrType() != type
                    || !existing.getPmrMbNo().equals(mbNo)
                    || existing.getPmrSourceApp() != sourceApp)
            .ifPresent(existing -> {
                throw new CustomException(ErrorCode.POINT_APPLY_ALREADY_PROCESSED);
            });
    return record;
}
```

멱등키가 맞아도 회원·타입·서비스가 하나라도 다르면 그건 "재시도"가 아니라 "충돌"입니다. 멱등 응답을 주는 대신 거절해요.

### 멱등의 소유권을 한 곳에만 둔다

포인트 원장 테이블에도 멱등키 컬럼이 있는데, 결제에서는 이 컬럼을 쓰지 않습니다.

```java
// 정책/어드민 지급·차감 전용 재시도 방지 키. 결제/환불은 hama_payment_record가 멱등을
// 단독 소유하므로 이 컬럼은 NULL로 남긴다.
@Column(name = "pt_idempotency_key")
private String ptIdempotencyKey;
```

같은 결제에 멱등 판정 주체가 둘이면 둘이 어긋날 때 어느 쪽이 옳은지 알 수 없어요. 그래서 **결제/환불의 멱등은 결제 기록 테이블이 단독으로 소유**하고, 정책 지급이나 어드민 조정처럼 결제 기록이 없는 거래만 원장 컬럼을 씁니다. 판정 주체를 하나로 못 박은 셈입니다.

## [남은 문제]

**첫째, 3겹의 락이 회원 단위 직렬화입니다.** 같은 회원의 충전·차감·환불이 전부 한 줄로 섭니다. 지금 트래픽에서는 문제가 안 되지만, 한 회원이 짧은 시간에 많은 차감을 일으키는 기능이 생기면 이 락이 병목이 될 수 있어요. 그때는 원장 append-only 특성을 살려 락을 좁히는 쪽을 봐야 합니다.

**둘째, 재시도로 다시 태우는 경로가 무한 루프에 빠질 여지가 있습니다.** 지금은 `catch` 안에서 한 번만 다시 태우니 안전하지만, 두 번째 시도도 제약 위반이 나면 예외가 그대로 올라갑니다. 상대 트랜잭션이 아직 커밋 전이라 조회에 안 잡히는 아주 좁은 창이 이론적으로 남아요. 실제로 관측한 적은 없고, 관측하려면 로그부터 붙여야 합니다.

**셋째, 이 구조는 "지급이 한 번"만 보장합니다.** 지급이 **반드시** 일어나는 것은 보장하지 못해요. 앱도 죽고 웹훅도 유실되면 포인트는 들어오지 않습니다. 그 구멍은 별도의 복구 스케줄러로 메우고 있는데, 그건 다음 글에서 다룰게요.

## [결론]

멱등성을 "중복 요청을 걸러내는 기능"으로 생각했을 때는 방어가 한 겹이면 충분해 보였습니다. 실제로 짜보니 네 겹이 각자 다른 것을 막고 있었어요.

| 겹 | 무엇을 막나 | 실패 시 |
| --- | --- | --- |
| 결정적 멱등키 | 경로가 달라 키가 갈라지는 것 | 두 경로가 서로를 못 알아본다 |
| 주문 UK | 서비스 DB에 주문이 두 번 생기는 것 | 결제 내역이 중복된다 |
| 회원 행 락 | 조회와 삽입 사이의 레이스 | 원장이 두 번 쓰인다 |
| 원장 UK | 앞의 세 겹이 전부 뚫린 경우 | 포인트가 두 번 지급된다 |

가장 중요한 하나를 꼽으라면 첫 번째입니다. **키를 클라이언트가 발급하지 않고 결제 사실에서 유도한 것**이 나머지를 전부 가능하게 했어요. 키가 같아야 조회도 제약도 의미가 있으니까요.

그리고 제약 위반을 예외 처리 대상이 아니라 **정상 흐름의 일부**로 받아들인 게 두 번째로 중요했습니다. 유니크 제약을 "여기 걸리면 버그"로 보면 500을 내보내게 되는데, 이 도메인에서는 걸리는 게 정상이었어요. 걸린 뒤에 무엇을 할지를 설계해야 했습니다.
