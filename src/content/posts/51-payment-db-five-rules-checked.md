---
title: "결제 DB 다섯 가지 원칙에 제 코드를 대봤습니다 (셋은 맞고 둘은 아니었다)"
description: "금액은 DECIMAL, 상태 전이는 DB 제약, 중복은 멱등키, 불일치는 대사 배치, 결제는 삭제 불가. 실제 결제 코드에 하나씩 대보니 CHECK 제약이 0개였고 대사 배치도 없었습니다. double 누적 오차는 직접 재봤어요."
date: 2026-08-17
project: "케이톡"
tags: ["결제", "DB 설계", "BigDecimal", "멱등성", "상태 머신", "MySQL"]
---

## [배경 - 다섯 줄을 읽고 제 코드가 걸렸다]

결제 DB 설계 원칙을 다섯 줄로 정리한 글을 봤습니다. "결제 데이터인데 그냥 숫자 컬럼에 넣으면 안 되나요" 라는 질문에 답하는 형태였어요.

제가 이해한 대로 줄이면 이렇습니다.

1. 금액은 DECIMAL 로 잡는다. float 는 쓰지 않는다
2. 상태 전이는 DB 제약으로 막는다
3. 중복 결제는 멱등 키로 차단한다
4. PG 사와의 불일치는 대사 배치로 잡는다
5. 결제 데이터는 삭제할 수 없다

읽으면서 두 가지가 걸렸어요. 하나는 3번과 4번이 제가 이미 글로 쓴 주제라는 것입니다. [11번 글](/posts/11-payment-idempotency-four-layers/)에서 멱등성을 네 겹으로 막았고, [12번 글](/posts/12-why-payment-webhook/)에서 웹훅이 왜 필요한지를 썼어요. 다른 하나는 **2번을 한 번도 생각해본 적이 없다**는 것이었습니다.

그래서 세어봤습니다. 케이톡 결제 코드는 서버 두 개에 걸쳐 있어요. 결제 원본은 서비스 서버가, 포인트 원장은 공통 지갑 서버가 소유합니다. 그 이유는 [13번 글](/posts/13-common-platform-not-msa/)에 적었습니다.

```bash
# CHECK 제약을 쓴 곳이 있는가
$ grep -rn "@Check\|check = " --include="*.java" ktalk-java-api/src peopleandtalk-java-integration/src
$ # 결과 없음
```

<svg class="diagram" viewBox="0 0 720 302" role="img" aria-label="결제 DB 다섯 가지 원칙에 대한 자체 점검 결과">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">다섯 줄에 제 코드를 대본 결과</text>
  <line x1="0" y1="26" x2="720" y2="26" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="0" y="50" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">1. 금액은 DECIMAL</text>
  <text x="300" y="50" font-size="13" font-weight="700" fill="var(--clay-text, #1B64DA)">지킴</text>
  <text x="368" y="50" font-size="10.5" fill="var(--ink-3, #8B9099)">precision 10, scale 2. 다만 포인트는 Integer 로 두고 이유를 따로 뒀다</text>
  <line x1="0" y1="62" x2="720" y2="62" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="86" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">2. 상태 전이를 DB 제약으로</text>
  <text x="300" y="86" font-size="13" font-weight="700" fill="var(--ink-3, #8B9099)">못 지킴</text>
  <text x="368" y="86" font-size="10.5" fill="var(--ink-3, #8B9099)">CHECK 제약 0개. 엔티티에도 전이 검증이 없다</text>
  <line x1="0" y1="98" x2="720" y2="98" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="122" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">3. 중복은 멱등 키로</text>
  <text x="300" y="122" font-size="13" font-weight="700" fill="var(--clay-text, #1B64DA)">지킴</text>
  <text x="368" y="122" font-size="10.5" fill="var(--ink-3, #8B9099)">DB 유니크 제약 두 곳. 11번 글에 자세히 적었다</text>
  <line x1="0" y1="134" x2="720" y2="134" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="158" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">4. 불일치는 대사 배치로</text>
  <text x="300" y="158" font-size="13" font-weight="700" fill="var(--ink-3, #8B9099)">절반</text>
  <text x="368" y="158" font-size="10.5" fill="var(--ink-3, #8B9099)">어드민 엑셀에 대사용 컬럼만 있다. 자동 배치는 없다</text>
  <line x1="0" y1="170" x2="720" y2="170" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="194" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">5. 결제는 삭제 불가</text>
  <text x="300" y="194" font-size="13" font-weight="700" fill="var(--clay-text, #1B64DA)">지킴</text>
  <text x="368" y="194" font-size="10.5" fill="var(--ink-3, #8B9099)">17개 컬럼 중 14개가 updatable=false. 탈퇴 시엔 이관한다</text>
  <line x1="0" y1="206" x2="720" y2="206" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="0" y="236" font-size="11" fill="var(--ink-3, #8B9099)">3번과 4번은 겪고 나서 고친 것이고, 1번과 5번은 처음부터 그렇게 잡았다.</text>
  <text x="0" y="256" font-size="11" fill="var(--ink-3, #8B9099)">2번만 아무 대비가 없었다. 문제가 난 적이 없어서 생각할 계기가 없었기 때문이다.</text>
  <text x="0" y="284" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">이 글은 그 하나를 찾은 기록이다.</text>
</svg>

## [1. 금액은 DECIMAL - 한 번 곱할 때는 안 드러납니다]

결제 금액 컬럼은 이렇게 되어 있습니다.

```java
// ktalk-java-api. 결제 원본
@Column(name = "oh_payment_money", nullable = false, updatable = false,
        precision = 10, scale = 2, comment = "실결제 USD 스냅샷")
private BigDecimal ohPaymentMoney;
```

```java
// peopleandtalk-java-integration. 공통 지갑의 감사 금액
@Column(name = "pmr_money", precision = 10, scale = 2, comment = "USD 감사 금액")
private BigDecimal pmrMoney;
```

둘 다 `BigDecimal` 이고 `precision = 10, scale = 2` 입니다. JPA 가 이 값을 `DECIMAL(10,2)` 로 만듭니다. 이건 처음부터 이렇게 잡았어요. 다만 왜 안 되는지는 감각으로만 알고 있었고, 실제로 얼마나 틀어지는지는 재본 적이 없었습니다.

그래서 재봤어요.

```java
public class FloatTest {
    public static void main(String[] a) {
        double d = 0;
        for (int i = 0; i < 10; i++) d += 0.1;
        System.out.println("double 0.1 x 10       = " + d);
        System.out.println("double == 1.0         = " + (d == 1.0));
        System.out.println("double 19.99 * 3      = " + (19.99 * 3));

        BigDecimal b = BigDecimal.ZERO;
        for (int i = 0; i < 10; i++) b = b.add(new BigDecimal("0.1"));
        System.out.println("BigDecimal 0.1 x 10   = " + b);

        float f = 0;
        for (int i = 0; i < 1000; i++) f += 0.01f;
        System.out.println("float 0.01 x 1000     = " + f);

        double sum = 0;
        for (int i = 0; i < 100000; i++) sum += 0.01;
        System.out.println("double 0.01 x 100,000 = " + sum);
    }
}
```

```
double 0.1 x 10       = 0.9999999999999999
double == 1.0         = false
double 19.99 * 3      = 59.97
BigDecimal 0.1 x 10   = 1.0
float 0.01 x 1000     = 10.0001335
double 0.01 x 100,000 = 999.9999999992356
```

측정 환경은 OpenJDK 25.0.2 입니다.

결과에서 눈에 걸린 건 세 번째 줄이었어요. **`19.99 * 3` 은 `59.97` 로 정확히 나옵니다.** 한 번 곱하는 것만으로는 오차가 드러나지 않습니다. 그래서 개발 중에 상품 하나 결제해보고 "잘 나오는데" 하고 넘어가기 쉬워요.

오차는 누적에서 나옵니다. `0.01` 을 10만 번 더하면 `999.9999999992356` 이고, 기대값은 `1000.0` 이에요. 정산이나 대사처럼 많은 행을 더하는 곳에서 이게 터집니다.

<svg class="diagram" viewBox="0 0 720 288" role="img" aria-label="double 과 BigDecimal 의 누적 결과 비교 실측값">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 번 계산할 때는 같고, 쌓을 때 갈린다</text>
  <text x="0" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">연산</text>
  <text x="300" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">결과</text>
  <text x="560" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">기대값</text>
  <line x1="0" y1="52" x2="720" y2="52" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <rect x="0" y="56" width="720" height="30" rx="4" fill="var(--surface, #FAFAFB)"/>
  <text x="12" y="76" font-size="11" fill="var(--ink, #16181A)">double  19.99 * 3</text>
  <text x="300" y="76" font-size="11" fill="var(--clay-text, #1B64DA)">59.97</text>
  <text x="560" y="76" font-size="11" fill="var(--ink-3, #8B9099)">59.97   맞는다</text>
  <rect x="0" y="92" width="720" height="30" rx="4" fill="var(--surface, #FAFAFB)"/>
  <text x="12" y="112" font-size="11" fill="var(--ink, #16181A)">double  0.1 을 10번 더함</text>
  <text x="300" y="112" font-size="11" fill="var(--ink, #16181A)">0.9999999999999999</text>
  <text x="560" y="112" font-size="11" fill="var(--ink-3, #8B9099)">1.0</text>
  <rect x="0" y="128" width="720" height="30" rx="4" fill="var(--surface, #FAFAFB)"/>
  <text x="12" y="148" font-size="11" fill="var(--ink, #16181A)">float  0.01 을 1,000번 더함</text>
  <text x="300" y="148" font-size="11" fill="var(--ink, #16181A)">10.0001335</text>
  <text x="560" y="148" font-size="11" fill="var(--ink-3, #8B9099)">10.0</text>
  <rect x="0" y="164" width="720" height="30" rx="4" fill="var(--clay-soft, #EAF2FE)"/>
  <text x="12" y="184" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">double  0.01 을 100,000번 더함</text>
  <text x="300" y="184" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">999.9999999992356</text>
  <text x="560" y="184" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">1000.0</text>
  <rect x="0" y="200" width="720" height="30" rx="4" fill="var(--surface, #FAFAFB)"/>
  <text x="12" y="220" font-size="11" fill="var(--ink, #16181A)">BigDecimal  0.1 을 10번 더함</text>
  <text x="300" y="220" font-size="11" fill="var(--clay-text, #1B64DA)">1.0</text>
  <text x="560" y="220" font-size="11" fill="var(--ink-3, #8B9099)">1.0   맞는다</text>
  <line x1="0" y1="244" x2="720" y2="244" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="264" font-size="11" fill="var(--ink-3, #8B9099)">실측. OpenJDK 25.0.2. 첫 줄이 맞기 때문에 결제 한 건 테스트로는 이 문제를 발견할 수 없다.</text>
  <text x="0" y="282" font-size="11" fill="var(--ink-3, #8B9099)">DB 쪽 FLOAT 컬럼의 오차는 재보지 않았다. 위 값은 애플리케이션 연산에서만 잰 것이다.</text>
</svg>

### 그런데 포인트는 Integer 입니다

여기서 원칙을 그대로 따르지 않은 곳이 하나 있어요. 포인트는 `Integer` 입니다.

```java
// 공통 지갑의 원장. 포인트는 정수다
@Column(name = "pt_delta_point", nullable = false, comment = "이 거래의 signed 총 변동량")
private Integer ptDeltaPoint;

@Column(name = "pt_paid_balance", nullable = false, comment = "거래 후 유료 잔액 스냅샷")
private Integer ptPaidBalance;
```

이유는 K포인트가 쪼갤 수 없는 단위이기 때문입니다. 0.5 포인트라는 것이 존재하지 않아요. 그러면 `DECIMAL` 로 잡을 이유가 없습니다. 오히려 `Integer` 로 두면 "반 포인트를 차감하는 코드" 가 컴파일되지 않으니 타입이 규칙을 지켜줘요.

정리하면 이렇게 갈립니다.

| 값 | 타입 | 이유 |
| --- | --- | --- |
| 실결제 금액 (USD) | `BigDecimal` / `DECIMAL(10,2)` | 스토어가 소수 둘째 자리까지 준다 |
| 유료 포인트 잔액 | `Integer` | 쪼갤 수 없는 단위다 |
| 포인트 단가 | `BigDecimal` | 금액을 포인트로 나눈 값이라 소수가 생긴다 |

**"금액은 DECIMAL" 이라는 규칙의 본질은 소수를 정확히 다루라는 것이고, 소수가 없으면 정수가 더 안전합니다.** 원칙을 문장 그대로 적용하기보다 왜 그렇게 말했는지를 보는 게 맞다고 생각했어요.

## [2. 상태 전이 - 이건 대비가 아예 없었습니다]

결제 상태는 셋입니다.

```java
/** 결제 상태. */
public enum OhStatus {
    SUCCESS,
    PARTIAL_REFUND,
    REFUND
}
```

전이 규칙은 자연스럽게 정해져요. 결제가 성공하면 `SUCCESS` 이고, 일부 환불되면 `PARTIAL_REFUND`, 전액 환불되면 `REFUND` 입니다. 그리고 **`REFUND` 는 종점입니다.** 이미 전액 환불된 결제가 다시 `SUCCESS` 가 될 수는 없어요.

문제는 코드가 이걸 모른다는 겁니다.

```java
// OrderHistory.java
public void markStatus(OhStatus status) {
    this.ohStatus = status;
}
```

아무 값이나 받습니다. 검증이 없어요. 호출하는 쪽을 보면 이렇습니다.

```java
// RefundUseCaseImpl.java
orderHistory.markStatus(OhStatus.REFUND);
// ...
orderHistory.markStatus(fullyRefunded ? OhStatus.REFUND : OhStatus.PARTIAL_REFUND);
```

여덟 곳에서 부릅니다. 지금은 전부 올바른 값을 넘기고 있어요. 그런데 규칙이 호출하는 쪽에 흩어져 있으니, 아홉 번째 호출을 추가하는 사람이 규칙을 다시 알아내야 합니다.

<svg class="diagram" viewBox="0 0 720 320" role="img" aria-label="결제 상태 전이 그래프와 현재 코드가 막지 못하는 전이" >
  <defs>
    <marker id="d51a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
    <marker id="d51b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">허용해야 하는 전이와 지금 막히지 않는 전이</text>
  <rect x="40" y="52" width="150" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="115" y="77" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">SUCCESS</text>
  <rect x="285" y="52" width="150" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="360" y="77" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">PARTIAL_REFUND</text>
  <rect x="530" y="52" width="150" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="605" y="72" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">REFUND</text>
  <text x="605" y="86" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">종점</text>
  <line x1="190" y1="72" x2="281" y2="72" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d51a)"/>
  <text x="235" y="64" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">일부 환불</text>
  <line x1="435" y1="72" x2="526" y2="72" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d51a)"/>
  <text x="480" y="64" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">잔여 환불</text>
  <path d="M115 52 Q360 8 605 52" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.4" marker-end="url(#d51a)"/>
  <text x="360" y="24" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">전액 환불 (한 번에)</text>
  <text x="0" y="128" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">그런데 이 세 가지도 통과한다</text>
  <rect x="0" y="140" width="720" height="112" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <path d="M100 168 L240 168" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#d51b)"/>
  <text x="18" y="172" font-size="10.5" fill="var(--ink-2, #545A64)">REFUND</text>
  <text x="252" y="172" font-size="10.5" fill="var(--ink-2, #545A64)">SUCCESS</text>
  <text x="380" y="172" font-size="10" fill="var(--ink-3, #8B9099)">환불된 결제가 성공으로 돌아간다</text>
  <path d="M100 200 L240 200" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#d51b)"/>
  <text x="18" y="204" font-size="10.5" fill="var(--ink-2, #545A64)">REFUND</text>
  <text x="252" y="204" font-size="10.5" fill="var(--ink-2, #545A64)">PARTIAL_REFUND</text>
  <text x="380" y="204" font-size="10" fill="var(--ink-3, #8B9099)">전액 환불이 일부 환불로 줄어든다</text>
  <path d="M100 232 L240 232" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#d51b)"/>
  <text x="18" y="236" font-size="10.5" fill="var(--ink-2, #545A64)">SUCCESS</text>
  <text x="252" y="236" font-size="10.5" fill="var(--ink-2, #545A64)">SUCCESS</text>
  <text x="380" y="236" font-size="10" fill="var(--ink-3, #8B9099)">같은 상태를 다시 쓴다. 이건 무해하지만 로그가 남지 않는다</text>
  <line x1="0" y1="276" x2="720" y2="276" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="296" font-size="11" fill="var(--ink-3, #8B9099)">지금 이 전이가 실제로 일어나고 있다는 뜻은 아니다. 호출하는 여덟 곳은 모두 올바른 값을 넘긴다.</text>
  <text x="0" y="314" font-size="11" fill="var(--ink-3, #8B9099)">막을 장치가 없다는 것이 문제다. 규칙이 코드가 아니라 사람의 기억에 있다.</text>
</svg>

### 두 겹으로 막을 수 있습니다

원칙의 표현은 DB 제약으로 막으라는 것이었어요. 저는 두 겹이 맞다고 생각합니다. 엔티티에서 막으면 에러 메시지를 제어할 수 있고, DB 에서 막으면 애플리케이션을 우회한 변경까지 걸립니다.

먼저 엔티티입니다.

```java
public enum OhStatus {
    SUCCESS,
    PARTIAL_REFUND,
    REFUND;

    /** 이 상태에서 갈 수 있는 다음 상태. REFUND 는 종점이라 비어 있다. */
    private Set<OhStatus> allowedNext() {
        return switch (this) {
            case SUCCESS -> EnumSet.of(PARTIAL_REFUND, REFUND);
            case PARTIAL_REFUND -> EnumSet.of(REFUND);
            case REFUND -> EnumSet.noneOf(OhStatus.class);
        };
    }

    public boolean canTransitionTo(OhStatus next) {
        return allowedNext().contains(next);
    }
}
```

```java
// OrderHistory.java
public void markStatus(OhStatus next) {
    if (!this.ohStatus.canTransitionTo(next)) {
        throw new CustomException(ErrorCode.INVALID_PAYMENT_STATUS_TRANSITION,
            "결제 상태를 %s 에서 %s 로 바꿀 수 없습니다".formatted(this.ohStatus, next));
    }
    this.ohStatus = next;
}
```

그다음 DB 입니다. MySQL 8.0 부터 CHECK 제약이 실제로 동작하는데, 이건 "상태 값이 세 개 중 하나인가" 만 검사할 수 있어요. 전이는 이전 값을 알아야 하니 CHECK 로는 안 됩니다. 트리거가 필요합니다.

```sql
-- 값의 범위는 CHECK 로 잡는다
ALTER TABLE hama_order_history
  ADD CONSTRAINT ck_oh_status
  CHECK (oh_status IN ('SUCCESS', 'PARTIAL_REFUND', 'REFUND'));

-- 전이 방향은 트리거로 잡는다. 되돌아가는 UPDATE 를 거부한다
CREATE TRIGGER trg_oh_status_forward_only
BEFORE UPDATE ON hama_order_history
FOR EACH ROW
BEGIN
  IF OLD.oh_status = 'REFUND' AND NEW.oh_status <> 'REFUND' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REFUND is terminal';
  END IF;
  IF OLD.oh_status = 'PARTIAL_REFUND' AND NEW.oh_status = 'SUCCESS' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cannot revert to SUCCESS';
  END IF;
END;
```

여기서 솔직히 망설이는 부분이 있어요. **트리거를 넣을지는 아직 결정하지 못했습니다.** 트리거는 애플리케이션 코드에 안 보이는 로직이라, 나중에 원인을 찾을 때 비싼 대가를 치릅니다. 마이그레이션 스크립트로 과거 데이터를 고쳐야 할 때도 걸려요.

그래서 순서를 이렇게 잡았습니다. 엔티티 검증을 먼저 넣고, `CHECK` 로 값 범위를 잡고, 트리거는 실제로 잘못된 전이가 관측된 다음에 넣습니다. **관측되지 않은 문제에 트리거까지 붙이는 건 [7번 글](/posts/07-retro-overengineering/)에서 반성한 그 패턴이에요.**

### 상태를 아예 안 바꾸는 방법도 있습니다

한 가지 더 생각해본 게 있어요. 상태를 UPDATE 하지 않고 이벤트를 쌓는 방법입니다. 환불 회차 테이블(`RefundGoogle`, `RefundApple`)이 이미 1:N 으로 있으니, 결제의 현재 상태는 환불 회차의 합으로 계산할 수 있어요.

그러면 `oh_status` 는 파생 값이 되고, 전이 규칙 위반이라는 개념 자체가 사라집니다. 잘못된 상태를 만들 방법이 없으니까요.

버린 이유는 조회 비용입니다. 어드민 결제 목록에서 상태로 필터링하는데, 그때마다 환불 회차를 집계해야 해요. 지금 구조는 `oh_status` 에 인덱스를 걸면 끝납니다. **읽기 편의를 위해 쓰기 시점의 정확성을 코드로 지키는 쪽을 골랐습니다.** 다만 이건 트레이드오프이고, 상태가 셋보다 많아지면 다시 볼 것 같아요.

## [3. 중복 결제와 4. 대사 - 하나는 지켰고 하나는 절반입니다]

3번은 이미 쓴 주제라 짧게 적습니다. 멱등키는 두 서버 양쪽에서 DB 유니크 제약으로 막습니다.

```java
// 서비스 서버의 결제 원본
@Table(name = "hama_order_history",
    uniqueConstraints = @UniqueConstraint(
        name = "uk_hama_order_history_idempotency_key",
        columnNames = {"oh_idempotency_key"}))
```

```java
// 공통 지갑 서버의 결제 기록
@Column(name = "pmr_idempotency_key", nullable = false,
        comment = "멱등 확인 정본 키({service}:{platform}:{type}:{store-id}[:{event-id}])")
private String pmrIdempotencyKey;
```

키를 스토어 트랜잭션 ID 로 만드는 게 핵심입니다. 클라이언트가 만든 UUID 를 쓰면 같은 결제를 두 번 보고할 때 키가 달라져서 못 막아요. 자세한 건 11번 글에 적었습니다.

4번은 절반만 했습니다. 자동 대사 배치가 없어요.

```java
/** 어드민 결제 내역 엑셀(7.17.1). 현재 필터/검색 조건 전체 결과와 대사용 컬럼을 추출한다. */
byte[] downloadAdminOrdersXlsx(OrderAdminSearchRequest request, String fileName);
```

"대사용 컬럼" 이라는 주석이 있는데, 그건 사람이 엑셀을 내려받아 스토어 정산서와 맞춰보라는 뜻입니다. 자동으로 도는 배치가 아니에요. 스케줄러를 세어보니 10개가 있는데 대사 관련은 없었습니다.

정확히는 한 방향만 자동입니다. 결제가 확정됐는데 원장에 안 들어간 경우는 복구 스케줄러가 잡아요. 13번 글에 적은 그 구조입니다. **못 잡는 건 반대 방향이에요.** 스토어에는 결제가 있는데 우리 DB 에 주문 자체가 없는 경우요. 그건 웹훅이 유실됐을 때 생기고, 우리 DB 만 스캔해서는 찾을 수 없습니다.

이 문제 구조는 [36번 글](/posts/36-compensating-transaction-reconciliation/)에서 다뤘던 것과 같아요. 다른 프로젝트였지만 "우리 쪽에 단서가 없으면 스캔으로 찾을 수 없다" 는 성질이 같습니다. 스토어의 결제 목록을 주기적으로 당겨와서 우리 주문과 맞추는 배치가 있어야 해요. 아직 없습니다.

<!-- 측정 필요: 스토어(Google Play, App Store) 결제 목록과 hama_order_history 를 특정 기간으로 맞춰
     불일치 건수를 센다. 이 숫자가 대사 배치를 만들 근거이자 우선순위다.
     지금은 그 조회 자체를 해본 적이 없어 불일치가 있는지도 모른다. -->

## [5. 결제 데이터는 삭제할 수 없다 - 개인정보와 부딪힙니다]

5번은 지켰는데, 지키는 방식이 조금 특이해서 따로 적을 값어치가 있습니다.

먼저 결제 원본은 거의 전부 불변입니다. 컬럼 17개 중 14개에 `updatable = false` 가 붙어 있어요.

```java
@Column(name = "mb_no", nullable = false, updatable = false, comment = "공통 회원 번호(논리 FK)")
private Long mbNo;

@Column(name = "oh_payment_money", nullable = false, updatable = false,
        precision = 10, scale = 2, comment = "실결제 USD 스냅샷")
private BigDecimal ohPaymentMoney;

@Column(name = "oh_prize_name", length = 100, updatable = false, comment = "결제 시점 상품명(한글) 스냅샷")
private String ohPrizeName;
```

바뀔 수 있는 건 둘뿐입니다. `oh_status` 와 `oh_common_pmr_idx` 예요. 나머지는 JPA 가 UPDATE 문에 넣지 않습니다. 실수로 `setXxx` 를 호출해도 DB 에 반영되지 않아요.

그리고 상품명을 컬럼으로 복사해둔 게 보이시죠. 상품 마스터를 참조하지 않고 결제 시점의 이름을 박제합니다.

```java
/**
 * 상품 마스터가 변경·삭제돼도 결제 당시 표시·감사 값을 유지하기 위한 주문 자체의 상품 스냅샷이다.
 * prIdx는 추적용 논리 참조만 유지하며 결제 조회의 정본은 이 필드들이다.
 */
```

원장 쪽도 같습니다. 거래 사유 제목과 닉네임과 회원 식별자를 전부 거래 시점 값으로 박아둬요.

```java
/** 거래 당시 PTR 제목 스냅샷. PTR 제목이 나중에 바뀌거나 비활성화돼도 과거 이력은 당시 표기를 유지한다. */
@Column(name = "pt_ptr_name_snapshot", nullable = false)
private String ptPtrNameSnapshot;
```

### 그런데 탈퇴하면 어떻게 하나

여기가 재미있는 부분이었어요. 두 요구가 정면으로 부딪힙니다.

한쪽은 결제 데이터를 지울 수 없다는 것입니다. 상사시효 5년이 코드에 상수로 들어가 있어요.

```java
/** 유료 K포인트 유효기간(상사시효). POL-PAY-0001 §7-1/§7-3. */
private static final int CHARGE_LOT_VALID_YEARS = 5;
// ...
this.expireAt = createdAt.plusYears(CHARGE_LOT_VALID_YEARS);
```

다른 한쪽은 탈퇴한 회원의 개인정보를 파기해야 한다는 것입니다. 이건 스케줄러로 돌아요.

```java
// 탈퇴 보관기간(30일) 지난 회원의 개인 데이터 익명화 (POL-OPS-0001 §4, 매일 03시)
@Scheduled(cron = "0 0 3 * * *", zone = KST)
@SchedulerLock(name = "purgeWithdrawnMemberData", lockAtLeastFor = "PT1M", lockAtMostFor = "PT30M")
public void purgeWithdrawnMemberData() {
    schedulerService.purgeWithdrawnMemberData();
}
```

30일 뒤 회원 정보가 익명화되면 결제 이력의 `mb_no` 는 아무것도 가리키지 않게 됩니다. 그러면 5년 동안 보관해야 하는 결제 이력에서 "누가 결제했는지" 를 알 수 없어요.

이걸 스냅샷으로 풀었습니다.

```java
/** 결제 시점 회원 식별정보 스냅샷. 탈퇴 후 원본 회원 정보가 삭제되어도 결제 이력을 조회할 수 있도록 보관한다. */
@Column(name = "oh_nickname", length = 20, updatable = false, comment = "결제 시점 닉네임 스냅샷")
private String ohNickname;

@Column(name = "oh_email", length = 100, updatable = false, comment = "결제 시점 이메일 스냅샷")
private String ohEmail;
```

그리고 결제 행 자체는 탈퇴 시점에 별도 테이블로 옮깁니다.

```java
/**
 * 탈퇴 회원 결제 내역 이관본(KTALK-167, FRD-USR-0026). 탈퇴 시 hama_order_history(+hama_order_google/hama_order_apple) 원본을
 * 이 테이블로 그대로 옮기고 원본은 삭제한다(hama_qna_withdrawn과 달리 원본을 남기지 않는다 — 결제 정보를 두 곳에 중복 보관하지 않기 위함).
 */
@Entity
@Table(name = "hama_withdrawn_order_history", comment = "탈퇴 회원 결제 내역(이관본, 원본 삭제)")
public class OrderHistoryWithdrawn extends BaseEntity {
```

"삭제할 수 없다" 는 원칙과 "원본은 삭제한다" 는 주석이 같이 있으니 모순처럼 보이는데, 실제로는 **행을 옮기고 지운 것**입니다. 데이터는 남아 있어요. 두 곳에 중복 보관하지 않으려고 원본을 지운 판단이고, 대신 원본 PK 를 값으로 보존합니다.

```java
/**
 * 이관 전 원본 PK. 원본 행은 이관 직후 삭제되므로 물리 FK가 아니라 값만 보존하는 논리 참조다.
 */
@Column(name = "oh_idx", updatable = false, comment = "원본 결제 내역 PK(hama_order_history.oh_idx, 이관 전 값)")
private Long ohIdx;
```

<svg class="diagram" viewBox="0 0 720 344" role="img" aria-label="탈퇴 시 개인정보와 결제 데이터가 각각 다른 경로로 처리되는 구조">
  <defs>
    <marker id="d51c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d51d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">지워야 하는 것과 남겨야 하는 것이 같은 행에 있었다</text>
  <rect x="270" y="30" width="180" height="30" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="360" y="50" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">회원 탈퇴</text>
  <line x1="290" y1="60" x2="150" y2="96" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d51c)"/>
  <line x1="430" y1="60" x2="570" y2="96" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d51d)"/>
  <rect x="0" y="100" width="330" height="112" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="18" y="122" font-size="11.5" font-weight="700" fill="var(--ink, #16181A)">개인정보 경로</text>
  <text x="18" y="144" font-size="10.5" fill="var(--ink-2, #545A64)">보관기간 30일이 지나면</text>
  <text x="18" y="161" font-size="10.5" fill="var(--ink-2, #545A64)">매일 03시 배치가 익명화한다</text>
  <text x="18" y="183" font-size="10" fill="var(--ink-3, #8B9099)">통화 내역은 1년 뒤 하드 삭제</text>
  <text x="18" y="200" font-size="10" fill="var(--ink-3, #8B9099)">QnA 는 이관본과 원본을 둘 다 남긴다</text>
  <rect x="390" y="100" width="330" height="112" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="408" y="122" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">결제 경로</text>
  <text x="408" y="144" font-size="10.5" fill="var(--clay-text, #1B64DA)">탈퇴 즉시 이관본 테이블로 옮기고</text>
  <text x="408" y="161" font-size="10.5" fill="var(--clay-text, #1B64DA)">원본 행은 삭제한다</text>
  <text x="408" y="183" font-size="10" fill="var(--clay-text, #1B64DA)">원본 PK 와 멱등키는 값으로 보존</text>
  <text x="408" y="200" font-size="10" fill="var(--clay-text, #1B64DA)">상사시효 5년까지 남는다</text>
  <rect x="150" y="240" width="420" height="62" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="360" y="262" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">두 경로가 만나는 지점이 스냅샷이다</text>
  <text x="360" y="282" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">결제 행이 닉네임, 이메일, 국적, 상품명을 결제 시점 값으로 들고 있다</text>
  <text x="360" y="296" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">회원 원본이 익명화돼도 결제 이력은 그대로 조회된다</text>
  <line x1="0" y1="322" x2="720" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="340" font-size="11" fill="var(--ink-3, #8B9099)">그런데 그 스냅샷 자체가 개인정보다. 결제 이력을 5년 남긴다는 말은 그 개인정보도 5년 남긴다는 뜻이다.</text>
</svg>

마지막 줄이 이번에 새로 인식한 것입니다. **스냅샷으로 문제를 푼 게 아니라 문제를 옮긴 것**일 수 있어요. 회원 테이블의 이메일은 익명화되는데 결제 행의 `oh_email` 은 5년 남습니다. 법적으로 결제 이력 보관이 우선이라 이게 맞는 처리라고 알고 있지만, 어느 컬럼까지가 "결제 이력에 필요한 개인정보" 인지는 제가 판단할 수 있는 영역이 아니에요. 국적까지 5년 남길 필요가 있는지는 확인이 필요합니다.

### 이미 알려진 구멍도 하나 있습니다

코드에 정직하게 남아 있는 주석이 있어요.

```java
/**
 * 원본 충전 멱등키(hama_order_history.oh_idempotency_key). 탈퇴 후 환불 시 지갑 서버 refund의 originalIdempotencyKey로
 * 넘겨 통합 원장의 원거래를 찾는다. 이 컬럼 신설(KTALK-133) 전에 이관된 행은 null이라 지갑 회수를 못 하고 로컬 이력만 남긴다.
 */
```

이관본에 멱등키 컬럼을 나중에 추가했기 때문에, 그 전에 이관된 행들은 원장의 원거래를 못 찾습니다. 탈퇴한 회원이 나중에 환불을 받으면 케이톡 쪽 이력만 남고 지갑 포인트는 회수되지 않아요. **백필할 원본이 이미 삭제됐으니 되돌릴 방법이 없습니다.**

원본을 지운 판단의 대가가 여기서 나왔습니다. 중복 보관을 피한 대신 스키마를 나중에 늘렸을 때 과거 데이터를 채울 수 없어요. 지금 다시 정하라면 이관본을 만들 때 원본 행 전체를 JSON 한 컬럼에 같이 넣어둘 것 같습니다. 조회에는 안 쓰고 복구용으로요.

## [결론]

다섯 줄을 읽고 제 코드를 대봤더니, 지킨 것들은 대개 **문제를 겪은 다음에** 지킨 것이었습니다. 멱등키는 중복 충전을 보고 나서 넣었고, 웹훅은 앱이 죽으면 포인트가 안 들어가는 걸 보고 넣었어요. 스냅샷은 상품명을 바꿨더니 과거 결제 내역의 표기가 바뀌는 걸 보고 넣었습니다.

못 지킨 하나는 반대였어요. **문제가 난 적이 없어서 생각할 계기가 없었습니다.** 상태를 잘못 전이시킨 사고가 없었으니까요. 그런데 없었던 이유가 구조 때문이 아니라 호출하는 곳이 여덟 개뿐이었기 때문입니다. 아홉 번째가 생기는 날 처음 나겠죠.

정리하면 셋입니다.

1. **원칙은 문장이 아니라 이유로 적용합니다.** "금액은 DECIMAL" 의 이유는 소수를 정확히 다루라는 것이고, 소수가 없는 포인트는 `Integer` 가 더 안전했어요.
2. **오차는 한 번 계산할 때 안 드러납니다.** `19.99 * 3` 은 double 로도 정확히 나옵니다. 누적에서 갈려요. 그래서 테스트로 발견하기 어렵습니다.
3. **막을 장치가 없는 것과 사고가 안 난 것은 다릅니다.** 상태 전이가 지금까지 옳았던 건 호출 지점이 적었기 때문이고, 구조가 지켜준 게 아니었습니다.

한계도 적습니다. 이 글에서 실제로 잰 것은 double 누적 오차 하나뿐이에요. DB 의 `FLOAT` 컬럼이 얼마나 틀어지는지, 스토어와 우리 DB 의 불일치가 실제로 몇 건인지는 재보지 않았습니다. 특히 4번은 그 숫자가 없으면 우선순위를 정할 수 없어요. 스토어 결제 목록을 기간으로 당겨와서 맞춰보는 게 다음에 할 일입니다.

그리고 다섯 줄짜리 글 하나가 제 코드의 구멍을 하나 찾아준 게 재미있었어요. 제 코드만 오래 보고 있으면 없는 문제는 계속 없는 상태로 남습니다. 남이 쓴 원칙을 가져와서 하나씩 대보는 게 그걸 깨는 방법이라고 생각합니다.

## [참고 자료]

- [MySQL 8.0 CHECK 제약](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html) MySQL 공식 문서
