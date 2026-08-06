---
title: "공지 목록 조회를 고치다가 네 번 갈아엎었습니다 (OSIV, BatchSize, Fetch Join, 페이지네이션)"
description: "OSIV를 끄자 예외가 터졌고, BatchSize와 Fetch Join을 거쳐 DTO 프로젝션까지 갔습니다. 쿼리 수는 유일한 지표가 아니었어요."
date: 2026-08-06
category: "아주이벤트"
tags: ["JPA", "Hibernate", "N+1"]
---

# 공지 목록 조회를 고치다가 네 번 갈아엎었습니다 (OSIV, BatchSize, Fetch Join, 페이지네이션)

## [배경 - 목록 하나 부르는데 쿼리가 스물한 개]

아주이벤트의 공지 목록 API를 손보던 중이었습니다. 로그를 켜보니 페이지 하나 부르는데 쿼리가 스물한 개 나가고 있었어요.

구조는 단순합니다. 공지 하나에 이미지가 여러 장 붙어요.

```java
@BatchSize(size = 100)
@OneToMany(mappedBy = "clubEvent", fetch = FetchType.LAZY,
           cascade = {CascadeType.PERSIST, CascadeType.REMOVE}, orphanRemoval = true)
@ToString.Exclude
private List<ClubEventImage> clubEventImageList;
```

전형적인 N+1이에요. 목록 20건을 가져오고, 각 공지의 이미지를 채우려고 스무 번을 더 나가는 겁니다.

여기서부터 네 번을 갈아엎었습니다. 순서대로 적어볼게요.

## [1차 시도 - OSIV를 껐습니다]

먼저 `open-in-view` 를 확인했어요. Spring Boot 기본값은 `true` 예요. 영속성 컨텍스트를 뷰 렌더링까지 열어두는 설정입니다.

```yaml
spring:
  jpa:
    open-in-view: false
```

`false` 로 바꿨습니다. 이유는 두 가지였어요.

첫째, OSIV가 켜져 있으면 **DB 커넥션을 응답이 끝날 때까지 붙잡고 있습니다.** 컨트롤러와 뷰에서 지연 로딩이 가능한 대신, 커넥션 반납이 그만큼 늦어져요. 트래픽이 몰리면 커넥션 풀이 먼저 마릅니다.

둘째, 쿼리가 어디서 나가는지 안 보입니다. 서비스 계층을 벗어난 곳에서 프록시가 초기화되면 추적이 어려워요.

그런데 끄고 나니 바로 터졌습니다.

```
org.hibernate.LazyInitializationException:
could not initialize proxy - no Session
```

트랜잭션이 끝난 뒤에 이미지 목록을 건드리고 있었던 거예요. OSIV가 켜져 있을 때는 조용히 동작하던 코드였습니다. **문제가 없었던 게 아니라 가려져 있었던 것**이었어요.

## [2차 시도 - @BatchSize를 붙였습니다]

지연 로딩 자체를 트랜잭션 안으로 끌고 들어오고, N+1은 배치로 묶기로 했습니다.

`@BatchSize(size = 100)` 을 컬렉션에 붙였어요. 이걸 붙이면 Hibernate가 프록시를 하나씩 초기화하지 않고 `IN` 절로 묶어서 한 번에 가져옵니다.

```sql
-- 붙이기 전: 20번 반복
SELECT * FROM club_event_image WHERE club_event_id = ?

-- 붙인 뒤: 1번
SELECT * FROM club_event_image WHERE club_event_id IN (?, ?, ?, ... )
```

21개가 2개가 됐어요. 여기서 만족할 뻔했습니다.

## [3차 시도 - Fetch Join으로 한 방에]

쿼리 두 개도 하나로 줄일 수 있지 않을까 싶었습니다. Fetch Join을 쓰면 조인 한 번으로 다 가져올 수 있으니까요.

```java
@Query("SELECT DISTINCT e FROM ClubEvent e LEFT JOIN FETCH e.clubEventImageList ORDER BY e.eventId")
Slice<ClubEvent> findAllWithImages(Pageable pageable);
```

쿼리는 정말 하나가 됐어요. 그런데 로그에 처음 보는 경고가 찍혔습니다.

```
WARN HHH90003004: firstResult/maxResults specified with collection fetch;
applying in memory
```

**컬렉션 fetch join과 페이지네이션을 같이 쓰면 페이징이 메모리에서 처리된다**는 뜻입니다.

이유를 생각해보면 당연합니다. 공지 20건에 이미지가 3장씩이면 조인 결과는 60행이에요. DB에 `LIMIT 20` 을 걸면 공지 20건이 아니라 **조인된 행 20개**가 잘려요. 공지로 치면 대략 6~7건입니다.

Hibernate는 이 문제를 알기 때문에 `LIMIT` 을 아예 걸지 않습니다. 전부 가져와서 애플리케이션 메모리에서 20건을 잘라요. 조용히 실패하지 않고 경고를 남긴다는 점은 다행이지만, 동작 자체는 위험합니다.

공지가 10만 건이면 10만 건을 다 읽고 20건을 반환해요.

## [4차 시도 - 목록에는 연관관계를 태우지 않기]

여기서 질문을 바꿨습니다. 애초에 목록 화면에 이미지 목록이 필요한가?

필요 없었어요. 목록에는 제목, 미리보기, 작성자, 작성 시각, 좋아요 수, 조회수만 나갑니다. 이미지는 상세 화면에서 씁니다.

그래서 엔티티를 조회하는 대신 **DTO로 직접 프로젝션**하기로 했습니다.

```java
@Query(
    "SELECT new com.example.ajouevent_be_v2.dto.clubevent.ClubEventSummaryResult("
        + "ce.eventId, ce.title, ce.contentPreview, ce.writer, ce.createdAt,"
        + "ce.likesCount, ce.viewCount, ce.subject, ce.type, ce.url) "
        + "FROM ClubEvent ce "
        + "WHERE ce.eventId IN :eventIds ORDER BY ce.createdAt DESC")
Slice<ClubEventSummaryResult> findByEventIds(
    @Param("eventIds") List<Long> eventIds, Pageable pageable);
```

이 방식이 앞의 문제를 전부 비켜갑니다.

- 엔티티가 아니라 DTO를 만드니 **영속성 컨텍스트에 올라가지 않습니다.** `LazyInitializationException` 이 발생할 여지가 없어요
- 연관관계를 태우지 않으니 **N+1이 아예 성립하지 않습니다**
- 조인이 없으니 **DB에서 `LIMIT` 이 정상 동작합니다**
- 필요한 컬럼만 뽑으니 `content` 같은 큰 컬럼을 읽지 않아요

마지막 항목은 별도로 다룬 적이 있습니다. 본문 앞부분을 `contentPreview` 라는 별도 컬럼에 잘라 두고, 목록에서는 그것만 읽는 구조예요.

## [성과 - 네 방식의 실측 비교]

공지 100건에 공지당 이미지 3장, 페이지 크기 20으로 네 가지를 재봤습니다. Hibernate 6.6, 통계는 `hibernate.generate_statistics` 로 수집했어요.

| 방식 | 쿼리 수 | 적재 엔티티 | 반환 건수 |
| --- | --- | --- | --- |
| Lazy 로딩 (배치 없음) | 21 | 80 | 20 |
| `@BatchSize(100)` | **2** | 80 | 20 |
| Fetch Join + Pageable | **1** | **400** | 20 |
| DTO 프로젝션 (실제 코드) | **1** | **0** | 20 |

쿼리 수만 보면 Fetch Join이 좋아 보입니다. 1회니까요.

**적재 엔티티 열을 봐야 합니다.** 20건을 반환하려고 엔티티 400개를 메모리에 올렸어요. 공지 100건과 이미지 300건 전부입니다. 페이징이 메모리에서 처리된다는 게 이 숫자로 드러납니다.

`@BatchSize` 는 쿼리가 하나 더 나가지만 적재량은 80개예요. 필요한 20건과 그에 딸린 이미지 60장입니다. 쿼리 하나를 아끼려다 다섯 배를 읽는 게 Fetch Join이었습니다.

DTO 프로젝션은 적재 엔티티가 **0개**입니다. 영속성 컨텍스트를 아예 쓰지 않으니까요.

## [결론]

목록 조회를 최적화하면서 배운 건 **쿼리 수가 유일한 지표가 아니라는 것**입니다. Fetch Join은 쿼리를 1회로 줄이지만 메모리 적재량을 다섯 배로 늘렸어요. 두 숫자를 같이 보지 않으면 잘못된 방향으로 갑니다.

정리하면 이렇습니다.

- OSIV를 끄면 숨어 있던 지연 로딩이 예외로 드러난다. 문제가 생긴 게 아니라 보이게 된 것이다
- `@BatchSize` 는 N+1을 `IN` 절 한 번으로 접는다. 컬렉션에 붙이는 것만으로 21개가 2개가 됐다
- 컬렉션 Fetch Join과 페이지네이션은 같이 쓸 수 없다. `HHH90003004` 경고가 뜨면 메모리 페이징이다
- 목록 화면에 연관관계가 필요 없다면 DTO 프로젝션이 가장 깔끔하다

남은 한계도 적어둘게요.

첫째, **DTO 프로젝션은 만능이 아닙니다.** 목록에 연관 데이터가 정말 필요한 화면이라면 쓸 수 없어요. 그럴 때는 ToOne 관계만 Fetch Join하고 ToMany는 `@BatchSize` 로 처리하는 조합이 정석입니다. 컬렉션이 하나도 안 껴 있으면 페이지네이션 문제가 생기지 않으니까요.

둘째, **`@BatchSize(100)` 의 100에 근거가 없습니다.** 페이지 크기가 20이면 100은 필요 이상이에요. 지금은 컬렉션이 한 번에 다 묶이니 동작에 문제가 없지만, 값을 정한 이유를 설명하라면 못 합니다.

셋째, **엔티티에는 여전히 `@BatchSize` 가 붙어 있습니다.** 목록 조회는 DTO로 바꿨지만 상세 조회 등 다른 경로에서 쓰이고 있어요. 어느 경로가 어떤 전략을 쓰는지 정리해둘 필요가 있습니다.

넷째, **측정 환경이 H2입니다.** 쿼리 수와 적재 엔티티 수는 Hibernate 계층의 동작이라 DB와 무관하지만, 실제 응답 시간은 MySQL에서 다시 재봐야 정확해요.

OSIV를 끄는 것으로 시작했는데 결국 조회 방식 자체를 바꾸게 됐습니다. 설정 한 줄이 감춰두고 있던 게 생각보다 많았어요.
