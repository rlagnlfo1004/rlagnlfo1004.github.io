---
title: "아직 없는 행은 잠글 수 없습니다 (Lock 전용 테이블과 Unique 제약)"
description: "SELECT FOR UPDATE로는 신규 INSERT 경쟁을 막지 못합니다. 30번 시도에서 30번 모두 중복이 생겼어요."
date: 2026-08-06
category: "메일상자"
tags: ["PostgreSQL", "동시성", "JPA"]
---

# 아직 없는 행은 잠글 수 없습니다 (Lock 전용 테이블과 Unique 제약)

## [배경 - 같은 메일 스레드가 두 번 생겼다]

메일상자는 여러 Gmail 계정을 한곳에서 보는 서비스입니다. Gmail의 `users.watch()` 로 변경을 구독하고, Pub/Sub 푸시를 받아 스레드 정보를 동기화해요.

운영 중에 같은 Gmail 스레드가 DB에 두 건 들어간 걸 발견했습니다. 조회 화면에 같은 대화가 두 번 나왔어요.

로그를 보니 원인은 짐작이 갔습니다. 메일이 하나 오면 Gmail은 관련 이벤트를 여러 개 보내요. 수신, 라벨 변경, 읽음 처리가 짧은 간격으로 들어옵니다. 그 이벤트들이 거의 동시에 처리되면서 경쟁이 생긴 겁니다.

처음에는 간단하게 생각했어요. 스레드 행을 비관적 락으로 잡으면 되겠다고요. 그런데 코드를 짜다가 막혔습니다.

## [문제 상황 분석 - 잠글 대상이 없는 구간]

### 최초 삽입은 락으로 막을 수 없습니다

`SELECT FOR UPDATE` 는 **존재하는 행**을 잠급니다. 그런데 신규 스레드는 아직 행이 없어요.

![SELECT FOR UPDATE 는 없는 행을 잠그지 못한다](/diagrams/04-insert-race.png)

둘 다 "없음"을 확인하고 둘 다 삽입합니다. 락을 걸었는데도 막히지 않아요. **잠글 대상이 존재하지 않는 구간**이라 애초에 성립하지 않는 방법이었습니다.

MySQL InnoDB라면 갭 락이 개입해서 다르게 동작할 여지가 있어요. 다만 이 프로젝트는 PostgreSQL을 씁니다. `jdbc:postgresql` 에 `PostgreSQLDialect` 이고, PostgreSQL의 기본 격리 수준인 Read Committed에서는 존재하지 않는 행에 대한 갭 락이 없습니다. 즉 DB에 기대서 해결될 문제가 아니었어요.

### 두 구간의 성격이 다릅니다

정리하고 보니 문제가 하나가 아니라 둘이었습니다.

| 구간 | 상황 | 필요한 것 |
| --- | --- | --- |
| 최초 삽입 | 행이 없음 | 중복 생성 차단 |
| 이후 갱신 | 행이 있음 | 동시 수정 직렬화 |

같은 도구로 둘 다 풀려고 한 게 실수였어요. 각각 다른 장치가 필요했습니다.

## [해결 방법 - Unique 제약과 Lock 전용 테이블]

### 최초 삽입은 DB 제약으로 막습니다

행이 없어서 락을 못 건다면, DB가 중복을 거부하게 만들면 됩니다.

```java
@Entity
@Table(
        name = "gmail_thread_locks",
        uniqueConstraints = @UniqueConstraint(
                columnNames = {"mail_account_id", "gmail_thread_id"})
)
public class GmailThreadLock extends BaseEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "mail_account_id", nullable = false)
    private MailAccount mailAccount;

    @Column(name = "gmail_thread_id", nullable = false, length = 255)
    private String gmailThreadId;
}
```

`(mail_account_id, gmail_thread_id)` 조합에 Unique 제약을 걸었어요. 동시에 두 건이 들어오면 하나는 반드시 제약 위반으로 실패합니다. 경쟁을 코드가 아니라 DB가 판정하는 구조예요.

계정 ID가 같이 들어간 것도 이유가 있습니다. Gmail 스레드 ID는 계정 안에서만 유일해요. 계정이 다르면 같은 ID가 나올 수 있으니 복합 키여야 합니다.

### 이후 갱신은 전용 행을 잠급니다

행이 생긴 뒤부터는 비관적 락이 제 역할을 합니다.

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("""
        SELECT gtl
        FROM GmailThreadLock gtl
        WHERE gtl.mailAccount.id = :mailAccountId
          AND gtl.gmailThreadId = :gmailThreadId
          AND gtl.deletedAt IS NULL
        """)
Optional<GmailThreadLock> findByMailAccountIdAndGmailThreadIdAndDeletedAtIsNullForUpdate(
        @Param("mailAccountId") UUID mailAccountId,
        @Param("gmailThreadId") String gmailThreadId
);
```

락을 거는 버전과 걸지 않는 버전을 따로 정의했어요. 단순 조회 경로에서 불필요한 락을 잡지 않기 위해서입니다. 같은 리포지토리에 두 메서드가 나란히 있습니다.

### 왜 Thread 엔티티를 직접 잠그지 않았나?

전용 테이블을 만든 이유를 정리하면 이렇습니다.

첫째, **잠금과 데이터의 수명이 다릅니다.** 스레드 데이터는 수정되고 삭제되지만, 잠금 지점은 계정과 스레드 ID 조합으로 고정돼요.

둘째, **락 대상이 최소화됩니다.** `Thread` 는 본문과 라벨 등 여러 컬럼을 가진 큰 엔티티입니다. 잠금만 필요한 상황에서 그 행을 통째로 잡으면 조회 경로까지 영향을 받아요. 잠금 전용 행은 컬럼 세 개뿐입니다.

셋째, **의도가 코드에 드러납니다.** `GmailThreadLock` 이라는 이름을 보면 이게 잠금 장치라는 걸 바로 알 수 있어요. 나중에 읽는 사람이 `Thread` 조회에 왜 `FOR UPDATE` 가 붙었는지 헷갈릴 일이 없습니다.

## [성과 - 개선 전후 비교]

`gmail_thread_locks` 와 같은 구조의 테이블을 만들고, 스레드 16개가 동시에 진입하는 상황을 30회 반복했습니다. PostgreSQL 15, 기본 격리 수준 Read Committed 입니다.

각 스레드는 실제 코드와 같은 순서로 움직여요. `SELECT ... FOR UPDATE` 로 조회하고, 없으면 `INSERT` 합니다.

| 구성 | 기대 행 수 | 실제 행 수 | 중복 생성된 스레드 | 제약 위반 예외 |
| --- | --- | --- | --- | --- |
| `SELECT FOR UPDATE` 만 | 30 | **327** | 30건 | 0건 |
| Unique 제약 추가 (실제 코드) | 30 | **30** | 0건 | 260건 |

`SELECT FOR UPDATE` 만으로는 전혀 막히지 않았습니다. 30개 스레드 ID 전부에서 중복이 생겼고, 행이 열 배 넘게 불어났어요. 예상은 했지만 30건 중 30건이 실패할 줄은 몰랐습니다. 조건이 갖춰지면 거의 확정적으로 터지는 경쟁이었어요.

제약 위반 예외가 0건이라는 점도 같이 봐야 합니다. **DB는 아무 이상을 감지하지 못했어요.** 16개 트랜잭션이 각자 "없음"을 확인하고 각자 삽입했으니, DB 입장에서는 전부 정상 요청입니다. 조용히 데이터만 어긋나는 종류의 버그입니다.

Unique 제약을 걸면 정확히 30행이 됩니다. 중복은 0건이에요. 대신 260건의 제약 위반 예외가 발생합니다. 480회 시도 중 30회만 성공하고 나머지는 거부되거나, 이미 생성된 행을 조회하고 물러난 거예요.

이 260건을 어떻게 다루느냐가 다음 문제입니다. 예외를 그대로 흘리면 메시지가 실패로 처리되고 재시도를 거쳐 DLQ까지 갈 수 있어요. 정상적인 경쟁 결과이므로 잡아서 재조회로 넘기는 편이 맞습니다.

## [결론]

동시성 문제를 볼 때 **행이 존재하는지부터 확인해야 한다**는 걸 배웠습니다. 비관적 락은 존재하는 행에만 걸리니까요. 없는 행을 두고 벌어지는 경쟁은 다른 장치가 필요합니다.

정리하면 두 단입니다.

- 최초 생성 경쟁은 Unique 제약으로 DB가 판정한다
- 이후 갱신 경쟁은 전용 락 행을 잡아 직렬화한다

남은 한계를 적어둘게요.

첫째, **락은 동시성을 막지 순서를 보장하지 않습니다.** 이게 가장 큰 구멍이에요. "수신 → 읽음 → 휴지통" 이벤트가 역순으로 도착하면 각각은 직렬로 처리되지만 결과 상태는 틀립니다. 지금은 컨슈머 concurrency가 1이라 사실상 순서가 지켜지고 있는데, 이건 설계로 보장한 게 아니라 설정값에 기대는 상태예요. 정직하게 말하면 아직 안 풀린 문제입니다. Gmail이 주는 단조 증가 값을 비교해 과거 상태를 무시하는 방향을 보고 있어요.

둘째, **concurrency가 1이면 병렬성이 없습니다.** 다른 스레드는 병렬 처리된다고 설명했지만, 컨슈머가 하나면 실제로는 순차예요. 이 락 구조는 concurrency를 올렸을 때 비로소 값을 합니다. 순서 문제를 먼저 풀어야 올릴 수 있으니 두 과제가 묶여 있습니다.

셋째, **락 테이블 행이 계속 쌓입니다.** 스레드 수만큼 늘어나고 `BaseEntity` 를 상속해 soft delete를 쓰니 물리적으로는 지워지지 않아요. 정리 정책이 필요합니다.

넷째, **제약 위반 이후 동작을 문서로 남겨야 합니다.** 경쟁에서 진 쪽이 예외를 받은 뒤 재조회로 이어지는지, 아니면 메시지 재처리로 도는지가 코드를 읽어야만 파악돼요.

락을 걸면 다 해결된다고 생각했는데, 정작 잠글 대상이 없는 구간이 있다는 게 이번 문제의 핵심이었습니다. 도구를 고르기 전에 문제가 몇 개인지 세는 게 먼저라는 걸 다시 확인했어요.
