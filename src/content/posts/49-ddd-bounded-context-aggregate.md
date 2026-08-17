---
title: "도메인 폴더는 있는데 도메인이 없었습니다 (DDD 로 아주이벤트 경계 다시 긋기)"
description: "카카오페이 여신코어 DDD 글을 읽고 제 저장소를 세어봤습니다. 엔티티 19개 중 9개가 다른 도메인 패키지를 직접 참조하고, is_read 라는 같은 컬럼명이 세 곳에서 다른 뜻이었어요. DDD 개념을 Java 코드로 정리하고 아주이벤트를 컨텍스트 다섯 개로 다시 나눠봅니다."
date: 2026-08-17
project: "아주이벤트"
tags: ["DDD", "아키텍처", "애그리거트", "바운디드 컨텍스트", "도메인 이벤트", "Spring"]
---

## [배경 - 폴더 이름이 도메인 이름이면 DDD 인가]

카카오페이와 카카오스타일의 기술 글 세 개를 연달아 읽었습니다. [여신코어를 DDD 로 구축한 이야기](https://tech.kakaopay.com/post/backend-domain-driven-design/), [PDP 서비스의 도메인 주도 헥사고날 아키텍처](https://devblog.kakaostyle.com/ko/2025-03-21-1-domain-driven-hexagonal-architecture-by-example/), 그리고 [홈 서버가 헥사고날을 도입했다가 걷어낸 이야기](https://tech.kakaopay.com/post/home-hexagonal-architecture/)예요.

첫 번째 글에 이런 문장이 있었습니다.

> 한도의 잔액을 변경하는 기능은 한도 도메인을 통해서만 사용하도록

읽자마자 제 코드가 떠올랐어요. 아주이벤트에는 `domain` 패키지가 있고 그 아래에 `clubevent`, `member`, `topic`, `keyword`, `push`, `notification` 이 나뉘어 있습니다. 이름만 보면 도메인별로 잘 나눈 구조입니다. 그런데 "이 도메인을 통해서만" 이라는 규칙이 실제로 서 있는지는 한 번도 확인해본 적이 없었어요.

그래서 세어봤습니다.

```bash
# 도메인 엔티티가 자기 패키지 밖의 도메인을 참조하는 경우
cd src/main/java/com/example/ajouevent_be_v2/domain
for f in $(find . -name "*.java"); do
  pkg=$(dirname $f | sed 's|./||')
  imports=$(grep -o "com.example.ajouevent_be_v2.domain.[a-z]*" $f \
    | sed 's|.*domain.||' | sort -u | grep -v "^$pkg$")
  [ -n "$imports" ] && echo "$pkg/$(basename $f .java) -> $imports"
done
```

| 확인한 것 | 결과 |
| --- | --- |
| 전체 코드 | 234 파일, 10,464 줄 |
| `domain` 패키지 | 19 파일, 1,029 줄 (엔티티 15개, enum 4개) |
| 엔티티 사이의 연관관계 (`@ManyToOne`, `@OneToMany`) | 26개 |
| 자기 패키지 밖 도메인을 참조하는 엔티티 | 19개 중 9개 |
| 그 참조의 총 개수 | 15개 |
| `Member` 를 import 하는 클래스 | 62개 (그중 `member` 패키지 밖 58개) |

숫자를 보고 나서 생각이 정리됐어요. **폴더는 도메인 이름으로 나뉘어 있는데, 그 안의 코드는 서로를 자유롭게 들여다봅니다.** 경계라고 부를 만한 것이 없었습니다.

<svg class="diagram" viewBox="0 0 720 404" role="img" aria-label="도메인 엔티티가 다른 도메인 패키지를 참조하는 지점을 표시한 행렬">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">엔티티 9개가 자기 패키지 밖을 15번 참조한다</text>
  <text x="250" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">clubevent</text>
  <text x="330" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">keyword</text>
  <text x="410" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">member</text>
  <text x="490" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">notification</text>
  <text x="570" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">push</text>
  <text x="650" y="44" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">topic</text>
  <line x1="0" y1="52" x2="690" y2="52" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <line x1="210" y1="30" x2="210" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="290" y1="30" x2="290" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="370" y1="30" x2="370" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="450" y1="30" x2="450" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="530" y1="30" x2="530" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="610" y1="30" x2="610" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <line x1="690" y1="30" x2="690" y2="322" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="72" font-size="11" fill="var(--ink, #16181A)">ClubEventLike</text>
  <text x="122" y="72" font-size="10" fill="var(--ink-3, #8B9099)">clubevent</text>
  <circle cx="410" cy="67" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="82" x2="690" y2="82" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="102" font-size="11" fill="var(--ink, #16181A)">Topic</text>
  <text x="122" y="102" font-size="10" fill="var(--ink-3, #8B9099)">topic</text>
  <circle cx="250" cy="97" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="112" x2="690" y2="112" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="132" font-size="11" fill="var(--ink, #16181A)">TopicMember</text>
  <text x="122" y="132" font-size="10" fill="var(--ink-3, #8B9099)">topic</text>
  <circle cx="410" cy="127" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="142" x2="690" y2="142" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="162" font-size="11" fill="var(--ink, #16181A)">Keyword</text>
  <text x="122" y="162" font-size="10" fill="var(--ink-3, #8B9099)">keyword</text>
  <circle cx="650" cy="157" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="172" x2="690" y2="172" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="192" font-size="11" fill="var(--ink, #16181A)">KeywordMember</text>
  <text x="122" y="192" font-size="10" fill="var(--ink-3, #8B9099)">keyword</text>
  <circle cx="410" cy="187" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="202" x2="690" y2="202" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <rect x="0" y="202" width="690" height="30" fill="var(--clay-soft, #EAF2FE)"/>
  <text x="0" y="222" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">Member</text>
  <text x="122" y="222" font-size="10" fill="var(--clay-text, #1B64DA)">member</text>
  <circle cx="250" cy="217" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="330" cy="217" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="650" cy="217" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="232" x2="690" y2="232" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="252" font-size="11" fill="var(--ink, #16181A)">PushCluster</text>
  <text x="122" y="252" font-size="10" fill="var(--ink-3, #8B9099)">push</text>
  <circle cx="250" cy="247" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="262" x2="690" y2="262" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="282" font-size="11" fill="var(--ink, #16181A)">PushClusterToken</text>
  <text x="122" y="282" font-size="10" fill="var(--ink-3, #8B9099)">push</text>
  <circle cx="250" cy="277" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="410" cy="277" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="292" x2="690" y2="292" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <rect x="0" y="292" width="690" height="30" fill="var(--clay-soft, #EAF2FE)"/>
  <text x="0" y="312" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">PushNotification</text>
  <text x="122" y="312" font-size="10" fill="var(--clay-text, #1B64DA)">notification</text>
  <circle cx="330" cy="307" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="410" cy="307" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="570" cy="307" r="5.5" fill="var(--clay, #3182F6)"/>
  <circle cx="650" cy="307" r="5.5" fill="var(--clay, #3182F6)"/>
  <line x1="0" y1="322" x2="690" y2="322" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <line x1="0" y1="352" x2="720" y2="352" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="372" font-size="11" fill="var(--ink-3, #8B9099)">파란 줄이 문제가 큰 둘이다. Member 는 세 도메인을 컬렉션으로 들고, PushNotification 은 네 도메인을 한꺼번에 참조한다.</text>
  <text x="0" y="392" font-size="11" fill="var(--ink-3, #8B9099)">나머지 엔티티 6개는 자기 패키지 안에만 머문다. 표에서 빠진 이유는 위반이 없기 때문이다.</text>
</svg>

이 글은 그 뒤에 정리한 내용입니다. DDD 개념을 하나씩 제 코드에 대보고, 아주이벤트를 경계로 다시 나누면 어떤 모양이 되는지까지 그려봤어요. 헥사고날 아키텍처는 별도의 주제라서 [다음 글](/posts/50-hexagonal-architecture-ports-adapters/)로 뺐습니다.

미리 밝혀둘 것이 있습니다. **이 글의 재설계는 아직 적용하지 않았습니다.** 지금 코드에서 센 숫자는 실측이지만, 나눈 뒤의 효과는 재본 값이 없어요. 설계안까지가 이 글의 범위입니다.

## [1. 도메인 - 문제 영역이지 폴더 이름이 아니다]

카카오페이 글은 도메인을 이렇게 정의합니다.

> 소프트웨어가 해결하고자 하는 문제 영역

여기서 제가 오해했던 게 드러났어요. 저는 `domain` 패키지에 JPA 엔티티를 모아두고 그걸 도메인이라고 불렀습니다. 그런데 문제 영역은 코드 바깥에 있는 것입니다. 아주이벤트의 문제 영역은 이렇게 적을 수 있어요.

> 아주대학교 각 학과 홈페이지의 공지사항을 크롤링해서, 그 공지를 구독한 학생에게 푸시로 알린다.

이 한 문장 안에 서로 성격이 다른 일이 네 개 들어 있습니다. 공지를 받아 보관하는 일, 누가 무엇을 구독했는지 관리하는 일, 실제로 푸시를 쏘고 실패를 되살리는 일, 앱 안의 알림함을 유지하는 일이에요. 지금 코드는 이 넷을 `Type` 이나 `Member` 같은 엔티티로 이어 붙여 하나처럼 다루고 있습니다.

**도메인 모델은 이 문제를 푸는 규칙이 사는 곳입니다.** 지금 제 엔티티에 규칙이 얼마나 있는지 보면 이렇습니다.

```java
// domain/clubevent/ClubEvent.java
public void incrementLikes() {
    this.likesCount++;
}

public void decreaseLikes() {
    this.likesCount--;
}
```

`likesCount` 를 1씩 올리고 내리는 것 말고는 판단이 없어요. "이미 찜한 사람이 또 찜하면 안 된다"는 규칙은 엔티티 밖에 있습니다.

```java
// orchestrator/ClubEventOrchestrator.java
public void likeEvent(Long eventId, Member member) {
    ClubEvent event = clubEventQueryService.getEventById(eventId);
    clubEventLikeCommandService.likeEvent(event, member);
}
```

규칙이 서비스로 새어 나간 상태예요. 이걸 두고 흔히 빈약한 도메인 모델이라고 부릅니다. 다만 이 자체가 곧 잘못이라고는 생각하지 않아요. 규칙이 단순하면 서비스에 두는 게 읽기 편할 때도 있습니다. 문제는 **규칙이 어디 있는지 정해두지 않았다는 점**입니다. 찜 중복 검사는 서비스에, 좋아요 카운터는 엔티티에, 재시도 상한은 또 다른 서비스에 있어요.

## [2. 유비쿼터스 언어 - 같은 단어가 세 곳에서 다른 뜻이었다]

> 도메인 전문가와 개발자가 공통으로 사용하는 언어

유비쿼터스 언어라는 말을 처음 읽었을 때는 "용어집을 만들라는 얘기인가" 정도로 이해했습니다. 그런데 제 코드에서 이게 깨진 지점을 찾으니 훨씬 구체적인 문제였어요.

### is_read 가 세 곳에 있고 셋 다 다른 뜻입니다

`is_read` 라는 컬럼이 세 테이블에 있습니다. 이름이 같으니 같은 개념일 거라고 생각했는데, 갱신되는 지점을 따라가 보면 셋 다 다른 질문에 답하고 있었어요.

<svg class="diagram" viewBox="0 0 720 300" role="img" aria-label="is_read 컬럼 세 개가 각각 다른 뜻을 가지는 것을 정리한 표">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같은 컬럼명 is_read 가 세 곳에서 다른 질문에 답한다</text>
  <text x="18" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">테이블.컬럼</text>
  <text x="270" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">이 값이 뜻하는 것</text>
  <text x="500" y="42" font-size="10.5" font-weight="700" fill="var(--ink-3, #8B9099)">true 가 되는 지점</text>
  <rect x="0" y="52" width="720" height="54" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="18" y="76" font-size="11" font-weight="700" fill="var(--ink, #16181A)">topic_members</text>
  <text x="18" y="94" font-size="11" fill="var(--ink-3, #8B9099)">.is_read</text>
  <text x="270" y="76" font-size="11" fill="var(--ink-2, #545A64)">이 카테고리 목록을</text>
  <text x="270" y="94" font-size="11" fill="var(--ink-2, #545A64)">열어봤는가</text>
  <text x="500" y="76" font-size="11" fill="var(--ink-2, #545A64)">카테고리별 공지 목록</text>
  <text x="500" y="94" font-size="11" fill="var(--ink-2, #545A64)">조회 API</text>
  <rect x="0" y="114" width="720" height="54" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="18" y="138" font-size="11" font-weight="700" fill="var(--ink, #16181A)">keyword_members</text>
  <text x="18" y="156" font-size="11" fill="var(--ink-3, #8B9099)">.is_read</text>
  <text x="270" y="138" font-size="11" fill="var(--ink-2, #545A64)">이 키워드 목록을</text>
  <text x="270" y="156" font-size="11" fill="var(--ink-2, #545A64)">열어봤는가</text>
  <text x="500" y="138" font-size="11" fill="var(--ink-2, #545A64)">단일 키워드 공지 목록</text>
  <text x="500" y="156" font-size="11" fill="var(--ink-2, #545A64)">조회 API</text>
  <rect x="0" y="176" width="720" height="54" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="18" y="200" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">push_notifications</text>
  <text x="18" y="218" font-size="11" fill="var(--clay-text, #1B64DA)">.is_read</text>
  <text x="270" y="200" font-size="11" fill="var(--clay-text, #1B64DA)">이 알림 하나를</text>
  <text x="270" y="218" font-size="11" fill="var(--clay-text, #1B64DA)">눌렀는가</text>
  <text x="500" y="200" font-size="11" fill="var(--clay-text, #1B64DA)">알림 읽음 처리 API</text>
  <text x="500" y="218" font-size="11" fill="var(--clay-text, #1B64DA)">(clicked_at 도 같이 찍는다)</text>
  <line x1="0" y1="256" x2="720" y2="256" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="276" font-size="11" fill="var(--ink-3, #8B9099)">앞의 둘은 뱃지를 끄는 신호이고, 마지막 하나는 알림 한 건의 상태다. 앞의 둘은 구독에 붙고 뒤의 하나는 알림함에 붙는다.</text>
  <text x="0" y="296" font-size="11" fill="var(--ink-3, #8B9099)">그런데 이름이 같아서, 코드를 읽을 때마다 어느 쪽 읽음인지 매번 다시 확인해야 한다.</text>
</svg>

앞의 두 개는 "구독한 카테고리에 새 글이 있다는 뱃지를 끌 것인가"이고, 마지막 하나는 "알림함의 이 줄을 읽음으로 표시할 것인가"입니다. 서로 다른 개념인데 이름이 같아요.

실제로 이 때문에 버그가 났습니다. 저장소 커밋 이력에 `[Fix] 알림 목록 조회 시 isRead 항상 true 반환 문제` 가 남아 있어요. 이름이 같으면 코드를 읽는 사람도 같은 것으로 읽습니다.

유비쿼터스 언어의 값어치가 여기 있다고 이해했어요. **용어집을 예쁘게 만드는 일이 아니라, 뜻이 다르면 이름을 다르게 쓰는 일**입니다. 뒤에서 컨텍스트를 나눌 때 이 셋은 각각 `categoryBadgeCleared`, `keywordBadgeCleared`, `readAt` 처럼 다른 이름을 갖게 됩니다.

### 그리고 단어가 남의 집에 살고 있었습니다

더 노골적인 사례가 하나 있었어요.

```java
// domain/clubevent/JobStatus.java
package com.example.ajouevent_be_v2.domain.clubevent;

public enum JobStatus {
    PENDING, IN_PROGRESS, SUCCESS, RETRY_PENDING,
    PARTIAL_FAIL, FAIL, PERMANENT_FAIL, NONE
}
```

푸시 발송의 상태 머신입니다. [21번 글](/posts/21-transactional-outbox-push-recovery/)에서 여섯 개 상태로 나눴다고 쓴 그 값들이에요. 그런데 이게 `clubevent` 패키지에 있습니다.

```bash
$ grep -rln "domain.clubevent.JobStatus" src/main/java
domain/push/PushCluster.java
domain/push/PushClusterToken.java
repository/adapter/push/PushClusterJpaRepositoryAdapter.java
repository/adapter/push/PushClusterTokenJpaRepositoryAdapter.java
repository/port/push/PushClusterRepositoryPort.java
repository/port/push/PushClusterTokenRepositoryPort.java
service/push/PushClusterCommandService.java
service/webhook/FcmPushResultService.java
```

여덟 개 클래스가 씁니다. 그리고 **그중 `clubevent` 패키지의 클래스는 하나도 없어요.** 공지 도메인은 이 enum 을 쓰지 않습니다. 처음에 어디 둘지 고민하다가 손에 닿는 곳에 만들었고, 그 뒤로 아무도 옮기지 않은 흔적입니다.

`Type` enum 도 비슷합니다. 58개 학과와 분류를 담은 enum 이 `domain/clubevent` 에 있는데, 정작 `topics` 테이블은 이 값에 유니크 제약을 걸어 자기 식별자로 씁니다.

```java
// domain/topic/Topic.java
@Enumerated(EnumType.STRING)
@Column(name = "type", unique = true)
private Type type;
```

카테고리라는 개념의 정본이 공지 쪽인지 구독 쪽인지가 코드로는 판단되지 않아요.

## [3. 바운디드 컨텍스트 - 뜻이 갈리는 곳이 경계다]

> 도메인을 명확하게 구분 짓는 경계

`is_read` 를 정리하다가 바운디드 컨텍스트가 왜 필요한지 이해했습니다. 같은 단어에 뜻이 두 개 붙었을 때, 이름을 하나로 통일하려 애쓰는 게 답이 아니에요. **같은 단어가 다른 뜻으로 쓰이는 지점, 거기가 경계입니다.**

`Member` 로 보면 더 분명해집니다. 지금 `Member` 엔티티를 import 하는 클래스가 62개이고 그중 58개가 `member` 패키지 밖에 있어요. 이 58개가 `Member` 를 부르는 이유는 서로 다릅니다.

| 부르는 쪽 | 필요한 것 | 필요 없는 것 |
| --- | --- | --- |
| 공지 조회 | 이 사람이 찜했는지 볼 식별자 | 이름, 학과, 디바이스 토큰 |
| 구독 관리 | 구독 주체 식별자, 수신 여부 | 이메일, 권한 |
| 푸시 발송 | 보낼 디바이스 토큰 목록 | 이름, 학과 |
| 알림함 | 알림의 수신자 식별자 | 토큰, 구독 정보 |
| 로그인 | 이메일, 권한, 리프레시 토큰 | 구독, 찜 |

한 클래스가 다섯 가지 역할을 겸하고 있습니다. 그래서 필드 하나를 고칠 때 어디가 깨질지 예측이 안 돼요.

아주이벤트를 나눈다면 컨텍스트는 다섯 개가 됩니다. 기준은 [13번 글](/posts/13-common-platform-not-msa/)에서 소유권을 정할 때 쓴 것과 같아요. **"이 데이터가 바뀔 때 누가 요구하는가."**

<svg class="diagram" viewBox="0 0 720 452" role="img" aria-label="아주이벤트를 다섯 개의 바운디드 컨텍스트로 나눈 컨텍스트 맵">
  <defs>
    <marker id="d49a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d49b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">컨텍스트 다섯 개와 그 사이를 흐르는 것</text>
  <rect x="0" y="28" width="180" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="90" y="46" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">크롤러 (Go, 외부)</text>
  <line x1="90" y1="56" x2="90" y2="76" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49a)"/>
  <text x="100" y="72" font-size="10" fill="var(--ink-3, #8B9099)">webhook</text>
  <rect x="0" y="80" width="215" height="104" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="16" y="102" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">공지 Notice</text>
  <text x="16" y="122" font-size="10.5" fill="var(--ink-2, #545A64)">Notice, NoticeImage</text>
  <text x="16" y="138" font-size="10.5" fill="var(--ink-2, #545A64)">Like, ViewCount, Banner</text>
  <text x="16" y="158" font-size="10" fill="var(--ink-3, #8B9099)">카테고리 코드의 정본을</text>
  <text x="16" y="172" font-size="10" fill="var(--ink-3, #8B9099)">여기가 소유한다</text>
  <rect x="252" y="80" width="215" height="104" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="268" y="102" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">구독 Subscription</text>
  <text x="268" y="122" font-size="10.5" fill="var(--ink-2, #545A64)">CategorySubscription</text>
  <text x="268" y="138" font-size="10.5" fill="var(--ink-2, #545A64)">KeywordSubscription</text>
  <text x="268" y="158" font-size="10" fill="var(--ink-3, #8B9099)">누구에게 보낼지 정하는</text>
  <text x="268" y="172" font-size="10" fill="var(--ink-3, #8B9099)">규칙을 여기가 소유한다</text>
  <rect x="504" y="80" width="216" height="104" rx="8" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="520" y="102" font-size="12" font-weight="700" fill="var(--ink, #16181A)">회원 Identity</text>
  <text x="520" y="122" font-size="10.5" fill="var(--ink-2, #545A64)">Member, RefreshToken</text>
  <text x="520" y="138" font-size="10.5" fill="var(--ink-2, #545A64)">OAuth 연동</text>
  <text x="520" y="158" font-size="10" fill="var(--ink-3, #8B9099)">디바이스 토큰은 여기가</text>
  <text x="520" y="172" font-size="10" fill="var(--ink-3, #8B9099)">더 이상 갖지 않는다</text>
  <path d="M215 118 L252 118" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49b)"/>
  <text x="233" y="112" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">이벤트</text>
  <path d="M467 148 L504 148" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49a)"/>
  <text x="486" y="142" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">id 조회</text>
  <rect x="252" y="228" width="215" height="104" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="268" y="250" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">발송 Delivery</text>
  <text x="268" y="270" font-size="10.5" fill="var(--ink-2, #545A64)">PushCluster, PushTarget</text>
  <text x="268" y="286" font-size="10.5" fill="var(--ink-2, #545A64)">DeviceToken</text>
  <text x="268" y="306" font-size="10" fill="var(--ink-3, #8B9099)">재시도 상한과 토큰 폐기를</text>
  <text x="268" y="320" font-size="10" fill="var(--ink-3, #8B9099)">여기가 소유한다</text>
  <rect x="0" y="228" width="215" height="104" rx="8" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="16" y="250" font-size="12" font-weight="700" fill="var(--clay-text, #1B64DA)">알림함 Inbox</text>
  <text x="16" y="270" font-size="10.5" fill="var(--ink-2, #545A64)">Notification</text>
  <text x="16" y="286" font-size="10.5" fill="var(--ink-2, #545A64)">UnreadCount</text>
  <text x="16" y="306" font-size="10" fill="var(--ink-3, #8B9099)">푸시가 도달하지 않아도</text>
  <text x="16" y="320" font-size="10" fill="var(--ink-3, #8B9099)">여기 기록은 남는다</text>
  <rect x="504" y="256" width="216" height="48" rx="8" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="612" y="276" font-size="11" text-anchor="middle" fill="var(--ink-2, #545A64)">FCM (외부)</text>
  <text x="612" y="293" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">Anticorruption Layer 로 감싼다</text>
  <path d="M359 184 L359 228" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49b)"/>
  <text x="369" y="208" font-size="9.5" fill="var(--clay-text, #1B64DA)">발송 요청 이벤트</text>
  <path d="M300 184 L120 228" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49b)"/>
  <text x="150" y="204" font-size="9.5" fill="var(--clay-text, #1B64DA)">같은 이벤트</text>
  <path d="M467 280 L504 280" fill="none" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49a)"/>
  <line x1="0" y1="360" x2="720" y2="360" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="380" font-size="11" fill="var(--ink-3, #8B9099)">파란 화살표는 도메인 이벤트다. 보내는 쪽은 받는 쪽을 모른다. 회색 화살표는 식별자 조회이고 동기 호출이다.</text>
  <text x="0" y="400" font-size="11" fill="var(--ink-3, #8B9099)">발송 요청 이벤트를 발송과 알림함이 같이 받는다. 알림함이 발송 결과를 기다리지 않는 것은 지금 코드와 같은 동작이다.</text>
  <text x="0" y="420" font-size="11" fill="var(--ink-3, #8B9099)">카테고리 코드는 공지가 소유하고 구독은 문자열로만 참조한다. enum 을 공유하지 않는다.</text>
  <text x="0" y="440" font-size="11" fill="var(--ink-3, #8B9099)">디바이스 토큰은 회원이 아니라 발송이 소유한다. 발송 실패로 토큰을 폐기하는 쪽이 발송이기 때문이다.</text>
</svg>

토큰 소유권을 옮긴 이유를 짚고 싶어요. 지금은 이런 코드가 있습니다.

```java
// service/webhook/FcmPushResultService.java
case UNREGISTERED:
    // 앱 삭제 또는 토큰 만료 — 재시도해도 동일 실패. 즉시 영구 실패 + 토큰 삭제
    token.markAsFail();
    invalidTokenValues.add(token.getTokenValue());
    return 1;
// ...
tokenRepositoryPort.batchSoftDeleteByTokenValues(invalidTokenValues);
```

발송 결과를 처리하는 서비스가 회원 도메인의 `tokens` 테이블을 소프트 삭제합니다. 남의 데이터를 지우고 있어요. 그런데 이건 코드를 잘못 쓴 게 아니라 **경계를 잘못 그은 결과**입니다. 디바이스 토큰의 유효성을 판정할 수 있는 유일한 주체는 FCM 응답을 보는 발송 쪽이니까요. 그러면 토큰은 발송이 소유하는 게 맞습니다.

## [4. 애그리거트 - 트랜잭션 경계이고 참조 경계다]

> 데이터의 일관성을 유지하기 위한 트랜젝션의 경계
> Aggregate Root를 통해서만 Aggregate 내부 접근 및 수정

애그리거트를 오래 "연관된 엔티티 묶음"으로만 이해했습니다. 그런데 카카오페이 글이 트랜잭션 경계라고 못 박은 걸 보고 기준이 잡혔어요. **한 트랜잭션에서 같이 바뀌어야 하는 것만 한 애그리거트에 넣는다.** 나머지는 밖입니다.

이 기준으로 보면 아주이벤트에 이미 잘 잡힌 애그리거트가 하나 있어요.

```java
// domain/push/PushCluster.java
@OneToMany(mappedBy = "pushCluster", fetch = FetchType.LAZY,
           cascade = CascadeType.ALL, orphanRemoval = true)
private List<PushClusterToken> tokens;
```

`PushCluster` 와 `PushClusterToken` 은 같이 바뀝니다. 발송 대상 목록을 만들 때 함께 저장되고, 배치 결과가 오면 토큰 상태와 클러스터 카운터가 같은 트랜잭션에서 갱신돼요. 루트는 `PushCluster` 하나입니다. 여기까지는 교과서대로 되어 있습니다.

문제는 `Member` 예요.

```java
// domain/member/Member.java
@OneToMany(mappedBy = "member", cascade = {CascadeType.PERSIST, CascadeType.REMOVE}, orphanRemoval = true)
private List<Token> tokens;

@OneToMany(mappedBy = "member", cascade = {CascadeType.PERSIST, CascadeType.REMOVE}, orphanRemoval = true)
private List<ClubEventLike> clubEventLikeList;

@OneToMany(mappedBy = "member", cascade = {CascadeType.PERSIST, CascadeType.REMOVE}, orphanRemoval = true)
private List<TopicMember> topicMembers;

@OneToMany(mappedBy = "member", cascade = {CascadeType.PERSIST, CascadeType.REMOVE}, orphanRemoval = true)
private List<KeywordMember> keywordMembers;
```

컬렉션 네 개가 매달려 있고, 그중 셋은 다른 도메인의 엔티티입니다. 회원 이름을 바꾸는 트랜잭션과 찜을 추가하는 트랜잭션은 아무 관계가 없는데, 모델은 둘을 한 덩어리로 묶어두고 있어요.

<svg class="diagram" viewBox="0 0 720 356" role="img" aria-label="Member 를 중심으로 모든 것이 매달린 구조와 애그리거트를 나눈 구조의 비교">
  <defs>
    <marker id="d49c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">객체로 참조할 때와 식별자로 참조할 때</text>
  <text x="0" y="42" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">지금의 구조. Member 가 네 컬렉션을 들고 있다</text>
  <rect x="0" y="52" width="346" height="230" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <rect x="118" y="70" width="110" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="173" y="91" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Member</text>
  <line x1="140" y1="104" x2="70" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49c)"/>
  <line x1="163" y1="104" x2="150" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49c)"/>
  <line x1="183" y1="104" x2="216" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49c)"/>
  <line x1="206" y1="104" x2="286" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49c)"/>
  <rect x="18" y="146" width="104" height="30" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="70" y="165" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">Token</text>
  <rect x="130" y="146" width="60" height="30" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="160" y="160" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">ClubEvent</text>
  <text x="160" y="172" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Like</text>
  <rect x="198" y="146" width="60" height="30" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="228" y="160" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Topic</text>
  <text x="228" y="172" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Member</text>
  <rect x="266" y="146" width="62" height="30" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="297" y="160" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Keyword</text>
  <text x="297" y="172" font-size="9.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Member</text>
  <text x="18" y="204" font-size="10.5" fill="var(--ink-2, #545A64)">애그리거트 하나에 도메인 네 개가 들어 있다.</text>
  <text x="18" y="222" font-size="10.5" fill="var(--ink-2, #545A64)">cascade REMOVE 가 넷 모두에 걸려 있어서,</text>
  <text x="18" y="240" font-size="10.5" fill="var(--ink-2, #545A64)">회원 삭제가 남의 도메인 데이터까지 지운다.</text>
  <text x="18" y="266" font-size="10.5" font-weight="700" fill="var(--clay-text, #1B64DA)">Member 를 import 하는 클래스 62개</text>
  <text x="374" y="42" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">나눈 뒤. 경계 밖은 식별자로만 부른다</text>
  <rect x="374" y="52" width="346" height="230" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <rect x="392" y="70" width="140" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="462" y="91" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Member</text>
  <text x="548" y="84" font-size="10" fill="var(--ink-3, #8B9099)">이메일, 이름, 학과,</text>
  <text x="548" y="98" font-size="10" fill="var(--ink-3, #8B9099)">권한만 갖는다</text>
  <rect x="392" y="126" width="150" height="32" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="404" y="146" font-size="10" fill="var(--ink-2, #545A64)">DeviceToken</text>
  <text x="556" y="146" font-size="10" fill="var(--ink-3, #8B9099)">memberId: Long</text>
  <rect x="392" y="166" width="150" height="32" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="404" y="186" font-size="10" fill="var(--ink-2, #545A64)">NoticeLike</text>
  <text x="556" y="186" font-size="10" fill="var(--ink-3, #8B9099)">memberId: Long</text>
  <rect x="392" y="206" width="150" height="32" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="404" y="226" font-size="10" fill="var(--ink-2, #545A64)">CategorySubscription</text>
  <text x="556" y="226" font-size="10" fill="var(--ink-3, #8B9099)">memberId: Long</text>
  <text x="392" y="266" font-size="10.5" font-weight="700" fill="var(--clay-text, #1B64DA)">참조가 끊기면 트랜잭션도 따라 나뉜다</text>
  <line x1="0" y1="310" x2="720" y2="310" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="330" font-size="11" fill="var(--ink-3, #8B9099)">오른쪽의 대가는 조인이 사라진 자리다. 화면 하나를 그리려면 컨텍스트 두 곳에 각각 물어 조립해야 한다.</text>
  <text x="0" y="350" font-size="11" fill="var(--ink-3, #8B9099)">아주이벤트는 이미 그렇게 하고 있다. 목록 조회에서 이미지와 찜 여부를 IN 절로 따로 가져와 조립한다.</text>
</svg>

### 애그리거트 밖은 식별자로 참조합니다

규칙 하나만 지키면 대부분 정리됩니다. **애그리거트 안은 객체로 참조하고, 밖은 ID 로 참조한다.** 지금 코드를 이 규칙에 맞추면 이렇게 됩니다.

```java
// 지금
@ManyToOne(fetch = FetchType.LAZY)
@JoinColumn(name = "member_id", nullable = false)
private Member member;

// 나눈 뒤
@Column(name = "member_id", nullable = false)
private Long memberId;
```

간단해 보이지만 효과가 큽니다. `PushNotification` 이 네 도메인을 참조하는 문제도 이걸로 풀려요. 지금은 `PushCluster`, `Topic`, `Keyword`, `Member` 를 전부 객체로 들고 있으면서, 정작 제목과 본문은 클러스터에서 복사해 자기 컬럼에 넣어둡니다.

```java
// service/notification/NotificationPushService.java
PushNotification.builder()
    .pushCluster(cluster)     // 객체 참조
    .topic(topic)             // 객체 참조
    .keyword(keyword)         // 객체 참조
    .member(member)           // 객체 참조
    .title(cluster.getTitle())        // 값 복사
    .body(cluster.getBody())          // 값 복사
    .imageUrl(cluster.getImageUrl())  // 값 복사
    .clickUrl(cluster.getClickUrl())  // 값 복사
    .build();
```

값을 복사한 판단은 옳았다고 생각해요. 알림함은 과거의 기록이니까 원본이 나중에 바뀌어도 그때 보낸 내용이 남아야 합니다. 그런데 복사를 해두고 객체 참조도 같이 들고 있으니 두 방식이 섞여 있는 상태예요. 스냅샷으로 가기로 했으면 참조는 ID 로 내려야 합니다.

### 애그리거트 루트를 Java 로 옮기면

카카오페이 글의 코드 규약은 Kotlin 기준입니다. 생성자를 `private` 으로 막고 팩토리 메서드만 열고, 변경 가능한 속성은 `internal set` 으로 잠근다고 되어 있어요. Java 로 옮기면 이렇게 됩니다.

```java
package com.ajouevent.delivery.domain;

@Entity
@Table(name = "push_clusters")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)   // JPA 용. 외부에서 못 부른다
public class PushCluster {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** 다른 애그리거트는 객체가 아니라 식별자로만 참조한다. */
    @Column(name = "notice_id", nullable = false)
    private Long noticeId;

    @Embedded
    private PushContent content;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private DeliveryStatus status;

    @Embedded
    private DeliveryCount count;

    private PushCluster(Long noticeId, PushContent content, int totalCount) {
        this.noticeId = noticeId;
        this.content = content;
        this.status = DeliveryStatus.PENDING;
        this.count = DeliveryCount.start(totalCount);
    }

    /**
     * 생성은 커맨드를 받는 정적 팩토리로만 한다.
     * 빌더를 열어두면 상태 조합을 아무도 통제하지 못한다.
     */
    public static PushCluster create(CreateCommand command) {
        return new PushCluster(command.noticeId(), command.content(), command.totalCount());
    }

    public record CreateCommand(Long noticeId, PushContent content, int totalCount) {
        public CreateCommand {
            if (totalCount <= 0) {
                throw new IllegalArgumentException("발송 대상이 없으면 클러스터를 만들지 않는다");
            }
        }
    }

    /** 상태 전이는 이 메서드를 통해서만 일어난다. 밖에서 setStatus 를 부를 방법이 없다. */
    public void markInProgress() {
        if (status != DeliveryStatus.PENDING) {
            throw new IllegalStateException("PENDING 이 아닌 클러스터를 시작할 수 없다: " + status);
        }
        this.status = DeliveryStatus.IN_PROGRESS;
    }

    public void applyResult(int success, int fail) {
        this.count = count.add(success, fail);
        if (count.isSettled()) {
            this.status = count.hasFailure() ? DeliveryStatus.PARTIAL_FAIL : DeliveryStatus.SUCCESS;
        }
    }
}
```

`@Builder` 를 지운 게 핵심이에요. 지금 코드는 빌더가 열려 있어서 어디서든 `jobStatus(SUCCESS)` 로 시작하는 클러스터를 만들 수 있습니다. 팩토리로 좁히면 "발송 대상이 0명이면 클러스터를 만들지 않는다" 같은 규칙을 한 곳에 세울 수 있어요.

값 객체도 같이 나옵니다.

```java
/** 식별자가 없고 값으로 비교되며 바뀌지 않는다. 이게 밸류 오브젝트다. */
@Embeddable
@Getter
@EqualsAndHashCode
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PushContent {

    @Column(nullable = false) private String title;
    @Column(nullable = false) private String body;
    @Column(nullable = false) private String imageUrl;
    @Column(nullable = false) private String clickUrl;

    public PushContent(String title, String body, String imageUrl, String clickUrl) {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("푸시 제목은 비어 있을 수 없다");
        }
        this.title = title;
        this.body = body;
        this.imageUrl = imageUrl;
        this.clickUrl = clickUrl;
    }
}
```

지금은 이 네 값이 `PushCluster` 와 `PushNotification` 에 각각 흩어져 있고, 검증도 없습니다. `imageUrl` 이 없으면 기본 이미지로 채우는 규칙은 서비스에 있어요.

```java
// service/push/PushClusterCommandService.java
private String resolveImageUrl(ClubEventCommand command) {
    List<String> images = Optional.ofNullable(command.images())
        .filter(imgs -> !imgs.isEmpty())
        .orElseGet(() -> List.of(fcmProperties.getDefaultImageUrl()));
    return images.get(0);
}
```

이건 값 객체 안으로 들어가는 게 자연스럽습니다. 정확히는 기본값 출처가 설정 파일이라 그대로 옮기기는 어려워요. 팩토리에 기본값을 주입해서 만드는 쪽이 현실적입니다.

## [5. 도메인 모델과 JPA 엔티티 - 카카오페이가 한 겹 더 나눈 이유]

위 코드는 JPA 엔티티가 곧 애그리거트 루트입니다. 카카오페이는 여기서 한 겹 더 나눴어요.

> 도메인 모듈은 Application이 직접 JPA Entity를 접근하는 것을 막습니다. 대신 Application은 DomainEntity를 통해 명령(command)을 전달합니다.

이유는 이렇게 적혀 있습니다.

> 도메인 설계가 DB Table 구조에 종속되지 않을 수 있으며, 도메인의 기능의 확장을 유연하게 할 수 있습니다

Java 로 옮기면 세 조각이 됩니다. 도메인 모델, 리포지토리 인터페이스, 그리고 변환을 맡는 JPA 어댑터예요.

```java
// ── delivery/domain. 순수 Java 이고 JPA 를 모른다
package com.ajouevent.delivery.domain;

public class PushCluster {

    private final PushClusterId id;          // null 이면 아직 저장 안 된 것
    private final NoticeId noticeId;
    private final PushContent content;
    private DeliveryStatus status;
    private DeliveryCount count;

    // 값 객체는 record 로 쓴다. JPA 매핑을 신경 쓸 필요가 없다
    public record PushClusterId(long value) {}
    public record NoticeId(long value) {}
    public record PushContent(String title, String body, String imageUrl, String clickUrl) {
        public PushContent {
            if (title == null || title.isBlank()) throw new IllegalArgumentException("제목이 없다");
        }
    }

    public static PushCluster create(NoticeId noticeId, PushContent content, int totalCount) { ... }

    public void applyResult(int success, int fail) { ... }
}
```

```java
// ── delivery/domain. 인터페이스도 도메인 쪽에 둔다
public interface PushClusterRepository {
    PushCluster save(PushCluster cluster);
    Optional<PushCluster> findById(PushClusterId id);
}
```

```java
// ── delivery/persistence. 여기만 JPA 를 안다. 패키지 밖으로 안 나간다
@Entity
@Table(name = "push_clusters")
class PushClusterJpaEntity {              // public 이 아니다
    @Id @GeneratedValue Long id;
    Long noticeId;
    String title;
    String body;
    // ...

    static PushClusterJpaEntity from(PushCluster domain) { ... }
    PushCluster toDomain() { ... }
}

@Repository
@RequiredArgsConstructor
class PushClusterRepositoryImpl implements PushClusterRepository {

    private final PushClusterJpaRepository jpa;

    @Override
    public PushCluster save(PushCluster cluster) {
        return jpa.save(PushClusterJpaEntity.from(cluster)).toDomain();
    }
}
```

Kotlin 의 `internal` 이 Java 에는 없으니, JPA 엔티티를 패키지 프라이빗으로 두고 `persistence` 패키지 밖에서는 아예 보이지 않게 만듭니다. 컴파일러가 경계를 지켜주는 셈이에요.

### 다만 카카오페이도 여기서 대가를 치렀습니다

같은 글에 아쉬웠던 점이 솔직하게 적혀 있어요. 배치에서는 JPA 엔티티에 직접 접근하는 게 유리한데 `internal` 로 막아뒀으니 접근할 수 없었다는 얘기입니다.

> 동일한 DB Table을 사용하는 다른 JPA Entity를 중복으로 만들게 되었고 도메인 변경에서 개발자가 잊지 않고 챙겨하는 포인트가 늘어나게 되었습니다

이 대목에서 제 규모를 다시 봤습니다. 아주이벤트는 전체 10,464 줄이고 도메인 코드는 1,029 줄이에요. 엔티티 15개에 테이블 15개입니다. 여기에 도메인 모델과 JPA 엔티티를 따로 두면 매핑 코드가 최소 15쌍 늘어납니다.

그래서 저는 **한 겹으로 갑니다.** JPA 엔티티를 애그리거트 루트로 쓰고, 대신 `@Builder` 를 닫고 ID 참조 규칙만 지키는 쪽이요. 4번 절의 코드가 그 버전입니다. 나중에 배치나 통계 모듈이 붙어서 같은 테이블을 다르게 읽어야 할 때가 오면 그때 나누면 됩니다.

이 판단은 [7번 글](/posts/07-retro-overengineering/)에서 했던 반성과 같은 방향이에요. 근거 없는 규모를 가정해서 구조를 먼저 세우면 비용만 남습니다.

## [6. 도메인 이벤트 - 오케스트레이터가 하던 일을 누가 받는가]

경계를 그으면 바로 문제가 생깁니다. 공지 하나가 들어오면 구독을 조회하고 발송 대상을 만들고 알림함에 적어야 하는데, 컨텍스트를 나누면 서로를 부를 수 없어요.

지금은 오케스트레이터가 이 일을 합니다.

```java
// orchestrator/WebhookOrchestrator.java
public WebhookResponse processWebhook(String crawlingToken, WebhookRequest request) {
    webhookService.validateToken(crawlingToken);
    ClubEventCommand command = request.toClubEventCommand();
    ClubEvent clubEvent = clubEventOrchestrator.createClubEvent(command);
    List<PushClusterSendRequest> sendRequests = pushOrchestrator.createClusters(clubEvent, command);
    if (!sendRequests.isEmpty()) {
        fcmOrchestrator.dispatchClusters(sendRequests);
    }
    return new WebhookResponse(...);
}
```

읽기 좋은 코드라고 생각합니다. 순서가 한눈에 보이고 디버깅도 쉬워요. 문제는 이 클래스가 네 컨텍스트를 전부 알아야 한다는 점입니다. 그 아래 `PushOrchestrator` 는 구독과 발송과 알림함을 같이 부르고, `ClubEventOrchestrator` 는 서비스 9개를 주입받고 있어요.

<svg class="diagram" viewBox="0 0 720 448" role="img" aria-label="지금의 호출 사슬과 도메인 이벤트로 뒤집은 흐름의 비교">
  <defs>
    <marker id="d49d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d49e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">공지 한 건이 들어왔을 때 지금과 나눈 뒤</text>
  <text x="0" y="42" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">지금의 구조. 한 호출 스택 안에서 네 도메인이 다 열린다</text>
  <rect x="0" y="52" width="720" height="146" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <rect x="18" y="70" width="150" height="30" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="93" y="89" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">WebhookOrchestrator</text>
  <line x1="93" y1="100" x2="93" y2="120" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49d)"/>
  <rect x="18" y="124" width="150" height="26" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="93" y="141" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">공지 저장</text>
  <line x1="168" y1="137" x2="200" y2="137" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49d)"/>
  <rect x="204" y="112" width="150" height="50" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="279" y="130" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">구독 조회</text>
  <text x="279" y="146" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">키워드 매칭</text>
  <line x1="354" y1="137" x2="386" y2="137" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49d)"/>
  <rect x="390" y="112" width="150" height="50" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="465" y="130" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">클러스터 생성</text>
  <text x="465" y="146" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">알림함 적재</text>
  <line x1="540" y1="137" x2="572" y2="137" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49d)"/>
  <rect x="576" y="112" width="126" height="50" rx="5" fill="none" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="639" y="130" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">FCM 발송</text>
  <text x="639" y="146" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">결과 반영</text>
  <text x="18" y="182" font-size="10.5" fill="var(--ink-3, #8B9099)">한 곳이 넷을 다 알아야 한다. 순서가 코드에 박혀 있어서 알림함 로직을 바꿀 때도 이 파일을 연다.</text>
  <text x="0" y="236" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">나눈 뒤. 보내는 쪽이 받는 쪽을 모른다</text>
  <rect x="0" y="246" width="720" height="152" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <rect x="18" y="266" width="160" height="44" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="98" y="284" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">공지 컨텍스트</text>
  <text x="98" y="300" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">저장하고 커밋한다</text>
  <path d="M178 288 L226 288" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49e)"/>
  <text x="202" y="280" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">AFTER</text>
  <text x="202" y="304" font-size="9" text-anchor="middle" fill="var(--clay-text, #1B64DA)">COMMIT</text>
  <rect x="230" y="266" width="170" height="44" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="315" y="284" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">NoticePublished</text>
  <text x="315" y="300" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">공지 id, 카테고리 코드, 제목</text>
  <path d="M400 288 L448 288" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49e)"/>
  <rect x="452" y="266" width="160" height="44" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="532" y="284" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">구독 컨텍스트</text>
  <text x="532" y="300" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">받을 사람을 확정한다</text>
  <path d="M532 310 L532 330 L300 330 L300 348" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d49e)"/>
  <text x="416" y="326" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">PushRequested (수신자 목록, 내용)</text>
  <rect x="130" y="352" width="170" height="34" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="215" y="373" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">알림함 컨텍스트</text>
  <rect x="320" y="352" width="170" height="34" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="405" y="373" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">발송 컨텍스트</text>
  <path d="M300 348 L215 352" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1" marker-end="url(#d49e)"/>
  <path d="M300 348 L405 352" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1" marker-end="url(#d49e)"/>
  <line x1="0" y1="418" x2="720" y2="418" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="438" font-size="11" fill="var(--ink-3, #8B9099)">아래 구조의 대가는 흐름이 코드 한 곳에 안 보이는 것이다. 장애를 볼 때 이벤트를 따라 파일을 옮겨 다녀야 한다.</text>
</svg>

Spring 에서는 추가 라이브러리 없이 됩니다.

```java
// ── notice 컨텍스트
@Service
@RequiredArgsConstructor
public class PublishNoticeService {

    private final NoticeRepository noticeRepository;
    private final ApplicationEventPublisher events;

    @Transactional
    public NoticeId publish(PublishNoticeCommand command) {
        Notice notice = noticeRepository.save(Notice.publish(command));
        // 공지 컨텍스트는 누가 이 이벤트를 받는지 모른다
        events.publishEvent(new NoticePublished(
            notice.id(), notice.categoryCode(), notice.title(), notice.url(), notice.thumbnailUrl()));
        return notice.id();
    }
}
```

```java
// ── contract 모듈. 컨텍스트 사이를 흐르는 계약이므로 엔티티를 담지 않는다
public record NoticePublished(
    long noticeId,
    String categoryCode,   // Type enum 이 아니라 문자열이다
    String title,
    String url,
    String thumbnailUrl
) {}
```

```java
// ── subscription 컨텍스트. 공지 컨텍스트를 import 하지 않는다
@Component
@RequiredArgsConstructor
public class NoticePublishedHandler {

    private final SubscriberFinder subscriberFinder;
    private final ApplicationEventPublisher events;

    /**
     * AFTER_COMMIT 으로 받는다. 공지 저장이 롤백되면 발송도 없어야 하기 때문이다.
     * 반대로 커밋 이후에 이 핸들러가 죽으면 이벤트는 사라진다. 그 구멍은 아래에 따로 적었다.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(NoticePublished event) {
        List<Long> categoryTargets = subscriberFinder.findByCategory(event.categoryCode());
        if (!categoryTargets.isEmpty()) {
            events.publishEvent(PushRequested.forCategory(event, categoryTargets));
        }
        subscriberFinder.findMatchingKeywords(event.categoryCode(), event.title())
            .forEach(match -> events.publishEvent(PushRequested.forKeyword(event, match)));
    }
}
```

이렇게 하면 `WebhookOrchestrator` 는 공지 저장까지만 알면 됩니다. 발송 로직이 바뀌어도 웹훅 진입점은 안 열어요.

### 그런데 이벤트만으로는 유실을 막지 못합니다

`AFTER_COMMIT` 은 트랜잭션이 끝난 뒤에 실행됩니다. 그 사이에 프로세스가 죽으면 이벤트는 사라져요. 공지는 저장됐는데 아무에게도 안 가는 상태가 됩니다.

이건 제가 이미 겪은 문제예요. [21번 글](/posts/21-transactional-outbox-push-recovery/)에서 발송 대상을 공지 저장과 **같은 트랜잭션에** 테이블로 적고, 스케줄러가 남은 것을 되살리는 구조로 풀었습니다. 그러니까 DDD 의 도메인 이벤트를 실제로 쓰려면 Transactional Outbox 가 같이 필요합니다.

```java
@Transactional
public NoticeId publish(PublishNoticeCommand command) {
    Notice notice = noticeRepository.save(Notice.publish(command));
    // 같은 트랜잭션에서 이벤트를 테이블에 적는다. 여기까지가 원자적이다
    outbox.append(new NoticePublished(...));
    return notice.id();
}
```

개념을 알고 나서 보니, 제가 21번 글에서 만든 것이 사실 Outbox 패턴의 절반이었어요. 발송 대상 테이블이 outbox 역할을 하고 있었습니다. 다만 이벤트를 저장한 게 아니라 발송 대상을 저장했으니, 그 테이블은 발송 컨텍스트에 속합니다. 컨텍스트를 나누면 공지 쪽에 별도의 outbox 가 하나 더 필요해요.

## [실무 적용 - 컨텍스트를 모듈로 만들면]

카카오페이는 경계를 Gradle 모듈로 못 박았습니다.

> Bounded Context는 Gradle module(Sub project)의 단위

각 도메인 모듈은 "서로 연관관계를 맺지 않습니다" 라고 되어 있고, 애플리케이션 모듈만 여러 도메인 모듈을 참조합니다. 아주이벤트에 적용하면 이렇게 됩니다.

```groovy
// settings.gradle
rootProject.name = 'ajouevent'

include 'app-api'          // 컨트롤러와 부팅. 컨텍스트들을 조립한다
include 'app-batch'         // 스케줄러
include 'contract'          // 컨텍스트 사이의 이벤트와 커맨드만 담는다

include 'context:notice'
include 'context:subscription'
include 'context:delivery'
include 'context:inbox'
include 'context:identity'
```

```groovy
// context/delivery/build.gradle
dependencies {
    implementation project(':contract')
    // 다른 context 모듈을 여기 적지 않는다. 적을 수 없게 하는 것이 목적이다
}
```

<svg class="diagram" viewBox="0 0 720 330" role="img" aria-label="컨텍스트를 Gradle 모듈로 나눴을 때의 의존 방향">
  <defs>
    <marker id="d49f" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">컨텍스트 모듈은 서로를 참조하지 않는다. 위와 아래만 본다</text>
  <rect x="150" y="30" width="180" height="34" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="240" y="52" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">app-api</text>
  <rect x="390" y="30" width="180" height="34" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="480" y="52" font-size="11" text-anchor="middle" fill="var(--ink, #16181A)">app-batch</text>
  <line x1="200" y1="64" x2="105" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="230" y1="64" x2="222" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="260" y1="64" x2="358" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="290" y1="64" x2="490" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="320" y1="64" x2="620" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="460" y1="64" x2="380" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="500" y1="64" x2="512" y2="112" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <rect x="0" y="116" width="132" height="60" rx="6" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="66" y="140" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">context:notice</text>
  <text x="66" y="158" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">공지, 찜, 조회수</text>
  <rect x="147" y="116" width="132" height="60" rx="6" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="213" y="140" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">subscription</text>
  <text x="213" y="158" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">구독, 수신 여부</text>
  <rect x="294" y="116" width="132" height="60" rx="6" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="360" y="140" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">delivery</text>
  <text x="360" y="158" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">클러스터, 토큰</text>
  <rect x="441" y="116" width="132" height="60" rx="6" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="507" y="140" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">inbox</text>
  <text x="507" y="158" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">알림함, 뱃지</text>
  <rect x="588" y="116" width="132" height="60" rx="6" fill="none" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="654" y="140" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">identity</text>
  <text x="654" y="158" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">회원, 인증</text>
  <line x1="66" y1="176" x2="300" y2="212" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="213" y1="176" x2="330" y2="212" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="360" y1="176" x2="360" y2="212" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="507" y1="176" x2="390" y2="212" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <line x1="654" y1="176" x2="420" y2="212" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d49f)"/>
  <rect x="240" y="216" width="240" height="40" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="360" y="232" font-size="11" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">contract</text>
  <text x="360" y="248" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">이벤트 record 와 식별자 타입만</text>
  <line x1="0" y1="284" x2="720" y2="284" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="304" font-size="11" fill="var(--ink-3, #8B9099)">contract 에 엔티티를 넣으면 그 순간 다시 하나가 된다. 이벤트 record 와 식별자 타입까지만 둔다.</text>
  <text x="0" y="324" font-size="11" fill="var(--ink-3, #8B9099)">지금은 단일 모듈 234 파일이다. 모듈로 쪼개면 빌드 설정과 순환 참조 정리 비용이 먼저 온다.</text>
</svg>

모듈까지 가지 않더라도 규칙을 테스트로 못 박는 방법이 있습니다. ArchUnit 이에요.

```java
@AnalyzeClasses(packages = "com.ajouevent")
class BoundaryTest {

    /** 컨텍스트 패키지끼리 서로 참조하지 않는다 */
    @ArchTest
    static final ArchRule 컨텍스트는_서로를_모른다 =
        SlicesRuleDefinition.slices()
            .matching("com.ajouevent.context.(*)..")
            .should().notDependOnEachOther();

    /** 도메인 모델은 프레임워크를 모른다 */
    @ArchTest
    static final ArchRule 도메인은_스프링과_JPA를_모른다 =
        noClasses().that().resideInAPackage("..domain..")
            .should().dependOnClassesThat()
            .resideInAnyPackage("org.springframework..", "jakarta.persistence..");
}
```

아직 저장소에 넣지 않았습니다. 지금 코드에 이 규칙을 걸면 얼마나 깨지는지가 궁금하네요.

<!-- 측정 필요: AjouEvent_BE_V2 에 ArchUnit(com.tngtech.archunit:archunit-junit5) 을 추가하고
     위 두 규칙을 실행해서 위반 건수를 센다.
     실행: ./gradlew test --tests "*BoundaryTest*"
     현재 grep 으로 센 위반은 엔티티 레벨 15건이지만, 서비스와 어댑터까지 포함한 전체 수는 모른다. -->

### 무엇을 얻고 무엇을 잃는가

얻는 것을 먼저 적으면, 지금 코드에서 실제로 불편했던 세 가지가 풀립니다.

첫째, `is_read` 처럼 뜻이 겹친 이름이 사라져요. 컨텍스트가 다르면 이름도 달라집니다.

둘째, 남의 데이터를 지우는 코드가 사라집니다. 발송이 토큰을 소유하면 `batchSoftDeleteByTokenValues` 는 자기 애그리거트를 다루는 정상적인 코드가 돼요.

셋째, 변경 범위가 예측 가능해집니다. 지금은 `Member` 를 고치면 58개 클래스가 사정권에 들어옵니다.

잃는 것도 분명합니다. 홈 서버 글이 헥사고날을 걷어낸 이유가 그대로 적용돼요.

> 신규 기능 개발 시 Domain, Port, Adapter 전 레이어를 수정해야 하는 비효율

컨텍스트를 나누면 조인이 사라집니다. "구독한 카테고리의 최신 공지" 같은 화면 하나가 두 컨텍스트에 걸치는데, 지금은 쿼리 한 방이고 나눈 뒤에는 두 번 물어 조립해야 해요. 아주이벤트는 이미 목록 조회에서 이미지와 찜 여부를 따로 가져와 조립하니 낯선 방식은 아니지만, 그 지점이 늘어납니다.

그리고 흐름이 한 곳에 안 보입니다. 지금은 `WebhookOrchestrator` 한 파일만 읽으면 공지가 들어와서 푸시가 나가기까지 전부 보여요. 이벤트로 바꾸면 파일 넷을 옮겨 다녀야 합니다.

규모도 봐야 합니다. [20번 글](/posts/20-fcm-callback-async-thread-pool/)에서 확인한 실제 트래픽은 최근 90일 동안 푸시 75,000건, 하루 평균 830건이었어요. 이 규모에 컨텍스트 다섯 개와 모듈 다섯 개는 과합니다. 홈 서버 글의 결론이 여기 그대로 걸려요.

> 은탄환은 없다는 말, 소프트웨어를 개발하면 어느 상황에서든 적용되는 말

### 그래서 제가 실제로 할 것

전부 하지는 않겠습니다. 비용 대비 효과가 분명한 것부터 순서를 정했어요.

| 할 것 | 비용 | 효과 |
| --- | --- | --- |
| `JobStatus` 를 `domain/push` 로 옮긴다 | import 8줄 | 단어가 제 집에 산다 |
| `is_read` 셋의 이름을 뜻대로 나눈다 | 컬럼명 마이그레이션 | 같은 버그가 다시 안 난다 |
| 디바이스 토큰 소유를 발송으로 옮긴다 | 패키지 이동과 서비스 정리 | 남의 데이터를 지우지 않는다 |
| 엔티티 `@Builder` 를 팩토리로 좁힌다 | 엔티티 15개 | 상태 조합이 통제된다 |
| 애그리거트 밖 참조를 ID 로 바꾼다 | 쿼리와 조립 코드 다수 | 트랜잭션 경계가 보인다 |
| ArchUnit 으로 규칙을 못 박는다 | 의존성 하나 | 규칙이 문서가 아니라 테스트가 된다 |
| Gradle 모듈로 쪼갠다 | 빌드 전면 개편 | 지금 규모에서는 보류 |

위의 다섯 개는 모듈을 안 쪼개도 됩니다. **경계는 모듈보다 먼저 이름과 참조에서 만들어진다**는 게 이번에 얻은 결론이에요.

## [결론]

DDD 를 "도메인별로 패키지를 나누는 것"으로 알고 있었습니다. 그래서 이미 하고 있다고 생각했어요. 세어보니 폴더만 나뉘어 있었습니다.

정리하면서 배운 것을 세 가지로 적어둘게요.

1. **경계는 뜻이 갈리는 곳에 있습니다.** `is_read` 가 세 곳에서 다른 질문에 답하고 있다는 걸 발견한 게 컨텍스트를 나눈 출발점이었어요. 이름이 겹치는 곳을 찾는 게 경계를 찾는 일이었습니다.
2. **애그리거트는 묶음이 아니라 트랜잭션 경계입니다.** 같이 커밋돼야 하는 것만 안에 넣고 나머지는 ID 로 부른다는 규칙 하나로, `Member` 에 매달린 컬렉션 네 개의 처리가 정해졌어요.
3. **소유권은 판정할 수 있는 쪽에 둡니다.** 디바이스 토큰이 유효한지 아는 건 FCM 응답을 보는 발송 쪽뿐이었습니다. 그래서 토큰은 발송 것이에요.

한계도 적어둡니다. 이 글의 재설계는 아직 코드가 아닙니다. 위 표의 순서대로 옮길 계획이지만, 옮기고 나서 정말 변경이 쉬워졌는지는 재봐야 알아요. 그리고 카카오페이가 얻은 가장 큰 값어치는 코드가 아니라 **기획자와 도메인 전문가가 같은 언어를 쓰게 된 것**이었는데, 이건 혼자 만드는 서비스에서는 그대로 얻기 어렵습니다.

> 개발자와 기획자, 여신 전문가 모두가 기술 용어가 아닌, 모두가 이해하는 도메인 중심의 언어로 소통하면서 요구사항의 모호함이 줄어들고

혼자 쓰는 유비쿼터스 언어도 값이 있다고는 생각해요. 반년 뒤의 저는 남이니까요.

## [참고 자료]

- [백엔드 개발자의 도메인 주도 설계(DDD) 경험기](https://tech.kakaopay.com/post/backend-domain-driven-design/) 카카오페이
- [Domain-Driven 헥사고날 아키텍처 by example](https://devblog.kakaostyle.com/ko/2025-03-21-1-domain-driven-hexagonal-architecture-by-example/) 카카오스타일
- [카카오페이 홈 서버는 왜 헥사고날 아키텍처를 걷어냈을까?](https://tech.kakaopay.com/post/home-hexagonal-architecture/) 카카오페이
