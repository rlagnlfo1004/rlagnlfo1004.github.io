---
title: "포트라고 이름 붙였는데 포트가 아니었습니다 (헥사고날 정의와 두 저장소 비교)"
description: "아주이벤트의 포트 17개 중 15개가 인터페이스가 아니라 어댑터를 주입받는 구체 클래스였습니다. 아올다 클라우드는 포트 59개가 모두 인터페이스예요. Cockburn 의 원래 정의로 돌아가 primary 와 secondary 포트의 방향을 정리하고, 두 저장소가 어디서 갈렸는지 세어봤습니다."
date: 2026-08-17
project: "공통"
tags: ["헥사고날 아키텍처", "아키텍처", "포트와 어댑터", "의존성 역전", "OpenStack", "Spring"]
---

## [배경 - 같은 이름을 두 저장소에서 다르게 쓰고 있었다]

[49번 글](/posts/49-ddd-bounded-context-aggregate/)에서 DDD 개념을 제 코드에 대보다가 곁가지로 발견한 게 있습니다. 아주이벤트에는 `repository/port` 와 `repository/adapter` 패키지가 있고, 아올다 클라우드(ACC)에는 `service/ports`, `repository/ports`, `external/ports` 가 있어요. 둘 다 헥사고날 아키텍처의 용어를 쓰고 있습니다.

그런데 성격을 세어보니 정반대였습니다.

```bash
# 포트 파일이 interface 인지 class 인지 센다
for f in $(find repository/port -name "*.java"); do
  echo "$(basename $f): $(grep -m1 -oE 'public (interface|class)' $f)"
done
```

| | 아주이벤트 | 아올다 클라우드 |
| --- | --- | --- |
| 전체 규모 | 234 파일, 10,464 줄 | 773 파일, 47,263 줄 |
| 포트 파일 | 17개 | 59개 |
| 그중 인터페이스 | 2개 | 59개 |
| 그중 구체 클래스 | 15개 | 0개 |
| 포트가 어댑터를 import | 15개 | 0개 |

아주이벤트의 포트는 대부분 이렇게 생겼습니다.

```java
// repository/port/push/PushClusterRepositoryPort.java
@Repository
@RequiredArgsConstructor
public class PushClusterRepositoryPort {

    private final PushClusterJpaRepositoryAdapter pushClusterJpaRepositoryAdapter;

    public Optional<PushCluster> findById(Long id) {
        return pushClusterJpaRepositoryAdapter.findById(id);
    }

    public PushCluster save(PushCluster pushCluster) {
        return pushClusterJpaRepositoryAdapter.save(pushCluster);
    }
    // ...
}
```

포트가 어댑터를 주입받아서 그대로 넘깁니다. 화살표가 안쪽이 아니라 바깥쪽을 향해요. **이건 포트가 아니라 위임 클래스입니다.**

<svg class="diagram" viewBox="0 0 720 300" role="img" aria-label="두 저장소의 포트 성격 비교와 의존 화살표 방향">
  <defs>
    <marker id="d50a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
    <marker id="d50b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">같은 이름의 두 구조. 화살표 방향이 반대다</text>
  <text x="0" y="42" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">아주이벤트. 포트 17개 중 15개가 구체 클래스</text>
  <rect x="0" y="52" width="720" height="76" rx="8" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <rect x="18" y="72" width="130" height="36" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="83" y="94" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Service</text>
  <line x1="148" y1="90" x2="188" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50b)"/>
  <rect x="192" y="72" width="150" height="36" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="267" y="88" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">XxxRepositoryPort</text>
  <text x="267" y="102" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">class</text>
  <line x1="342" y1="90" x2="382" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50b)"/>
  <rect x="386" y="72" width="160" height="36" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="466" y="88" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">JpaRepositoryAdapter</text>
  <text x="466" y="102" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">class</text>
  <line x1="546" y1="90" x2="586" y2="90" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50b)"/>
  <rect x="590" y="72" width="112" height="36" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="646" y="94" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">JpaRepository</text>
  <text x="0" y="170" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">아올다 클라우드. 포트 59개가 모두 인터페이스</text>
  <rect x="0" y="180" width="720" height="76" rx="8" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <rect x="18" y="200" width="130" height="36" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="83" y="222" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Module</text>
  <line x1="148" y1="218" x2="188" y2="218" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50a)"/>
  <rect x="192" y="200" width="150" height="36" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="267" y="216" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">XxxRepositoryPort</text>
  <text x="267" y="230" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">interface</text>
  <line x1="382" y1="218" x2="346" y2="218" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50a)"/>
  <rect x="386" y="200" width="160" height="36" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="466" y="216" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">XxxRepositoryAdapter</text>
  <text x="466" y="230" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">implements</text>
  <line x1="546" y1="218" x2="586" y2="218" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50a)"/>
  <rect x="590" y="200" width="112" height="36" rx="5" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="646" y="222" font-size="10.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">JpaRepository</text>
  <line x1="0" y1="278" x2="720" y2="278" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="296" font-size="11" fill="var(--ink-3, #8B9099)">아래 줄에서 어댑터의 화살표만 왼쪽을 향한다. 어댑터가 포트를 구현하기 때문이다. 이 한 방향이 헥사고날의 전부다.</text>
</svg>

이 글은 그래서 헥사고날의 원래 정의로 돌아가 보고, 두 저장소가 어디서 갈렸는지 세어본 기록입니다. 그리고 아올다 클라우드도 잘한 것만 있지는 않았어요.

## [1. 헥사고날의 정의 - 육각형은 중요하지 않다]

Alistair Cockburn 이 2005년에 쓴 원문의 의도는 한 문장입니다.

> Allow an application to equally be driven by users, programs, automated test or batch scripts, and to be developed and tested in isolation from its eventual run-time devices and databases.

두 개를 말하고 있어요. 하나는 **애플리케이션을 무엇이 구동하든 똑같이 동작하게** 만드는 것입니다. 사람이 브라우저로 부르든, 배치 스크립트가 부르든, 테스트가 부르든 같은 입구를 쓴다는 뜻이에요. 다른 하나는 **최종적으로 붙을 장치와 DB 없이도 개발하고 테스트할 수 있게** 만드는 것입니다.

육각형인 이유도 원문에 적혀 있습니다.

> The hexagon is not a hexagon because the number six is important, but rather to allow the people doing the drawing to have room to insert ports and adapters as they need, not being constrained by a one-dimensional layered drawing.

여섯이라는 숫자는 아무 의미가 없어요. 계층을 위아래로 쌓는 그림에서 벗어나려고 고른 모양입니다. 그리고 그렇게 한 목적이 이거예요.

> The hexagon is intended to visually highlight (a) the inside-outside asymmetry and the similar nature of ports

**안과 밖의 비대칭.** 이 단어가 핵심이라고 생각합니다. 레이어드 아키텍처는 위아래를 그리는데, 위아래는 대칭이에요. 컨트롤러가 서비스를 부르고 서비스가 리포지토리를 부르는 한 줄입니다. 헥사고날은 안과 밖을 그리고, 안이 밖을 모르는 게 규칙입니다.

<svg class="diagram" viewBox="0 0 720 340" role="img" aria-label="레이어드 아키텍처의 한 방향 흐름과 헥사고날의 안팎 비대칭 비교">
  <defs>
    <marker id="d50c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d50d" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">한 줄로 흐르는 그림과 안팎으로 나눈 그림</text>
  <text x="0" y="40" font-size="11.5" font-weight="700" fill="var(--ink-2, #545A64)">레이어드. 화살표가 한 방향으로만 간다</text>
  <rect x="0" y="52" width="140" height="34" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="70" y="74" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Controller</text>
  <line x1="140" y1="69" x2="176" y2="69" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50c)"/>
  <rect x="180" y="52" width="140" height="34" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="250" y="74" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Service</text>
  <line x1="320" y1="69" x2="356" y2="69" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50c)"/>
  <rect x="360" y="52" width="140" height="34" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="430" y="74" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">Repository</text>
  <line x1="500" y1="69" x2="536" y2="69" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50c)"/>
  <rect x="540" y="52" width="140" height="34" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="610" y="74" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">DB</text>
  <text x="0" y="106" font-size="10.5" fill="var(--ink-3, #8B9099)">서비스가 리포지토리를 안다. DB 기술을 바꾸면 서비스가 따라 바뀔 수 있다.</text>
  <text x="0" y="146" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">헥사고날. 화살표가 전부 안쪽을 향한다</text>
  <rect x="230" y="160" width="260" height="130" rx="10" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="360" y="186" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">Application</text>
  <text x="360" y="206" font-size="10.5" text-anchor="middle" fill="var(--ink-2, #545A64)">유스케이스와 도메인 규칙</text>
  <rect x="248" y="218" width="100" height="26" rx="4" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="298" y="235" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">primary port</text>
  <rect x="372" y="218" width="100" height="26" rx="4" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="0.8"/>
  <text x="422" y="235" font-size="9.5" text-anchor="middle" fill="var(--clay-text, #1B64DA)">secondary port</text>
  <text x="360" y="266" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">두 포트 모두 애플리케이션이 소유한다</text>
  <text x="360" y="282" font-size="10" text-anchor="middle" fill="var(--ink-3, #8B9099)">밖의 이름이 여기 들어오지 않는다</text>
  <rect x="18" y="176" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="83" y="196" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">REST Controller</text>
  <rect x="18" y="212" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="83" y="232" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">Scheduler</text>
  <rect x="18" y="248" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="83" y="268" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">Test</text>
  <line x1="148" y1="191" x2="226" y2="220" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <line x1="148" y1="227" x2="226" y2="229" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <line x1="148" y1="263" x2="226" y2="238" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <text x="18" y="166" font-size="10" font-weight="700" fill="var(--ink-3, #8B9099)">driving adapter</text>
  <rect x="572" y="176" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="637" y="196" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">JPA Adapter</text>
  <rect x="572" y="212" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="637" y="232" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">OpenStack Adapter</text>
  <rect x="572" y="248" width="130" height="30" rx="5" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="637" y="268" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">Fake (테스트용)</text>
  <line x1="572" y1="191" x2="494" y2="220" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <line x1="572" y1="227" x2="494" y2="229" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <line x1="572" y1="263" x2="494" y2="238" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50d)"/>
  <text x="572" y="166" font-size="10" font-weight="700" fill="var(--ink-3, #8B9099)">driven adapter</text>
  <line x1="0" y1="312" x2="720" y2="312" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="332" font-size="11" fill="var(--ink-3, #8B9099)">양쪽 화살표가 모두 육각형을 향한다. 밖은 안을 알지만 안은 밖을 모른다. 이 비대칭이 육각형으로 그리는 이유다.</text>
</svg>

## [2. Primary 와 Secondary - 이름은 비슷한데 방향이 반대다]

포트가 두 종류라는 걸 알고 나서야 아주이벤트의 코드가 왜 틀렸는지 설명할 수 있었어요. 원문의 구분은 이렇습니다.

> A primary actor is an actor that drives the application (takes it out of quiescent state to perform one of its advertised functions). A secondary actor is one that the application drives, either to get answers from or to merely notify.

그리고 그림에서의 위치까지 정해줍니다.

> primary ports and primary adapters on the left side (or top) of the hexagon, and the secondary ports and secondary adapters on the right (or bottom) side

주도하는 쪽이 primary 이고, 주도당하는 쪽이 secondary 입니다. 흔히 driving 과 driven 이라고도 불러요. 여기서 헷갈리기 쉬운 점이 하나 있습니다. **두 포트는 구현체가 있는 곳이 반대입니다.**

| | primary (driving, inbound) | secondary (driven, outbound) |
| --- | --- | --- |
| 누가 주도하나 | 밖이 안을 부른다 | 안이 밖을 부른다 |
| 인터페이스를 정의하는 곳 | 애플리케이션 | 애플리케이션 |
| 구현체가 있는 곳 | 애플리케이션 안 | 애플리케이션 밖 |
| 어댑터의 역할 | 인터페이스를 **호출** | 인터페이스를 **구현** |
| 예 | 유스케이스 인터페이스 | 리포지토리, 외부 API 클라이언트 |

정의하는 곳은 둘 다 애플리케이션입니다. 이게 두 포트의 공통점이고, Cockburn 이 "similar nature of ports" 라고 쓴 부분이라고 이해했어요. 그런데 구현체 위치가 반대라서, 코드로 옮기면 모양이 다르게 생깁니다.

```java
// ── primary port. 애플리케이션이 세상에 제공하는 기능 목록이다
package com.ajouevent.notice.application.port.in;

public interface PublishNoticeUseCase {
    NoticeId publish(PublishNoticeCommand command);
}
```

```java
// ── primary port 의 구현체는 안에 있다
package com.ajouevent.notice.application;

@Service
@RequiredArgsConstructor
class PublishNoticeService implements PublishNoticeUseCase {   // 패키지 프라이빗
    private final NoticeRepository noticeRepository;           // secondary port 를 쓴다

    @Override
    public NoticeId publish(PublishNoticeCommand command) { ... }
}
```

```java
// ── driving adapter 는 primary port 를 부른다. 구현하지 않는다
package com.ajouevent.notice.adapter.in.web;

@RestController
@RequiredArgsConstructor
public class WebhookController {
    private final PublishNoticeUseCase publishNotice;   // 인터페이스에만 의존한다

    @PostMapping("/webhook/notice")
    public WebhookResponse receive(@RequestBody WebhookRequest request) {
        NoticeId id = publishNotice.publish(request.toCommand());
        return WebhookResponse.of(id);
    }
}
```

```java
// ── secondary port. 애플리케이션이 밖에 요구하는 것이다
package com.ajouevent.notice.application.port.out;

public interface NoticeRepository {
    Notice save(Notice notice);
    Optional<Notice> findById(NoticeId id);
}
```

```java
// ── driven adapter 는 secondary port 를 구현한다. 여기만 JPA 를 안다
package com.ajouevent.notice.adapter.out.persistence;

@Repository
@RequiredArgsConstructor
class NoticeJpaAdapter implements NoticeRepository {
    private final NoticeJpaRepository jpa;

    @Override
    public Notice save(Notice notice) {
        return jpa.save(NoticeJpaEntity.from(notice)).toDomain();
    }
}
```

`PublishNoticeService` 를 보면 `NoticeJpaAdapter` 라는 이름이 어디에도 없습니다. 컴파일할 때 그 클래스가 존재하지 않아도 됩니다. 이게 헥사고날이 말하는 격리예요.

### 컨트롤러 없이도 애플리케이션이 돌아가는가

원문 의도의 "equally be driven by users, programs, automated test or batch scripts" 를 실감한 지점이 있어요. 아주이벤트에는 스케줄러가 다섯 개 있습니다.

```
CrawlingTokenScheduler
PopularEventCacheScheduler
PushPollingPublisherScheduler
TokenValidationScheduler
ViewCountScheduler
```

이 스케줄러들은 컨트롤러와 같은 자격의 driving adapter 입니다. HTTP 요청이 아니라 시간이 애플리케이션을 깨우는 것뿐이에요. 그런데 지금 코드에서는 스케줄러가 서비스 구현 클래스를 직접 주입받습니다. primary port 가 없으니 "무엇이 부르든 같은 입구"라는 원래 목표가 절반만 서 있는 셈입니다.

## [3. 그래서 아주이벤트의 포트는 포트가 아니었다]

정의를 정리하고 나서 다시 보면 문제가 명확해집니다.

```java
// repository/port/push/PushClusterRepositoryPort.java
import com.example.ajouevent_be_v2.repository.adapter.push.PushClusterJpaRepositoryAdapter;

@Repository
@RequiredArgsConstructor
public class PushClusterRepositoryPort {
    private final PushClusterJpaRepositoryAdapter pushClusterJpaRepositoryAdapter;
```

포트가 어댑터를 import 합니다. 17개 중 15개가 그래요. 그러면 secondary port 의 정의가 깨집니다. 안이 밖을 모르는 게 규칙인데, 포트 파일 자체가 어댑터 클래스 이름을 알고 있으니까요.

정직하게 짚을 것이 하나 있습니다. **이 구조가 동작을 망가뜨리지는 않습니다.** 서비스는 잘 돌아가고 있어요. 그리고 Mockito 는 구체 클래스도 mock 할 수 있으니 테스트도 됩니다. 그래서 이걸 버그라고 부를 수는 없습니다.

실제로 잃는 것은 세 가지예요.

**첫째, 구현을 갈아끼울 수 없습니다.** 카카오스타일 PDP 글에 나온 사례가 정확히 이 지점이었어요.

> 로컬 캐시 추가 시 Output Port 구현체만 변경되며, 비즈니스 로직 변경은 전혀 발생하지 않습니다

아주이벤트에서 공지 목록에 캐시를 붙이려면 어떻게 해야 할까요. 지금 구조에서는 포트 클래스의 메서드 본문을 열어서 캐시 조회를 끼워 넣어야 합니다. 서비스가 그 포트의 타입에 직접 묶여 있으니까요.

**둘째, 727줄이 위임만 합니다.** 포트 15개 중 12개는 조건문도 반복문도 없이 어댑터 호출만 넘기는 코드예요. 인터페이스라면 시그니처만 있으니 그게 정상이지만, 클래스라서 본문이 있고 그 본문이 전부 한 줄 위임입니다. 추상화의 값어치는 없고 파일 개수만 늘어난 상태입니다.

**셋째, 이름이 거짓말을 합니다.** 다음에 이 코드를 읽는 사람은 포트라는 이름을 보고 대체 가능한 인터페이스를 기대할 겁니다. 카카오페이 홈 서버 글이 지적한 것도 결국 이 문제였어요.

> 외부 세계(infrastructure)의 구현이 내부의 인터페이스(domain)를 정의하는 주객전도 현상을 낳았습니다

### 인터페이스가 된 두 개는 캐시였습니다

재미있는 게 있었어요. 17개 중 인터페이스인 2개가 무엇인지 보니 둘 다 캐시였습니다.

```java
// repository/port/clubevent/ClubEventCachePort.java
public interface ClubEventCachePort {
    Optional<SliceResult<ClubEventSummaryResult>> getTypeEvents(Type type, String keyword, Pageable pageable);
    void saveTypeEvents(Type type, String keyword, Pageable pageable, SliceResult<ClubEventSummaryResult> events);
    // ...
}
```

`ClubEventCachePort` 와 `CrawlingTokenCachePort` 입니다. 그리고 각각 구현체가 하나뿐이에요. 그런데도 인터페이스로 만든 건, 캐시는 언젠가 바꿀 것 같다는 감각이 있었기 때문일 겁니다.

여기서 배운 게 있습니다. **저는 이미 기준을 알고 있었어요.** 바뀔 것 같은 곳은 인터페이스로 만들었고, 안 바뀔 것 같은 곳은 클래스로 만들었습니다. 문제는 안 바뀔 것 같은 곳에도 포트라는 이름을 붙인 것이었어요. 이름을 지웠으면 그냥 리포지토리 래퍼였고 아무 문제가 없었습니다.

고치는 방법은 간단합니다. 포트를 인터페이스로 바꾸고 어댑터가 구현하게 하면 됩니다.

```java
// 고친 뒤. 인터페이스는 도메인 쪽에 두고 구현은 어댑터가 한다
public interface PushClusterRepository {
    Optional<PushCluster> findById(Long id);
    PushCluster save(PushCluster pushCluster);
    void incrementCountsAndUpdateStatus(Long id, int successDelta, int failDelta);
}

@Repository
@RequiredArgsConstructor
class PushClusterJpaAdapter implements PushClusterRepository {
    private final PushClusterJpaRepository jpa;
    // ...
}
```

파일 개수는 그대로인데 화살표 방향이 바뀝니다. 위임 본문이 사라지고 시그니처만 남아요.

## [4. 아올다 클라우드는 어떻게 했나]

아올다 클라우드는 OpenStack 위에 올린 대학 클라우드 서비스입니다. Nova, Neutron, Cinder, Glance, Keystone 같은 OpenStack 컴포넌트의 REST API 를 조합해서 화면을 만들어요. 여기서는 포트를 세 층으로 나눴습니다.

<svg class="diagram" viewBox="0 0 720 386" role="img" aria-label="아올다 클라우드의 실제 계층 구조와 각 층의 파일 수">
  <defs>
    <marker id="d50e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #8B9099)"/>
    </marker>
    <marker id="d50f" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--clay, #3182F6)"/>
    </marker>
  </defs>
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">포트 세 층. 괄호 안은 실제 파일 수와 줄 수</text>
  <rect x="230" y="28" width="260" height="34" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="360" y="49" font-size="10.5" text-anchor="middle" fill="var(--ink, #16181A)">Controller  (45 파일, 9,686 줄)</text>
  <line x1="360" y1="62" x2="360" y2="82" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50e)"/>
  <rect x="190" y="86" width="340" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="360" y="107" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">service/ports  interface 23개  (387 줄)</text>
  <rect x="556" y="86" width="164" height="34" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="638" y="102" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">service/adapters</text>
  <text x="638" y="115" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">22 파일, 2,141 줄</text>
  <line x1="556" y1="103" x2="534" y2="103" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50f)"/>
  <line x1="360" y1="120" x2="360" y2="140" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50e)"/>
  <rect x="190" y="144" width="340" height="40" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <text x="360" y="162" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--ink, #16181A)">service/modules  (39 파일, 4,914 줄)</text>
  <text x="360" y="177" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">여러 유스케이스가 공유하는 기능 단위</text>
  <line x1="270" y1="184" x2="180" y2="216" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50e)"/>
  <line x1="450" y1="184" x2="540" y2="216" stroke="var(--ink-3, #8B9099)" stroke-width="1" marker-end="url(#d50e)"/>
  <rect x="0" y="220" width="330" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="165" y="241" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">repository/ports  interface 14개  (298 줄)</text>
  <rect x="390" y="220" width="330" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <text x="555" y="241" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">external/ports  interface 22개  (448 줄)</text>
  <rect x="0" y="266" width="330" height="40" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="165" y="284" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">repository/adapters (14) → jpa (14)</text>
  <text x="165" y="299" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">QueryDSL 모듈 5개는 여기 붙는다</text>
  <rect x="390" y="266" width="330" height="40" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.8"/>
  <text x="555" y="284" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">external/adapters (22) → modules (64)</text>
  <text x="555" y="299" font-size="9.5" text-anchor="middle" fill="var(--ink-3, #8B9099)">HTTP 호출은 마지막 한 클래스로 모인다</text>
  <line x1="165" y1="266" x2="165" y2="258" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50f)"/>
  <line x1="555" y1="266" x2="555" y2="258" stroke="var(--clay, #3182F6)" stroke-width="1.2" marker-end="url(#d50f)"/>
  <rect x="0" y="318" width="330" height="26" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="165" y="335" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">MySQL</text>
  <rect x="390" y="318" width="330" height="26" rx="5" fill="var(--sunk, #F1F3F6)"/>
  <text x="555" y="335" font-size="10" text-anchor="middle" fill="var(--ink-2, #545A64)">OpenStack  (Nova, Neutron, Cinder, Glance, Keystone)</text>
  <line x1="0" y1="362" x2="720" y2="362" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="380" font-size="11" fill="var(--ink-3, #8B9099)">파란 상자가 인터페이스다. 위쪽 하나는 primary port 이고 아래쪽 둘은 secondary port 다. 어댑터의 화살표만 파란 상자를 향한다.</text>
</svg>

`service/ports` 23개가 primary port 이고, `repository/ports` 14개와 `external/ports` 22개가 secondary port 입니다. 59개 전부 인터페이스예요.

### 어댑터가 진짜 어댑터 일을 합니다

driven adapter 의 값어치를 가장 잘 보여주는 코드가 인스턴스 목록 조회입니다. 포트 시그니처는 이렇게 깔끔해요.

```java
// external/ports/NovaServerExternalPort.java
public interface NovaServerExternalPort {
    PageResponse<InstanceResponse> callListInstances(
        String keystoneToken, String projectId, String marker, String direction, int limit);
    void callCreateInstance(String keystoneToken, String projectId, InstanceCreateRequest request);
}
```

`InstanceResponse` 는 우리 타입입니다. Nova 의 타입이 아니에요. 그럼 Nova 의 응답은 누가 우리 타입으로 바꾸느냐, 어댑터가 합니다.

```java
// external/adapters/nova/NovaServerExternalAdapter.java
private List<InstanceResponse> parseServers(ResponseEntity<NovaServersResponse> response) {
    List<InstanceResponse> servers = new ArrayList<>();
    for (NovaServersResponse.Server server : response.getBody().getServers()) {
        List<String> internalIps = new ArrayList<>();
        List<String> externalIps = new ArrayList<>();

        // addresses Map을 순회하며 IP 주소 추출
        if (server.getAddresses() != null) {
            server.getAddresses().values().forEach(addressList ->
                addressList.forEach(addr -> {
                    if ("fixed".equals(addr.getType())) {
                        internalIps.add(addr.getAddr());
                    } else if ("floating".equals(addr.getType())) {
                        externalIps.add(addr.getAddr());
                    }
                })
            );
        }
        // image는 Object 타입이므로 처리
        String imageId = extractImageId(server.getImage());
        // ...
    }
    return servers;
}

private String extractImageId(Object image) {
    if (image instanceof String) return (String) image;
    if (image instanceof Map) {
        Map<String, Object> imageMap = (Map<String, Object>) image;
        Object id = imageMap.get("id");
        return id != null ? id.toString() : null;
    }
    return null;
}
```

Nova 의 `image` 필드는 문자열일 때도 있고 객체일 때도 있습니다. `flavor` 는 `original_name` 이 있으면 그걸 쓰고 없으면 `name` 으로 떨어져요. 주소는 네트워크 이름을 키로 하는 Map 안에 `fixed` 와 `floating` 이 섞여 있습니다.

이 지저분함이 전부 어댑터 안에서 끝납니다. 서비스는 `List<InstanceResponse>` 만 받아요. **이게 driven adapter 가 하는 일이고, 아주이벤트의 위임 포트에는 없는 것입니다.** 아주이벤트의 포트는 변환할 게 없어서 넘기기만 했어요. 변환할 게 없다는 건 애초에 포트가 필요 없었다는 신호였습니다.

### 포트로 모아둔 덕에 정책을 한 곳에 걸었습니다

OpenStack 호출을 전부 `external` 아래로 모아둔 효과가 하나 더 있었어요. Resilience 정책을 애노테이션 하나로 걸 수 있습니다.

```java
// external/resilience/OpenstackPolicy.java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface OpenstackPolicy {
    // 비워두면: 기존 규칙(component-method) 그대로
    String retry() default "";
    String circuitBreaker() default "";
}
```

```java
// external/resilience/OpenstackPolicyAspect.java
@Around("within(com.acc.local.external.modules..*) && @annotation(policy)")
public Object around(ProceedingJoinPoint pjp, OpenstackPolicy policy) throws Throwable {
    OpenstackCallContext.set(new OpenstackCallContext.Ctx(policy.retry(), policy.circuitBreaker()));
    try {
        return pjp.proceed();
    } finally {
        OpenstackCallContext.clear();
    }
}
```

포인트컷이 `within(com.acc.local.external.modules..*)` 입니다. 외부 호출이 그 패키지 밖으로 새지 않는다는 전제가 서 있으니 이 한 줄로 전부 걸려요. [1번 글](/posts/01-circuit-breaker-retry-order/)에서 Circuit Breaker 와 Retry 의 중첩 순서를 실측으로 고른 게 이 지점입니다.

### module 층은 카카오페이의 biz-component 와 같은 역할입니다

아올다 클라우드에는 `service/modules` 라는 층이 하나 더 있습니다. 헥사고날 원문에는 없는 이름이에요. 무슨 역할인지 보면 카카오페이 글에 정확히 같은 것이 나옵니다.

> Biz-component 패키지 생성. 납부라는 기능이 동작했을 때 필수적으로 동작해야 하는 기능을 묶어 개발

여러 유스케이스가 공유해야 하는 기능 덩어리입니다. 아올다 클라우드에서 예를 들면 프로젝트 목록 조회와 프로젝트 상세 조회가 둘 다 "관리자 토큰 발급 후 Keystone 조회 후 토큰 폐기" 를 해야 하는데, 이걸 `AuthModule` 이 갖고 있어요.

```java
// service/adapters/project/ProjectServiceAdapter.java
@Override
public List<ProjectResponse> getProjects(String keyword, String sessionId) {
    String requestUserId = sessionModule.getKeystoneUserId(sessionId);
    String unscopedToken = sessionModule.getKeystoneUnscopedToken(sessionId);
    String adminTokenWithProject = authModule.issueSystemAdminTokenWithAdminProjectScope(requestUserId);
    try {
        List<ProjectServiceDto> projectServiceDataList =
            projectModule.getAllProjectListForUser(keyword, requestUserId, unscopedToken, adminTokenWithProject);
        authModule.invalidateSystemAdminToken(adminTokenWithProject);
        // ...
    } catch (Exception e) {
        authModule.invalidateSystemAdminToken(adminTokenWithProject);
        throw e;
    }
}
```

adapter 는 순서를 정하고 module 은 각 단계를 수행합니다. 49번 글에서 본 아주이벤트의 orchestrator 와 service 관계와 같은 모양이에요. 이름만 다릅니다.

## [5. 그런데 아올다 클라우드도 새는 곳이 있었다]

포트가 전부 인터페이스라고 해서 다 잘된 건 아니었습니다. 세어보니 세 군데가 새고 있었어요.

### 22개 중 6개가 HTTP 를 그대로 노출합니다

```bash
$ grep -rl "ResponseEntity\|JsonNode" external/ports | wc -l
6
```

```java
// external/ports/compute/ComputeQuotaExternalPort.java
public interface ComputeQuotaExternalPort {
    ResponseEntity<JsonNode> callGetQuota(String token, String projectId);
    ResponseEntity<JsonNode> callGetQuotaDetail(String token, String projectId);
    ResponseEntity<Void> callUpdateCPUQuota(String token, String projectId, int cpuLimit);
}
```

`NovaServerExternalPort` 가 `InstanceResponse` 로 말했던 것과 대조적이에요. 여기는 포트가 `ResponseEntity` 와 `JsonNode` 로 말합니다. Spring 의 HTTP 타입과 Jackson 의 트리 타입이 그대로 포트 시그니처에 있으니, 이 포트를 쓰는 쪽은 결국 JSON 을 직접 파싱해야 합니다.

포트를 통과했는데 아무것도 변환되지 않은 상태예요. **인터페이스이기만 하면 포트가 되는 게 아니라, 안쪽 언어로 말해야 포트가 됩니다.**

### 도메인 모델에 외부 페이지네이션이 들어와 있습니다

`domain/model` 을 열어보니 이런 파일이 있었어요.

```java
// domain/model/auth/UserListResponse.java
package com.acc.local.domain.model.auth;

@Getter
@Builder
public class UserListResponse {
    private List<UserKeystoneDto> userKeystoneDtos;
    private String nextMarker;
    private String prevMarker;
}
```

`nextMarker` 와 `prevMarker` 는 Keystone 의 marker 기반 페이지네이션 규약입니다. 그게 도메인 모델 패키지에 있어요. 게다가 담고 있는 게 `UserKeystoneDto` 목록이니, 도메인 모델이 아니라 외부 응답의 껍데기입니다. 이름도 Response 로 끝나요.

카카오페이 홈 서버 글이 헥사고날을 걷어낸 이유 중 하나가 이거였습니다.

> 홈 서버의 핵심 비즈니스 로직은 사실상 '외부 데이터를 조합하여 SDUI에 맞게 렌더링하는 것'이었습니다

### 그리고 숫자가 그 진단을 확인해줍니다

층별로 줄 수를 세어봤습니다.

| 층 | 파일 | 줄 | 비중 |
| --- | --- | --- | --- |
| `external` 전체 (ports, adapters, modules, dto) | 311 | 16,610 | 35.1% |
| 그중 `external/dto` (외부 응답의 모양) | 203 | 6,572 | 13.9% |
| `controller` | 45 | 9,686 | 20.5% |
| `service` 전체 (ports, adapters, modules) | 84 | 7,442 | 15.7% |
| `entity` (JPA) | 20 | 1,261 | 2.7% |
| `domain` (enum 23개 포함) | 38 | 1,355 | 2.9% |

도메인이 2.9% 이고 외부 연동이 35% 입니다. 외부 응답 DTO 하나만 해도 도메인의 다섯 배 가까이 되고요. 이 서비스의 본질은 도메인 규칙이 아니라 **OpenStack API 여러 개를 조합해서 화면 모양으로 만드는 것**이라는 뜻입니다.

그러니까 아올다 클라우드는 카카오페이 여신코어보다 카카오페이 홈 서버에 훨씬 가까운 성격입니다. 그런데도 걷어내지 않고 유지하는 게 맞다고 생각해요. 이유는 다음 절에 적습니다.

## [6. 그럼 언제 값을 하는가]

홈 서버 글은 헥사고날이 맞는 프로젝트의 특성을 세 개로 정리했습니다.

1. 도메인 모델이 명확한가
2. 외부 의존성보다 코어 로직이 풍부한가
3. 코어 모듈을 두 개 이상이 재사용하는가

제 세 저장소를 이 기준에 대봤어요.

| | 아주이벤트 | 아올다 클라우드 | 메일상자 |
| --- | --- | --- | --- |
| 규모 | 234 파일 | 773 파일 | 멀티모듈 3개 |
| 외부 시스템 수 | FCM, S3, OAuth | OpenStack 5종 + Keycloak + Google | Gmail API, RabbitMQ |
| 도메인 규칙의 양 | 적음 (구독과 발송 상태) | 적음 (2.9%) | 중간 |
| 코어를 쓰는 실행 주체 | API, 스케줄러 5개 | API, 스케줄러 | API, worker 프로세스 |
| 포트가 실제로 변환하는가 | 아니오 | 부분적으로 예 | 예 |

기준 1과 2로는 셋 다 헥사고날이 필요하지 않습니다. 그런데 **기준 3에서는 셋 다 걸립니다.** 실행 주체가 API 하나가 아니에요.

<svg class="diagram" viewBox="0 0 720 300" role="img" aria-label="세 프로젝트가 헥사고날의 세 조건에 어떻게 걸리는지 비교" >
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">세 조건 중 무엇이 걸리는가</text>
  <text x="228" y="42" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">도메인이 두껍다</text>
  <text x="392" y="42" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">외부 의존이 적다</text>
  <text x="570" y="42" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">코어를 여럿이 쓴다</text>
  <line x1="0" y1="52" x2="660" y2="52" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="0.5"/>
  <text x="0" y="76" font-size="11" fill="var(--ink, #16181A)">카카오페이 여신코어</text>
  <text x="228" y="76" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="392" y="76" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="570" y="76" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="0" y="94" font-size="9.5" fill="var(--ink-3, #8B9099)">대출 심사와 한도 규칙이 코드의 중심이다</text>
  <line x1="0" y1="106" x2="660" y2="106" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="130" font-size="11" fill="var(--ink, #16181A)">카카오페이 홈 서버</text>
  <text x="228" y="130" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="392" y="130" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="570" y="130" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="0" y="148" font-size="9.5" fill="var(--ink-3, #8B9099)">24개 서버를 조합해 SDUI 를 만든다. in Port 가 하나뿐이었다</text>
  <line x1="0" y1="160" x2="660" y2="160" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="184" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">아올다 클라우드</text>
  <text x="228" y="184" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="392" y="184" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="570" y="184" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="0" y="202" font-size="9.5" fill="var(--ink-3, #8B9099)">도메인은 2.9% 지만 OpenStack 응답을 한 곳에서 번역할 값어치가 있다</text>
  <line x1="0" y1="214" x2="660" y2="214" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="238" font-size="11" font-weight="700" fill="var(--clay-text, #1B64DA)">아주이벤트</text>
  <text x="228" y="238" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink-3, #8B9099)">X</text>
  <text x="392" y="238" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="570" y="238" font-size="12" font-weight="700" text-anchor="middle" fill="var(--clay-text, #1B64DA)">O</text>
  <text x="0" y="256" font-size="9.5" fill="var(--ink-3, #8B9099)">외부는 FCM 하나뿐이고 스케줄러 5개가 같은 코어를 쓴다</text>
  <line x1="0" y1="272" x2="720" y2="272" stroke="var(--rule-soft, rgba(22,24,26,.06))" stroke-width="0.5"/>
  <text x="0" y="292" font-size="11" fill="var(--ink-3, #8B9099)">홈 서버가 걷어낸 이유는 셋이 다 X 였기 때문이다. 하나라도 O 면 그 한 조건에 맞는 만큼만 쓰면 된다.</text>
</svg>

아주이벤트에는 스케줄러가 다섯 개고, 아올다 클라우드는 스냅샷 정책 스케줄러가 같은 기능을 부릅니다. 메일상자는 API 서버와 worker 프로세스가 같은 도메인 코드를 씁니다. 세 곳 모두 "무엇이 부르든 같은 입구" 가 실제로 필요한 상황이에요. 원문 의도의 첫 문장이 여기서 값을 합니다.

그래서 제 결론은 전부 아니면 전무가 아닙니다. **필요한 조건에 걸리는 만큼만 씁니다.**

- 외부 시스템의 응답 모양이 지저분하면 그것만 secondary port 로 감쌉니다. 아올다 클라우드의 Nova 어댑터가 이 값을 합니다.
- 실행 주체가 둘 이상이면 primary port 를 둡니다. 스케줄러와 컨트롤러가 같은 인터페이스를 부르게요.
- 그 외에는 인터페이스를 만들지 않습니다. 구현이 하나뿐이고 변환할 것도 없으면 그냥 클래스입니다.

홈 서버 글의 마지막 문장이 이 판단의 근거예요.

> 구조적인 이점만을 보기보다는 프로젝트의 본질적인 특성과 도메인에 대한 이해가 필수적으로 선행되어야 한다

## [실무 적용 - 두 저장소에서 각각 할 일]

### 아주이벤트

포트 15개를 전부 인터페이스로 바꾸지는 않겠습니다. 그게 오히려 홈 서버가 겪은 "40개 out Port 관리 비용" 을 자초하는 길이에요. 세 갈래로 나눕니다.

| 대상 | 조치 | 이유 |
| --- | --- | --- |
| 캐시 포트 2개 | 그대로 인터페이스 유지 | 이미 맞다 |
| FCM 발송 | secondary port 로 인터페이스화 | 응답 변환과 에러 코드 해석이 있다 |
| 스케줄러가 부르는 기능 | primary port 신설 | 실행 주체가 둘이다 |
| 나머지 JPA 포트 12개 | 이름을 `Repository` 로 바꾸고 어댑터와 합친다 | 위임만 하는 층이라 없애는 게 맞다 |

마지막 줄이 핵심입니다. 포트를 인터페이스로 고치는 것보다 **포트라는 층 자체를 없애는 게** 더 정직한 선택인 곳이 있어요. 727줄 중 대부분이 그렇습니다.

FCM 은 반대로 포트가 필요합니다. 지금은 이렇게 되어 있어요.

```java
// service/webhook/FcmPushResultService.java
switch (errorCode) {
    case INTERNAL:
    case UNAVAILABLE:
        markAsRetryPendingOrPermanentFail(token, false);
        return 0;
    case QUOTA_EXCEEDED:
        markAsRetryPendingOrPermanentFail(token, true);
        return 0;
    case UNREGISTERED:
        token.markAsFail();
        invalidTokenValues.add(token.getTokenValue());
        return 1;
    // ...
}
```

`MessagingErrorCode` 는 Firebase SDK 의 enum 입니다. 이걸 도메인 서비스가 직접 switch 하고 있어요. secondary port 를 두면 이렇게 갈립니다.

```java
// 우리 언어로 정의한 발송 결과
public record SendOutcome(String tokenValue, Result result) {
    public enum Result { SUCCESS, RETRYABLE, THROTTLED, TOKEN_INVALID, PERMANENT_FAIL }
}

public interface PushSender {
    List<SendOutcome> send(List<PushMessage> messages);
}
```

```java
// 어댑터만 Firebase 를 안다. MessagingErrorCode 해석이 여기서 끝난다
@Component
class FirebasePushSenderAdapter implements PushSender {
    @Override
    public List<SendOutcome> send(List<PushMessage> messages) { ... }

    private SendOutcome.Result translate(MessagingErrorCode code) {
        if (code == null) return PERMANENT_FAIL;
        return switch (code) {
            case INTERNAL, UNAVAILABLE -> RETRYABLE;
            case QUOTA_EXCEEDED -> THROTTLED;
            case UNREGISTERED, INVALID_ARGUMENT -> TOKEN_INVALID;
            default -> PERMANENT_FAIL;
        };
    }
}
```

이러면 재시도 상한과 백오프 계산은 도메인 규칙으로 남고, Firebase 의 에러 코드 목록은 어댑터 안에 갇힙니다. FCM 을 APNs 로 바꾸는 일이 생겨도 도메인은 안 열어요. 그리고 테스트에서 `PushSender` 를 가짜 구현으로 바꿔서 THROTTLED 시나리오를 만들 수 있습니다.

### 아올다 클라우드

세 가지입니다.

첫째, `ResponseEntity<JsonNode>` 를 노출하는 포트 6개를 우리 타입으로 바꿉니다. 특히 쿼터 관련 포트는 [37번 글](/posts/37-openstack-response-capture-dto/)에서 응답 캡처 DTO 를 만들었던 것과 같은 방식으로 처리할 수 있어요.

둘째, `domain/model` 에서 Response 로 끝나는 클래스를 `dto` 로 옮깁니다. 도메인 모델 패키지에 외부 페이지네이션 마커가 있을 이유가 없습니다.

셋째, `service/ports` 의 시그니처가 Response DTO 를 반환하는 문제는 일단 두겠습니다. 컨트롤러가 그대로 내려주는 구조라 지금 바꾸면 DTO 한 겹이 더 늘어나고, 그 비용이 얻는 것보다 커 보여요.

<!-- 측정 필요: 아주이벤트에서 repository/port 12개를 어댑터와 합쳤을 때 줄어드는 코드 줄 수.
     현재 port 727줄 + adapter 1,107줄 = 1,834줄. 합친 뒤를 실제로 세어 비교한다. -->

## [결론]

헥사고날 아키텍처를 "port 와 adapter 패키지를 만드는 것" 으로 알고 있었습니다. 그래서 두 저장소에 다 그 패키지를 만들었어요. 한쪽은 인터페이스였고 한쪽은 위임 클래스였는데, 그 차이를 이 글을 쓰기 전까지 인식하지 못했습니다.

정리하면서 얻은 것을 셋으로 적어둘게요.

1. **헥사고날의 전부는 화살표 방향입니다.** 포트가 인터페이스인지 여부가 아니라, 어댑터가 포트를 구현하는지가 기준이에요. 포트가 어댑터를 import 하는 순간 아무것도 남지 않습니다.
2. **포트는 인터페이스인 것으로 부족하고, 안쪽 언어로 말해야 합니다.** 아올다 클라우드의 포트 22개 중 6개는 인터페이스지만 `ResponseEntity<JsonNode>` 로 말해서 아무것도 막지 못했어요.
3. **변환할 것이 없으면 포트가 필요 없습니다.** 아주이벤트의 JPA 포트 12개는 조건문 하나 없이 위임만 했습니다. 그건 포트가 없어야 한다는 신호였어요.

한계도 적습니다. 이 글의 숫자는 전부 정적인 구조 측정이에요. 파일 수, 줄 수, 인터페이스 개수입니다. 정작 중요한 건 "이 구조에서 기능 하나를 바꾸는 데 파일 몇 개를 열었는가" 인데, 그건 재본 적이 없습니다. 홈 서버 팀은 헥사고날을 걷어내고 PR 기준 8,000줄 이상을 줄였다고 했어요. 그런 비교를 하려면 제 저장소에서도 같은 기능을 두 구조로 만들어봐야 합니다. 다음에 기능 하나가 들어올 때 열어야 했던 파일 수를 세어보려고요.

그리고 이번에 가장 도움이 된 건 20년 전에 쓰인 원문 한 문장이었습니다. 헥사고날을 소개하는 글은 대개 육각형 그림부터 보여주는데, 원문은 육각형이 중요하지 않다고 먼저 말하고 있었어요.

> The hexagon is not a hexagon because the number six is important

## [참고 자료]

- [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/) Alistair Cockburn
- [카카오페이 홈 서버는 왜 헥사고날 아키텍처를 걷어냈을까?](https://tech.kakaopay.com/post/home-hexagonal-architecture/) 카카오페이
- [Domain-Driven 헥사고날 아키텍처 by example](https://devblog.kakaostyle.com/ko/2025-03-21-1-domain-driven-hexagonal-architecture-by-example/) 카카오스타일
- [백엔드 개발자의 도메인 주도 설계(DDD) 경험기](https://tech.kakaopay.com/post/backend-domain-driven-design/) 카카오페이
