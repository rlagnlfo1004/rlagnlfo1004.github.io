---
title: "메일 2,000통을 한 번에 가져오지 않습니다 (초기 동기화를 5개씩 쪼갠 이유)"
description: "계정을 연결하면 스레드 수천 개를 받아와야 합니다. 배치 크기를 5로 잡은 이유와, 배치가 끝날 때마다 AI 기능을 조금씩 켜는 구조. 그리고 그 과정에서 찾은 상호작용 하나."
date: 2026-08-09
project: "메일상자"
tags: ["배치 처리", "RabbitMQ", "Gmail API", "점진적 활성화"]
---

## [배경 - 연결하고 나서 아무것도 안 보이는 시간]

메일상자에 Gmail 계정을 연결하면 과거 메일을 가져와야 합니다. 안 그러면 인박스가 텅 비어 있어요.

처음에는 이걸 한 흐름에서 처리했습니다. 스레드 목록을 받고, 하나씩 본문을 조회하고, DB에 저장하는 식이었어요.

문제가 두 가지였습니다.

**첫째, 오래 걸립니다.** 스레드가 2,000개면 Gmail API를 2,000번 넘게 불러야 해요. 그동안 사용자는 빈 화면을 봅니다.

**둘째, 중간에 실패하면 처음부터입니다.** 1,800번째에서 429가 나면 앞의 1,799개도 다시 받아야 했어요.

## [문제 상황 분석 - 쿼터가 배치 크기를 정한다]

### 배치로 나누는 것까지는 쉽습니다

큰 작업을 쪼개서 큐에 넣는 건 익숙한 방법이에요. 문제는 **얼마씩 쪼갤 것인가**였습니다.

처음에는 크게 잡으려고 했어요. 메시지 수가 적을수록 오버헤드가 적으니까요. 그런데 Gmail API 쿼터를 보고 생각이 바뀌었습니다.

Gmail API는 호출 수가 아니라 **연산별 가중치**로 쿼터를 셉니다. 저희가 쓰는 값은 이래요.

| 호출 | 비용 |
| --- | --- |
| `threads.list` | 10 units |
| `threads.get` | 40 units |

그리고 저희가 [사용자별로 걸어둔 토큰 버킷](/posts/27-gmail-rate-limit-redis-lua-token-bucket/)의 용량이 분당 12,000 units입니다.

배치 크기를 50으로 잡으면 이렇게 됩니다.

```
배치 1개 = threads.get 50회 = 50 × 40 = 2,000 units
분당 예산 12,000 units ÷ 2,000 = 배치 6개
```

**메시지 하나가 분당 예산의 6분의 1을 먹습니다.** 이러면 문제가 생겨요.

토큰이 부족하면 예외가 나고 메시지는 재시도 대기로 갑니다. 배치가 크면 **거의 다 처리해놓고 마지막 몇 개에서 토큰이 떨어져 통째로 재시도**되는 일이 생겨요. 이미 저장한 것도 다시 조회합니다.

### 배치 크기를 5로 정했습니다

```java
private int maxThreads = 2000;
private int threadListPageSize = 500;
private int threadBatchSize = 5;
```

배치 하나가 `5 × 40 = 200 units` 입니다. 분당 예산으로 60개를 처리할 수 있어요.

작게 잡아서 얻은 게 셋입니다.

**첫째, 재시도 범위가 좁습니다.** 실패해도 스레드 5개만 다시 받아요.

**둘째, 다른 작업과 섞일 수 있습니다.** 초기 동기화가 도는 중에도 새 메일 푸시는 계속 옵니다. 배치가 크면 그 사이에 실시간 동기화가 토큰을 못 얻어요. 작으면 사이사이에 끼어들 수 있습니다.

**셋째, 진행이 눈에 보입니다.** 5개씩 저장되니 사용자 화면에 메일이 조금씩 채워져요. 전부 끝나고 한 번에 나타나는 것보다 낫습니다.

대가는 메시지 수예요. 2,000개면 배치가 400개입니다. 메시지 하나당 브로커 왕복과 DB 트랜잭션이 붙으니 오버헤드가 400번 생겨요. 다만 이건 **바깥 API 쿼터에 비하면 싼 비용**이라고 봤습니다. 병목이 어디인지가 배치 크기를 정합니다.

## [해결 방법 - 두 단계와 점진적 활성화]

### 1단계는 목록만, 2단계는 본문

큐를 두 개 씁니다. 같은 Listener 클래스가 양쪽을 다 처리하는데, 한쪽에서는 Producer고 한쪽에서는 Consumer예요.

```
[1단계] mailsangja.sync.gmail.initial 소비
    → Gmail threads.list 로 스레드 ID 목록 조회
    → threadBatchSize(5) 단위로 분할
    → mailsangja.sync.gmail.initial.thread-batch 로 발행   ← Producer

[2단계] mailsangja.sync.gmail.initial.thread-batch 소비
    → 배치의 threadId 별로 threads.get
    → DB 저장
```

1단계 코드입니다.

```java
GoogleMailApiContext context = GoogleMailApiContext.from(mailAccount);
List<String> threadIds = gmailMessageApiService.getInitialThreadIds(context);

List<List<String>> threadBatches = partitionThreadIds(threadIds);

for (List<String> threadBatch : threadBatches) {
    initialMailSyncThreadBatchPublisher.publish(new InitialMailSyncThreadBatchMessage(
            message.mailAccountId(),
            message.userId(),
            message.provider(),
            message.emailAddress(),
            threadBatch
    ));
}
```

1단계를 따로 둔 이유는 **비용 차이** 때문이에요. `threads.list` 는 10 units이고 페이지당 500개씩 가져옵니다. 2,000개를 받는 데 4번이면 돼요. 40 units입니다.

반면 본문 조회는 2,000번에 80,000 units예요. **2,000배 차이**입니다. 이 둘을 한 메시지에 묶으면 재시도할 때 싼 것과 비싼 것이 같이 돌아요.

### 배치가 끝날 때마다 AI 기능을 켭니다

여기가 이 구조에서 제일 마음에 드는 부분입니다.

배치를 저장한 직후에 후속 작업을 바로 발행해요.

```java
InitialMailSyncSaveResult saveResult = initialMailSyncCommandService.saveThreadBatch(mailAccount, commands);
publishEmbeddingMessages(saveResult.messageIds());

Set<UUID> activeLabelIds = labelQueryService.findActiveLabelIdsByUserId(message.userId());
boolean labelReclassifyPublished = false;
if (!activeLabelIds.isEmpty() && !saveResult.threadIds().isEmpty()) {
    labelReclassifyPublisher.publish(message.userId(), activeLabelIds, saveResult.threadIds());
    labelReclassifyPublished = true;
}
```

임베딩과 라벨 분류를 **전체 동기화가 끝나기를 기다리지 않고** 배치 단위로 시작합니다.

그러면 사용자 경험이 이렇게 됩니다.

```
0초    연결 완료
30초   배치 1~10 저장 → 메일 50통이 보임, 그 50통은 검색도 됨
2분    배치 1~100 저장 → 메일 500통, 라벨도 붙어 있음
10분   전체 완료
```

전체가 끝나야 검색이 되는 구조였다면 10분 동안 아무것도 못 합니다. 배치 단위로 켜면 **처리된 만큼은 바로 쓸 수 있어요.**

`saveResult` 가 저장된 ID를 돌려주는 것도 이 때문입니다. 요청한 ID가 아니라 **실제로 저장된 ID**를 기준으로 후속 작업을 발행해요. 중복이라 건너뛴 스레드에 대해 임베딩을 또 만들면 비용만 나갑니다.

### 상한을 둡니다

```java
private int maxThreads = 2000;
```

아무리 메일이 많아도 2,000개까지만 가져옵니다.

이건 순수하게 비용 판단이에요. 10년치 메일이 5만 통인 계정을 전부 받으면 쿼터도, 임베딩 비용도, 저장 공간도 감당이 안 됩니다. 그리고 대부분의 사용자는 최근 메일을 봐요.

다만 이건 **사용자에게 안 보이는 제한**입니다. 어딘가에서 "최근 2,000개 대화만 가져옵니다" 라고 말해줘야 하는데, 지금은 코드에만 있어요.

## [성과 - 개선 전후 비교]

| 항목 | 단일 처리 | 두 단계 배치 |
| --- | --- | --- |
| 실패 시 재처리 범위 | 전체 | 스레드 5개 |
| AI 기능 사용 가능 시점 | 전체 완료 후 | 배치 저장 직후 |
| 쿼터 소모 단위 | 한 번에 80,000 units | 배치당 200 units |
| 실시간 동기화와의 경합 | 초기 동기화가 독점 | 배치 사이에 끼어들 수 있음 |
| 메시지 수 (2,000 스레드 기준) | 1개 | 401개 |

수치는 구조에서 계산한 값이고, **실제 소요 시간은 측정하지 않았습니다.**

<!-- 측정 필요:
     1) 스레드 2,000개 계정의 초기 동기화 전체 소요 시간 (concurrency 5 기준)
     2) 첫 배치 저장까지 걸린 시간 (사용자가 첫 메일을 보는 시점)
     3) 배치 크기 5 / 20 / 50 비교: 총 소요 시간과 429 발생 횟수
     4) 배치 재시도 시 saveThreadBatch 가 실제로 멱등한지 (같은 배치 2회 처리) -->

## [결론]

정리하면 이렇습니다.

- 배치 크기는 처리 효율이 아니라 병목의 단위가 정한다. 여기서는 API 쿼터였다
- 비용이 크게 다른 작업은 같은 메시지에 묶지 않는다
- 후속 작업을 배치 단위로 발행하면 전체 완료 전에도 기능이 켜진다

한계를 적어둘게요. 첫 번째는 코드를 읽다가 찾은 상호작용입니다.

첫째, **초기 동기화가 발행한 라벨 재분류가 통째로 건너뛰어질 수 있습니다.**

[앞 글](/posts/28-label-reclassify-debounce-rate-limit/)에서 라벨 재분류에 stale skip을 넣었다고 적었어요. 라벨별로 최신 작업 ID를 Redis에 저장하고, 메시지의 `jobId` 가 그것과 다르면 건너뜁니다.

그런데 초기 동기화 쪽 Publisher는 `jobId` 를 안 넣어요.

```java
publishBatch(new LabelReclassifyMessage(userId, labelIds, threadBatch, null));
```

컨슈머의 판정은 이렇습니다.

```java
String latestJobId = labelReclassifyJobStore.getLatestJobId(labelId);
boolean stale = latestJobId != null && !latestJobId.equals(messageJobId);
```

`messageJobId` 가 `null` 인데 `latestJobId` 에 값이 있으면 **stale로 판정됩니다.** 그리고 `latestJobId` 는 사용자가 라벨 규칙을 수정할 때 저장되고 TTL이 1일이에요.

즉 **최근 하루 안에 라벨 규칙을 고친 적이 있는 사용자는, 그 라벨에 대해 초기 동기화가 발행한 재분류가 전부 건너뛰어집니다.** 새로 가져온 메일에 그 라벨이 안 붙어요.

처음에는 코드를 읽고 추론한 것이라 확신이 없었습니다. 그래서 `LabelReclassificationListenerTest` 에 두 케이스를 추가해 돌려봤어요.

```java
@Test
void handle_nullJobIdMessage_isTreatedAsStaleWhenLatestJobIdExists() {
    LabelReclassifyMessage message = new LabelReclassifyMessage(
            userId, Set.of(labelId), List.of(UUID.randomUUID()), null);
    when(labelReclassifyJobStore.getLatestJobId(labelId)).thenReturn("job-from-user-edit");

    listener.handle(message);

    verify(labelQueryService, never()).findAllActiveByUserId(userId);
    verify(messageLabelCommandService, never()).applyLabelsWithLock(any(), any(), anyList(), any(), any());
}
```

```
./gradlew :test --tests "...LabelReclassificationListenerTest"

tests="6" skipped="0" failures="0" errors="0"
```

**추론이 맞았습니다.** `latestJobId` 가 있으면 `findAllActiveByUserId` 조차 호출되지 않고 배치가 통째로 버려져요.

대조군도 같이 넣었습니다. `latestJobId` 가 `null` 이면(규칙을 고친 적이 없거나 TTL이 만료됐으면) 같은 메시지가 정상 처리됩니다. 그래서 **이 결함은 최근에 라벨 규칙을 고친 사용자에게만 나타나요.** 재현 조건이 좁아서 오래 안 드러난 것 같습니다.

고치는 방향은 두 가지예요. `jobId` 가 `null` 인 메시지를 stale 판정에서 빼거나, 초기 동기화 쪽 Publisher도 `jobId` 를 발급해서 `latestJobId` 에 등록하는 겁니다. 후자가 일관성 있지만, 그러면 사용자 편집으로 만든 작업을 초기 동기화가 덮어쓰게 되니 우선순위를 정해야 합니다.

두 개의 기능을 각각 만들 때는 맞았는데, 같이 놓고 보니 어긋났습니다. 한쪽은 "낡은 작업을 버린다" 였고 다른 쪽은 "새 메일에 라벨을 붙인다" 였는데, 두 번째가 첫 번째의 판정 규칙에 걸린 거예요.

둘째, **진행률을 모릅니다.** 배치 400개가 큐에 들어간 뒤로는 어디까지 처리됐는지 서버가 추적하지 않아요. 사용자에게 "동기화 중 (30%)" 을 보여줄 수 없고, 일부 배치가 DLQ로 갔을 때 알아채기도 어렵습니다.

셋째, **배치 재시도의 멱등성을 확인 안 했습니다.** `saveThreadBatch` 가 중복 저장을 막는지 코드를 따라가야 알 수 있어요. 재시도가 기본 동작인 구조에서 이걸 테스트로 못 박아두지 않은 건 구멍입니다.

넷째, **2,000개 상한이 사용자에게 안 보입니다.** 오래된 메일을 찾다가 없는 걸 발견하면 버그로 보여요.

배치 크기를 정할 때 "얼마가 효율적인가" 를 먼저 물었는데, 실제로 답을 준 건 "무엇이 먼저 마르는가" 였습니다.
