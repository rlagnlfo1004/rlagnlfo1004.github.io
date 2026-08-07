---
title: "목록 응답 DTO 47개에 필드를 넣었는데 조회 코드는 115줄만 바뀌었습니다 (QueryDSL Projections.fields)"
description: "35만 줄짜리 관리자 API의 목록 응답 전체에 회원 필드를 일괄 추가했습니다. 조회 계층이 거의 흔들리지 않은 이유와, Projections.fields 가 조용히 넘기는 실수를 직접 실행해서 확인했어요."
date: 2026-08-07
project: "레인보우TV"
tags: ["QueryDSL", "JPA", "DTO 프로젝션", "리팩터링"]
---

## [배경 - 목록 API 전체에 같은 필드 세 개를 넣어야 했다]

운영팀에서 요청이 하나 내려왔습니다. 관리자 화면의 목록 조회와 엑셀 다운로드에 회원의 R고객번호, SO, 지역을 같이 보여달라는 요청이었어요.

한 화면이 아니었습니다. 회원 목록, 결제 목록, 환불 목록, 포인트 목록, 경품 교환 내역, 문의 목록, 파트너 게시판, 이웃파트너, 가입경로, 구독 공지 확인까지 목록이 있는 화면은 거의 전부였습니다.

먼저 프로젝트 규모를 재봤습니다.

```bash
$ find src/main/java -name "*.java" | wc -l
    4463
$ find src/main/java -name "*.java" -exec cat {} + | wc -l
  353217
$ find src/main/java -name "*CustomRepositoryImpl.java" | wc -l
     129
```

Java 파일 4,463개에 35만 줄, QueryDSL 커스텀 리포지토리 구현체가 129개입니다. 목록 API마다 조회 쿼리가 따로 있는 구조입니다.

솔직히 처음에는 겁이 났습니다. 목록 조회를 엔티티로 가져와서 서비스에서 DTO로 옮기는 구조였다면, 필드 하나 추가할 때마다 연관관계를 타고 들어가는 코드를 47곳에 심어야 했을 테니까요. 회원 정보를 추가로 조회하는 쿼리가 목록마다 늘어나는 것도 걱정이었어요.

그런데 열어보니 조회 코드는 이미 전부 DTO 프로젝션으로 되어 있었습니다.

```bash
$ grep -rno "Projections\.\(fields\|constructor\|bean\|tuple\)" --include="*.java" src/main/java | wc -l
     610
```

610곳입니다. 그리고 이 구조 덕분에 실제로 바뀐 조회 코드는 115줄이었어요. 그 이야기를 적어볼게요.

## [문제 상황 분석 - Projections 세 가지는 무엇을 기준으로 값을 넣는가]

QueryDSL 의 `Projections` 에는 팩터리 메서드가 여러 개 있습니다. 이름이 비슷해서 아무거나 써도 되는 것처럼 보이지만, **값을 DTO에 넣는 기준이 서로 다릅니다.**

저장소에서 실제로 쓰이는 비율을 먼저 세봤습니다.

```bash
$ grep -rn "Projections\." --include="*.java" src/main/java \
    | sed 's/.*Projections\.\([a-zA-Z]*\).*/\1/' | sort | uniq -c | sort -rn
 408 fields
 141 constructor
  60 bean
   1 tuple
```

### Projections.constructor 는 위치로 넣습니다

생성자 인자 순서대로 값을 채웁니다. 첫 번째 표현식이 첫 번째 파라미터로, 두 번째가 두 번째로 들어가요.

컴파일러가 검증해줄 것 같지만 아닙니다. `Projections.constructor(Dto.class, ...)` 의 인자는 그냥 `Expression<?>` 가변인자라서, 생성자와 맞는지는 **쿼리를 만드는 시점에 리플렉션으로** 확인해요.

저장소 커밋 이력에도 이 문제로 고친 흔적이 있었습니다. DTO에 필드를 하나 추가했는데 `Projections.constructor` 쪽을 같이 안 고쳐서 터진 건이었어요.

### Projections.fields 는 이름으로 넣습니다

DTO의 필드명과 표현식의 별칭을 맞춰서 값을 넣습니다. 순서는 상관없어요. setter 도 필요 없고 필드에 직접 리플렉션으로 씁니다.

이름이 안 맞으면 `as()` 로 별칭을 붙여줍니다. 저장소에도 이런 코드가 있어요.

```java
orderEntity.createdAt.as("orderCreatedAt")
```

엔티티 필드는 `createdAt` 인데 응답 DTO 필드는 `orderCreatedAt` 이라서 별칭을 붙인 경우입니다.

중첩 경로일 때는 **맨 끝 이름만 봅니다.** 이 부분은 헷갈려서 직접 확인했어요.

```java
PathBuilder<Object> memberInfo = new PathBuilder<>(Object.class, "memberInfoEntity");
var nested = memberInfo.get("soDefine").getString("sdName");

System.out.println("경로 전체 = " + nested);
System.out.println("리프 이름 = " + nested.getMetadata().getName());
```

```
경로 전체 = memberInfoEntity.soDefine.sdName
리프 이름 = sdName
바인딩 결과 = sdName=대전
```

`memberInfoEntity.soDefine.sdName` 을 그대로 넣으면 DTO의 `sdName` 필드에 들어갑니다. `soDefine` 은 무시돼요. 그래서 저장소 코드가 조인 없이 연관 경로를 바로 select 에 넣을 수 있었던 겁니다.

### Projections.bean 은 setter 로 넣습니다

이름으로 찾는 것은 `fields` 와 같지만 setter 를 호출합니다. setter 가 없으면 값이 안 들어가요. 저장소에서 60곳 쓰이고 있는데 `fields` 와 섞여 있어서 구분 기준은 찾지 못했습니다.

## [실측 - 필드가 늘거나 순서가 바뀌면 어떻게 되는가]

세 방식이 "DTO가 변했는데 쿼리를 안 고친" 상황에서 각각 어떻게 반응하는지 직접 돌려봤습니다. QueryDSL 5.1.0, JDK 17 이고, `QBean` 과 `ConstructorExpression` 을 직접 만들어 `newInstance` 를 호출했어요.

```java
public static class ListResp {
    private String mbId;
    private String mbName;
    private String adShortSi;

    public ListResp() {}
    public ListResp(String mbId, String mbName) { ... }
    public ListResp(String mbId, String mbName, String adShortSi) { ... }
}
```

결과입니다.

| 상황 | 결과 |
| --- | --- |
| `fields(mbId, mbName)` 정상 | `mbId=hwirae, mbName=김휘래, adShortSi=null` |
| `fields` 에 DTO 에 없는 이름(`adShortSee`) | **예외 없음.** `mbName=null, adShortSi=null` |
| `fields` 로 컬럼 3개 정상 바인딩 | `adShortSi=대전` |
| `constructor` 인자 2개, 생성자 있음 | 정상 |
| `constructor` 인자 4개, 생성자 없음 | `ExpressionException: No constructor found for class ListResp with parameters: [String, String, String, String]` |
| `constructor` 같은 타입 인자 순서가 뒤바뀜 | **예외 없음.** `mbId=김휘래, mbName=hwirae` |

두 방식의 실패 모양이 정반대입니다.

**`constructor` 는 개수가 틀리면 시끄럽게 터집니다.** `ExpressionException` 이 나요. 다만 이게 컴파일 에러가 아니라 **런타임 예외**라는 게 중요합니다. 빌드는 통과하고, 그 API를 호출하는 순간 500이 납니다.

그리고 개수가 맞으면서 타입도 같으면 조용히 뒤바뀝니다. 위 표의 마지막 줄이 그 경우고, 이름과 아이디가 서로 맞바뀐 응답이 나가요. 이건 예외도 안 나고 로그도 없습니다.

**`fields` 는 이름이 안 맞으면 조용히 null 을 둡니다.** 오타를 내면 그 필드만 비어서 나가요. 목록 응답에서 한 칼럼만 비어 있는 형태라 눈에 잘 안 띕니다.

정리하면 이렇습니다.

- 컬럼을 늘릴 때 위험한 쪽은 `constructor` 입니다. 생성자를 같이 안 고치면 그 API가 죽어요
- 컬럼 이름을 다룰 때 위험한 쪽은 `fields` 입니다. 틀리면 아무 일도 안 일어나고 값만 안 들어갑니다

이번 작업은 **기존 응답에 필드를 덧붙이는 일**이었어요. `constructor` 였다면 47개 DTO의 생성자 시그니처를 전부 따라 고쳐야 했고, 하나 빠뜨리면 런타임에 터집니다. `fields` 는 select 에 한 줄, DTO에 한 줄만 추가하면 끝이에요. 이번 요구사항에는 `fields` 쪽이 압도적으로 유리했습니다.

## [해결 방법 - 조회 계층은 두 줄로 끝난다]

실제로 조회 코드에 들어간 변경은 이런 모양입니다. 결제 목록 조회 코드입니다.

```java
@Override
public List<OrderSubscriptionListResp> getSubList(OrderSubscriptionListReq request) {
    Expression<OrderSubscriptionListResp> select = Projections.fields(
        OrderSubscriptionListResp.class,
        orderEntity.ordPayment,
        // ...
        memberInfoEntity.soDefine.sdName,
        memberInfoEntity.miRNum,
        memberInfoEntity.mbNumber,
        // ...
        orderEntity.createdAt.as("orderCreatedAt"),
        inAppReceiptIdExpression(),
        areaDefineEntity.adShortSi          // 추가한 한 줄
    );
    return getSubPage(select, request).fetch();
}
```

그리고 조인 한 줄입니다.

```java
.leftJoin(soDefineEntity).on(soDefineEntity.sdIdx.eq(memberInfoEntity.soDefine.sdIdx))
.leftJoin(areaDefineEntity).on(areaDefineEntity.adIdx.eq(memberInfoEntity.areaDefine.adIdx))
```

DTO 쪽도 한 줄입니다.

```java
@Schema(description = "지역")
private String adShortSi;
```

이게 전부입니다. 응답 DTO 하나당 조회 코드 두 줄, DTO 한 줄이에요.

`leftJoin` 을 쓴 이유는 지역 정보가 없는 회원이 있기 때문입니다. `join` 으로 걸면 지역이 안 붙은 회원이 목록에서 사라져요. 필드를 추가하는 작업이 **행을 지우는 작업**이 되는 겁니다. 이건 실수하기 쉬운 부분이라 조인 방향을 하나하나 확인했습니다.

그리고 여기서 N+1 이 생기지 않습니다. 지역 이름을 가져오려고 회원마다 쿼리를 더 나가는 게 아니라, 애초에 조인해서 필요한 칼럼만 select 에 얹었으니까요. 엔티티를 안 만들기 때문에 영속성 컨텍스트에도 아무것도 안 올라갑니다.

## [성과 - 계층별로 몇 줄이 바뀌었나]

커밋 20개의 변경 줄 수를 계층별로 나눠서 세봤습니다. `git show --numstat` 결과를 경로로 분류했습니다.

```bash
$ git show --numstat --format="" <커밋> | awk '{ ... 경로별 분류 ... }'
```

| 계층 | 추가 | 삭제 |
| --- | --- | --- |
| 조회 (`CustomRepositoryImpl`) | **115** | 33 |
| UseCase | 54 | 13 |
| 엑셀 응답 DTO | 370 | 210 |
| 그 외 응답 DTO | 186 | 83 |
| 합계 | 725 | 339 |

건드린 파일은 78개고 그중 `CustomRepositoryImpl` 이 13개, 응답 DTO가 47개(엑셀 응답 25개 포함), UseCase 가 14개입니다.

한 가지 밝혀둘 게 있어요. 엑셀 응답 DTO 370줄 중 65줄은 줄바꿈 문자가 CRLF 인 파일 하나를 통째로 다시 쓴 분량입니다. 실제 필드 추가분은 그만큼 적어요.

**여기서 눈에 걸린 건 115 대 556 이라는 비율입니다.** 조회 계층은 115줄로 끝났는데, DTO와 엑셀 매핑에서 556줄이 나갔습니다.

이유는 명확합니다. 조회는 프로젝션 한 줄이면 되는데, **엑셀은 프로젝션의 혜택을 못 받고 있었어요.**

```java
return NeighborPartnerListExcelResp.builder()
    .no(StringConverterUtils.safeToString(i + 1))
    .miRNum(StringConverterUtils.safeToString(resp.getMiRNum()))
    .miSo(StringConverterUtils.safeToString(
        MemberConverterUtils.convertToMiSo(resp.getMiSo())))
    .adShortSi(StringConverterUtils.safeToString(resp.getAdShortSi()))
    // ...
```

목록 응답 DTO를 받아서 엑셀 응답 DTO로 손으로 옮기는 빌더입니다. 필드 하나가 늘면 이 빌더 호출을 전부 찾아서 한 줄씩 넣어야 합니다. 같은 화면의 엑셀이 여섯 종류면 여섯 곳이에요.

그러니까 이번 작업에서 **DTO 프로젝션이 깎아준 것은 조회 계층이고, 안 깎인 것은 손으로 쓴 매핑 계층**이었습니다. 프로젝션이 코드를 줄여준다는 말은 정확히는 "조회에서 DTO까지의 매핑 코드를 없애준다"는 뜻이에요. 그 뒤에 또 다른 손 매핑이 있으면 그 비용은 그대로 남습니다.

<!-- 측정 필요: 로컬에 운영 스키마를 띄우고 목록 API 하나의 쿼리 수와 응답 시간을 필드 추가 전후로 비교. hibernate.generate_statistics=true 로 수집 -->

## [결론]

35만 줄 프로젝트의 목록 응답 47개에 필드를 넣었는데 조회 코드는 115줄만 바뀌었습니다. 앞서 쓴 사람이 목록 조회를 전부 DTO 프로젝션으로 만들어둔 덕이었어요.

정리하면 이렇습니다.

- `Projections.fields` 는 이름으로 바인딩하니 **응답에 필드를 덧붙이는 변경에 강합니다.** select 한 줄, DTO 한 줄이면 끝이에요
- `Projections.constructor` 는 위치로 바인딩합니다. 컬럼이 늘면 `ExpressionException` 으로 런타임에 터지고, 같은 타입끼리 순서가 바뀌면 조용히 값이 뒤바뀝니다
- 연관 경로는 리프 이름으로 바인딩됩니다. `memberInfoEntity.soDefine.sdName` 은 DTO의 `sdName` 에 들어가요
- 필드를 추가하려고 조인을 넣을 때 `join` 을 쓰면 그 값이 없는 행이 목록에서 사라집니다. `leftJoin` 인지 확인해야 합니다

남은 한계도 적어둘게요.

첫째, **`fields` 의 조용한 실패를 막을 장치가 없습니다.** DTO 필드명과 select 별칭이 안 맞으면 그냥 null 이에요. 지금은 화면을 열어서 눈으로 확인하는 게 유일한 검증인데, 목록 API마다 응답 필드가 채워지는지 보는 테스트가 있어야 맞습니다. 47개를 손으로 확인했다는 건 자랑이 아니라 테스트가 없다는 뜻이에요.

둘째, **`fields` 와 `bean` 이 섞여 있는 기준을 모릅니다.** 408곳과 60곳인데 왜 나뉘었는지 코드에서 근거를 찾지 못했어요. 새로 쓸 때 어느 쪽을 골라야 하는지 팀에 물어봐야 합니다.

셋째, **엑셀 매핑이 남아 있습니다.** 이번 작업 변경량의 절반 이상이 여기서 나왔어요. 목록 응답 DTO에서 엑셀 응답 DTO로 옮기는 빌더가 화면마다 여러 개씩 있는데, `@ExcelColumn` 어노테이션이 이미 붙어 있으니 목록 응답 DTO에 엑셀 칼럼 정보를 얹어서 한 단계를 없앨 수 있을 것 같습니다. 다만 마스킹 함수와 코드값 변환이 엑셀 쪽에만 걸려 있어서, 그 로직을 어디로 옮길지부터 정해야 해요.

넷째, **쿼리 수와 응답 시간을 재지 못했습니다.** 조인을 두 개 늘렸으니 실행 계획이 바뀌었을 텐데, 로컬에 운영 스키마를 띄우지 못해서 비교하지 못했어요. 조인 대상이 코드 정의 테이블이라 카디널리티가 낮다는 것만 확인한 상태입니다.

작업 자체는 단순 반복이었는데, 조회 계층이 얼마나 흔들리는지가 앞서 만든 사람의 선택으로 결정된다는 걸 숫자로 본 게 남습니다. 프로젝션을 쓴다는 판단이 몇 달 뒤에 다른 사람의 작업량을 다섯 배 차이로 갈랐어요.
