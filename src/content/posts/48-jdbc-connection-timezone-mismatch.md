---
title: "왕복이 맞아떨어져서 아무도 못 본 9시간 (JVM UTC vs 커넥션 KST)"
description: "JVM은 UTC인데 JDBC 커넥션만 Asia/Seoul이었습니다. 쓸 때 +9, 읽을 때 -9라 애플리케이션 안에서는 증상이 없었어요. 임시 테이블로 물리값을 직접 확인하고 126개 컬럼을 옮기기까지."
date: 2026-08-13
project: "코리안쌤"
tags: ["MySQL", "JDBC", "타임존", "Hibernate", "Connector/J", "마이그레이션"]
---

## [배경 - 생년월일 API 를 만들다 생긴 의문]

케이톡 백엔드가 서버 간 호출로 부르는 내부 API 를 만들고 있었어요. 회원 번호를 받아 생년월일을 내려주면 케이톡이 만 19세 미만 가입 차단을 판정하는 구조입니다. 값을 그대로 내려주기만 하는 단순한 API 라 별 고민이 없었는데, 문득 이 서버가 시각을 어느 기준으로 다루는지 확실히 해두고 싶어졌어요.

JVM 이 UTC 라는 건 알고 있었습니다. 세 군데에 걸어뒀거든요.

```groovy
// build.gradle
tasks.named('bootRun') {
    jvmArgs '-Duser.timezone=UTC'
}

// jib container
jvmFlags = [
        // ...
        '-Duser.timezone=UTC'
]
```

```java
// KoreanssamApplication.java
@PostConstruct
void setDefaultTimeZoneToUtc() {
    TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
}
```

IDE 로 띄우면 gradle 플래그가 안 먹으니 `@PostConstruct` 로 한 번 더 막아둔 겁니다. 여기까지는 의도한 대로였어요. 그런데 datasource 설정을 열고 손이 멈췄습니다.

```yaml
# src/main/resources/db/mysql/mysql-dev.yml
spring:
  datasource:
    url: jdbc:mysql://10.100.13.201:3306/koreanssam_db?...&serverTimezone=Asia/Seoul
```

`serverTimezone=Asia/Seoul` 이었어요. JVM 은 UTC 인데 커넥션만 KST 였습니다.

처음 든 생각은 "그럼 지금까지 저장된 시각이 전부 9시간 틀렸겠네" 였어요. 그런데 어드민 화면을 봐도, API 응답을 봐도 시각이 멀쩡했습니다. 틀렸어야 하는데 안 틀렸으니 둘 중 하나예요. 제 이해가 틀렸거나, 어딘가에서 상쇄되고 있거나.

## [문제 상황 분석 - 타임존이 세 군데에 있다]

### 세 개의 기준

JDBC 로 시각을 주고받을 때 타임존이 개입하는 지점은 하나가 아닙니다. 정확히는 세 군데예요.

| 위치 | 이 프로젝트 값 | 무엇을 정하나 |
| --- | --- | --- |
| JVM 기본 타임존 | UTC | `LocalDateTime.now()` 가 만드는 벽시계, `Timestamp.valueOf()` 의 해석 기준 |
| JDBC 커넥션 타임존 | Asia/Seoul | 드라이버가 instant 를 DB 자릿수로 바꿀 때 쓰는 기준 |
| MySQL 서버 타임존 | UTC | `NOW()`, `CURRENT_TIMESTAMP` 의 기준 |

로컬 MySQL 에 직접 물어보니 서버는 UTC 였어요.

```sql
SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();
```

```
@@global.time_zone  @@session.time_zone  NOW()                UTC_TIMESTAMP()
UTC                 UTC                  2026-08-13 11:23:54  2026-08-13 11:23:54
```

JVM 도 UTC 이고 서버도 UTC 인데, 드라이버 변환 기준만 혼자 Asia/Seoul 이었습니다.

### serverTimezone 은 서버 설정을 바꾸지 않는다

여기서 제가 잘못 알고 있던 게 하나 드러났어요. `serverTimezone` 이라는 이름 때문에 이 옵션이 서버의 세션 타임존을 바꾼다고 생각했거든요. 그래서 커넥션이 KST 면 서버 세션도 KST 가 될 거라 여겼습니다.

그런데 아니었어요. Connector/J 8.x 부터 이 옵션의 정식 이름은 `connectionTimeZone` 이고 `serverTimezone` 은 별칭입니다. 하는 일은 드라이버가 변환할 때 쓸 기준을 알려주는 것뿐이에요. 서버의 `time_zone` 변수는 건드리지 않습니다. 실제로 바꾸려면 `forceConnectionTimeZoneToSession=true` 를 따로 켜야 하는데 저희는 안 켜져 있었어요.

위 쿼리 결과가 그 증거입니다. 커넥션은 Asia/Seoul 이라고 선언돼 있는데 `@@session.time_zone` 은 UTC 로 나왔죠. 세 기준이 각자 따로 놀 수 있다는 뜻입니다.

### 왜 화면은 멀쩡했는가?

이게 제일 궁금했던 부분이에요. 추측만으로는 답이 안 나와서 직접 재현해보기로 했습니다.

## [실측 - 임시 테이블로 왕복시키기]

Hibernate 를 거치지 않고 드라이버 동작만 보고 싶었어요. 그래서 순수 JDBC 로 임시 테이블에 쓰고 읽는 프로그램을 짰습니다. `TEMPORARY TABLE` 이라 세션이 끝나면 사라지니 실제 데이터는 건드리지 않아요.

측정 환경은 mysql-connector-j 9.7.0, MySQL 서버 타임존 UTC, Java 17, JVM 기본 타임존 UTC 입니다. Spring Boot 4.1.0 이 물어오는 드라이버 버전을 그대로 썼어요.

```java
TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
String url = "jdbc:mysql://localhost:3306/koreanssam_db?...&serverTimezone=Asia/Seoul";

try (Connection c = DriverManager.getConnection(url, user, password)) {
    c.createStatement().execute("CREATE TEMPORARY TABLE tz_probe (id INT, ts DATETIME(6))");

    LocalDateTime ldt = LocalDateTime.of(2026, 8, 13, 0, 0, 0);
    try (PreparedStatement p = c.prepareStatement("INSERT INTO tz_probe VALUES (?,?)")) {
        p.setInt(1, 1);
        p.setTimestamp(2, Timestamp.valueOf(ldt));   // Hibernate 가 쓰는 경로
        p.executeUpdate();
        p.setInt(1, 2);
        p.setObject(2, ldt);                          // LocalDateTime 직접 바인딩
        p.executeUpdate();
    }
    // DATE_FORMAT 으로 읽으면 드라이버 변환을 거치지 않은 물리 자릿수가 나옵니다
    // ...
}
```

### DATETIME 컬럼 결과

```
애플리케이션이 쓰려는 값 = 2026-08-13T00:00

[DB 물리 digits] id=1 -> 2026-08-13 09:00:00
[DB 물리 digits] id=2 -> 2026-08-13 00:00:00
[읽기]  id=1 getTimestamp=2026-08-13 00:00:00.0 | getObject(LocalDateTime)=2026-08-13T09:00
[읽기]  id=2 getTimestamp=2026-08-12 15:00:00.0 | getObject(LocalDateTime)=2026-08-13T00:00
```

id=1 을 보세요. `2026-08-13T00:00` 을 썼는데 DB 에는 `09:00` 으로 들어갔습니다. 9시간 밀렸어요. 그런데 `getTimestamp` 으로 읽으면 다시 `00:00` 이 나옵니다.

쓸 때 +9, 읽을 때 -9. 화면이 멀쩡했던 이유가 이거였습니다.

### 왜 상쇄되는가

`LocalDateTime` 은 타임존이 없는 타입이에요. 그런데 드라이버까지 가는 길에 잠깐 타임존이 있는 값으로 바뀌었다가 되돌아옵니다.

```
[쓰기]
① AuditingEntityListener
   LocalDateTime.now()              →  2026-08-13T00:00      (JVM UTC 벽시계)
② Hibernate TimestampJdbcType
   Timestamp.valueOf(ldt)           →  instant 2026-08-13T00:00Z
                                        (JVM 기본존 UTC 로 해석하면서 instant 가 됨)
③ Connector/J setTimestamp
   preserveInstants=true            →  Asia/Seoul 로 환산
   DB 기록                           →  2026-08-13 09:00:00   ← +9

[읽기]
④ digits 를 Asia/Seoul 로 해석      →  instant 2026-08-13T00:00Z
⑤ JVM UTC 벽시계로 환산             →  2026-08-13T00:00      ← -9, 원복
```

핵심은 ②번이에요. `Timestamp.valueOf()` 가 타임존 없는 값을 JVM 기본존으로 해석하면서 instant 로 승격시킵니다. 그러면 ③번에서 드라이버가 이 instant 를 커넥션 타임존 자릿수로 바꿔야겠다고 판단해요. Connector/J 8.0.23 부터 기본값이 된 `preserveInstants=true` 가 하는 일입니다. 읽을 때는 정확히 역순이라 원래 값이 돌아옵니다.

따라서 애플리케이션 왕복은 항상 맞아떨어집니다. 틀리는 건 DB 에 남은 물리값 하나뿐이에요.

### 바인딩 경로가 다르면 결과도 다르다

실측하면서 예상 못 한 걸 하나 더 봤습니다. id=2 는 `setObject(LocalDateTime)` 으로 넣은 건데 이건 안 밀렸어요.

| 바인딩 | DB 물리값 | getTimestamp 으로 읽으면 | getObject(LocalDateTime) 으로 읽으면 |
| --- | --- | --- | --- |
| `setTimestamp(Timestamp.valueOf(ldt))` | 09:00 | 00:00 (원복) | 09:00 |
| `setObject(ldt)` | 00:00 | 15:00 (전날) | 00:00 (원복) |

같은 컬럼에 같은 값을 넣었는데 경로에 따라 물리값이 9시간 갈립니다. `LocalDateTime` 은 instant 가 아니라서 드라이버가 변환을 안 하는데, `Timestamp` 는 instant 라서 변환을 하기 때문이에요.

그리고 읽을 때 짝이 안 맞으면 값이 또 틀어집니다. 표의 대각선을 보면 09:00 과 15:00 이라는 엉뚱한 값이 나오죠. 쓰기와 읽기가 같은 경로일 때만 원복된다는 뜻입니다. 지금은 Hibernate 가 양쪽 다 `Timestamp` 경로로 통일해주고 있어서 맞아떨어지는 거예요. 누군가 네이티브 쿼리로 `setObject` 를 섞어 쓰면 그때 깨집니다.

### DATE 컬럼은 밀리지 않는다

처음 의문의 출발점이었던 생년월일도 확인했어요. `mp_birthdate` 는 `date` 컬럼이고 `LocalDate` 로 매핑돼 있습니다.

```
애플리케이션이 쓰려는 값 = 2005-03-14
[DB 물리 digits] id=1 -> 2005-03-14   (setDate 경로)
[DB 물리 digits] id=2 -> 2005-03-14   (setObject 경로)
[읽기]  id=1 getDate=2005-03-14 | getObject(LocalDate)=2005-03-14
[읽기]  id=2 getDate=2005-03-14 | getObject(LocalDate)=2005-03-14
```

양쪽 경로 모두 안 밀렸습니다. `DATE` 는 시각 성분이 없어서 드라이버가 instant 변환을 태우지 않아요.

사실 이 확인 때문에 원래 계획 하나를 접었습니다. 내부 API 응답에서 생년월일을 KST 로 변환해 내리려 했는데, 실측해보니 값이 애초에 안 밀렸거든요. 타임존 없는 타입에 타임존 변환을 붙이면 무의미하거나, 방향을 반대로 잡으면 생일이 하루 앞당겨집니다. 재보지 않았으면 없어도 될 코드를 넣을 뻔했어요.

## [형제 서버와 비교 - 같은 인스턴스, 다른 커넥션]

여기까지는 "우리 서버 안에서는 아무 문제 없다"로 끝날 뻔했어요. 그런데 같은 회사의 다른 서버들은 어떻게 하고 있는지 궁금해서 열어봤습니다.

세 서비스가 같은 MySQL 인스턴스(`10.100.13.201:3306`)를 쓰고 있었어요. 스키마만 다릅니다.

| 서비스 | JVM | serverTimezone | DB 물리 자릿수 |
| --- | --- | --- | --- |
| ktalk-java-api | UTC | **UTC** | UTC |
| peopleandtalk-java-integration | UTC | **UTC** | UTC |
| koreanssam-java-api | UTC | **Asia/Seoul** | **KST** |

```yaml
# ktalk-java-api / mysql-dev.yml
jdbc-url: jdbc:mysql://10.100.13.201:3306/ktalk_db?...&serverTimezone=UTC

# peopleandtalk-java-integration / mysql-dev.yml
url: jdbc:mysql://10.100.13.201:3306/integrated_db?...&serverTimezone=UTC
```

셋 다 JVM 을 UTC 로 못박는 방식도 똑같았어요. `-Duser.timezone=UTC` 를 gradle 에 걸고 `TimeZone.setDefault` 를 애플리케이션 클래스에서 한 번 더 부릅니다. `BaseEntity` 도 셋 다 동일했습니다.

```java
@CreatedDate
@Column(name = "created_at", updatable = false, nullable = false)
private LocalDateTime createdAt;
```

같은 인스턴스, 같은 엔티티 패턴, 같은 JVM 설정인데 커넥션 설정 한 줄만 저희가 달랐어요. 그래서 같은 서버에서 `ktalk_db.created_at` 과 `koreanssam_db.created_at` 을 나란히 조회하면 9시간이 어긋납니다.

애플리케이션 안에서는 안 보이던 문제가 여기서 드러납니다. 앱을 거치지 않고 DB 를 직접 읽는 순간, 그러니까 SQL 클라이언트로 조회하거나 데이터 배치가 두 스키마를 가로지르는 순간에요.

그리고 저희 코드에는 이미 그 전제로 쓰인 주석이 있었습니다.

```groovy
// UTC 고정. 케이톡, 통합DB가 모두 UTC로 저장하므로 같은 기준을 쓴다.
'-Duser.timezone=UTC'
```

의도는 정확했는데 커넥션 설정이 그 의도를 배신하고 있었어요. JVM 만 맞추면 되는 줄 알았던 겁니다.

커밋 이력을 보니 `serverTimezone=Asia/Seoul` 은 저장소 첫 커밋(2026-07-16, "프로젝트 및 에이전트 초기 세팅")부터 있었습니다. 초기 세팅 때 들어와서 그대로 굳은 거예요. 다행히 아직 한 달이 안 됐고 운영 데이터가 쌓이기 전이었습니다.

## [해결 방법 - 설정 한 줄과 126개 컬럼]

고치기로 했습니다. 판단 기준은 하나였어요. 앱 밖에서 이 DB 를 읽는 주체가 있느냐. 저희는 같은 서버에 형제 스키마가 있고 스키마를 가로지르는 조회가 예정돼 있어서, 두면 언젠가 터질 문제였습니다.

설정 자체는 한 줄입니다.

```yaml
# before
url: jdbc:mysql://...?...&serverTimezone=Asia/Seoul
# after
url: jdbc:mysql://...?...&serverTimezone=UTC
```

문제는 따라붙는 쪽이었어요. `schema.sql` 기준 `datetime(6)` 컬럼이 **126개**, 테이블 **55개** 입니다. 커넥션을 UTC 로 바꾸면 되돌리던 -9 가 사라지니 기존 행은 전부 9시간 미래로 읽혀요.

```
DB 물리값 09:00 (기존 행, KST 자릿수)

현재  : 읽기 -9 → 00:00 → @AdminDateTime +9 → 09:00 KST 표기   정확
변경 후: 읽기 ±0 → 09:00 → @AdminDateTime +9 → 18:00 KST 표기   9시간 미래
```

마이그레이션 없이 설정만 바꿨을 때 생기는 일을 정리하면 이렇습니다.

- **한 컬럼에 두 기준이 섞입니다.** 기존 행은 KST 자릿수, 신규 행은 UTC 자릿수예요. 어느 행이 어느 기준인지 구분할 방법이 없어서 정렬과 범위 조회가 조용히 깨집니다. 이게 제일 무서운 항목입니다.
- **만료와 쿨다운이 9시간 연장됩니다.** 비밀번호 재설정 인증코드, 비밀번호 잠금, 닉네임 변경 쿨다운, 세션 만료가 전부 해당돼요. 인증코드가 9시간 더 살아있는 건 버그를 넘어 보안 문제입니다.
- **어드민 표기가 9시간 미래로 갑니다.** `@AdminDateTime` 이 붙은 파일이 8개인데 저장값을 UTC 로 보고 +9 를 하거든요.

반대로 다행인 것도 있었어요.

- 스키마에 `DEFAULT CURRENT_TIMESTAMP` 와 `ON UPDATE CURRENT_TIMESTAMP` 가 **0건** 입니다. 시각을 만드는 주체가 전부 애플리케이션(JPA Auditing)이라 서버 타임존이 끼어들 여지가 없고, 마이그레이션 `UPDATE` 가 `updated_at` 을 건드리지도 않아요.
- 레거시 덤프 테이블은 영향이 없습니다. 시각 컬럼이 INT epoch 초라 드라이버 변환을 통째로 우회하거든요. 원래 다른 이유로 넣은 장치인데 결과적으로 방어가 됐습니다.
- `DATE` 컬럼도 안 밀리니 생년월일은 대상이 아니에요.

### 재실행을 막는 장치

마이그레이션에서 제일 걱정한 건 두 번 도는 상황이었습니다. `- INTERVAL 9 HOUR` 를 두 번 돌리면 -18시간이 되고, 그 시점에는 무엇이 원본이었는지 알 방법이 없어요.

그래서 표식 테이블을 스크립트 맨 앞에 뒀습니다.

```sql
-- 재실행 방지. 두 번 돌리면 -18시간이 된다. 롤백했으면 이 표를 DROP 하고 다시 돌린다.
CREATE TABLE hama_migration_tz_utc_20260813 (
    applied_at DATETIME(6) NOT NULL,
    PRIMARY KEY (applied_at)
) ENGINE=InnoDB COMMENT='커넥션 타임존 UTC 전환 적용 표식. 재실행 방지용';

START TRANSACTION;

UPDATE hama_member_profile SET
    created_at = created_at - INTERVAL 9 HOUR,
    mp_last_login_at = mp_last_login_at - INTERVAL 9 HOUR,
    mp_nickname_changed_at = mp_nickname_changed_at - INTERVAL 9 HOUR,
    mp_password_locked_until = mp_password_locked_until - INTERVAL 9 HOUR,
    updated_at = updated_at - INTERVAL 9 HOUR;

-- ... 54개 테이블 더

COMMIT;
```

MySQL 배치 모드는 첫 에러에서 멈추니, 두 번째 실행은 `CREATE TABLE` 에서 걸려 `UPDATE` 까지 못 갑니다. 별도 로직 없이 DDL 의 성질만 쓴 셈이에요. `NULL` 컬럼은 `NULL - INTERVAL 9 HOUR` 가 `NULL` 이라 따로 처리할 게 없었습니다.

## [성과 - 적용 전후]

로컬 DB 에 백업을 뜨고 적용했습니다. 적용 전후 값이에요.

| 테이블 | 적용 전 MAX(created_at) | 적용 후 | 행 수 |
| --- | --- | --- | --- |
| hama_question | 2026-08-12 09:32:32.855434 | 2026-08-12 00:32:32.855434 | 952 |
| hama_chapter | 2026-08-12 09:32:32.601428 | 2026-08-12 00:32:32.601428 | 16 |
| hama_keyword | 2026-08-12 09:32:32.184525 | 2026-08-12 00:32:32.184525 | 294 |
| hama_member_profile | 2026-08-06 17:42:27.649132 | 2026-08-06 08:42:27.649132 | 7 |

전부 정확히 9시간 이동했고 행 수는 그대로입니다. 마이크로초 자리가 보존된 것도 확인 포인트예요. `DATETIME(6)` 에 `INTERVAL 9 HOUR` 를 빼면 소수부가 날아갈까 걱정했는데 그대로 남았습니다.

재실행 가드도 의도대로 동작했어요.

```
ERROR 1050 (42S01) at line 27: Table 'hama_migration_tz_utc_20260813' already exists
--- 재실행 후 값 (안 바뀌어야 정상) ---
2026-08-12 00:32:32.855434
```

마지막으로 새 설정에서 왕복을 다시 쟀습니다.

```
애플리케이션이 쓰려는 값 = 2026-08-13T00:00
[DB 물리 digits] 2026-08-13 00:00:00
[읽기]           2026-08-13 00:00:00.0
```

이제 안 밀립니다. 쓴 값과 물리값과 읽은 값이 전부 같아요. `ktalk_db`, `integrated_db` 와 같은 기준이 됐습니다.

## [결론]

정리하면 이렇습니다. JVM 은 UTC, 커넥션은 KST, 서버는 UTC 였고, 쓰기의 +9 와 읽기의 -9 가 상쇄되면서 애플리케이션 안에서는 아무 증상이 없었어요. 틀린 건 DB 에 남은 물리 자릿수 하나입니다.

그래서 이런 어긋남은 항상 고쳐야 하느냐 하면, 그건 아니라고 생각해요. 판단 기준은 앱 밖에서 그 DB 를 읽는 주체가 있느냐입니다. 코리안쌤 API 만 읽는다면 현행 유지도 합리적인 선택이에요. 사용자에게 보이는 값은 정확하고, 126개 컬럼을 옮기는 비용이 이득보다 클 수 있으니까요. 저희는 같은 인스턴스에 형제 스키마가 있어서 고치는 쪽이 맞았고, 데이터가 적은 지금이 가장 쌌습니다.

남은 한계도 적어둡니다.

- 이 글의 적용과 측정은 로컬 DB 기준입니다. 개발 서버는 앱을 내리고 배포와 함께 진행해야 해요. 구버전이 떠 있는 채로 돌리면 쓰기가 다시 섞입니다.
- 개발 서버 MySQL 의 실제 `time_zone` 은 확인하지 못했습니다. 로컬은 UTC 였지만 개발 서버가 다르면 `NOW()` 기준이 또 갈려요. 이 프로젝트는 DB 에서 시각을 만드는 데가 없어서 영향은 작지만, 적용 전에는 봐야 합니다.
- `setObject` 와 `setTimestamp` 의 차이는 지금 Hibernate 가 경로를 통일해줘서 안 드러납니다. 네이티브 쿼리로 시각을 바인딩하는 코드가 생기면 그때 다시 볼 문제예요.

그리고 DB 를 파다가 엉뚱한 데서 진짜 버그를 하나 봤습니다.

```java
LocalDate baseDate = LocalDate.now();
BirthdateFormats.requireMinimumAge(birthdate, baseDate);
```

`LocalDate.now()` 는 JVM 기본존을 따르니 UTC 기준이에요. 그래서 한국 시간 새벽 0시부터 오전 9시 사이에는 기준일이 하루 뒤처집니다. 오늘 만 14세가 된 회원이 오전 9시까지는 미성년으로 판정돼서 가입이 막혀요. DB 쪽 어긋남은 왕복이 맞아서 안 보였는데 이건 그냥 보입니다. 새벽에 가입하는 사람이 드물어서 아직 신고가 안 들어온 것뿐이에요.

JVM 을 UTC 로 통일하는 것과 도메인 판정을 KST 로 하는 것은 별개의 문제였습니다. 저장은 UTC 로 하되 사용자에게 의미가 있는 판정은 그 사용자의 시간대로 해야 하는데, 전자만 맞춰놓고 다 됐다고 생각했던 거예요.

마지막으로 하나. 이 문제를 찾은 계기는 버그 리포트가 아니라 "그런데 이 서버는 시각을 어느 기준으로 다루지?" 라는 단순한 의문이었어요. 증상이 없는 어긋남은 질문하지 않으면 발견되지 않습니다. 그리고 추측으로는 끝까지 못 갔을 거예요. 임시 테이블에 실제로 써보고 물리값을 확인한 다음에야 왕복이 상쇄된다는 걸 알았으니까요. 설정 이름이 `serverTimezone` 이라고 해서 서버 설정을 바꾸는 게 아니라는 것도, 생년월일에 넣으려던 변환이 사실 필요 없다는 것도 재보고 나서 알았습니다.

## 참고

- MySQL Connector/J 문서, `connectionTimeZone` 과 `preserveInstants` 항목
- Connector/J 8.0.23 릴리스 노트, 타임존 처리 방식 변경
