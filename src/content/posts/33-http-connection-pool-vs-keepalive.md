---
title: "커넥션 풀이 없는 줄 알았는데 재사용률이 100%였습니다 (keep-alive 캐시와 풀의 차이)"
description: "\"풀이 없어서 매번 TCP를 새로 연다\"고 적었는데 재보니 아니었어요. JDK는 재사용을 합니다. 없는 건 재사용이 아니라 제한이었습니다."
date: 2026-08-09
project: "메일상자"
tags: ["HTTP", "커넥션 풀", "RestClient", "벤치마크", "Apache HttpClient"]
---

## [배경 - Gmail API를 하루에 몇 번 부르는가]

메일상자는 Gmail API를 자주 부릅니다. 초기 동기화 때는 스레드 하나마다 한 번씩 부르고, 실시간 동기화도 이벤트마다 붙어요.

컨슈머도 여럿입니다. 초기 동기화 3개, 스레드 배치 5개, 히스토리 이벤트 3개와 5개. 이들이 동시에 같은 호스트로 HTTP 요청을 보냅니다.

이력서에 이렇게 적었어요.

> Gmail API 고빈도 호출 환경에서 커넥션 풀 미구성으로 매 요청마다 TCP 연결 생성 비용 누적

글을 쓰려고 코드를 열었는데, 제가 적어둔 것과 달랐습니다.

## [문제 상황 분석 - 코드부터 다시 읽었다]

### 저장소에는 Apache HttpClient가 없습니다

Gmail 클라이언트 설정은 이렇게 생겼어요.

```java
@Configuration
public class GoogleMailMessageClientConfig {

    @Bean
    public RestClient googleMailMessageRestClient(
            GoogleMailInitialSyncProperties properties,
            RestClient.Builder restClientBuilder
    ) {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout((int) properties.getConnectTimeout().toMillis());
        requestFactory.setReadTimeout((int) properties.getReadTimeout().toMillis());

        return restClientBuilder
                .requestFactory(requestFactory)
                .build();
    }
}
```

`SimpleClientHttpRequestFactory` 입니다. Apache HttpClient도, `PoolingHttpClientConnectionManager` 도 없어요. 저장소 전체를 뒤져도 `maxConnTotal`, `maxConnPerRoute`, `evictExpiredConnections` 가 한 군데도 안 나옵니다. gradle 의존성에도 Apache HttpClient가 없어요.

즉 **이력서에 적은 커넥션 풀 구성은 저장소에 없습니다.** 설계만 하고 안 넣었거나, 다른 브랜치에 있거나, 제가 잘못 적은 겁니다.

### "풀이 없다"가 "재사용을 안 한다"는 뜻은 아닙니다

그런데 코드를 보고 나서 더 이상한 게 있었어요. `SimpleClientHttpRequestFactory` 는 JDK의 `HttpURLConnection` 을 씁니다. 그런데 **JDK의 HTTP 구현도 keep-alive를 합니다.**

그러면 "매 요청마다 TCP 연결"이라는 제 서술이 맞는 걸까요? 재보기로 했습니다.

## [해결 방법 - 실제로 세본다]

TCP 연결이 몇 번 만들어지는지 세는 하네스를 짰습니다.

- 로컬에 `ServerSocket` 을 띄우고 `accept()` 횟수를 셉니다
- 서버는 한 소켓에서 여러 요청을 처리합니다 (`Connection: keep-alive`, `Content-Length` 명시)
- 클라이언트는 `HttpURLConnection` 으로 요청하고 본문을 끝까지 읽습니다
- JDK 25.0.2

본문을 끝까지 읽는 게 중요해요. **다 안 읽으면 커넥션이 재사용 풀로 돌아가지 않습니다.** 이걸 빠뜨리면 측정이 통째로 틀립니다.

```java
static void get(int port) throws IOException {
    URL url = URI.create("http://127.0.0.1:" + port + "/x").toURL();
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setRequestMethod("GET");
    conn.setConnectTimeout(3000);
    conn.setReadTimeout(5000);
    try (InputStream in = conn.getInputStream()) {
        in.readAllBytes();   // 본문을 끝까지 읽어야 커넥션이 풀로 반환된다
    }
}
```

## [성과 - 개선 전후 비교]

### 기본 설정에서

```
JDK 25.0.2
http.keepAlive      = (unset → true)
http.maxConnections = (unset → 5)

순차 50회        요청  50  처리  50  새 TCP 연결   0  재사용률 100.0%
8스레드 200회    요청 200  처리 200  새 TCP 연결  10  재사용률  95.0%
32스레드 200회   요청 200  처리 200  새 TCP 연결  30  재사용률  85.0%
```

**순차 호출에서는 새 연결이 0건**입니다. 워밍업에서 만든 연결을 50번 내내 재사용했어요. 재사용률 100%입니다.

즉 **"매 요청마다 TCP 연결을 만든다"는 제 서술은 틀렸습니다.** JDK는 재사용합니다.

동시 호출에서는 연결이 늘어나요. 8스레드에 10개, 32스레드에 30개입니다. 당연한 결과예요. 동시에 8개 요청이 진행 중이면 소켓도 8개가 필요하니까요.

### maxConnections를 줄이면 오히려 늘어납니다

여기서 흥미로운 게 나왔습니다. JDK에는 `http.maxConnections` 라는 설정이 있어요. 이걸 2로 줄여봤습니다.

```
http.maxConnections = 2

순차 50회        요청  50  처리  50  새 TCP 연결   0  재사용률 100.0%
8스레드 200회    요청 200  처리 200  새 TCP 연결  64  재사용률  68.0%
32스레드 200회   요청 200  처리 200  새 TCP 연결  68  재사용률  66.0%
```

8스레드에서 **10개였던 연결이 64개로 늘었습니다.**

처음에는 이해가 안 됐는데, 생각해보니 당연했어요. `http.maxConnections` 는 **동시 연결 수 제한이 아니라 캐시 크기**입니다. 2로 줄이면 요청이 끝난 뒤 2개만 보관하고 나머지는 버려요. 그러면 다음 요청이 새로 연결해야 합니다.

**줄이면 제한이 걸리는 게 아니라 재사용이 안 됩니다.**

### 캐시와 풀은 다릅니다

이 측정으로 정리된 게 이겁니다.

| | JDK keep-alive 캐시 | Apache 커넥션 풀 |
| --- | --- | --- |
| 요청이 끝난 연결 | 보관했다가 재사용 | 보관했다가 재사용 |
| 동시 요청이 상한을 넘으면 | 새로 연결한다 | **대기한다** |
| 상한 설정 | JVM 전역 시스템 프로퍼티 | 클라이언트별, 호스트별 |
| 대기 타임아웃 | 없음 | `connectionRequestTimeout` |
| 만료/유휴 연결 정리 | 자동, 제어 불가 | `evictExpired`, `evictIdle` |

**제가 없다고 적었어야 할 건 재사용이 아니라 제한이었습니다.**

그리고 이 서비스에서 필요한 건 제한 쪽이에요. Gmail API에는 [사용자별 쿼터](/posts/27-gmail-rate-limit-redis-lua-token-bucket/)가 있어서 동시 호출 수를 눌러야 합니다. 지금 구조는 컨슈머가 늘어나는 만큼 연결도 늘어나요. 아무도 안 막습니다.

### 설정이 전역이라는 것도 문제입니다

`http.maxConnections` 는 JVM 시스템 프로퍼티입니다. 그러니까 **Gmail 클라이언트만 따로 잡을 수 없어요.** 이 값을 바꾸면 같은 JVM의 모든 HTTP 클라이언트가 영향을 받습니다.

지금 워커에는 Gmail Message, Gmail History, Gmail Watch, Google OAuth 네 개의 `RestClient` 가 있고 전부 같은 방식입니다. 각각 성격이 다른데 하나의 전역 값만 있어요.

## [결론]

이 글의 결론은 기술 이야기 반, 정정 반입니다.

**정정.** 이력서에 "커넥션 풀 미구성으로 매 요청마다 TCP 연결 생성 비용 누적" 이라고 적었는데, 두 가지가 틀렸어요.

첫째, **저장소에 커넥션 풀 구성이 없습니다.** `maxConnTotal=20`, `maxConnPerRoute=10` 같은 값은 코드에 존재하지 않아요. Apache HttpClient 의존성 자체가 없습니다.

둘째, **"매 요청마다 TCP 연결"은 사실이 아닙니다.** 순차 호출 50회에서 새 연결은 0건이었어요. JDK는 keep-alive로 재사용합니다.

기술적으로 배운 건 이겁니다.

- keep-alive 캐시와 커넥션 풀은 다르다. 캐시는 재사용을 하고 풀은 제한을 한다
- 상한을 줄이면 제한이 걸릴 거라고 생각했는데, 캐시에서는 재사용이 줄어든다
- 측정할 때 응답 본문을 끝까지 읽지 않으면 커넥션이 반환되지 않아 결과가 뒤집힌다

앞으로 볼 것도 적어둘게요.

첫째, **Apache HttpClient 5로 옮길지를 정해야 합니다.** 지금 필요한 건 동시 호출 제한인데, Redis 토큰 버킷이 이미 그 역할을 일부 하고 있어요. 커넥션 풀까지 두면 제한이 두 겹이 됩니다. 어느 층에서 막는 게 맞는지 먼저 정하는 게 순서예요.

둘째, **옮긴다면 HttpClient 5의 타임아웃 설정 위치를 확인해야 합니다.** 4.x에서는 연결 타임아웃이 `RequestConfig` 에 있었는데 5.x에서는 `ConnectionConfig` 로 옮겨졌다고 알고 있어요. 이력서에 `mergeRequestConfig` 관련 내용을 적어뒀는데, 지금 코드로는 확인할 수 없습니다.

<!-- 확인 필요: Apache HttpClient 5 에서 RequestConfig 에 설정한 connectTimeout 이 실제로 무시되는지.
     검증 방법: HC5 의존성 추가 후, RequestConfig 에만 connectTimeout 을 주고
     연결되지 않는 IP(예: 10.255.255.1)로 요청해 실제 대기 시간을 측정.
     ConnectionConfig 에 준 경우와 비교. -->

셋째, **네 개의 RestClient가 같은 설정을 복사하고 있습니다.** 타임아웃만 다르고 구조는 같아요. 공통 팩토리로 묶으면 나중에 풀을 붙일 때 한 곳만 고치면 됩니다.

이번 글은 쓰면서 제 서술이 틀린 걸 찾은 경우예요. 재보기 전까지는 "풀이 없으니 매번 새로 연결하겠지" 라고 믿고 있었습니다. 근거 없이 그럴듯한 인과를 만들어놓고 그걸 성과로 적었어요. 측정이 30분이면 되는 일이었는데 안 했습니다.
