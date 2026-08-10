---
title: "LOT 단위로 포인트를 깎을 때 무엇을 먼저 태울 것인가"
description: "유료 5년, 무료 1년. 유효기간이 다른 포인트를 FIFO로만 깎으면 사용자가 손해를 봅니다. 만료 임박순 → 무료 우선 → FIFO로 정한 이유와 그 대가."
date: 2026-08-07
project: "케이톡"
tags: ["재화 설계", "FIFO", "포인트", "원장", "JPA"]
---

## [배경 - 포인트가 한 덩어리가 아니다]

K포인트에는 두 종류가 있습니다.

- **유료 포인트** — 실제 돈을 내고 충전한 것. 유효기간 5년
- **무료 포인트** — 웰컴 지급, 이벤트, 정책 보상, 어드민 지급. 유효기간 1년

```java
public enum PtdPriceType {
    // FREE lot은 웰컴/정책/어드민 지급을 모두 포함하며 현재 정책상 1년 만료를 적용한다.
    FREE(1),
    PAID(5);

    private final int validYears;

    public LocalDateTime expiresAt(LocalDateTime from) {
        return from.plusYears(validYears);
    }
}
```

유료가 5년인 건 상법상 상사시효 때문이고, 무료가 1년인 건 서비스 정책입니다.

기간이 다르니 잔액을 숫자 하나로 들고 있을 수 없습니다. "3,000P 보유"라고만 저장하면 그중 어느 만큼이 언제 사라지는지 알 수 없어요. 그래서 **지급 건마다 덩어리를 만들고 그 덩어리 단위로 관리**합니다. 이 덩어리를 lot이라고 불렀어요.

lot은 두 행으로 표현됩니다. 처음 지급이 root, 이후 소진이 child예요.

```java
@Column(name = "ptd_lot_root_idx")
private Long ptdLotRootIdx;

public boolean isLotRoot() {
    return ptdLotRootIdx == null;
}

public Long lotGroupKey() {
    return ptdLotRootIdx != null ? ptdLotRootIdx : ptdIdx;
}
```

root는 `+1000`, 거기서 300을 쓰면 child로 `-300`이 붙습니다. **잔량은 그 그룹의 합**이에요. 어떤 행도 수정하지 않고 계속 덧붙이기만 합니다.

```java
static LotBalance calculate(Collection<PointTransactionDetailEntity> details, LocalDateTime now) {
    Map<Long, List<PointTransactionDetailEntity>> lots = details.stream()
            .collect(Collectors.groupingBy(PointTransactionDetailEntity::lotGroupKey));

    int paid = 0;
    int free = 0;
    for (List<PointTransactionDetailEntity> group : lots.values()) {
        int remaining = group.stream().mapToInt(PointTransactionDetailEntity::getPtdDeltaPoint).sum();
        PointTransactionDetailEntity root = group.stream()
                .filter(PointTransactionDetailEntity::isLotRoot)
                .findFirst()
                .orElseThrow(() -> new CustomException(ErrorCode.POINT_LOT_ROOT_NOT_FOUND, ...));
        if (remaining <= 0 || !root.getPtdExpiresAt().isAfter(now)) {
            continue;
        }
        if (root.getPtdPriceType() == PtdPriceType.PAID) {
            paid += remaining;
        } else {
            free += remaining;
        }
    }
    return new LotBalance(paid, free);
}
```

만료 판정과 유료/무료 구분이 **root 행에만** 있는 게 포인트입니다. child는 얼마를 깎았는지만 들고 있어요. 소진 이력이 아무리 쌓여도 그 lot의 성격은 root 하나가 결정합니다.

## [문제 상황 분석 - 순수 FIFO는 사용자에게 불리하다]

이제 300P를 차감해야 합니다. 어느 lot부터 깎을까요.

가장 먼저 떠오르는 건 FIFO입니다. 먼저 받은 것부터 쓰는 방식이고, 재고 회계에서 쓰는 표준이에요. 직관적이고 설명하기도 쉽습니다.

그런데 여기에는 만료가 있습니다. FIFO는 "먼저 들어온 것"을 먼저 쓰지만, 우리가 신경 써야 할 건 "먼저 **사라질** 것"이에요. 둘은 다릅니다.

예를 들어 이런 상황을 생각해볼게요.

- 1월에 유료 500P 충전 (2031년 만료)
- 3월에 무료 100P 지급 (2027년 만료)

FIFO대로면 1월 유료부터 씁니다. 그러면 3월에 받은 무료 100P는 안 쓰인 채 남아 있다가 2027년에 소멸해요. 사용자는 **쓸 수 있었던 100P를 잃습니다.** 유료 포인트를 아껴봐야 만료가 5년 뒤라 여유가 있는데도요.

만료가 있는 재화에서 순수 FIFO는 사용자에게 손해를 끼칩니다.

### 그렇다고 만료순만으로도 부족합니다

그럼 만료가 임박한 것부터 쓰면 될까요. 대부분은 맞는데 동점이 나옵니다. 같은 날 지급된 무료 포인트 두 건은 만료일이 같아요.

그리고 만료일이 같을 때 유료와 무료가 섞이면 **무료를 먼저 태우는 게** 사용자에게 유리합니다. 유료는 환불 대상이 될 수 있으니 최대한 남겨두는 편이 좋고요.

그래서 세 단계로 정했습니다.

## [해결 방법 - 만료 임박순 → 무료 우선 → FIFO]

```java
// PAID+FREE lot을 모두 포함해 POL-PAY-0001 §7-2 우선순위(만료 짧은 순 → 동일 시 FREE 우선 → 동일 시
// root idx 오름차순 FIFO 근사)로 반환한다(정책 기반 포인트 차감 API에서 사용). 만료되었거나 소진된 lot은 제외한다.
static List<AvailableLot> availableLotsByPriority(
        Collection<PointTransactionDetailEntity> details, LocalDateTime now) {
    ...
    available.sort(Comparator.comparing(AvailableLot::expiresAt)
            .thenComparing((AvailableLot lot) -> lot.priceType() == PtdPriceType.FREE ? 0 : 1)
            .thenComparing(AvailableLot::rootPtdIdx));
    return available;
}
```

세 줄짜리 `Comparator`가 정책 전부입니다.

| 순위 | 기준 | 이유 |
| --- | --- | --- |
| 1 | 만료일 오름차순 | 곧 사라질 것부터 태워 소멸 손실을 줄인다 |
| 2 | 무료 우선 | 유료는 환불 대상이 될 수 있어 남겨둔다 |
| 3 | root idx 오름차순 | 먼저 적립된 것부터. FIFO 근사 |

주석의 "FIFO **근사**"라는 표현을 일부러 남겼어요. 이건 순수 FIFO가 아닙니다. FIFO는 마지막 동점 처리에만 쓰이고, 앞의 두 기준이 먼저 개입해요. 문서에 "FIFO로 처리한다"고만 적으면 나중에 읽는 사람이 오해할 것 같아서 코드에 정확히 뭘 하는지 적어뒀습니다.

<svg class="diagram" viewBox="0 0 720 292" role="img" aria-label="적립 순서와 소진 우선순위 비교">
  <defs>
    <marker id="ar-lot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">300P 를 차감할 때 어느 lot 부터 태우는가</text>
  <text x="0" y="38" font-size="11.5" font-weight="700" fill="var(--ink-3, #9A958B)">적립된 순서 (root idx)</text>
  <text x="380" y="38" font-size="11.5" font-weight="700" fill="var(--clay, #BF5F3B)">실제 소진 순서 (우선순위)</text>
  <rect x="0" y="48" width="300" height="38" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="72" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">#101</text>
  <text x="58" y="72" font-size="11" fill="var(--ink-3, #9A958B)">PAID</text>
  <text x="108" y="72" font-size="11" fill="var(--ink-2, #63605A)">500P</text>
  <text x="286" y="72" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">2031-03-01</text>
  <rect x="0" y="94" width="300" height="38" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="118" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">#102</text>
  <text x="58" y="118" font-size="11" fill="var(--ink-3, #9A958B)">FREE</text>
  <text x="108" y="118" font-size="11" fill="var(--ink-2, #63605A)">100P</text>
  <text x="286" y="118" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">2026-09-01</text>
  <rect x="0" y="140" width="300" height="38" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="164" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">#103</text>
  <text x="58" y="164" font-size="11" fill="var(--ink-3, #9A958B)">PAID</text>
  <text x="108" y="164" font-size="11" fill="var(--ink-2, #63605A)">300P</text>
  <text x="286" y="164" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">2030-06-01</text>
  <rect x="0" y="186" width="300" height="38" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="210" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">#104</text>
  <text x="58" y="210" font-size="11" fill="var(--ink-3, #9A958B)">FREE</text>
  <text x="108" y="210" font-size="11" fill="var(--ink-2, #63605A)">200P</text>
  <text x="286" y="210" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">2027-01-15</text>
  <line x1="316" y1="136" x2="366" y2="136" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-lot)"/>
  <rect x="380" y="48" width="340" height="38" rx="6" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="394" y="72" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">#102</text>
  <text x="438" y="72" font-size="11" fill="var(--clay, #BF5F3B)">FREE</text>
  <text x="488" y="72" font-size="11" fill="var(--ink-2, #63605A)">100P</text>
  <text x="706" y="72" font-size="11" text-anchor="end" fill="var(--clay, #BF5F3B)">전량 소진 · 잔여 200P</text>
  <rect x="380" y="94" width="340" height="38" rx="6" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="394" y="118" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">#104</text>
  <text x="438" y="118" font-size="11" fill="var(--clay, #BF5F3B)">FREE</text>
  <text x="488" y="118" font-size="11" fill="var(--ink-2, #63605A)">200P</text>
  <text x="706" y="118" font-size="11" text-anchor="end" fill="var(--clay, #BF5F3B)">전량 소진 · 잔여 0P</text>
  <rect x="380" y="140" width="340" height="38" rx="6" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="394" y="164" font-size="11" font-weight="700" fill="var(--ink-3, #9A958B)">#103</text>
  <text x="438" y="164" font-size="11" fill="var(--ink-3, #9A958B)">PAID</text>
  <text x="488" y="164" font-size="11" fill="var(--ink-3, #9A958B)">300P</text>
  <text x="706" y="164" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">건드리지 않음</text>
  <rect x="380" y="186" width="340" height="38" rx="6" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="394" y="210" font-size="11" font-weight="700" fill="var(--ink-3, #9A958B)">#101</text>
  <text x="438" y="210" font-size="11" fill="var(--ink-3, #9A958B)">PAID</text>
  <text x="488" y="210" font-size="11" fill="var(--ink-3, #9A958B)">500P</text>
  <text x="706" y="210" font-size="11" text-anchor="end" fill="var(--ink-3, #9A958B)">건드리지 않음</text>
  <line x1="0" y1="244" x2="720" y2="244" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="262" font-size="11" fill="var(--ink-3, #9A958B)">순수 FIFO 였다면 #101 유료 500P 부터 깎이고, 2026-09-01 에 만료될 무료 100P 가 그대로 소멸했을 것이다.</text>
  <text x="0" y="280" font-size="11" fill="var(--ink-3, #9A958B)">차감 결과는 원장에 child 행 두 개(#102 에 -100, #104 에 -200)로 남는다.</text>
</svg>

### 소진은 여러 lot에 걸칩니다

300P 차감이 lot 하나로 안 끝나면 순서대로 여러 개를 태웁니다. 소진할 때마다 child 행이 하나씩 붙어요.

```java
int remainingToDeduct = amount;
int paidConsumed = 0;
int freeConsumed = 0;
List<LotConsumption> consumptions = new ArrayList<>();
for (PointBalanceCalculator.AvailableLot lot : PointBalanceCalculator.availableLotsByPriority(existing, now)) {
    if (remainingToDeduct <= 0) {
        break;
    }
    int consume = Math.min(lot.remaining(), remainingToDeduct);
    if (lot.priceType() == PtdPriceType.PAID) {
        paidConsumed += consume;
    } else {
        freeConsumed += consume;
    }
    consumptions.add(new LotConsumption(lot.rootPtdIdx(), consume));
    remainingToDeduct -= consume;
}
// 사전 잔액과 실제 소진 가능한 lot이 어긋나면 조용히 부분 차감하지 않고 롤백한다.
if (remainingToDeduct > 0) {
    throw new CustomException(ErrorCode.INSUFFICIENT_POINT);
}
```

마지막 세 줄이 중요합니다. 잔액 검사는 이미 위에서 통과했는데도 실제로 태우다 보면 모자랄 수 있어요. 그럴 때 **가능한 만큼만 깎고 성공으로 처리하지 않습니다.** 통째로 롤백해요.

부분 차감을 허용하면 "500P 필요한 기능을 300P만 내고 썼다"가 됩니다. 재화 도메인에서 조용한 부분 성공은 나중에 정산이 안 맞는 원인이 돼요. 실패로 끝내는 편이 낫습니다.

### 차감 대상을 제한하는 API도 있습니다

어드민이 무료 포인트만 회수하는 기능은 유료 lot을 건드리면 안 됩니다. 별도 메서드를 뒀어요.

```java
// FREE 전용 lot만 다룬다(어드민 무료 포인트 차감 API에서 사용) — 만료 빠른 순 → idx 순으로 소진 순서를 정한다.
static List<AvailableLot> availableFreeLots(
        Collection<PointTransactionDetailEntity> details, LocalDateTime now) {
    ...
    if (root.getPtdPriceType() == PtdPriceType.FREE && remaining > 0 && root.getPtdExpiresAt().isAfter(now)) {
        available.add(new AvailableLot(root.getPtdIdx(), remaining, root.getPtdExpiresAt(), root.getPtdPriceType()));
    }
    ...
    available.sort(Comparator.comparing(AvailableLot::expiresAt).thenComparing(AvailableLot::rootPtdIdx));
    return available;
}
```

전부 무료 lot이니 2순위(무료 우선)가 의미 없어져서 정렬이 두 단계로 줄었습니다.

## [환불은 FIFO를 따르지 않습니다]

여기가 이 도메인에서 제일 헷갈렸던 부분이에요.

차감은 "어느 lot이든 상관없으니 유리한 순서로"입니다. 환불은 다릅니다. **그 결제로 지급된 바로 그 lot에서 회수해야** 해요. 다른 lot에서 빼면 회계가 어긋납니다.

```java
// 특정 충전 거래(chargeTxPtIdx)가 만든 PAID lot 하나의 잔여량을 계산한다(환불 회수 대상 lot 조회용).
// root 행의 pt_idx로 lot을 찾고, 그 lot의 전체 delta(다른 거래가 만든 child 포함)를 합산한다.
static Optional<AvailableLot> chargeLot(
        Collection<PointTransactionDetailEntity> details, Long chargeTxPtIdx) {
```

그런데 그 lot은 이미 다 쓰였을 수 있습니다. 1,000P 충전하고 900P를 쓴 뒤에 전액 환불을 요청하면, 회수할 수 있는 건 100P뿐이에요.

```java
Optional<PointBalanceCalculator.AvailableLot> lot =
        PointBalanceCalculator.chargeLot(existing, chargeTxPtIdx);
// 해당 충전 lot 잔량이 요청보다 적으면 가능한 만큼만 회수하고 차액은 서비스 손실로 둔다.
int actualRecall = lot.map(available -> Math.min(available.remaining(), recallPoint)).orElse(0);
```

**차액은 서비스 손실로 둡니다.** 다른 lot에서 마저 빼면 사용자 잔액이 음수가 되거나, 환불과 무관한 포인트를 뺏는 셈이 돼요. 스토어는 이미 사용자에게 돈을 돌려줬고, 우리는 이미 제공한 서비스 값을 못 받은 겁니다. 이건 설계로 막을 수 있는 게 아니라 받아들일 손실이에요.

차감과 정반대 태도라는 게 재밌습니다. 차감은 모자라면 전체 롤백이고, 환불 회수는 모자라면 가능한 만큼만 하고 넘어갑니다. **사용자에게 불리한 쪽으로는 절대 반올림하지 않는다**는 원칙이 두 경우에 다르게 나타난 거예요.

회수량 계산은 두 단계로 나눠 걸었습니다.

```java
/**
 * 환불 회수 K포인트 1차 clamp(서비스 몫). 2차 clamp(Lot 실잔량 단위)는 공통 서버가 한다.
 * <pre>
 * unitPrice = oh_payment_money / oh_charged_point (결제 시점 실단가)
 * rawRecallPoint = round(refundMoney / unitPrice)
 * recallPoint = min(rawRecallPoint, max(oh_charged_point - alreadyRecalledPoint, 0))
 * </pre>
 */
public static int recallPoint(BigDecimal paymentMoney, int chargedPoint,
        int alreadyRecalledPoint, BigDecimal refundMoney) {
    BigDecimal unitPrice = paymentMoney.divide(BigDecimal.valueOf(chargedPoint), 12, RoundingMode.HALF_UP);
    long rawRecallPoint = refundMoney.divide(unitPrice, 0, RoundingMode.HALF_UP).longValueExact();
    long remainingChargedPoint = Math.max(chargedPoint - alreadyRecalledPoint, 0);
    return (int) Math.min(rawRecallPoint, remainingChargedPoint);
}
```

1차는 서비스가 **"이 결제로 준 것보다 많이 회수하지 않는다"** 를 보장하고, 2차는 공통 서버가 **"실제 lot 잔량보다 많이 회수하지 않는다"** 를 보장합니다. 각자 자기가 아는 정보로만 판단해요. 서비스는 결제 금액과 이미 환불한 양을 알고, 공통 서버는 lot 잔량을 압니다. 서로 상대의 데이터를 몰라도 되게 나눈 거예요.

부분 환불이 여러 번 들어올 수 있어서 `alreadyRecalledPoint`를 빼는 것도 필요했습니다. 100P짜리를 30P씩 네 번 환불 요청하면 네 번째는 10P만 회수돼야 하니까요.

## [남은 문제]

**첫째, 잔액 조회가 전건 로딩입니다.** `findAllByMbNo(mbNo)`로 그 회원의 모든 상세 행을 메모리에 올린 뒤 자바에서 그룹핑해요. 만료된 lot과 이미 소진된 lot까지 전부 읽습니다. 오래 쓴 회원일수록 행이 쌓이고, 잔액 조회는 아주 자주 불리는 API예요. 지금 규모에서는 체감이 없지만 구조적으로 커지는 비용입니다. 만료·소진된 lot을 별도 테이블로 아카이빙하거나, root 행에 잔량 캐시 컬럼을 두는 쪽을 검토해야 합니다.

**둘째, 정렬을 자바에서 합니다.** 정렬 기준을 DB 인덱스로 태우면 필요한 lot만 읽고 끝낼 수 있는데, lot 잔량이 child 합산이라 SQL로 옮기려면 집계가 들어가요. 그래서 미뤘습니다. 첫 번째 문제와 같이 풀어야 할 것 같아요.

**셋째, 만료된 lot을 정리하는 배치가 없습니다.** 만료는 조회 시점에 `expiresAt.isAfter(now)`로 걸러낼 뿐이고, 행은 계속 남아요. 회계상 이력이 남는 건 맞지만 조회 비용은 계속 늘어납니다.

**넷째, 우선순위 정책이 코드에만 있습니다.** `Comparator` 세 줄이 정책의 정본이에요. 정책 문서 번호를 주석에 달아두긴 했지만, 정책이 바뀌면 배포가 필요합니다. 지금은 바뀔 일이 드물어서 이대로 두고 있어요.

## [결론]

"FIFO로 처리한다"는 말이 실제로는 세 단계 정렬이었습니다. 그리고 그 세 단계는 성능이나 구현 편의가 아니라 **사용자가 손해를 덜 보는 순서**에서 나왔어요.

- 만료 임박순 — 안 쓰고 사라지는 포인트를 줄인다
- 무료 우선 — 환불 가능한 유료를 남긴다
- FIFO — 나머지 동점을 결정한다

이 도메인을 만지면서 제일 크게 바뀐 생각은, 재화 설계에서 **"둥글게 처리하기"가 거의 항상 틀렸다**는 점입니다. 300P 중 200P만 있으니 200P만 깎고 넘어가기, 회수할 게 부족하니 다른 데서 마저 빼기 — 둘 다 코드로는 짧지만 나중에 정산이 안 맞는 원인이 돼요.

그래서 매번 같은 질문을 했습니다. **이 상황에서 손해를 누가 볼 것인가.** 답이 사용자면 롤백했고, 서비스면 받아들이고 기록으로 남겼습니다. 차감과 환불이 반대로 동작하는 것도 이 질문에 답하다 보니 그렇게 된 거예요.
