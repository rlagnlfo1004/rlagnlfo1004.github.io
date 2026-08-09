---
title: "알림을 끄려면 구독을 해지해야 했습니다 (상태 하나를 둘로 나눈 이야기)"
description: "\"알림이 너무 많아요\"라는 피드백에 대한 첫 답이 \"구독을 취소하세요\"였습니다. 그건 답이 아니었어요. 구독과 알림 수신은 애초에 다른 축이었습니다."
date: 2026-08-09
project: "아주이벤트"
tags: ["도메인 모델링", "UX", "JPA", "푸시 알림"]
---

## [배경 - 알림이 너무 많다는 말]

아주이벤트에서 게시판을 구독하면 새 공지가 올라올 때마다 푸시가 갑니다. 그게 이 서비스의 전부예요.

그런데 사용자에게 이런 얘기를 들었습니다. 시험 기간에 학사 공지가 몰리는데 알림이 계속 울려서 불편하다고요. 잠깐 알림만 안 받고 싶다는 말이었어요.

그때 제가 안내한 방법은 이거였습니다. **구독을 취소하세요.**

말해놓고 이상하다고 느꼈어요. 이 사람은 공지를 안 보겠다는 게 아니라 소리가 울리는 게 싫다는 겁니다. 그런데 제가 준 선택지는 "다 받거나 아예 끊거나" 둘뿐이었어요.

## [문제 상황 분석 - 상태 하나가 두 가지 일을 하고 있었다]

### 구독 여부가 네 가지를 결정하고 있었습니다

당시 구조에서는 `topic_members` 행이 존재하느냐가 전부를 결정했습니다.

| 행이 있으면 | 행이 없으면 |
| --- | --- |
| 푸시 알림이 간다 | 안 간다 |
| 구독 탭 목록에 뜬다 | 안 뜬다 |
| 안 읽은 공지 뱃지가 붙는다 | 안 붙는다 |
| 구독 게시판 모아보기에 포함된다 | 안 된다 |

하나의 불리언이 네 가지 동작을 묶어서 켜고 끕니다. 사용자가 그중 하나만 끄고 싶어도 방법이 없어요.

여기서 알게 된 게 있습니다. **행의 존재 여부는 관계를 표현하는 데는 좋지만 상태를 표현하는 데는 부족합니다.** 관계는 있거나 없거나지만, 상태는 여러 축을 가질 수 있으니까요.

### 두 축은 서로 독립입니다

정리해보니 사용자가 원하는 조합은 네 가지였어요.

```
                    알림 받음        알림 안 받음
  구독 중         ┌──────────────┬──────────────┐
                  │  기본 상태    │  조용히 보기  │   ← 이게 없었다
                  └──────────────┴──────────────┘
  구독 안 함      ┌──────────────┬──────────────┐
                  │   (불가능)    │   미구독     │
                  └──────────────┴──────────────┘
```

왼쪽 아래는 애초에 성립하지 않아요. 구독하지 않은 게시판의 알림을 받을 이유가 없으니까요. 그러니 실제로는 세 가지 상태가 필요한데, 저는 두 개만 만들어둔 상태였습니다.

"조용히 보기" 칸이 비어 있었던 거예요. 그리고 사용자가 요청한 건 정확히 그 칸이었습니다.

### 구독을 취소하면 되돌리기가 비쌉니다

이게 결정적이었어요. 구독 취소는 단순히 상태가 바뀌는 게 아닙니다.

```java
@Transactional
public void unsubscribeFromTopic(TopicUnsubscribeRequest request, Member member) {
    Topic topic = topicQueryService.findByDepartment(request.topic());
    tokenService.unsubscribeFromTopic(topic, member);
    topicCommandService.deleteTopicMember(topic, member);
}
```

`topic_members` 행이 지워지고, 연결된 토큰 매핑도 같이 지워집니다. 그러면 `last_read_at` 도 사라져요. 다시 구독하면 읽음 기록이 초기화됩니다.

즉 알림 하나 끄자고 구독을 취소하면 **되돌아올 때 상태가 그대로 복원되지 않아요.** 시험 기간 끝나고 다시 켜면 안 읽은 공지가 잔뜩 쌓인 것처럼 보입니다. 사용자 입장에서는 이게 손해예요.

## [해결 방법 - 수신 여부를 별도 컬럼으로 분리]

### 컬럼 하나를 추가했습니다

`TopicMember` 에 `receive_notification` 을 뒀습니다.

```java
@Entity
@Table(name = "topic_members")
public class TopicMember {
    // ...
    @Column(name = "is_read", nullable = false, columnDefinition = "TINYINT(1)")
    private boolean isRead;

    @Column(name = "last_read_at", nullable = false)
    private LocalDateTime lastReadAt;

    @Column(name = "receive_notification", nullable = false, columnDefinition = "TINYINT(1)")
    private boolean receiveNotification;

    public void updateReceiveNotification(boolean receiveNotification) {
        this.receiveNotification = receiveNotification;
    }

    public void markAsRead() {
        this.isRead = true;
        this.lastReadAt = LocalDateTime.now();
    }
}
```

컬럼 하나 추가한 게 전부입니다. 스키마 변경으로 보면 사소해요. 다만 이 컬럼이 생기면서 **행의 존재는 관계만 뜻하게 됐고, 알림 여부는 별도 축이 됐습니다.**

토글은 상태만 바꿉니다.

```java
@Transactional
public void updateNotificationPreference(Member member, String topicName, boolean receiveNotification) {
    Topic topic = topicRepositoryPort.findByDepartment(topicName)
        .orElseThrow(() -> new TopicException(TopicErrorCode.TOPIC_NOT_FOUND));

    TopicMember topicMember = topicMemberRepositoryPort.findByMemberAndTopic(member, topic)
        .orElseThrow(() -> new TopicException(TopicErrorCode.SUBSCRIPTION_NOT_FOUND));

    topicMember.updateReceiveNotification(receiveNotification);
}
```

행을 지우지 않으니 `last_read_at` 이 살아 있어요. 다시 켜도 읽음 기록 그대로입니다.

`SUBSCRIPTION_NOT_FOUND` 예외를 던지는 것도 의도한 부분이에요. 구독하지 않은 게시판의 알림 설정을 바꾸겠다는 요청은 성립하지 않습니다. 앞의 표에서 "불가능" 칸이 코드에도 반영돼 있어야 한다고 봤어요.

### 발송 대상 조회에서 한 번만 거릅니다

새 공지가 들어오면 발송 대상을 뽑는데, 이 쿼리에서 걸러집니다.

```java
@Query("SELECT tm FROM TopicMember tm JOIN FETCH tm.member "
     + "WHERE tm.topic = :topic AND tm.receiveNotification = true")
List<TopicMember> findByTopicWithMemberAndReceiveNotificationTrue(@Param("topic") Topic topic);
```

필터를 여기 한 곳에만 뒀습니다. 발송 파이프라인 뒤쪽 어디에도 이 조건이 없어요.

일부러 그랬습니다. 대상 선정은 한 곳에서 끝나야 나중에 읽는 사람이 헷갈리지 않아요. 조건이 여러 군데 흩어지면 "왜 이 사람에게 안 갔지" 를 추적할 때 전부 뒤져야 합니다.

그리고 이 필터가 발송 쪽에만 있다는 게 중요해요. 목록 조회 쿼리에는 이 조건이 없습니다. 그래서 알림을 꺼도 구독 탭에는 계속 보이고, 앱에 들어와서 공지를 확인할 수 있어요. 원래 사용자가 원했던 게 이거였습니다.

## [성과 - 개선 전후 비교]

운영 데이터로 확인한 값입니다.

| 항목 | 값 |
| --- | --- |
| 전체 구독 | 958건 |
| 알림 비활성 | 32건 |
| 비율 | 약 3.3% |

숫자 자체는 작아요. 그런데 이 32건을 어떻게 읽느냐가 중요합니다.

이 기능이 없었다면 이 32건은 **구독 취소로 갔을 가능성이 큽니다.** 알림이 부담스러운데 끄는 방법이 그것뿐이었으니까요. 그러면 지표에는 구독 수 감소로 잡혔을 거예요.

즉 이 기능이 만든 건 새로운 사용이 아니라 **이탈하지 않은 상태**입니다. 이런 건 늘어난 숫자로는 안 보이고, 줄지 않은 숫자로만 보여요.

과장하지 않고 적으면 이렇습니다. 32명이 구독을 유지한 채 알림만 껐고, 그중 몇 명이 나중에 다시 켰는지는 아직 안 봤습니다.

<!-- 측정 필요: receive_notification 을 false 로 바꿨다가 다시 true 로 되돌린 사용자 수.
     현재 스키마에는 토글 이력이 없어서 집계 불가. 이력 테이블이 필요함 -->

## [결론]

정리하면 이렇습니다.

- 행의 존재는 관계를 뜻하고, 상태는 컬럼으로 따로 표현한다
- 하나의 불리언이 네 가지 동작을 묶고 있으면 사용자는 부분 제어를 못 한다
- 되돌리기 비용이 비싼 조작을 유일한 선택지로 두면 안 된다

한계도 적어둘게요.

첫째, **키워드 구독에는 이 토글이 없습니다.** 이게 제일 큰 구멍이에요. `KeywordMember` 를 보면 `is_read` 와 `last_read_at` 만 있고 `receive_notification` 이 없습니다.

```java
@Entity
@Table(name = "keyword_members")
public class KeywordMember {
    // ...
    private boolean isRead;
    private LocalDateTime lastReadAt;
    // receiveNotification 없음
}
```

키워드 발송 대상을 뽑는 쿼리도 이 조건 없이 전원을 가져와요. 그러니까 게시판 알림은 끌 수 있는데 키워드 알림은 못 끕니다. 같은 문제를 한쪽만 고친 상태예요.

둘째, **끄는 단위가 게시판 하나입니다.** "전체 알림 일시정지" 나 "야간에는 안 받기" 같은 건 안 됩니다. 시험 기간에만 조용히 하고 싶은 사람은 구독한 게시판을 하나씩 다 꺼야 해요.

셋째, **토글 이력을 안 남깁니다.** 컬럼 값만 바꾸니 언제 껐다 켰는지 알 수 없어요. 위에 측정 필요로 남긴 것도 이 때문입니다.

넷째, **32건이라는 숫자를 해석할 근거가 약합니다.** 이 기능이 이탈을 막았다는 건 제 추정이에요. 기능 도입 전후의 구독 취소율을 비교했어야 하는데 그 데이터를 안 모아뒀습니다.

피드백은 "알림이 많다" 였는데 제가 처음 들은 건 "구독을 줄이고 싶다" 였어요. 사용자가 말한 문제와 제가 이해한 문제가 다르면 해법도 어긋납니다.
