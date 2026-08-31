---
title: "point_transaction 은 왜 이렇게 생겼나 (재화 도메인의 원장 설계)"
description: "잔액 컬럼 하나면 될 것 같았던 포인트가 테이블 다섯 개가 됐습니다. append-only 원장, lot 명세 분리, 스냅샷 컬럼이 각각 무엇을 막고 있는지."
date: 2026-08-07
project: "코리안쌤"
tags: ["재화 설계", "원장", "데이터 모델링", "JPA", "스냅샷"]
---

## [배경 - 잔액 컬럼 하나로 시작했다면]

포인트 기능을 처음 설계한다고 하면 가장 단순한 모델은 이겁니다.

```sql
ALTER TABLE member ADD COLUMN point INT NOT NULL DEFAULT 0;
```

지급하면 더하고 차감하면 뺍니다. 잔액 조회는 컬럼 하나 읽으면 끝이에요. 빠르고 명확합니다.

이 모델이 무너지는 순간은 이런 질문이 들어올 때예요.

- "이 회원 포인트가 왜 3,000P죠? 어제는 5,000P였는데"
- "지난달 무료 지급 총액이 얼마인가요"
- "이 결제 환불하면 얼마 회수돼요?"
- "유효기간 지난 포인트가 얼마나 되나요"

전부 답할 수 없습니다. 현재 값만 있고 **어떻게 그 값이 됐는지가 없으니까요.** 그리고 재화 도메인에서 이런 질문은 부가 기능이 아니라 필수입니다. 돈이 얽혀 있으면 반드시 "왜"를 되짚어야 할 일이 생겨요.

그래서 잔액을 저장하는 대신 **변동을 저장**하기로 했습니다. 회계에서 쓰는 원장(ledger) 방식이에요. 결과적으로 테이블 다섯 개가 됐습니다.

<svg class="diagram" viewBox="0 0 720 344" role="img" aria-label="포인트 거래 하나가 남기는 테이블 구조">
  <defs>
    <marker id="ar-led" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">거래 한 건이 남기는 행들</text>
  <rect x="0" y="34" width="205" height="88" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="14" y="54" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">payment_record</text>
  <text x="14" y="72" font-size="10.5" fill="var(--ink-3, #9A958B)">결제/환불 멱등의 정본</text>
  <text x="14" y="89" font-size="10.5" fill="var(--ink-2, #63605A)">멱등키 (UK) · 실결제 금액</text>
  <text x="14" y="106" font-size="10.5" fill="var(--ink-2, #63605A)">플랫폼 · 원 충전 키</text>
  <rect x="250" y="34" width="250" height="88" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="264" y="54" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)" font-family="var(--font-mono)">point_transaction</text>
  <text x="264" y="72" font-size="10.5" fill="var(--ink-3, #9A958B)">원장 헤더 · 거래 한 건</text>
  <text x="264" y="89" font-size="10.5" fill="var(--ink-2, #63605A)">변동량 · 직후 잔액 스냅샷</text>
  <text x="264" y="106" font-size="10.5" fill="var(--ink-2, #63605A)">사유·닉네임·식별자 스냅샷</text>
  <rect x="540" y="34" width="180" height="88" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="554" y="54" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">PTR</text>
  <text x="554" y="72" font-size="10.5" fill="var(--ink-3, #9A958B)">상세 사유</text>
  <text x="554" y="89" font-size="10.5" fill="var(--ink-2, #63605A)">영상대화 · AI 파트너</text>
  <text x="554" y="106" font-size="10.5" fill="var(--ink-2, #63605A)">사용자 노출용 활동명</text>
  <rect x="250" y="176" width="250" height="88" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="264" y="196" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)" font-family="var(--font-mono)">..._detail</text>
  <text x="264" y="214" font-size="10.5" fill="var(--ink-3, #9A958B)">lot 명세 · 어느 덩어리에서 얼마</text>
  <text x="264" y="231" font-size="10.5" fill="var(--ink-2, #63605A)">root = 지급 / child = 소진</text>
  <text x="264" y="248" font-size="10.5" fill="var(--ink-2, #63605A)">유료·무료 · 만료일 · 단가</text>
  <rect x="540" y="176" width="180" height="88" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="554" y="196" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">TR</text>
  <text x="554" y="214" font-size="10.5" fill="var(--ink-3, #9A958B)">상위 분류</text>
  <text x="554" y="231" font-size="10.5" fill="var(--ink-2, #63605A)">charge · deduct · refund</text>
  <text x="554" y="248" font-size="10.5" fill="var(--ink-2, #63605A)">어드민 필터 기준</text>
  <line x1="206" y1="72" x2="244" y2="72" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-led)"/>
  <line x1="244" y1="88" x2="206" y2="88" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-led)"/>
  <text x="225" y="112" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #9A958B)">상호</text>
  <line x1="501" y1="80" x2="534" y2="80" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-led)"/>
  <line x1="375" y1="122" x2="375" y2="170" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-led)"/>
  <text x="386" y="150" font-size="10" fill="var(--ink-3, #9A958B)">1 : N</text>
  <line x1="630" y1="122" x2="630" y2="170" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-led)"/>
  <text x="641" y="150" font-size="10" fill="var(--ink-3, #9A958B)">N : 1</text>
  <line x1="0" y1="286" x2="720" y2="286" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="304" font-size="11" fill="var(--ink-3, #9A958B)">어느 행도 UPDATE 하지 않는다. 소진도 취소도 새 행을 덧붙여 표현한다.</text>
  <text x="0" y="322" font-size="11" fill="var(--ink-3, #9A958B)">회원 테이블로 향하는 FK 가 없다. 회원이 삭제돼도 원장은 5 년간 그대로 남는다.</text>
  <text x="0" y="340" font-size="11" fill="var(--ink-3, #9A958B)">잔액은 컬럼이 아니라 lot 명세를 합산해 계산한다. 헤더의 잔액은 그 시점 표시용 스냅샷이다.</text>
</svg>

## [문제 상황 분석 - 원장이 지켜야 하는 것]

원장을 만들기로 한 뒤 요구가 하나씩 붙었습니다.

**과거는 바뀌면 안 됩니다.** 어제 찍힌 거래 내역이 오늘 다르게 보이면 원장이 아니에요. 그런데 참조하는 데이터는 바뀝니다. 사유 이름도 바뀌고, 닉네임도 바뀌고, 회원이 탈퇴하기도 해요.

**회원이 사라져도 남아야 합니다.** 탈퇴하면 회원 행을 하드 삭제하는데(탈퇴+30일), 결제 이력은 5년을 보관해야 해요. FK가 있으면 삭제 자체가 막힙니다.

**어드민이 조회할 수 있어야 합니다.** 닉네임이나 이메일로 검색하고, 사유별로 필터링하고, 기간으로 자릅니다.

이 셋이 데이터 모델을 결정했어요.

## [해결 방법]

### 헤더와 명세를 나눴습니다

거래 하나는 두 종류의 정보를 담습니다. "누가 왜 얼마를 움직였나"(헤더)와 "그 결과 어느 덩어리가 어떻게 변했나"(명세)예요.

둘을 한 테이블에 넣으면 거래 하나가 여러 lot에 걸칠 때 헤더 정보가 중복됩니다. 300P 차감이 lot 두 개에 걸치면 사유와 회원 정보가 두 번 저장돼요. 그래서 나눴습니다.

```java
@Entity
@Table(name = "hama_point_transaction")
public class PointTransactionEntity {
    @Column(name = "pt_delta_point", nullable = false)
    private Integer ptDeltaPoint;

    @Column(name = "pt_paid_balance", nullable = false)
    private Integer ptPaidBalance;

    @Column(name = "pt_free_balance", nullable = false)
    private Integer ptFreeBalance;
```

`delta`(변동량)와 `balance`(직후 잔액)를 **둘 다** 저장합니다. 하나면 나머지를 계산할 수 있는데도요.

이건 의도적인 중복입니다. delta만 있으면 "3월 5일 시점 잔액"을 알기 위해 그 이전 모든 행을 더해야 해요. 내역 화면에서 각 줄마다 "이때 잔액이 얼마였는지"를 보여주려면 매번 누적합이 필요합니다. balance를 같이 박아두면 그 행만 읽으면 돼요.

대신 **잔액의 정본은 balance 컬럼이 아닙니다.** 진짜 잔액은 lot 명세를 합산해서 구해요. 헤더의 balance는 그 시점의 표시용 스냅샷입니다. 만료로 인해 잔액이 줄어드는 건 거래 없이 일어나니까, 시간이 지나면 마지막 행의 balance와 실제 잔액이 달라집니다. 정본을 명세 쪽에 둔 이유예요.

### 사유를 두 단계로 나눴습니다

사유 하나로 시작했는데 요구가 갈렸습니다. 어드민은 "충전/차감/환불" 같은 큰 분류로 필터링하고 싶어하고, 사용자는 "영상대화에 썼다" 같은 구체적인 활동명을 보고 싶어해요.

```java
/**
 * 포인트 상세 거래 사유(PTR). 사용자에게 노출되는 구체적 활동명(영상대화/AI 파트너/채팅 등)을 담당하고,
 * TransactionReasonEntity(TR)는 어드민 필터·상위 분류를 그대로 유지한다. PTR 하나는 TR 하나에 속한다.
 */
```

한 테이블에 두 요구를 넣으면 어드민 필터가 수십 개로 늘어나거나, 사용자 화면에 "deduct"라고 뜹니다. 나누니 각자 자기 축으로 커질 수 있게 됐어요.

그리고 조합이 어긋나는 걸 막습니다.

```java
/**
 * ptrCode는 (ptr_owner_service, ptr_code) 조합으로만 유일하다 — 호출 서비스 전용 행을 우선 찾고,
 * 없으면 ALL 공용 행을 쓴다. 찾은 PTR의 상위 TR이 이 거래에서 실제로 쓰는 trIdx와 다르면(잘못된 조합)
 * 못 찾은 것으로 처리한다.
 */
private PointTransactionReasonEntity resolvePtr(String ptrCode, PtSourceApp sourceApp, Long expectedTrIdx) {
    OwnerService serviceOwner = OwnerService.valueOf(sourceApp.name());
    PointTransactionReasonEntity ptr = pointTransactionReasonRepository
            .findByPtrOwnerServiceAndPtrCode(serviceOwner, ptrCode)
            .or(() -> pointTransactionReasonRepository.findByPtrOwnerServiceAndPtrCode(OwnerService.ALL, ptrCode))
            .orElseThrow(() -> new CustomException(ErrorCode.POINT_TRANSACTION_REASON_NOT_FOUND));
    if (!ptr.getTrIdx().equals(expectedTrIdx)) {
        throw new CustomException(ErrorCode.POINT_TRANSACTION_REASON_NOT_FOUND);
    }
    return ptr;
}
```

"충전(TR)인데 상세 사유는 영상대화(PTR)"처럼 앞뒤가 안 맞는 조합을 거절해요. 원장에 들어간 뒤에는 고칠 수 없으니 들어가기 전에 막아야 합니다.

### 참조 대신 스냅샷을 박습니다

여기가 원장 설계의 핵심입니다. **참조는 미래에 바뀌고, 원장은 과거를 고정해야** 해요.

```java
/** 거래 당시 PTR 제목 스냅샷. PTR 제목이 나중에 바뀌거나 비활성화돼도 과거 이력은 당시 표기를 유지한다. */
@Column(name = "pt_ptr_name_snapshot", nullable = false)
private String ptPtrNameSnapshot;

@Column(name = "pt_ptr_name_en_snapshot", nullable = false)
private String ptPtrNameEnSnapshot;
```

사유 이름을 FK로만 들고 있으면, "영상대화"를 "화상통화"로 이름 바꾸는 순간 **작년 내역까지 전부 바뀝니다.** 사용자가 작년에 본 화면과 지금 보는 화면이 달라져요. 그래서 `ptr_idx`(추적용)와 이름 스냅샷(표시용)을 같이 저장합니다.

닉네임과 식별자도 같습니다.

```java
/** 거래 당시 닉네임 스냅샷. 호출 서비스가 제공(통합 DB에 원천 없음) — 코쌤/과거행은 null. */
@Column(name = "pt_nickname")
private String ptNickname;

/** 거래 당시 회원 식별자 스냅샷(이메일회원=mb_id, 구글/카카오=ac_provider_uid, 애플=ac_apple_sub).
 *  insert 시점 박제 — 과거행은 마이그레이션 백필, 없으면 null. */
@Column(name = "pt_email")
private String ptEmail;
```

닉네임은 아예 **통합 DB에 원천이 없습니다.** 서비스 서버가 갖고 있어요. 조회할 때마다 서비스 서버에 물어볼 수는 없으니 거래 시점에 받아서 박아둡니다.

이 스냅샷이 어드민 조회 구조까지 바꿨어요.

```java
// 닉네임/이메일은 이제 거래 시점 스냅샷 컬럼(pt_nickname/pt_email)에서 필터·표시한다.
// (과거 행 이메일은 마이그레이션 백필로 채워져 있어 기존 email→mbNo 2단계 조회는 제거)
```

전에는 이메일로 검색하려면 회원 테이블에서 `mbNo`를 찾고 그걸로 원장을 뒤지는 2단계였습니다. 탈퇴한 회원은 검색이 안 됐어요. 스냅샷을 넣고 나서는 원장 한 테이블만 보면 됩니다.

### 회원 FK를 두지 않았습니다

원장 어디에도 회원 테이블로 향하는 FK가 없습니다. `mb_no`는 그냥 숫자예요. 이게 탈퇴 처리를 가능하게 합니다.

```java
// 탈퇴 전부 파기(회원 행 하드 삭제, 탈퇴+30일) 후에도 스토어 환불이 들어올 수 있다 — 원장은
// 회원 FK가 없어 5년 보관되므로, 회원 행이 없어도 환불 이벤트를 원장에 기록한다.
// 있으면 잠그고, 없으면 그대로 진행한다(KTALK-133).
memberService.lockByIdIfPresent(mbNo);
```

`lockByIdIfPresent`라는 이름에 상황이 다 들어 있어요. 충전에서는 `getByIdForUpdate`로 **반드시** 회원을 잠그지만, 환불에서는 없어도 진행합니다. 탈퇴 후에도 스토어 환불은 들어오니까요.

돈이 오간 기록은 회원이 사라졌다고 없앨 수 없습니다. FK를 뺀 건 편의가 아니라 요건이었어요.

### 생성 경로마다 정적 팩토리를 나눴습니다

거래를 만드는 방법이 네 가지입니다. 빌더를 그대로 노출하지 않고 각각 메서드를 뒀어요.

```java
public static PointTransactionEntity createCharge(...)
public static PointTransactionEntity createRefundDeduct(...)
public static PointTransactionEntity createPolicyAdjustment(...)
public static PointTransactionEntity createAdminAdjustment(...)
```

경로마다 채워야 하는 컬럼이 달라서입니다. 어드민 조정만 `adminNote`와 `adminId`가 필수고, 정책 지급만 `ppIdx`를 갖고, 결제/환불만 `pmrIdx`를 나중에 채웁니다. 빌더를 열어두면 어떤 조합이든 만들 수 있어서 어드민 메모 없는 어드민 조정 같은 게 생겨요.

부호도 여기서 고정합니다. `createRefundDeduct`는 인자로 양수를 받아 `-recallPoint`로 저장해요. 호출부가 부호를 헷갈릴 여지를 없앴습니다.

### 멱등의 소유권을 명시했습니다

원장에도 멱등키 컬럼이 있는데 결제에서는 안 씁니다.

```java
// 정책/어드민 지급·차감 전용 재시도 방지 키. 결제/환불은 hama_payment_record가 멱등을
// 단독 소유하므로 이 컬럼은 NULL로 남긴다.
@Column(name = "pt_idempotency_key")
private String ptIdempotencyKey;
```

결제는 결제 기록 테이블이 판정하고, 정책 지급이나 어드민 조정처럼 결제 기록이 없는 거래만 이 컬럼을 씁니다. 판정 주체가 둘이면 어긋날 때 어느 쪽이 옳은지 알 수 없어요.

두 테이블이 서로를 가리키는 것도 그래서입니다.

```java
// 결제_기록(pmr)은 이 거래의 ptIdx를 참조해야 생성되므로, pmr을 먼저 만든 뒤 그 id를
// 여기로 되돌려 링크한다(Setter 대신 의도를 드러내는 도메인 메서드).
public void linkPaymentRecord(Long pmrIdx) {
    this.pmrIdx = pmrIdx;
}
```

원장을 먼저 쓰고, 결제 기록이 그걸 가리키고, 마지막에 원장이 결제 기록을 되가리킵니다. 순환이라 한 번에 못 만들어요. 이 어색함을 감추지 않고 `linkPaymentRecord`라는 이름으로 드러냈습니다.

## [남은 문제]

**첫째, 헤더의 잔액 스냅샷이 시간이 지나면 실제와 어긋납니다.** 만료는 거래 없이 일어나니까요. 표시용이라고 정해뒀지만, 이 컬럼을 정본으로 오해하고 쓰는 코드가 언젠가 생길 것 같아요. 이름을 `pt_paid_balance_at_tx`처럼 바꾸는 게 나았을지도 모르겠습니다.

**둘째, 스냅샷 컬럼이 늘어나는 걸 막을 기준이 없습니다.** 지금은 사유 이름·닉네임·식별자인데, "그때 어느 화면에서 썼는지도 필요하다"는 요구가 오면 또 늘어나요. 어디까지 박을지에 대한 원칙이 아직 없습니다.

**셋째, 원장 조회에 페이징 정렬 제약이 있습니다.** 정렬 가능한 컬럼을 `createdAt`과 `ptIdx` 둘로 막아뒀어요. 임의 컬럼 정렬을 허용하면 인덱스 없는 정렬이 나가서 막은 건데, 어드민 요구가 늘면 인덱스를 같이 늘려야 합니다.

**넷째, 사유 코드를 enum으로 변환하지 않고 문자열로 반환하는 부분이 있습니다.**

```java
/**
 * 거래 사유는 원장에 저장된 코드가 정본이다. 이력 조회에서 과거/신규 코드를 enum으로 강제 변환하면
 * 배포 순서나 레거시 데이터 때문에 전체 이력 조회가 실패할 수 있으므로 문자열 그대로 반환한다.
 */
```

배포 중에 새 코드가 들어온 행을 구버전 서버가 읽으면 enum 변환에서 터집니다. 조회 하나 때문에 전체 이력 화면이 깨지는 게 더 나쁘다고 판단해서 문자열로 뒀어요. 타입 안전성을 포기한 거라 마음에 걸리는 선택입니다.

## [결론]

컬럼 하나로 시작할 수 있었던 게 테이블 다섯 개가 됐습니다. 늘어난 이유를 정리하면 이렇게 됩니다.

| 무엇 | 왜 필요했나 |
| --- | --- |
| 변동을 저장 (원장) | "왜 이 잔액인가"에 답해야 한다 |
| 헤더 / 명세 분리 | 거래 하나가 여러 lot에 걸친다 |
| 사유 2단계 (TR / PTR) | 어드민 필터와 사용자 표기의 축이 다르다 |
| 이름·닉네임·식별자 스냅샷 | 참조는 바뀌고 과거는 고정돼야 한다 |
| 회원 FK 제거 | 탈퇴해도 5년 보관해야 한다 |
| 멱등 소유권 분리 | 판정 주체가 둘이면 어긋날 때 답이 없다 |

전부 "지금 필요해서"가 아니라 **"나중에 되돌릴 수 없어서"** 넣은 것들입니다. 잔액 컬럼 하나로 6개월 굴린 뒤에 원장으로 바꾸려면 과거 데이터를 복원할 방법이 없어요. 스냅샷도 마찬가지로, 안 박아두면 그 시점 값은 영영 사라집니다.

재화 도메인에서 배운 게 이 지점입니다. 대부분의 설계 결정은 나중에 고칠 수 있는데, **기록하지 않은 과거만은 고칠 수 없어요.** 그래서 여기서만큼은 "일단 단순하게 가고 나중에 필요하면 늘리자"가 통하지 않았습니다.
