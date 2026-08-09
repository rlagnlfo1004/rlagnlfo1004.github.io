---
title: "문서대로 DTO를 짰더니 전부 null이었습니다 (실제 응답을 캡처해서 맞추기)"
description: "OpenStack 응답에는 문서에 없는 한 겹이 더 있었습니다. 실제 응답을 파일로 떠서 DTO를 맞춘 과정과, 캡처하면서 신경 쓴 것들."
date: 2026-08-09
project: "아올다 클라우드"
tags: ["OpenStack", "DTO", "Jackson", "API 연동", "캡처"]
---

## [배경 - 값이 안 들어오는데 예외도 안 난다]

아올다 클라우드는 OpenStack API를 중계합니다. Nova, Cinder, Glance, Neutron, Keystone을 부르고 그 결과를 콘솔용으로 가공해요.

키페어 목록을 붙일 때였습니다. 문서를 보고 DTO를 만들고, 호출하고, 로그를 찍어봤어요. 예외는 안 났습니다. HTTP 200도 잘 왔고요.

그런데 **이름도 fingerprint도 전부 `null`** 이었습니다.

Jackson은 매핑할 필드를 못 찾아도 예외를 안 던집니다. 그냥 비워둬요. 그래서 잘못된 DTO는 조용히 지나갑니다. 응답 본문을 직접 찍어보고 나서야 원인을 알았어요.

## [문제 상황 분석 - 문서와 실제가 다른 지점들]

### 리스트 응답에 한 겹이 더 있었습니다

실제로 받은 본문입니다.

```json
{
  "keypairs": [
    {
      "keypair": {
        "name": "test",
        "public_key": "ssh-rsa AAAAB3NzaC1yc2EAAAAD... Generated-by-Nova",
        "fingerprint": "58:29:aa:b7:4d:e1:b7:8c:54:90:09:1b:6b:06:ff:bf"
      }
    }
  ]
}
```

`keypairs` 배열의 각 원소가 다시 `keypair` 로 한 번 더 감싸여 있어요.

제가 만든 DTO는 이걸 기대했습니다.

```
keypairs: [ { name, fingerprint } ]
```

실제는 이거고요.

```
keypairs: [ { keypair: { name, fingerprint } } ]
```

한 겹 차이인데 결과는 전부 `null` 입니다.

### 만들 때와 조회할 때 모양이 다릅니다

더 헷갈렸던 건 이 래핑이 **일관되지 않다**는 점이었어요.

| 호출 | 응답 구조 |
| --- | --- |
| 생성 (POST) | `{ "keypair": { ... } }` |
| 목록 (GET) | `{ "keypairs": [ { "keypair": { ... } } ] }` |

생성은 한 겹, 목록은 두 겹입니다. 같은 리소스인데 모양이 달라요.

그래서 어댑터도 두 갈래로 처리합니다.

```java
// 생성: 단일 keypair wrapper 형태
JsonNode keypairNode = response.getBody().path("keypair");
NovaKeypairsResponse.Keypair keypair = objectMapper.treeToValue(keypairNode, NovaKeypairsResponse.Keypair.class);
```

```java
// 목록: 이중 래핑
for (NovaKeypairsResponse.KeypairWrapper item : keypairs) {
    NovaKeypairsResponse.Keypair keypair = item.getKeypair();
    // ...
}
```

### 있을 때도 있고 없을 때도 있는 필드

또 하나는 `private_key` 였습니다.

```java
// Nova returns private_key only on create when Nova generates the keypair.
// Absent for imported keys or for list/get operations.
@JsonProperty("private_key")
private String privateKey;
```

**Nova가 키를 생성해줄 때만 개인키가 옵니다.** 사용자가 이미 있는 공개키를 등록한 경우에는 안 와요. 목록이나 상세 조회에서도 안 옵니다.

이건 당연한 동작이에요. 개인키는 생성 순간에만 전달할 수 있고 서버는 보관하지 않으니까요. 다만 **문서만 보면 필드 목록에 있어서 항상 오는 줄 압니다.**

이 사실을 코드 주석으로 남긴 게 중요했어요. 다음에 읽는 사람이 "왜 여기만 null 체크가 있지" 를 묻지 않게 됩니다.

## [해결 방법 - 실제 응답을 파일로 떠둔다]

문서를 신뢰할 수 없다면 실제 응답을 근거로 삼아야 합니다. 그래서 **응답을 캡처해서 저장소에 남기는 러너**를 만들었어요.

### 요청과 응답을 같이 저장합니다

```java
public void save(String component, String name, String method, String uri, int port,
                 Map<String, String> headers, Map<String, String> query, int status,
                 JsonNode body) {
    // ...
    fw.write("  \"request\": {\n");
    fw.write("    \"method\": \"" + method + "\",\n");
    fw.write("    \"uri\": \"" + uri + "\",\n");
    fw.write("    \"port\": " + port + ",\n");
    // ...
    fw.write("  \"response\": {\n");
    fw.write("    \"status\": " + status + ",\n");
    fw.write("    \"body\": " + (body == null ? "null" : mapper.writeValueAsString(body)) + "\n");
```

응답만 저장하지 않고 **요청도 같이** 남깁니다. 나중에 파일만 보고 "이건 어떤 호출의 결과인가" 를 알 수 있어야 하니까요. 포트까지 남기는 건 OpenStack 컴포넌트가 포트로 구분되기 때문입니다. Nova는 8774, Cinder는 8776 하는 식이에요.

지금 저장소에는 이렇게 만들어진 캡처가 **94개** 있습니다. 컴포넌트별 디렉터리로 나뉘어 있어요.

### 토큰은 지우고 저장합니다

```java
Map.of("X-Auth-Token", "__MASKED__", "X-Auth-Token-Scope", scopeName(scope))
```

Keystone 토큰은 `__MASKED__` 로 바꿔서 저장합니다. 이 파일들이 저장소에 커밋되니까요.

토큰 스코프는 남깁니다. **같은 API도 토큰 스코프에 따라 응답이 다를 수 있어서** 그게 어떤 스코프로 받은 결과인지가 정보예요.

### 최신본만 남깁니다

```java
File[] olds = dir.listFiles((d, fname) -> fname.startsWith(baseName + "_") || fname.equals(baseName + ".json"));
if (olds != null) {
    for (File old : olds) {
        try { old.delete(); } catch (Exception ignore) {}
    }
}
```

같은 시나리오의 이전 캡처를 지우고 새로 씁니다. 타임스탬프를 붙여 쌓아두면 어느 게 최신인지 헷갈리고, 파일이 계속 늘어나요.

버전 이력은 git이 관리합니다. **파일명으로 이력을 만들지 않고 커밋으로 남기는** 쪽을 골랐어요. 그러면 `git diff` 로 OpenStack 응답이 언제 어떻게 바뀌었는지 볼 수 있습니다.

### 캡처가 운영 클러스터를 두드립니다

이 러너는 **실제 OpenStack 클러스터**를 부릅니다. 학내에서 실제로 쓰는 환경이라 조심해야 했어요.

```yaml
rate:
  sleep-ms: 800
  jitter-ms: 1200
  retries: 6
  backoff-ms: 1000
  cooldown-every: 10
  cooldown-ms: 15000
  startup-warmup-ms: 3000
```

호출마다 800ms에 최대 1200ms의 지터를 더해 쉽니다.

```java
public void pause() {
    long jitter = jitterMs > 0 ? ThreadLocalRandom.current().nextLong(jitterMs + 1) : 0;
    long delay = Math.max(0, sleepMs + jitter);
    // ...
}
```

지터를 넣은 건 일정한 간격으로 두드리면 트래픽이 규칙적인 파형이 되기 때문이에요. 무작위로 흩뜨리면 순간 부하가 덜 몰립니다.

`cooldown-every: 10` 은 열 번마다 15초를 쉰다는 뜻입니다. 짧은 간격의 휴식과 별개로 주기적인 긴 휴식을 넣었어요. 실패해도 재시도하지만 백오프가 붙습니다.

**이 값들은 캡처를 빨리 끝내는 것보다 클러스터에 부담을 안 주는 걸 목표로 잡았습니다.** 캡처는 한 번 돌리면 되는 작업이라 느려도 상관없어요.

### 쓰기 캡처는 따로 끕니다

```yaml
nova:
  servers: true
  servers-detail: true
  keypairs: true
  limits: true
  write:
    enabled: false
    keypairs: true
```

읽기는 켜져 있고 Nova 쓰기는 꺼져 있습니다. **쓰기 캡처는 실제 리소스를 만들기 때문**이에요.

생성 응답을 캡처하려면 진짜로 만들어봐야 합니다. 키페어처럼 가벼운 건 괜찮지만 인스턴스나 볼륨은 자원을 잡아요. 그래서 컴포넌트별로 따로 켤 수 있게 했습니다.

### DTO는 캡처를 보고 씁니다

캡처를 보고 나면 DTO가 명확해집니다.

```java
public class NovaKeypairsResponse {
    private List<KeypairWrapper> keypairs;

    public static class KeypairWrapper {
        private Keypair keypair;
    }

    public static class Keypair {
        private String name;
        @JsonProperty("public_key")
        private String publicKey;
        private String fingerprint;
        @JsonProperty("private_key")
        private String privateKey;
    }
}
```

`KeypairWrapper` 라는 클래스가 생긴 이유가 이제 코드에 드러나요. 이름만 봐도 "감싸는 층" 이라는 걸 알 수 있습니다.

모든 DTO에 `@JsonIgnoreProperties(ignoreUnknown = true)` 를 붙였습니다. OpenStack은 마이크로버전에 따라 필드가 추가되는데, 모르는 필드가 오면 예외가 나는 게 기본 동작이에요. 그러면 클러스터를 업그레이드하는 순간 콘솔이 멈춥니다.

## [성과 - 개선 전후 비교]

| 항목 | 문서 기반 | 캡처 기반 |
| --- | --- | --- |
| DTO 구조 근거 | API 문서 | 실제 응답 JSON 94건 |
| 매핑 실패 발견 시점 | 런타임에 값이 null | DTO 작성 시점 |
| 응답 변화 추적 | 불가 | `git diff` |
| 필드 존재 조건 | 문서 설명 | 실제 캡처 + 코드 주석 |

수치가 없습니다. 캡처를 도입한 뒤 매핑 오류가 몇 건 줄었는지를 세지 않았어요.

<!-- 측정 필요:
     1) 캡처 파일을 픽스처로 쓰는 역직렬화 테스트를 만들고, 전체 DTO 중 몇 개가 실제 응답과 맞는지
        (openstack-captures/**/*.json 을 읽어 각 DTO 로 파싱 → null 필드 비율 확인)
     2) 마이크로버전 업그레이드 전후 캡처 diff 에서 바뀐 필드 수 -->

## [결론]

정리하면 이렇습니다.

- Jackson은 매핑 실패를 조용히 넘긴다. 예외가 안 났다고 맞는 게 아니다
- 외부 API는 문서보다 실제 응답이 정답이다
- 캡처는 운영 시스템을 두드리니 속도보다 부담을 기준으로 설정한다
- 파일명으로 이력을 만들지 말고 git에 맡긴다

한계를 적어둘게요. 첫 번째가 제일 아깝습니다.

첫째, **캡처를 테스트에 안 씁니다.** 94개의 실제 응답 JSON이 저장소에 있는데, 이걸 픽스처로 쓰는 테스트가 없어요. DTO를 고칠 때 캡처와 맞는지 자동으로 확인할 수 있는 재료가 이미 있는데 사람이 눈으로 봅니다.

캡처 파일을 읽어 각 DTO로 역직렬화하고 주요 필드가 `null` 이 아닌지 확인하는 테스트만 있어도 매핑 오류를 컴파일 이후 바로 잡을 수 있어요. 이게 다음에 할 일입니다.

둘째, **캡처가 특정 시점에 고정됩니다.** OpenStack을 업그레이드하면 응답이 바뀔 수 있는데, 캡처를 다시 돌리지 않으면 저장소의 파일이 낡습니다. 그리고 낡았다는 걸 알려주는 장치가 없어요.

셋째, **캡처 파일에 실제 UUID가 들어 있습니다.** 토큰은 가렸지만 프로젝트 ID, 서버 ID, 볼륨 ID는 그대로예요. 공개 저장소라면 내부 자원 식별자가 노출됩니다. 값을 익명화하되 구조는 유지하는 처리가 필요합니다.

넷째, **`ignoreUnknown = true` 가 양날입니다.** 새 필드가 와도 안 깨지는 대신, **필드 이름이 바뀌어도 안 깨져요.** 이름이 바뀌면 조용히 `null` 이 되고, 처음 겪은 문제로 되돌아갑니다. 캡처 기반 테스트가 있으면 이걸 잡을 수 있어요.

다섯째, **응답 캡처만 있고 요청 캡처가 부족합니다.** 쓰기 API의 요청 본문 형식도 문서와 다를 수 있는데, 쓰기 캡처는 대부분 꺼져 있어요.

"문서를 봤는데 안 된다" 를 몇 번 반복하고 나서야 캡처를 만들었습니다. 처음부터 실제 응답을 보고 시작했으면 훨씬 빨랐을 거예요. 다만 캡처를 만들어두고 정작 테스트에 안 쓴 건 아직 절반만 한 셈입니다.
