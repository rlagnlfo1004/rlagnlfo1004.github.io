---
title: "Specification.where(null) 이 막혔습니다 (Spring Data JPA 3.5 에서 4.0 으로)"
description: "QueryDSL 은 null 조건을 조용히 버리는데 Specification 은 4.0 부터 거부합니다. NPE 가 날 거라고 생각했는데 아니었어요. 버전 네 개를 직접 돌려서 확인했습니다."
date: 2026-08-07
project: "공통"
tags: ["JPA", "Spring Data JPA", "QueryDSL", "Specification", "버전 업그레이드"]
---

## [배경 - null 을 조건 없음으로 쓰는 습관]

요즘 보는 관리자 API 저장소는 동적 조건을 이런 식으로 씁니다.

```java
public interface MemberBooleanExpressionHelper {

    default BooleanExpression mbNoEq(Long mbNo) {
        return mbNo == null ? null : memberEntity.mbNo.eq(mbNo);
    }

    default BooleanExpression grIdxEq(Long grIdx) {
        return grIdx == null ? null : groupEntity.grIdx.eq(grIdx);
    }
}
```

검색 파라미터가 없으면 `null` 을 돌려주고, 그걸 그대로 `where()` 에 넣는 방식이에요. QueryDSL 이 null 을 알아서 버려주니까요.

이 패턴이 저장소에 얼마나 있는지 세봤습니다.

```bash
$ find src/main/java -name "*BooleanExpressionHelper.java" | wc -l
      98
$ grep -rh "default .* [a-zA-Z]*(" --include="*BooleanExpressionHelper.java" src/main/java | wc -l
    1061
$ grep -rh "? null :\|: null;" --include="*BooleanExpressionHelper.java" src/main/java | wc -l
     731
$ grep -rh "return null;" --include="*BooleanExpressionHelper.java" src/main/java | wc -l
     268
```

인터페이스 98개에 조건 메서드 1,061개, 그중 null 을 돌려주는 자리가 999곳입니다. 그러니까 이 저장소에서 `null` 은 "값이 없음"이 아니라 **"이 조건은 안 걸겠다"** 는 뜻으로 쓰이고 있어요.

그런데 Spring Data JPA 의 `Specification` 으로 같은 걸 하려니 IDE 에서 취소선이 보였습니다. 프로젝트가 Spring Boot 3.5.0 인데 `Specification.where(...)` 가 이미 deprecated 였어요.

```java
@Deprecated(since = "3.5.0", forRemoval = true)
static <T> Specification<T> where(@Nullable Specification<T> spec) {
    return spec == null ? (root, query, builder) -> null : spec;
}
```

`forRemoval = true` 입니다. 없어질 거라는 뜻입니다. 그래서 4.0 에서 뭐가 어떻게 바뀌는지, 지금 코드가 그때 무엇 때문에 터질지 확인해봤습니다.

## [문제 상황 분석 - 두 라이브러리가 null 을 다르게 봅니다]

### QueryDSL 은 null 을 조건에서 빼버립니다

먼저 QueryDSL 쪽 동작을 눈으로 봤습니다. `EntityManager` 없이 JPQL 문자열만 만들어봤습니다. QueryDSL 5.1.0, JDK 17 입니다.

```java
static final PathBuilder<Object> member = new PathBuilder<>(Object.class, "m");

static BooleanExpression mbIdEq(String mbId) {
    return mbId == null ? null : member.getString("mbId").eq(mbId);
}

static String query(BooleanExpression... conditions) {
    return new JPAQuery<Void>(null, JPQLTemplates.DEFAULT)
        .from(member)
        .where(conditions)
        .toString();
}
```

결과입니다.

```
조건 둘 다 있음
  select m from Object m where m.mbId = ?1 and m.sdIdx = ?2
조건 하나가 null
  select m from Object m where m.mbId = ?1
조건 둘 다 null
  select m from Object m
```

조건이 전부 null 이면 `where` 절 자체가 사라집니다. `where (null)` 같은 이상한 JPQL 이 나가는 게 아니라 아예 안 붙어요. QueryDSL 은 null 을 **"이 자리는 비었다"** 로 해석합니다.

### Specification 도 3.5 까지는 같은 규칙이었습니다

`Specification` 은 `toPredicate` 가 `@Nullable Predicate` 를 돌려주는 인터페이스입니다. 즉 **null 을 돌려주는 게 정상 동작이에요.** 합성 코드도 그걸 전제로 쓰여 있습니다.

```java
// SpecificationComposition
Predicate thisPredicate = toPredicate(lhs, root, query, builder);
Predicate otherPredicate = toPredicate(rhs, root, query, builder);

if (thisPredicate == null) {
    return otherPredicate;
}

return otherPredicate == null ? thisPredicate
    : combiner.combine(builder, thisPredicate, otherPredicate);
```

한쪽이 null 이면 다른 쪽만 씁니다. 둘 다 null 이면 null 이 나가고 `where` 절이 안 붙어요. QueryDSL 과 결과가 같습니다.

### 그럼 왜 막았을까

문제는 null 이 두 군데에 있었다는 점입니다.

```
1) Specification 참조 자체가 null       → "조건 객체가 없다"
2) toPredicate() 의 반환값이 null       → "조건을 안 걸겠다"
```

2번은 인터페이스 계약이라 남아야 합니다. 그런데 1번까지 허용하면 `spec.and(other)` 에서 `other` 가 null 인 게 실수인지 의도인지 구분할 방법이 없어요. `where(null)` 은 그 구분을 없애버리는 API 였습니다.

4.0 에서는 1번을 막고, 2번을 표현하는 이름을 따로 만들었습니다.

```java
static <T> Specification<T> unrestricted() {
    return (root, query, builder) -> null;
}
```

3.5 의 `where(null)` 이 돌려주던 것과 **몸통이 똑같습니다.** 이름만 붙은 겁니다. "조건을 안 걸겠다"를 null 이 아니라 객체로 말하게 만든 겁니다.

## [실측 - 버전별로 무엇이 터지는가]

여기서 예상이 하나 틀렸습니다. 저는 4.0 에서 null 을 넣으면 `NullPointerException` 이 날 거라고 생각했어요. `@Nullable` 이 떨어졌으니 JSpecify 기반으로 null 검사가 들어갔을 테고, 그럼 NPE 겠지 싶었습니다.

확인해보려고 버전 네 개에 같은 코드를 돌렸어요. 자바 파일 하나를 클래스패스만 바꿔서 컴파일하고 실행했습니다.

```java
static final Specification<Object> ALWAYS_NULL = (root, query, builder) -> null;

probe("Specification.where((Specification) null)", () -> Specification.where((Specification<Object>) null));
probe("spec.and(null)", () -> ALWAYS_NULL.and((Specification<Object>) null));
probe("Specification.allOf(spec, null)", () -> Specification.allOf(ALWAYS_NULL, null));
probe("null 시드.and(spec)", () -> nullSeed().and(ALWAYS_NULL));
```

3.5.0 과 3.5.4 는 JDK 17 로, 4.0.4 와 4.1.0 은 JDK 21 로 돌렸어요. Spring Boot 와의 대응은 각 스타터 pom 에서 확인한 값입니다.

| Spring Boot | spring-data-jpa |
| --- | --- |
| 3.5.0 | 3.5.0 |
| 3.5.6 | 3.5.4 |
| 4.0.3 | 4.0.3 |
| 4.0.5 | 4.0.4 |
| 4.1.0 | 4.1.0 |

실행 결과입니다.

| 호출 | 3.5.0 | 3.5.4 | 4.0.4 | 4.1.0 |
| --- | --- | --- | --- | --- |
| `unrestricted()` 존재 | 없음 | **있음** | 있음 | 있음 |
| `where((Specification) null)` | 통과 | 통과 | **IAE** | **IAE** |
| `spec.and(null)` | 통과 | 통과 | **IAE** | **IAE** |
| `spec.or(null)` | 통과 | 통과 | **IAE** | **IAE** |
| `not(null)` | 통과 | 통과 | **IAE** | **IAE** |
| `allOf()` 빈 배열 | 통과 | 통과 | 통과 | 통과 |
| `allOf(spec, null)` | 통과 | 통과 | **IAE** | **IAE** |
| `null` 시드`.and(spec)` | **NPE** | **NPE** | **NPE** | **NPE** |

`IAE` 는 `IllegalArgumentException` 입니다. NPE 가 아니었습니다.

```
java.lang.IllegalArgumentException: Specification must not be null
java.lang.IllegalArgumentException: Other specification must not be null
```

소스를 열어보니 이유가 있었어요. JSpecify 애너테이션은 붙었지만 실제 검사는 Spring 의 `Assert` 로 하고 있습니다.

```java
default Specification<T> and(Specification<T> other) {

    Assert.notNull(other, "Other specification must not be null");

    return SpecificationComposition.composed(this, other, CriteriaBuilder::and);
}
```

`Assert.notNull` 은 `IllegalArgumentException` 을 던집니다. 그래서 예외 타입을 잡아서 처리하는 코드가 있다면 NPE 를 기다리면 안 돼요.

**그런데 NPE 가 아예 안 나는 것도 아닙니다.** 표의 마지막 줄이에요. 이건 버전과 무관하게 전부 NPE 였습니다.

```
java.lang.NullPointerException: Cannot invoke
"org.springframework.data.jpa.domain.Specification.and(...)"
because the return value of "SpecNullProbe.nullSeed()" is null
```

이게 왜 중요한지가 이 글의 핵심이에요. 3.5 에서 흔히 쓰던 누적 패턴은 이렇게 생겼습니다.

```java
Specification<MemberEntity> spec = Specification.where(null);   // 3.5 에서 deprecated
if (req.getMbId() != null)  spec = spec.and(mbIdEq(req.getMbId()));
if (req.getSdIdx() != null) spec = spec.and(sdIdxEq(req.getSdIdx()));
```

취소선이 그어진 걸 보고 `where(null)` 을 그냥 지우면 이렇게 됩니다.

```java
Specification<MemberEntity> spec = null;                        // 시드가 null 이 됨
if (req.getMbId() != null)  spec = spec.and(mbIdEq(req.getMbId()));   // NPE
```

deprecation 경고를 없애려고 손댄 코드가 NPE 로 바뀌는 거예요. **경고를 지우는 게 목적이 되면 이렇게 됩니다.** 컴파일은 되고, 검색 조건이 하나라도 들어오는 순간 500이 납니다.

한 가지가 더 있습니다. 4.0 에서는 `Specification.where(null)` 이 **컴파일조차 안 됩니다.**

```
Ambiguity.java:4: error: reference to where is ambiguous
        Object o = Specification.where(null);
                                ^
  both method <T#1>where(Specification<T#1>) in Specification
  and method <T#2>where(PredicateSpecification<T#2>) in Specification match
```

4.0 에 `PredicateSpecification` 을 받는 `where` 오버로드가 추가돼서, 인자가 `null` 이면 어느 쪽인지 결정할 수 없기 때문이에요. 같은 코드를 3.5.0 으로 컴파일하면 removal 경고만 뜨고 통과합니다.

컴파일이 막히는 건 오히려 다행입니다. 조용히 통과했다가 런타임에 터지는 것보다 낫죠. 다만 마이그레이션할 때 "빌드가 깨지는 곳"과 "빌드는 되는데 런타임에 깨지는 곳"이 섞여 있다는 걸 알고 시작해야 합니다.

## [해결 방법 - unrestricted() 와 allOf() 로 옮기기]

옮기는 규칙은 단순합니다. **null 로 표현하던 "조건 없음"을 객체로 바꾸는 것**이 전부예요.

시드는 `unrestricted()` 로 바꿉니다.

```java
// 전
Specification<MemberEntity> spec = Specification.where(null);

// 후
Specification<MemberEntity> spec = Specification.unrestricted();
```

조건 메서드가 null 을 돌려주던 부분도 같이 바꿔야 합니다. 이쪽을 놓치면 시드만 고쳐도 `and()` 에서 터져요.

```java
// 전
private Specification<MemberEntity> mbIdEq(String mbId) {
    return mbId == null ? null
        : (root, query, cb) -> cb.equal(root.get("mbId"), mbId);
}

// 후
private Specification<MemberEntity> mbIdEq(String mbId) {
    return mbId == null ? Specification.unrestricted()
        : (root, query, cb) -> cb.equal(root.get("mbId"), mbId);
}
```

조건을 여러 개 모아서 넘기는 형태라면 `allOf` 가 더 깔끔해요. 4.0 의 `allOf` 는 시드가 `unrestricted()` 입니다.

```java
static <T> Specification<T> allOf(Iterable<Specification<T>> specifications) {
    return StreamSupport.stream(specifications.spliterator(), false)
        .reduce(Specification.unrestricted(), Specification::and);
}
```

그래서 이렇게 쓸 수 있습니다.

```java
Specification<MemberEntity> spec = Specification.allOf(
    mbIdEq(req.getMbId()),
    sdIdxEq(req.getSdIdx()),
    createdAtBetween(req.getStart(), req.getEnd())
);
```

빈 배열을 넣어도 통과합니다. 위 표에서 `allOf()` 만 네 버전 모두 통과한 게 이 이유예요. 다만 **원소에 null 이 섞이면 4.0 부터는 터집니다.** 3.5 의 javadoc 에는 "Can contain nulls" 라고 적혀 있었는데 4.0 에서는 그 문구가 빠졌어요. 조건 메서드가 null 을 안 돌려주게 고치는 게 먼저입니다.

`if` 로 감싸서 조건부로 붙이는 방식도 여전히 돼요. 취향 문제이고, 조건 개수가 많으면 `allOf` 쪽이 읽기 편했습니다.

### 4.0 으로 올리기 전에 미리 할 수 있습니다

위 표에서 눈에 띄는 게 하나 더 있어요. **3.5.4 에는 이미 `unrestricted()` 가 있습니다.** 3.5.0 에는 없고요.

즉 Spring Boot 3.5.6 이상이라면 지금 코드를 `unrestricted()` 로 미리 옮겨둘 수 있습니다. 3.5.4 는 null 도 계속 받아주니까, 옮기는 중에 절반만 바뀐 상태여도 동작이 깨지지 않아요. 4.0 으로 올리는 날에 한꺼번에 고치는 것보다 이 편이 안전합니다.

<!-- 측정 필요: Hibernate 와 실DB 를 붙인 상태에서 unrestricted() 만 넣은 Specification 이 실제로 where 절 없는 SQL 을 만드는지 show-sql 로 확인. 지금은 SpecificationComposition 소스로만 확인한 상태 -->

## [성과 - 체크리스트로 정리]

지금 코드에서 찾아야 할 곳을 정리했습니다.

| 찾을 패턴 | 바꿀 것 | 안 바꾸면 |
| --- | --- | --- |
| `Specification.where(null)` | `Specification.unrestricted()` | 4.0 에서 컴파일 실패 |
| `Specification.where(spec)` (한 개 감싸기) | `spec` 그대로 사용 | 3.5 removal 경고 |
| 조건 메서드가 `null` 리턴 | `unrestricted()` 리턴 | `and()` 에서 IAE |
| `Specification<T> spec = null` 누적 | `unrestricted()` 로 시작 | 버전 무관 NPE |
| `findAll(null)`, `count(null)` | `unrestricted()` 전달 | 4.0 에서 IAE |
| `allOf(list)` 의 list 에 null | 원소를 `unrestricted()` 로 | 4.0 에서 IAE |

찾는 건 grep 으로 대충 걸립니다.

```bash
$ grep -rn "Specification.where" --include="*.java" src/main
$ grep -rn "Specification<.*> .* = null" --include="*.java" src/main
```

두 번째 줄이 진짜 위험한 쪽이에요. 첫 번째는 컴파일러가 잡아주는데 두 번째는 안 잡아줍니다.

## [결론]

`Specification.where(null)` 이 사라지는 건 API 하나가 없어지는 일이 아니라, **null 로 두 가지를 표현하던 관습을 정리하는 변경**이었습니다. "조건 객체가 없다"와 "조건을 걸지 않겠다"를 구분하려고 `unrestricted()` 라는 이름을 만든 거예요.

정리하면 이렇습니다.

- QueryDSL 의 `where(null)` 은 조건을 아예 안 붙입니다. 전부 null 이면 `where` 절 자체가 사라져요
- `Specification` 도 3.5 까지는 같았지만 4.0 부터 null 참조를 거부합니다
- 예외는 NPE 가 아니라 `IllegalArgumentException` 입니다. `Assert.notNull` 로 검사하니까요
- NPE 는 다른 데서 납니다. `where(null)` 을 지우고 시드를 null 로 남겼을 때예요. 버전과 무관합니다
- 4.0 에서 `Specification.where(null)` 은 오버로드 모호성으로 컴파일이 안 됩니다
- `unrestricted()` 는 3.5.4 부터 있습니다. 4.0 으로 올리기 전에 미리 옮길 수 있어요

남은 한계를 적어둘게요.

첫째, **실DB 로 SQL 을 확인하지 못했습니다.** `unrestricted()` 만 넣었을 때 `where` 절이 정말 안 붙는지는 `SpecificationComposition` 소스를 읽어서 판단한 것이고, QueryDSL 쪽처럼 문자열로 눈으로 본 게 아니에요. Hibernate 를 붙여서 다시 봐야 정확합니다.

둘째, **4.0 에 추가된 `PredicateSpecification`, `UpdateSpecification`, `DeleteSpecification` 를 안 다뤘습니다.** `where` 가 모호해진 이유로만 언급했는데, 이 세 개가 왜 갈라졌는지는 따로 볼 주제예요. `CriteriaUpdate` 와 `CriteriaDelete` 는 `CriteriaQuery` 가 아니라서 기존 `toPredicate` 시그니처에 억지로 끼워져 있었던 흔적이 3.5 소스 주석에 남아 있습니다.

셋째, **제가 보는 저장소는 이 문제를 안 겪습니다.** QueryDSL 로만 조건을 만들고 `Specification` 은 쓰지 않아요. 그래서 이 글은 마이그레이션 경험담이 아니라 버전 네 개를 돌려본 기록입니다. 실제로 999곳을 옮겨본 사람의 이야기와는 무게가 다릅니다.

넷째, **QueryDSL 이 null 을 삼키는 게 항상 좋은 것도 아닙니다.** 파라미터 이름을 오타 내면 조건이 조용히 빠지고, 전체 목록이 나갑니다. 예외가 안 나니까 발견도 늦어요. Spring Data 가 굳이 막은 방향이 불편하지만 더 안전한 쪽이라는 건 인정해야 할 것 같습니다.

deprecation 경고를 없애는 것과 그 경고가 말하려는 걸 이해하는 건 다른 일이었어요. 취소선만 보고 지웠으면 NPE 를 심었을 겁니다.
