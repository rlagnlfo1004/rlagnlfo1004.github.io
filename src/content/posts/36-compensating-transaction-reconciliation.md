---
title: "OpenStack에는 있는데 DB에는 없습니다 (보상 트랜잭션이 놓친 방향)"
description: "외부 리소스를 만들고 DB 저장에 실패하면 되돌려야 합니다. 그 보상이 안 도는 경우가 있고, 그걸 메우라고 만든 정합성 스케줄러는 정반대 방향만 봅니다."
date: 2026-08-09
project: "아올다 클라우드"
tags: ["분산 트랜잭션", "보상 트랜잭션", "ShedLock", "정합성", "JPA"]
---

## [배경 - 콘솔에는 있는데 실제로는 없는 키페어]

아올다 클라우드에서 인스턴스를 만들려면 SSH 키페어가 필요합니다. 사용자가 키페어를 만들면 두 곳에 기록돼요.

1. **OpenStack (Nova)** 이 실제 키를 만들고 보관합니다
2. **저희 DB** 가 그 키가 어느 프로젝트 소속인지 기록합니다

두 번째가 필요한 이유는 OpenStack의 키페어가 사용자 단위라서예요. 저희 콘솔은 프로젝트 단위로 보여주니 그 매핑을 따로 들고 있어야 합니다.

문제는 이 둘이 어긋날 수 있다는 겁니다. **하나는 성공하고 하나는 실패하는 순간**이 있어요.

운영 중에 콘솔 목록에는 보이는데 인스턴스를 만들 때 "그런 키 없다" 는 오류가 나는 일이 있었습니다.

## [문제 상황 분석 - 두 시스템에 걸친 쓰기]

### 트랜잭션이 한쪽만 덮습니다

키페어를 만드는 코드는 이렇게 생겼어요.

```java
@Transactional
public CreateKeypairResponse createKeypair(CreateKeypairRequest request, String keystoneToken, String userId, String projectId) {
    ProjectEntity project = projectRepositoryPort.findById(projectId)
            .orElseThrow(() -> new KeystoneException(KeypairErrorCode.DB_PROJECT_NOT_FOUND));
    UserDbExtraEntity user = userRepositoryPort.findUserDetailById(userId)
            .orElseThrow(() -> new KeypairException(KeypairErrorCode.USER_NOT_FOUND));

    // OpenStack에 Keypair 생성
    CreateKeypairResponse response = keypairExternalPort.createKeypair(keystoneToken, request);
    // ... DB 저장
}
```

`@Transactional` 이 붙어 있지만 그건 **DB에만 적용됩니다.** OpenStack 호출은 트랜잭션 밖이에요. 롤백해도 OpenStack의 키는 안 지워집니다.

가능한 조합이 네 가지예요.

| OpenStack | DB | 결과 |
| --- | --- | --- |
| 성공 | 성공 | 정상 |
| 성공 | 실패 | **OpenStack에만 있음 (고아 리소스)** |
| 실패 | (시도 안 함) | 정상 (아무것도 안 만들어짐) |
| 성공 | 성공했다가 나중에 삭제 실패 | **DB에만 있음 (유령 레코드)** |

두 번째와 네 번째가 문제입니다. 그리고 이 둘은 **증상이 반대**예요.

## [해결 방법 - 즉시 보상과 주기적 대조]

### 1층. 실패하면 바로 되돌립니다

DB 저장이 실패하면 OpenStack에 만든 걸 지웁니다.

```java
try {
    KeypairEntity keypairEntity = KeypairEntity.builder()
            .keypairId(response.getFingerprint())
            .keypairName(response.getKeypairName())
            .user(user)
            .project(project)
            .build();
    keypairRepositoryPort.save(keypairEntity);
    log.info("Successfully created keypair. UserId: {}, Project: {}", userId, projectId);
    return response;
} catch (Exception e) {
    log.warn("Failed to save keypair to DB. Rolling back OpenStack creation for keypair: {}", response.getKeypairName(), e);
    try {
        keypairExternalPort.deleteKeypair(keystoneToken, response.getKeypairName());
        log.warn("Roll Back Success (Failed to save keypair): {}", response.getKeypairName());
    } catch (Exception rollbackEx) {
        log.error("CRITICAL: Failed to rollback OpenStack keypair creation: {}. Orphan resource.", response.getKeypairName(), rollbackEx);
    }
    throw new KeypairException(KeypairErrorCode.DB_SAVE_FAILED);
}
```

보상 트랜잭션입니다. **DB를 되돌릴 수 없으니 외부 쪽을 되돌리는** 방식이에요.

보상 자체가 실패할 수 있다는 것도 코드에 드러나 있습니다. 중첩 `try-catch` 안에서 `CRITICAL` 로그와 `Orphan resource` 라는 단어를 남겨요. **되돌리기가 실패하면 사람이 개입해야 한다**는 걸 로그에 적어둔 겁니다.

### 2층. 매일 새벽에 대조합니다

보상만으로는 부족합니다. 프로세스가 죽거나 응답이 유실되면 보상 자체가 안 돌아요.

그래서 주기적으로 두 시스템을 대조하는 스케줄러를 뒀습니다.

```java
@Scheduled(cron = "0 0 4 * * *")
@SchedulerLock(name = "keypairSync", lockAtMostFor = "2h", lockAtLeastFor = "30m")
@Transactional
public void syncAllKeypairs() {
    // ...
}
```

새벽 4시에 하루 한 번 돕니다. 사용자 활동이 적은 시간이라 대조 중에 값이 바뀔 가능성이 낮아요.

`@SchedulerLock` 의 두 값이 각각 다른 문제를 막습니다.

| 옵션 | 값 | 막는 것 |
| --- | --- | --- |
| `lockAtMostFor` | 2h | 인스턴스가 죽어서 락이 영원히 안 풀리는 상황 |
| `lockAtLeastFor` | 30m | 서버 간 시계 차이로 같은 작업이 두 번 도는 상황 |

`lockAtLeastFor` 가 특히 중요해요. 작업이 1분 만에 끝나도 락을 30분 잡습니다. 그러면 시계가 조금 어긋난 다른 인스턴스가 4시 1분에 스케줄을 돌려도 락에 걸려요.

### 대조 기준을 fingerprint로 잡습니다

이름이 아니라 fingerprint를 키로 씁니다.

```java
return allKeypairs.stream()
        .collect(Collectors.toMap(
                KeypairEntity::getKeypairId,  // fingerprint
                k -> k,
                (existing, replacement) -> existing  // 중복 시 기존 값 유지
        ));
```

이름은 바뀔 수 있지만 **fingerprint는 공개키에서 계산되는 값이라 안 바뀝니다.** 이름을 키로 잡으면 이름이 바뀐 키를 "삭제된 키" 로 오판해요.

이 선택 덕분에 두 가지 경우를 구분할 수 있습니다.

```java
if (!openstackKeypairMap.containsKey(fingerprint)) {
    toDelete.add(dbKeypair);
    log.info("Case 1 - Marking for deletion from DB: fingerprint={}, name={}", ...);
} else {
    KeypairSyncDto osKeypair = openstackKeypairMap.get(fingerprint);
    if (!dbKeypair.getKeypairName().equals(osKeypair.getName())) {
        String oldName = dbKeypair.getKeypairName();
        dbKeypair.updateKeypairName(osKeypair.getName());
        updatedCount++;
        log.info("Case 2 - Updating keypair name in DB: fingerprint={}, oldName={}, newName={}", ...);
    }
}
```

- **Case 1**: fingerprint가 OpenStack에 없다 → DB 레코드를 지운다
- **Case 2**: fingerprint는 같은데 이름이 다르다 → OpenStack 이름으로 맞춘다

### 어느 쪽이 진실인지 정합니다

두 시스템이 다를 때 **누구를 믿을지**를 정하는 게 정합성 설계의 핵심입니다.

여기서는 **OpenStack이 진실**입니다. 이유가 명확해요. 실제 키를 가지고 있고 인스턴스가 실제로 참조하는 게 OpenStack이니까요. 저희 DB는 그 위에 얹은 메타데이터입니다.

그래서 동기화가 한 방향입니다. OpenStack을 읽어서 DB를 고쳐요. 반대로는 안 합니다.

이걸 명시적으로 정하지 않으면 코드가 이상해집니다. "다르면 어떻게 하지" 를 케이스마다 다르게 판단하게 되거든요.

## [성과 - 개선 전후 비교]

| 항목 | 보상만 | 보상 + 정합성 스케줄러 |
| --- | --- | --- |
| DB 저장 실패 시 | 즉시 OpenStack 롤백 시도 | 동일 |
| 보상 실패 시 | 고아 리소스 방치 | (아래 한계 참조) |
| 삭제된 키의 DB 레코드 | 남음 | 새벽 4시에 정리 |
| 이름 변경 반영 | 안 됨 | 새벽 4시에 반영 |
| 다중 인스턴스 중복 실행 | 해당 없음 | ShedLock으로 차단 |

수치는 없습니다. 불일치가 실제로 몇 건 있었는지, 스케줄러가 몇 건을 고쳤는지 집계하지 않았어요.

<!-- 측정 필요:
     1) syncAllKeypairs 실행마다 Case 1/Case 2 건수를 메트릭으로 노출
     2) 불일치 발생률 = 정정 건수 / 전체 키페어 수
     3) 스케줄러 1회 실행 소요 시간과 OpenStack API 호출 횟수 -->

## [결론]

정리하면 이렇습니다.

- 두 시스템에 걸친 쓰기에서 DB 트랜잭션은 절반만 덮는다
- 보상 트랜잭션은 보상 자체가 실패할 수 있다는 전제로 짜야 한다
- 정합성 대조에서는 어느 쪽이 진실인지를 먼저 정해야 한다
- 대조 키는 바뀌지 않는 값이어야 한다

한계를 적어둘게요. 앞의 두 개가 특히 큽니다.

첫째, **정합성 스케줄러가 반대 방향을 안 봅니다.**

Case 1은 "DB에 있고 OpenStack에 없는 것" 을 지웁니다. Case 2는 이름을 맞춰요. 그런데 **"OpenStack에 있고 DB에 없는 것"** 을 처리하는 코드가 없습니다.

그리고 그게 정확히 **보상이 실패했을 때 남는 상태**예요. 즉 보상이 못 지운 고아 리소스는 스케줄러도 안 건드립니다. 두 장치를 만들어놨는데 **둘 다 같은 방향만 보고 있어요.**

둘째, **보상이 아예 안 도는 경로가 있습니다.** 엔티티의 ID 전략 때문이에요.

```java
@Entity
@Table(name = "keypairs")
@IdClass(KeypairProjectId.class)
public class KeypairEntity {

    @Id
    @Column(name = "keypair_id")
    private String keypairId;
    // ...
    @Id
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "project_id", nullable = false)
    private ProjectEntity project;
```

**`@GeneratedValue` 가 없습니다.** ID를 코드가 직접 넣어요. `keypairId` 에는 OpenStack이 돌려준 fingerprint가 들어갑니다.

이게 왜 문제냐면, `@GeneratedValue(IDENTITY)` 였다면 Hibernate가 **ID를 받아오기 위해 `persist()` 시점에 INSERT를 즉시 실행**합니다. 그래야 생성된 키를 알 수 있으니까요. 그러면 제약 위반이 `save()` 호출에서 바로 터지고 `try-catch` 에 잡힙니다.

반면 ID가 이미 정해져 있으면 서둘러 INSERT할 이유가 없어요. **쓰기가 flush 시점으로 미뤄집니다.** 그리고 flush는 트랜잭션 커밋 때 일어나는데, 커밋은 `createKeypair` 가 끝난 뒤예요.

```
createKeypair()
  ├─ OpenStack 생성 성공
  ├─ try { save(entity) }        ← INSERT 안 나감. 예외도 없음
  ├─ catch 안 탐 → 보상 안 함
  └─ return
        ↓
     트랜잭션 커밋 → flush → INSERT → 여기서 실패   ← try-catch 밖
```

즉 **보상 코드는 `save()` 자체가 던지는 예외에만 반응하는데, 정작 쓰기는 그 뒤에 일어납니다.**

여기까지는 코드를 읽고 세운 가설이었습니다. 그래서 실제로 재봤어요.

`KeypairEntity` 와 같은 조건(`@IdClass` 복합키, 할당 ID, `@GeneratedValue` 없음)의 엔티티를 만들고, 운영과 같은 **MariaDB**에 붙여서 `SimpleJpaRepository.save()` 를 관찰했습니다. `SimpleJpaRepository` 는 `KeypairRepositoryAdapter` 가 부르는 바로 그 구현체예요.

관측할 때 한 가지 함정이 있었습니다. 처음에는 `SELECT COUNT(*)` 로 행 수를 셌는데 **네이티브 쿼리가 자동 flush를 유발**해서 결과가 오염됐어요. `FlushModeType.COMMIT` 으로 바꾸고 나서야 제대로 보였습니다.

```
테스트 3건, 실패 0건

save_할당ID엔티티는_INSERT를_flush까지_미룬다      → save() 직후 0행, flush 후 1행
save_중복ID는_예외없이_기존행을_덮어쓴다            → 예외 없음, 값이 덮어써짐
컬럼길이_제약위반은_save호출시점에_잡히지_않는다    → save() 에서 예외 안 남
```

**세 가지가 다 확인됐습니다.**

첫째, `save()` 직후에는 행이 0개입니다. flush를 불러야 1개가 돼요. 예상대로 쓰기가 미뤄집니다.

둘째, 컬럼 길이 제약을 어겨도 `save()` 호출은 예외를 던지지 않습니다. **`try-catch` 가 아무것도 못 잡아요.**

셋째, 중복 ID는 예외조차 안 납니다. Spring Data의 `save()` 는 엔티티가 신규가 아니라고 판단하면 `merge()` 로 가는데, ID가 이미 채워져 있으니 신규가 아니라고 봐요. 그래서 **INSERT가 아니라 UPDATE가 되어 기존 행을 조용히 덮어씁니다.**

세 번째가 보상 트랜잭션 이야기와 별개로 더 나쁩니다. 같은 fingerprint의 키페어를 다른 사용자가 등록하면, **예외가 나서 막히는 게 아니라 기존 소유자 정보가 덮어써집니다.**

고치는 방향은 `saveAndFlush` 로 쓰기를 앞당기거나, `TransactionSynchronization` 으로 커밋 실패 후에 보상하는 겁니다. 전자가 간단하지만 트랜잭션 안에서 외부 API를 부르는 구조 자체는 그대로 남아요.

셋째, **트랜잭션 안에서 외부 API를 부릅니다.** `createKeypair` 와 `deleteKeypair` 둘 다 `@Transactional` 메서드 안에서 OpenStack을 호출해요. [트랜잭션 안 외부 호출이 커넥션을 오래 잡는다는 글](/posts/10-transactional-external-call/)을 써놓고 여기서는 그렇게 하고 있습니다.

스케줄러는 더 심해요. `syncAllKeypairs` 가 `@Transactional` 인데 그 안에서 사용자마다 토큰을 발급하고 키페어 목록을 조회합니다. 사용자가 100명이면 **HTTP 호출 200번 동안 DB 커넥션 하나를 붙잡고 있어요.** `lockAtMostFor` 를 2시간으로 잡은 걸 보면 오래 걸릴 걸 예상한 것 같은데, 그동안 커넥션이 묶입니다.

넷째, **실패가 조용합니다.**

```java
} catch (Exception e) {
    log.error("Critical error during keypair synchronization", e);
}
```

스케줄러 전체가 `try-catch` 로 감싸여 있고 로그만 남깁니다. 새벽 4시에 실패하면 아무도 몰라요. 사용자별 조회 실패도 `log.warn` 으로 넘어가는데, **그 사용자의 키페어가 전부 "OpenStack에 없음" 으로 보여서 Case 1로 삭제될 수 있습니다.** 조회 실패와 실제 부재를 구분하지 않아요.

이게 제일 위험한 부분이라고 생각합니다. 정합성을 맞추려고 만든 장치가 데이터를 지울 수 있어요.

다섯째, **fingerprint 중복을 조용히 버립니다.** `Collectors.toMap` 의 병합 함수가 기존 값을 유지하는데, 같은 fingerprint가 서로 다른 프로젝트에 있으면 하나는 맵에서 사라집니다. 사라진 쪽은 대조 대상에서 빠져요.

보상 트랜잭션과 정합성 스케줄러를 둘 다 만들어놓고 안심했는데, 글을 쓰려고 코드를 나란히 놓고 보니 **둘이 같은 방향만 보고 있었습니다.** 장치를 두 개 만드는 것과 두 방향을 덮는 것은 다른 일이었어요.
