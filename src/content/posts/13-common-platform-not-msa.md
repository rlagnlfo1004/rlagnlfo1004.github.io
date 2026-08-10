---
title: "이거 MSA인가요? — 공통 지갑 서버와 서비스 서버의 경계 긋기"
description: "서비스 두 개가 하나의 공통 플랫폼 서버를 씁니다. 공유 DB에서 HTTP로 옮기며 무엇을 누가 소유할지 정한 기준과, 이 구조를 MSA라 부르기 어려운 이유."
date: 2026-08-07
project: "케이톡"
tags: ["MSA", "아키텍처", "분산 트랜잭션", "Spring", "JWT"]
---

## [배경 - 서버가 셋인데 DB는 몇 개여야 하나]

하마그룹에는 케이톡과 코리안쌤이라는 서비스가 있습니다. 둘은 다른 앱이고 다른 사용자층을 가지지만, 회원 체계와 재화(K포인트)를 공유해요. 코리안쌤에서 충전한 포인트를 케이톡에서 쓸 수 있습니다.

그래서 서버가 셋입니다.

- `ktalk-java-api` — 케이톡 서비스 서버
- `koreanssam-java-api` — 코리안쌤 서비스 서버
- `peopleandtalk-java-integration` — 공통 플랫폼 서버

공통 서버의 역할은 프로젝트 문서 첫 줄에 적혀 있어요.

> peopleandtalk-java-integration is the common platform server shared by the K-talk and KoreanSSam services. It owns authentication, membership, account linking, and the points/paid-currency wallet, and is called internally by each service's own backend server (never directly by their clients).

인증, 회원, 계정 연동, 포인트 지갑을 소유하고, **각 서비스의 백엔드 서버가 내부 호출로만** 부릅니다. 클라이언트는 공통 서버의 존재를 모릅니다.

<svg class="diagram" viewBox="0 0 720 372" role="img" aria-label="서비스 서버 두 개와 공통 플랫폼 서버의 구조">
  <defs>
    <marker id="ar-msa" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">클라이언트는 공통 서버를 모른다</text>
  <rect x="40" y="28" width="240" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="160" y="47" font-size="11.5" text-anchor="middle" fill="var(--ink-2, #63605A)">케이톡 앱</text>
  <rect x="440" y="28" width="240" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="560" y="47" font-size="11.5" text-anchor="middle" fill="var(--ink-2, #63605A)">코리안쌤 앱</text>
  <line x1="160" y1="58" x2="160" y2="84" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-msa)"/>
  <line x1="560" y1="58" x2="560" y2="84" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-msa)"/>
  <rect x="20" y="88" width="280" height="96" rx="8" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="38" y="110" font-size="12" font-weight="700" fill="var(--clay, #BF5F3B)">케이톡 서버</text>
  <text x="38" y="130" font-size="11" fill="var(--ink-2, #63605A)">영수증 검증 · 상품 · 결제 원본</text>
  <text x="38" y="147" font-size="11" fill="var(--ink-2, #63605A)">과금 정책 · 스토어 웹훅 수신</text>
  <rect x="38" y="156" width="244" height="20" rx="4" fill="var(--sunk, #F1EDE3)"/>
  <text x="48" y="170" font-size="10.5" fill="var(--ink-3, #9A958B)">케이톡 DB (서비스 단독 소유)</text>
  <rect x="420" y="88" width="280" height="96" rx="8" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="438" y="110" font-size="12" font-weight="700" fill="var(--ink-2, #63605A)">코리안쌤 서버</text>
  <text x="438" y="130" font-size="11" fill="var(--ink-2, #63605A)">자기 도메인 · 자기 정책</text>
  <text x="438" y="147" font-size="11" fill="var(--ink-2, #63605A)">같은 계약으로 지갑을 부른다</text>
  <rect x="438" y="156" width="244" height="20" rx="4" fill="var(--sunk, #F1EDE3)"/>
  <text x="448" y="170" font-size="10.5" fill="var(--ink-3, #9A958B)">코리안쌤 DB (서비스 단독 소유)</text>
  <path d="M160 184 L160 214 Q160 224 175 224 L330 224" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-msa)"/>
  <path d="M560 184 L560 214 Q560 224 545 224 L390 224" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-msa)"/>
  <text x="360" y="215" font-size="10.5" text-anchor="middle" fill="var(--ink-3, #9A958B)">HTTP · X-Service-Auth</text>
  <rect x="130" y="240" width="460" height="98" rx="8" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="150" y="262" font-size="12" font-weight="700" fill="var(--clay, #BF5F3B)">공통 플랫폼 서버</text>
  <text x="150" y="282" font-size="11" fill="var(--ink-2, #63605A)">인증 · 회원 · 계정 연동</text>
  <text x="150" y="299" font-size="11" fill="var(--ink-2, #63605A)">포인트 원장 · 결제 기록 (재화의 정본)</text>
  <rect x="150" y="308" width="420" height="20" rx="4" fill="var(--sunk, #F1EDE3)"/>
  <text x="160" y="322" font-size="10.5" fill="var(--ink-3, #9A958B)">통합 DB · 서비스 서버만 접근한다</text>
  <line x1="0" y1="352" x2="720" y2="352" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="368" font-size="11" fill="var(--ink-3, #9A958B)">DB 사이에 FK 가 없다. 서비스 DB 의 mb_no 는 통합 DB 를 가리키는 논리 참조일 뿐이다.</text>
</svg>

## [문제 상황 분석 - 공유 DB에서 출발했습니다]

지금은 서비스마다 DB를 갖지만, 처음부터 그랬던 건 아닙니다. 흔적이 코드에 남아 있어요.

```java
/**
 * 프로필/약관동의 등 케이톡DB 도메인의 엔티티/리포지토리를 담당한다. (...)
 * 데이터소스가 하나뿐이라 @Primary가 없어도 타입 주입이 되지만,
 * 데이터소스가 다시 늘어날 때 어느 쪽이 기본인지 헷갈리지 않도록 명시해 둔다.
 */
```

"데이터소스가 **다시** 늘어날 때"라는 표현이 과거를 알려줍니다. 케이톡 서버는 한때 자기 DB와 통합 DB를 동시에 붙들고 있었어요. 하나의 애플리케이션이 두 데이터소스를 갖고 남의 테이블을 직접 읽고 썼습니다.

편했습니다. 조인 한 번이면 회원 정보와 결제 내역을 같이 가져올 수 있었고, 트랜잭션 하나로 둘 다 커밋할 수 있었어요.

문제는 소유권이었습니다. 결제 내역 테이블을 공통 서버가 갖고 있었는데, 실제로 그 테이블의 스키마를 바꾸고 싶어하는 쪽은 항상 케이톡이었어요. 스토어별 상세, 상품 스냅샷, 환불 회차 같은 건 전부 서비스 사정이니까요. 그런데 테이블 주인은 공통 서버라 변경마다 조율이 필요했습니다.

그래서 이관했어요.

```java
/**
 * 결제 내역(서비스 소유, 충전 원본). 공통 지갑 서버가 소유하던 hama_order_history를 서비스로 이관한다
 * (docs/payment-refund-handling.md §3.1).
 * 5년 보관/상사시효(expireAt)의 기준 행이며, OS별 상세(OrderGoogle/OrderApple)와 1:1,
 * 환불 회차(RefundGoogle/RefundApple)와 1:N이다.
 */
```

## [해결 방법 - 무엇을 누가 소유할지 정하기]

이관하면서 세운 기준은 하나였습니다. **"이 데이터가 바뀔 때 누가 요구하는가."**

| 데이터 | 소유 | 이유 |
| --- | --- | --- |
| 결제 원본, 스토어별 상세, 환불 회차 | 서비스 | 스토어·상품·영수증은 서비스 사정이다 |
| 상품(가격, 스토어 코드) | 서비스 | 서비스마다 상품 구성이 다르다 |
| 과금 정책 | 서비스 | 정책은 서비스 기능에 붙어 바뀐다 |
| 포인트 원장, 잔액 | 공통 | 두 서비스가 같은 지갑을 본다 |
| 결제 기록(멱등 판정) | 공통 | 판정 주체가 하나여야 한다 |
| 회원, 인증, 계정 연동 | 공통 | 계정이 서비스 간 연결점이다 |

경계가 선명해지자 공통 서버가 몰라도 되는 게 늘었습니다. 정책이 대표적이에요.

```java
/**
 * 정책 기반 지급/차감의 사유(tr_code)·정책 참조(ppIdx)는 호출 서비스가 정해서 넘긴다
 * (자기 정책 테이블을 각자 소유하는 구조라 이 서버는 더 이상 정책을 모른다).
 * ppIdx는 검증 없이 그대로 저장하는 논리 FK다.
 */
@Transactional
public PointTransactionEntity applyPolicyAmount(
        Long mbNo, Long ppIdx, String trCode, String ptrCode, int amount,
        String idempotencyKey, PtSourceApp sourceApp, PointUserSnapshot snapshot) {
```

"이 서버는 더 이상 정책을 모른다"가 핵심입니다. 공통 서버는 **얼마를 왜 움직였는지 기록만** 하고, 얼마여야 하는지는 판단하지 않아요. `ppIdx`는 검증 없이 그대로 저장하는 추적용 값입니다.

대신 사유 코드에는 소유 서비스를 붙였어요.

```java
/** 이 사유를 쓸 수 있는 서비스; ALL이면 모든 서비스가 공용으로 쓴다. */
@Column(name = "tr_owner_service", nullable = false)
@Enumerated(EnumType.STRING)
private OwnerService trOwnerService;

public enum OwnerService { KTALK, KOREANSSAM, ALL }
```

케이톡이 코리안쌤 전용 사유로 거래를 만들려 하면 "없는 사유"로 거절됩니다.

```java
/** tr_code는 전역 유일하다. 소유 서비스가 호출 서비스와 다르고 ALL도 아니면 이 서비스 것이 아니므로 못 찾은 것으로 처리한다. */
private Long resolveTrIdx(String trCode, PtSourceApp sourceApp) {
    TransactionReasonEntity reason = transactionReasonRepository.findByTrCode(trCode)
            .orElseThrow(() -> new CustomException(ErrorCode.POINT_TRANSACTION_REASON_NOT_FOUND));
    TransactionReasonEntity.OwnerService owner = reason.getTrOwnerService();
    boolean usableByService = owner == TransactionReasonEntity.OwnerService.ALL
            || owner == TransactionReasonEntity.OwnerService.valueOf(sourceApp.name());
    if (!usableByService) {
        throw new CustomException(ErrorCode.POINT_TRANSACTION_REASON_NOT_FOUND);
    }
    return reason.getTrIdx();
}
```

서비스별 격리를 애플리케이션 레벨 규칙이 아니라 **데이터 모델 자체**에 넣은 셈이에요.

### 호출 계약을 세 가지로 나눴습니다

공통 서버를 부를 때 "누구 자격으로 부르는가"가 매번 달랐습니다. 처음에는 AOP로 토큰을 자동 전파하려 했는데, 그러다 사고가 날 것 같아서 명시적으로 골라 쓰게 바꿨어요.

```java
/**
 * 공통 서버 요청의 인증 헤더를 계약별로 조립한다.
 *
 * <p>토큰 종류가 URL과 body의 대상 회원 출처까지 바꾸므로, AOP로 암묵 전파하지 않고 HTTP client가
 * 이 세 메서드 중 하나를 명시적으로 선택한다. 이로써 source-only 요청에 Authorization 또는 sub가
 * 섞이는 실수를 막는다.</p>
 */
@Component
public class CommonServerRequestAuth {

    public static final String SERVICE_AUTH_HEADER = "X-Service-Auth";

    /** 회원 Authorization을 그대로 전달하고, 동일 회원을 sub로 한 서비스 JWT를 추가한다. */
    public void applyUserDelegation(HttpHeaders headers, Long mbNo) { ... }

    /** Authorization/sub/role이 없는 서버 작업 전용 서비스 JWT만 추가한다. */
    public void applySourceOnly(HttpHeaders headers) { ... }
}
```

토큰 종류가 URL까지 바꿉니다. 사용자 위임이면 `/api/v1/point/charge`, 서버 작업이면 `/api/v1/internal/point/charge`예요. 대상 회원을 어디서 읽느냐가 달라지기 때문입니다. 위임 호출은 `Authorization`의 주체에서, 내부 호출은 body의 `mbNo`에서 읽어요.

환불 쪽 선택이 이 구분의 의미를 잘 보여줍니다.

```java
/**
 * refund는 다르다 — 호출자가 Apple/Google 웹훅 또는 어드민 GPC 반영뿐이고 회원 본인이 직접
 * 트리거하는 경로가 없으므로, 현재 요청에 Authorization이 있어도(예: 어드민 자신의 토큰)
 * 그건 절대 대상 회원의 위임 토큰이 아니다 — 그래서 refund는 분기 없이 항상 source-only
 * internal endpoint만 쓴다(대상 회원은 body의 mbNo로 넘긴다).
 */
```

어드민이 환불을 반영할 때 어드민의 토큰이 요청에 실려 있습니다. 이걸 무심코 전달하면 공통 서버는 "어드민 계정의 포인트를 차감하라"로 읽어요. 그래서 환불은 아예 분기를 없애고 항상 내부 엔드포인트만 씁니다.

### 분산 트랜잭션은 안 씁니다

충전 한 번에 DB 두 개가 바뀝니다. 케이톡 DB에 주문이 들어가고, 통합 DB에 원장이 들어가요. 둘을 하나의 트랜잭션으로 묶고 싶은 유혹이 있지만, 2PC는 도입하지 않았습니다.

대신 **순서를 정하고 뒤를 멱등하게** 만들었어요.

<svg class="diagram" viewBox="0 0 720 268" role="img" aria-label="분산 트랜잭션 없이 두 DB 를 맞추는 순서">
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">DB 두 개를 2PC 없이 맞추는 방법</text>
  <rect x="0" y="30" width="336" height="86" rx="8" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="18" y="52" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">1 · 케이톡 DB · 주문 커밋</text>
  <text x="18" y="72" font-size="11" fill="var(--ink-2, #63605A)">멱등키와 함께 주문 원본을 먼저 확정한다.</text>
  <text x="18" y="89" font-size="11" fill="var(--ink-2, #63605A)">원장 참조 컬럼은 아직 비어 있다.</text>
  <text x="18" y="106" font-size="10.5" fill="var(--ink-3, #9A958B)">여기서 죽으면 → 3 번이 주워간다</text>
  <rect x="384" y="30" width="336" height="86" rx="8" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="402" y="52" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">2 · 통합 DB · 원장 커밋</text>
  <text x="402" y="72" font-size="11" fill="var(--ink-2, #63605A)">같은 멱등키로 호출한다. 이미 있으면</text>
  <text x="402" y="89" font-size="11" fill="var(--ink-2, #63605A)">기존 결과를 그대로 재생해 돌려준다.</text>
  <text x="402" y="106" font-size="10.5" fill="var(--ink-3, #9A958B)">응답이 유실돼도 → 3 번이 주워간다</text>
  <rect x="0" y="134" width="720" height="86" rx="8" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="18" y="156" font-size="11.5" font-weight="700" fill="var(--clay, #BF5F3B)">3 · 복구 스케줄러 · 두 DB 를 맞춘다</text>
  <text x="18" y="176" font-size="11" fill="var(--ink-2, #63605A)">원장 참조가 비어 있는 주문을 주기 스캔해 같은 멱등키로 다시 호출한다.</text>
  <text x="18" y="193" font-size="11" fill="var(--ink-2, #63605A)">이미 반영된 건이 섞여도 멱등 재생이라 이중 적립이 없다.</text>
  <text x="18" y="210" font-size="10.5" fill="var(--ink-3, #9A958B)">최종적 일관성 — 잠깐 어긋나지만 반드시 수렴한다</text>
  <text x="0" y="244" font-size="11" fill="var(--ink-3, #9A958B)">2PC 를 쓰지 않은 대가: 두 DB 가 어긋나 있는 구간이 존재한다.</text>
  <text x="0" y="262" font-size="11" fill="var(--ink-3, #9A958B)">그 대신 공통 서버 장애가 서비스 서버의 트랜잭션을 잡아두지 않는다.</text>
</svg>

주문을 먼저 커밋하는 순서가 중요합니다. 반대로 하면 원장은 들어갔는데 주문이 없는 상태가 생기고, 그건 **스캔으로 찾을 방법이 없어요.** 주문이 먼저 있으면 "원장 참조가 빈 주문"이라는 단서가 남습니다.

## [그래서 MSA인가]

솔직히 아니라고 생각합니다. 몇 가지는 MSA 교과서와 맞지만 결정적인 게 어긋나요.

**맞는 것.** 서비스마다 DB를 단독 소유하고, DB 간 FK가 없고, 통신은 HTTP로만 하고, 서비스 경계에서 인증을 다시 합니다. 공통 서버가 죽어도 케이톡의 다른 기능은 살아 있어요.

**어긋나는 것.** 마이크로서비스는 보통 **비즈니스 능력 단위**로 쪼개고, 서비스끼리는 대등합니다. 여기는 그렇지 않아요.

첫째, 공통 서버가 **계층**입니다. 케이톡과 코리안쌤이 나란히 있고 그 아래에 플랫폼이 깔린 모양이에요. 서비스 간 호출이 아니라 위아래 호출입니다.

둘째, 공통 서버가 **단일 장애점**에 가깝습니다. 인증과 회원이 거기 있으니 죽으면 로그인부터 막혀요. 마이크로서비스에서 흔히 말하는 "부분 장애 격리"가 인증 계층에서는 성립하지 않습니다.

셋째, 서비스가 **둘뿐이고 앞으로도 크게 늘 것 같지 않습니다.** MSA가 값을 하는 건 팀과 배포 단위가 많아질 때인데, 이 규모에서는 그 이득이 크지 않아요.

정확히 부르자면 **"공유 플랫폼 + 서비스 서버"** 구조입니다. 모놀리스도 MSA도 아니고 그 사이 어딘가예요. 회원과 재화를 서비스별로 복제할 수 없다는 제약에서 자연스럽게 나온 모양이라고 생각합니다.

그리고 이 구조에는 정해진 이름의 위험이 있어요. **분산 모놀리스**입니다. 서비스는 나뉘었는데 배포는 같이 해야 하는 상태요. 실제로 겪었습니다. 결제 API 하나를 바꾸려면 공통 서버와 케이톡 서버를 순서 맞춰 올려야 하고, 그동안 계약이 어긋나는 구간이 생겨요. 지금은 서로 모르는 필드를 무시하도록 맞춰 완화하고 있는데, 근본 해결은 아닙니다.

## [남은 문제]

**첫째, 서비스가 늘어날 때 사유 코드가 감당이 될지 모르겠습니다.** 지금 `tr_owner_service`에 존재하는 행은 전부 케이톡 소유예요. 코리안쌤이 자기 사유를 본격적으로 쓰기 시작하면 공용(ALL)과 전용의 경계를 다시 그어야 할 겁니다.

**둘째, 서비스 서버가 늘어날수록 인증 계약이 복잡해집니다.** 지금도 위임·조건부 위임·서버 전용 세 가지인데, AI 위임 과금 같은 특수 경로가 생길 때마다 하나씩 늘어요. 계약을 문서가 아니라 타입으로 강제하는 방법을 찾고 싶은데 아직 못 찾았습니다.

**셋째, 최종적 일관성의 지연을 측정하지 않았습니다.** 복구 스케줄러가 몇 분 주기로 도는지가 곧 "어긋난 채로 있는 최대 시간"인데, 실제로 얼마나 어긋나는지는 재본 적이 없어요. 미반영 건수와 복구까지 걸린 시간을 지표로 뽑는 게 다음 과제입니다.

## [결론]

"MSA인가요"라는 질문을 받았을 때 바로 답을 못 했습니다. 서비스마다 DB가 따로 있고 HTTP로 부르니 MSA 같은데, 공통 서버가 없으면 아무것도 안 되니 아닌 것 같기도 했어요.

정리하고 나서 생각이 바뀐 건, **이름을 정하는 게 별로 중요하지 않다**는 점이었습니다. 중요한 건 경계를 어디에 긋고 그 경계에서 무엇을 보장하느냐였어요. 이번에 실제로 정한 건 세 가지입니다.

1. **소유권은 "누가 변경을 요구하는가"로 정한다.** 결제 원본을 서비스로 옮긴 근거가 이거였습니다.
2. **경계를 넘을 때 자격을 명시한다.** 토큰 전파를 자동화하지 않고 세 계약 중 하나를 고르게 했어요.
3. **분산 트랜잭션 대신 순서 + 멱등 + 복구를 쓴다.** 대가는 최종적 일관성이고, 얻은 것은 서비스 서버가 공통 서버 장애에 물려 있지 않다는 점입니다.

이 세 가지가 서 있으면 MSA라 부르든 아니든 굴러갑니다. 반대로 이게 없으면 서비스를 아무리 잘게 쪼개도 분산 모놀리스가 되고요. 이름보다 경계가 먼저라는 게 이번에 배운 것입니다.
