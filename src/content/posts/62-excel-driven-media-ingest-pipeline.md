---
title: "엑셀 한 장으로 영상 217편을 인코딩에 태웁니다 (스트리밍 반입과 조건부 UPDATE 선점)"
description: "137MB 원본을 힙에 담지 않고 임시 파일로 흘려보낸 이유, 파이프라인을 다섯 구간으로 자른 방식, 다중 인스턴스에서 ShedLock 없이 행 단위 조건부 UPDATE 로 선점한 근거, 그리고 Full Jitter 백오프를 직접 짠 이유를 코드와 E2E 로그로 정리했습니다. 접수에서 편성까지 2분 41초가 실측입니다."
date: 2026-08-31
project: "코리안쌤"
tags: ["OCI", "파이프라인", "JVM", "스케줄러", "Full Jitter", "Rate Limit", "Spring"]
draft: false
---

## [배경 - 인코딩은 가운데 한 칸이었습니다]

[61번 글](/posts/61-oci-media-flow-encoding/)에서 인코딩 자체를 정리했습니다. 워크플로를 한 번 선언해 두고 잡을 던지면 HLS 한 벌이 떨어진다는 이야기였어요. 그 글 마지막에 "다음에는 샘플을 실제로 태워 실측으로 되짚겠다"고 적어 뒀는데, 태워 보고 나서 알게 된 건 다른 것이었습니다.

**인코딩은 파이프라인의 가운데 한 칸이었어요.** 잡을 던지기 전에 원본이 버킷에 있어야 하고, 잡이 끝난 걸 누군가 알아야 하고, 끝난 영상이 커리큘럼의 어느 자리에 들어갈지 정해져야 합니다. 217편을 사람 손으로 그걸 다 하면 편당 다섯 번 클릭이니 천 번이 넘어요.

처음 설계에는 PAR(Pre-Authenticated Request) 업로드 경로가 있었습니다. 관리자가 브라우저에서 파일을 고르면 서버가 미리 서명된 URL 을 내주고, 브라우저가 그 URL 로 버킷에 직접 올리는 방식이에요. 서버가 영상 바이트를 아예 만지지 않으니 제일 깔끔한 그림이었어요.

그런데 실제 운영을 보니 **사람이 파일을 들고 있지 않았어요.** 영상 217편은 이미 구글 드라이브에 있고, 관리자가 갖고 있는 건 링크예요. 편성표도 엑셀로 관리하고 있었고요. PAR 경로는 "파일을 들고 브라우저 앞에 앉은 사람"을 전제하는데 그 사람이 없었던 겁니다.

그래서 접수 창구를 엑셀 네 칸으로 바꿨습니다. 레벨, 과번호, 순서, 영상 URL 이에요.

```java
public record LearningVideoExcelRow(
        @ExcelColumn(columnName = "레벨") String level,
        @ExcelColumn(columnName = "과번호") String chapterNo,
        @ExcelColumn(columnName = "순서") String sortOrder,
        @ExcelColumn(columnName = "영상 URL") String videoUrl
) {
}
```

네 칸이 전부 `String` 인 게 의도예요. 엑셀에서 온 값에 검증 애노테이션을 붙이면 한 칸이 틀렸을 때 파일 전체가 죽어요. 217편을 올리는 화면에서 그건 최악이라, 타입 변환과 범위 검사를 전부 정책 클래스로 내렸습니다. 그리고 PAR 경로는 남기지 않고 지웠어요. 남겨 두면 결속 없는 자산이 계속 생기고, 그 갈래 하나 때문에 결속 컬럼을 NULL 로 열어 둬야 합니다.

이 글은 그 뒤에 실제로 부딪힌 네 가지입니다. 137MB 를 어디에 둘 것인가, 파이프라인을 어디서 자를 것인가, 인스턴스가 둘일 때 같은 영상을 두 번 내려받지 않게 하는 방법, 그리고 남의 서버를 때리는 속도를 어떻게 제한할 것인가예요.

## [문제 상황 분석 - 137MB 를 어디에 두는가]

PAR 을 버리는 순간 서버가 영상 바이트를 만지게 됩니다. 드라이브에서 받아서 버킷에 올려야 하니까요. 그리고 이 서버의 힙은 넉넉하지 않아요.

```groovy
jvmFlags = [
        '-Xms512m',
        '-Xmx1536m',
        '-XX:+UseG1GC',
        // ...
]
```

### 배열 하나가 힙 상한을 정합니다

가장 짧게 쓰는 코드는 이거예요.

```java
// 이렇게 쓰지 않았습니다
byte[] video = restClient.get().uri(url).retrieve().body(byte[].class);
```

한 줄이고 읽기 쉬워요. 그런데 이 줄은 **응답 전체를 힙 위의 배열 하나로 만듭니다.** 실측한 원본이 137MB 였고 워커를 둘로 두었으니, 최악의 순간에 힙에는 274MB 가 배열로 앉아 있게 돼요. 이건 잰 값이 아니라 137MB 를 두 배 한 산술입니다. 실제로는 SDK 가 업로드하면서 다시 버퍼링하면 더 늘 수도 있어요.

숫자 자체보다 무서운 건 **그 숫자를 우리가 정하지 않는다**는 점이었어요. 원본 용량은 강의를 찍은 쪽이 정하고, 관리자는 링크만 붙여 넣어요. 300MB 짜리가 섞여 들어오면 힙 계산이 그대로 무너집니다.

G1 을 쓰고 있어서 한 가지가 더 걸렸어요. G1 은 힙을 region 으로 쪼개 쓰고, region 크기의 절반을 넘는 배열은 humongous 로 따로 다뤄요. region 크기를 지정하지 않았으니 기본식(힙을 2048 로 나누고 1MB 를 하한으로 둡니다)대로 1MB 가 되고, 그러면 humongous 문턱은 512KB 입니다. 137MB 배열은 문턱의 274배예요. humongous 는 연속된 region 을 요구하고 젊은 영역의 회수 대상이 아니라서, 이런 배열이 오가면 [52번 글](/posts/52-jvm-gc-stw-and-cold-start/)에서 다룬 종류의 문제가 생깁니다.

<svg class="diagram" viewBox="0 0 720 252" role="img" aria-label="힙 상한 1536MB 를 720픽셀 눈금으로 그린 막대 두 개. 위는 원본을 배열로 받아 274MB 를 차지하는 안, 아래는 임시 파일로 흘려보내 힙에 복사 버퍼만 남는 안">
  <text x="0" y="14" font-size="13" font-weight="600" fill="var(--ink-2, #545A64)">막대 하나가 힙 상한이다. 눈금은 720픽셀을 1536MB 에 맞췄다</text>

  <text x="0" y="44" font-size="11.5" font-weight="700" fill="var(--ink-3, #8B9099)">버린 안, 응답을 배열로 전량 받기</text>
  <rect x="0" y="54" width="720" height="34" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <rect x="0" y="54" width="64" height="34" rx="6" fill="var(--clay-soft, #EAF2FE)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <line x1="32" y1="54" x2="32" y2="88" stroke="var(--clay, #3182F6)" stroke-width="1"/>
  <text x="76" y="70" font-size="10.5" fill="var(--ink-2, #545A64)">원본 배열 두 개가 힙 안에 앉는다</text>
  <text x="76" y="84" font-size="10.5" font-family="var(--font-mono)" fill="var(--clay-text, #1B64DA)">137MB x 2 = 274MB</text>
  <text x="716" y="70" font-size="10.5" text-anchor="end" font-family="var(--font-mono)" fill="var(--ink-3, #8B9099)">-Xmx1536m</text>
  <text x="716" y="84" font-size="10" text-anchor="end" fill="var(--ink-3, #8B9099)">용량은 관리자가 정한다</text>

  <text x="0" y="130" font-size="11.5" font-weight="700" fill="var(--clay-text, #1B64DA)">채택, 임시 파일로 흘려보내기</text>
  <rect x="0" y="140" width="720" height="34" rx="6" fill="var(--bg, #FFFFFF)" stroke="var(--clay, #3182F6)" stroke-width="1.2"/>
  <rect x="0" y="140" width="5" height="34" rx="2" fill="var(--clay, #3182F6)"/>
  <rect x="7" y="140" width="5" height="34" rx="2" fill="var(--clay, #3182F6)"/>
  <text x="22" y="161" font-size="10.5" fill="var(--ink-2, #545A64)">힙에 남는 것은 복사 버퍼뿐이다. 원본 용량과 무관하다</text>

  <rect x="0" y="196" width="720" height="28" rx="6" fill="var(--sunk, #F1F3F6)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
  <rect x="0" y="196" width="64" height="28" rx="6" fill="var(--surface, #FAFAFB)" stroke="var(--ink-3, #8B9099)" stroke-width="1"/>
  <line x1="32" y1="196" x2="32" y2="224" stroke="var(--ink-3, #8B9099)" stroke-width="1"/>
  <text x="76" y="214" font-size="10.5" fill="var(--ink-2, #545A64)">대신 컨테이너 디스크로 옮겨 갔다. 성공이든 실패든 finally 에서 지운다</text>
  <text x="716" y="214" font-size="10" text-anchor="end" fill="var(--ink-3, #8B9099)">임시 파일</text>
</svg>

<p class="diagram-note">274MB 는 잰 값이 아니라 실측 원본 137MB 를 워커 수로 곱한 산술입니다. 아래 막대의 복사 버퍼 폭은 눈에 보이게 그린 것이고 실제 비율은 아닙니다.</p>

### 그래서 응답을 파일로 흘려보냈습니다

`RestClient` 의 `exchange` 를 쓰면 응답 본문 스트림을 직접 받을 수 있어요. 받은 스트림을 그대로 임시 파일에 복사하면 힙에는 복사 버퍼만 남아요.

```java
return restClient.get().uri(url).exchange((request, response) -> {
    HttpStatusCode status = response.getStatusCode();
    if (!status.is2xxSuccessful()) {
        return Attempt.ofFailure(status.value() == 429 || status.is5xxServerError(),
                retryAfter(response.getHeaders()), "status=" + status.value());
    }

    MediaType contentType = response.getHeaders().getContentType();
    // 200 인데 HTML 이면 파일이 아니라 대용량 확인 안내 문서다
    if (contentType != null && MediaType.TEXT_HTML.equalsTypeAndSubtype(contentType)) {
        return Attempt.ofConfirmPage();
    }
    try (InputStream body = response.getBody()) {
        long bytes = Files.copy(body, tempFile, StandardCopyOption.REPLACE_EXISTING);
        if (bytes <= 0) {
            return Attempt.ofFailure(true, null, "빈 응답");
        }
        return Attempt.ofSuccess();
    }
});
```

여기서 하나 배운 게 있어요. **드라이브 공개 링크는 200 을 주면서 영상이 아닌 것을 줄 수 있습니다.** 용량이 큰 파일은 "바이러스 검사를 못 했다"는 확인 페이지를 HTML 로 돌려주는데, 상태 코드는 200 이에요. 그래서 상태만 보고 파일로 저장하면 137MB 자리에 몇 KB 짜리 HTML 이 들어앉고, 인코딩 잡이 그걸 받아 실패해요. 컨텐츠 타입을 보고 갈라야 했습니다.

올릴 때도 같은 원칙이에요. 파일을 열어 스트림으로 넘기고, 길이는 파일 크기에서 읽습니다.

```java
long contentLength = Files.size(file);

try (InputStream body = Files.newInputStream(file)) {
    client.putObject(PutObjectRequest.builder()
            .namespaceName(properties.namespace())
            .bucketName(properties.sourceBucket())
            .objectName(objectKey)
            .contentLength(contentLength)
            .contentType(VIDEO_CONTENT_TYPE)
            .putObjectBody(body)
            .build());
}
```

`contentLength` 를 미리 채우는 게 중요합니다. 길이를 안 주면 SDK 가 길이를 알아내려고 스트림을 자기 쪽에 모으거나 청크로 나눠야 하는데, 앞에서 힙을 아낀 의미가 거기서 사라져요. 파일로 받아 뒀으니 길이는 `Files.size` 한 번으로 공짜입니다. **임시 파일은 힙을 아끼려고 쓴 것이지만, 길이를 미리 아는 이득까지 같이 왔습니다.**

대가도 적어요. 힙 압력이 컨테이너 디스크로 옮겨 갔고, 성공이든 실패든 지워야 하는 파일이 하나 생겼어요. 그래서 삭제를 두 군데에 뒀습니다. 다운로드가 예외로 끝나면 클라이언트가 자기 임시 파일을 지우고, 반입 워커는 업로드 성공 여부와 무관하게 `finally` 에서 지웁니다.

한 가지 짚어 둘 것은, **영상은 우리 API 를 통과하지 않는다**는 점이에요. 엑셀만 멀티파트로 들어옵니다.

```yaml
spring:
  servlet:
    multipart:
      # 관리자 영상 적재 엑셀(최대 500행)을 받는다. 기본값 1MB 로는 헤더가 붙은 xlsx 도 걸린다.
      # 영상 원본은 이 경로로 들어오지 않는다 - 서버가 드라이브에서 직접 받아 버킷에 올린다.
      max-file-size: 10MB
```

10MB 는 엑셀 500행을 받기 위한 값이에요. 영상 크기와는 상관이 없어요.

## [파이프라인 - 다섯 구간과 상태 다섯 개]

접수를 동기로 다 처리할 수는 없어요. 500행이면 다운로드와 업로드가 500번이니까요. 그래서 접수만 동기로 끝내고 `202 Accepted` 를 돌려주고, 나머지를 뒤로 넘겼습니다.

<figure class="mermaid-figure">
<pre class="mermaid-src">flowchart TB
  a["① 접수 (동기, 우리 서버)&lt;br/>엑셀 1장 → 행 검증 → 챕터 조회 → 블록 확보 → 자산 UPSERT(PENDING)&lt;br/>여기서 202 로 응답이 나간다"]:::accent
  b["② 반입 (비동기, 우리 서버)&lt;br/>@Async 워커 동시 2 + 60초 스케줄러&lt;br/>드라이브 공개 링크 → 임시 파일 → PutObject → UPLOADING"]:::accent
  c["③ 인코딩 (OCI 관리형)&lt;br/>createobject 이벤트 → Events 규칙 → PBF → Media Flow 잡&lt;br/>우리 함수 코드 0줄, 잡 생성은 우리에게 알리지 않는다"]:::neutral
  d["④ 확정 (OCI 관리형 + 우리 서버)&lt;br/>mediaworkflowjob.end → Events 규칙 → ONS 토픽 → HTTPS 구독&lt;br/>웹훅 수신 후 GetMediaWorkflowJob 재조회로 상태를 확정한다"]:::neutral
  e["⑤ 공개 (우리 서버)&lt;br/>DONE 인 편만 즉시 hama_learning_block_video 에 편성&lt;br/>다른 편을 기다리지 않는다"]:::accent
  a --> b --> c --> d --> e
</pre>
</figure>

③과 ④에 우리가 쓴 함수 코드가 한 줄도 없어요. 잡을 만드는 트리거는 Oracle 카탈로그의 Pre-Built Function 을 그대로 쓰고, 완료 릴레이는 Notifications 의 HTTPS 구독이 대신해요. 함수를 짜는 이유가 "JSON 에서 한 조각 꺼내 POST 한다"뿐이면 컨테이너 레지스트리와 배포 파이프라인을 통째로 들일 이유가 없다고 판단했습니다.

그 대신 관리형에 맞춰 포기한 게 있어요. PBF 는 잡의 `displayName` 을 우리가 정하게 해 주지 않고, 잡을 만들었다는 사실도 알려주지 않아요. 실측해 보니 이름은 편마다 `PBF_ks-portrait-9x16-1080_Job` 으로 같았습니다. 그래서 **잡과 자산을 잇는 열쇠를 입력 객체 키로 잡았습니다.** 완료 이벤트를 받아 잡을 재조회하면 응답의 `parameters.input.objectName` 에 우리가 올린 키가 그대로 들어 있어요.

이 결정이 상태 기계를 하나 줄였어요.

<figure class="mermaid-figure">
<pre class="mermaid-src">flowchart LR
  p["PENDING&lt;br/>반입 대기"]:::soft
  i["INGESTING&lt;br/>반입 중"]:::accent
  u["UPLOADING&lt;br/>원본이 버킷에 있다"]:::accent
  d["DONE&lt;br/>편성 완료"]:::soft
  f["FAILED"]:::mute
  p -->|"조건부 UPDATE 선점"| i
  i -->|"PutObject 성공"| u
  u -->|"job-ended 재조회 SUCCEEDED"| d
  i -->|"다운로드나 업로드 실패"| f
  u -->|"재조회 FAILED"| f
  i -->|"10분 넘게 멈춤, 고아 회수"| p
  f -->|"관리자 재시도"| p
</pre>
</figure>

`RUNNING` 이 없어요. 잡이 도는 동안 자산은 `UPLOADING` 에 그대로 있어요. 잡 생성을 우리가 모르니 "인코딩 중"으로 바꿔 줄 시점이 존재하지 않기 때문입니다. 없는 정보를 상태로 만들면 그 상태는 반드시 거짓말을 합니다.

웹훅 쪽에도 원칙 하나를 세웠습니다. **페이로드는 신호일 뿐이고 진실은 재조회입니다.**

```java
public void jobEnded(JsonNode body) {
    String jobId = extractJobId(body);
    if (jobId == null) {
        log.warn("[OCI-CAPTURE] job-ended 웹훅에서 잡 OCID 를 찾지 못했다(구독 확인 요청이거나 미상 봉투). body={}", body);
        return;
    }

    OciMediaServicesClient.MediaJobView view = ociMediaServicesClient.getJob(jobId);
    MediaJobOutcome outcome = mediaAssetService.applyJobEnded(jobId, view.inputObjectKey(),
            view.lifecycleState(), view.outputKey());
    // ...
}
```

본문을 DTO 로 고정하지 않고 `JsonNode` 로 받아요. 구독을 만들면 확인 요청이 같은 경로로 한 번 들어오는데, 그 봉투는 잡 OCID 가 없는 다른 모양이에요. 그리고 어떤 봉투가 와도 200 을 돌려줍니다. 4xx 를 주면 Notifications 가 구독을 죽이기 때문입니다. 진실을 재조회에서 얻으니 봉투를 엄격하게 검사할 이유도 없었어요.

이 구조가 실제로 값을 했어요. 첫 시도에서 완료 이벤트 규칙이 아예 만들어져 있지 않아 웹훅이 안 왔는데, 잡 OCID 만 알면 웹훅을 직접 쏘아도 결과가 같았습니다. 진실이 재조회라서 봉투는 누가 만들었든 상관이 없었던 거예요.

## [해결 방법 - 다중 인스턴스에서 ShedLock 을 쓰지 않은 이유]

여기가 이 작업에서 가장 오래 고민한 자리입니다.

반입 워커는 두 경로로 투입됩니다. 접수 직후 `@Async` 로 바로 한 번, 그리고 60초 스케줄러가 `PENDING` 을 훑어 다시 한 번이에요. 앞의 것이 응답을 빠르게 만들고, 뒤의 것이 놓친 걸 회수합니다.

문제는 이 서버가 한 대가 아니라는 점이었어요. 배포 스크립트가 이렇게 돕니다.

```bash
echo "1. 새 컨테이너 추가"
docker compose up -d --scale "$API_CONTAINER=2" --no-recreate
```

무중단 배포라 새 컨테이너를 띄우고 헬스체크가 통과한 뒤에 옛 컨테이너를 내립니다. **그 사이에는 인스턴스가 둘이고, 둘 다 자기 스케줄러를 돌립니다.** 같은 `PENDING` 행을 둘이 집으면 같은 영상을 두 번 내려받고 두 번 올려요. 객체 키에 UUID 가 붙어 있으니 버킷에 파일이 둘 생기고, `createobject` 이벤트가 두 번 발화하고, 잡도 둘 생깁니다. 어느 잡이 나중에 끝나는지는 우리가 정할 수 없으니 최종 영상이 무엇일지 알 수 없게 됩니다.

### 후보 세 개를 비교했습니다

| 방법 | 무엇을 잠그나 | 우리 경우에 걸린 것 |
|---|---|---|
| ShedLock | 스케줄러 메서드. 한 주기를 인스턴스 하나만 실행한다 | 겹침의 축이 인스턴스가 아니다. 한 인스턴스 안에서도 접수 직후 투입과 스케줄러 회수가 같은 행을 집는다 |
| `SELECT ... FOR UPDATE SKIP LOCKED` | 행. 트랜잭션이 끝날 때까지 잡고 있는다 | 반입 한 건이 다운로드와 업로드로 분 단위다. 그 시간 내내 DB 커넥션과 행 락을 쥐게 된다 |
| 행 단위 조건부 UPDATE | 행. `UPDATE` 한 문장 동안만 | 채택 |

ShedLock 을 먼저 검토했고, 여기서 판단이 한 번 바뀌었습니다. 처음에는 "다중 인스턴스니까 분산 락"이라고 반사적으로 생각했어요. 그런데 무엇을 잠그려는 건지 다시 물어보니 답이 달라졌어요. ShedLock 이 잠그는 것은 **스케줄러 메서드**이고, 우리가 겹치지 않게 하려는 것은 **자산 한 행**입니다.

이 차이가 실제 결과로 드러나는 지점이 둘 있었어요. 첫째, ShedLock 을 걸어 스케줄러를 한 대만 돌게 해도 접수 직후 `@Async` 투입은 두 인스턴스 어디서든 일어납니다. 겹침이 그대로 남아요. 둘째, 락을 쥔 인스턴스가 배포로 내려가면 `lockUntil` 이 지나기 전까지 아무도 그 일을 하지 않습니다. 무중단 배포 중에 워커가 멈추는 셈이에요.

`SKIP LOCKED` 는 대량 작업 큐에는 잘 맞는 방식이에요. 다만 우리 작업 한 건의 수명이 문제였어요. 트랜잭션을 열어 행을 잠그고, 그 안에서 137MB 를 내려받고 올리고, 그다음에 커밋해야 합니다. [10번 글](/posts/10-transactional-external-call/)에서 트랜잭션 안의 외부 호출이 커넥션 풀에 무슨 짓을 하는지 재봤는데, 그 글의 실험이 초 단위 호출이었고 이건 분 단위예요.

그리고 이 프로젝트에는 Redis 가 없어요. 의존성부터 새로 들여야 하고, 들이면 [42번 글](/posts/42-redis-distributed-lock-fencing-token/)에서 다룬 만료와 fencing 문제가 그대로 따라옵니다. 워커 하나 때문에 그걸 감당할 이유를 못 찾았어요.

### 조건부 UPDATE 한 문장

채택한 건 이겁니다.

```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("""
        update MediaAssetEntity a
           set a.encodingStatus = com.hama.koreanssam.domain.media.entity.MediaEncodingStatus.INGESTING,
               a.updatedAt = :now
         where a.id = :id
           and a.encodingStatus = com.hama.koreanssam.domain.media.entity.MediaEncodingStatus.PENDING
        """)
// 벌크 UPDATE 는 Auditing 을 타지 않는다. updated_at 을 직접 밀지 않으면 즉시 고아로 잡힌다
int claimForIngest(@Param("id") Long id, @Param("now") LocalDateTime now);
```

호출부는 영향 행 수만 봅니다.

```java
@Transactional
public boolean claimForIngest(Long assetId) {
    return mediaAssetRepository.claimForIngest(assetId) == 1;
}
```

```java
void ingest(Long assetId) {
    if (!mediaAssetService.claimForIngest(assetId)) {
        log.debug("반입 선점에 실패했다(남이 가져갔다). assetId={}", assetId);
        return;
    }
    // 여기 아래는 이 행을 이긴 워커 하나만 실행한다
```

`1` 이면 내가 이겼고, `0` 이면 누군가 먼저 가져갔으니 조용히 물러납니다. 락을 따로 두지 않고 **상태 컬럼 자체를 선점 표식으로 쓰는** 방식이에요. 원자성은 DB 가 `UPDATE` 한 문장에 대해 이미 보장하는 것을 그대로 씁니다.

이점을 정리하면 이렇습니다.

| 항목 | 조건부 UPDATE 로 얻은 것 |
|---|---|
| 의존성 | 0개. 라이브러리도 표도 추가하지 않는다 |
| 락 수명 | `UPDATE` 한 문장. 다운로드 분 단위와 무관하다 |
| 인스턴스 수 | 몇 대여도 같다. 두 대든 다섯 대든 이기는 쪽이 하나다 |
| 투입 경로 | 접수 직후 투입과 스케줄러 회수가 같은 규칙으로 걸러진다 |
| 인스턴스 사망 | 죽은 인스턴스가 쥔 행은 10분 뒤 고아로 회수된다 |
| 병렬성 | 워커 둘이 서로 다른 행을 동시에 처리한다. 직렬화되지 않는다 |

마지막 줄이 ShedLock 과 갈리는 실질적 차이예요. 메서드를 잠그면 한 주기를 한 대만 돌지만, 행을 잠그면 **두 인스턴스가 서로 다른 영상을 동시에 반입합니다.** 인스턴스가 늘어날 때 처리량도 같이 늘어요.

대신 함정이 하나 있었어요. 벌크 `UPDATE` 는 JPA Auditing 을 타지 않습니다. `updated_at` 을 쿼리 안에서 직접 밀지 않으면 선점 직후의 시각이 접수 시각에 머물러 있고, 아래 고아 회수가 **반입을 시작하자마자 그 행을 고아로 판정합니다.** 이건 로그에도 응답에도 안 드러나는 종류의 고장이라 테스트로 못 박아 뒀어요.

```java
@Test
void 선점은_한_워커만_이긴다() {
    MediaAssetEntity asset = savePending(10L, 1);

    // 접수 즉시 투입과 스케줄러 회수가 같은 자산을 겹쳐 집는 것이 정상이다. 진 쪽은 0을 받고 물러난다
    assertEquals(1, mediaAssetJpaAdapter.claimForIngest(asset.getId()));
    assertEquals(0, mediaAssetJpaAdapter.claimForIngest(asset.getId()));
}

@Test
void 선점은_updated_at_을_함께_민다() {
    // 벌크 UPDATE 는 JPA Auditing 을 타지 않는다. 여기서 시각이 멈추면 반입을 시작하자마자 고아로 잡힌다
    MediaAssetEntity asset = savePending(10L, 1);
    LocalDateTime before = asset.getUpdatedAt();

    mediaAssetJpaAdapter.claimForIngest(asset.getId());

    LocalDateTime after = mediaAssetJpaAdapter.findById(asset.getId()).orElseThrow().getUpdatedAt();
    assertFalse(after.isBefore(before), "선점이 updated_at 을 되돌렸다: %s → %s".formatted(before, after));
}
```

### 선점을 고르면 회수가 따라옵니다

선점의 대가는 명확합니다. `INGESTING` 으로 바꾼 워커가 죽으면 그 행은 아무도 손대지 않아요. 상태가 곧 락이니 락을 쥔 채 사라진 것과 같아요. 그래서 회수를 같은 스케줄러에 붙였습니다.

```java
@Scheduled(fixedDelayString = "${media.ingest.scheduler-delay-ms:60000}")
public void sweep() {
    try {
        mediaAssetService.releaseOrphans(orphanThreshold, pendingBatchSize);

        List<Long> pendingIds = mediaAssetService.findPendingIds(pendingBatchSize);
        if (pendingIds.isEmpty()) {
            return;
        }
        MediaIngestBusiness proxy = self.getObject();
        pendingIds.forEach(proxy::ingestAsync);
    } catch (Exception e) {
        log.error("반입 스케줄러가 실패했다. 다음 주기에 다시 시도한다.", e);
    }
}
```

`INGESTING` 인 채로 10분을 넘긴 행을 `PENDING` 으로 되돌립니다. 되돌려 놓으면 다음 주기에 살아 있는 인스턴스가 집어 가요. **인스턴스가 죽어도 파이프라인이 스스로 낫는 구간이 여기입니다.** 회수 기준을 `updated_at` 으로 잡았기 때문에 위의 함정이 치명적이었던 거고요.

여기서 `self.getObject()` 로 자기 프록시를 꺼내 쓰는 것도 이유가 있습니다.

```java
// this 로 부르면 프록시를 안 타 스케줄러 스레드에서 동기로 돌고 동시 실행 제한이 사라진다
private final ObjectProvider<MediaIngestBusiness> self;
```

`this.ingestAsync(id)` 로 쓰면 `@Async` 가 안 걸립니다. [46번 글](/posts/46-spring-aop-proxy-internals/)에서 정리한 그 문제예요. 그러면 100건이 스케줄러 스레드 하나에서 순서대로 돌고, 아래에서 이야기할 동시 2 제한도 같이 사라집니다.

## [부하 제어 - Rate Limit 과 Full Jitter 를 직접 짰습니다]

부하 제어는 두 층으로 나눠 생각했어요. **내가 상대를 때리는 속도**와 **상대가 거절했을 때 물러나는 방식**입니다. 앞의 것이 없으면 뒤의 것을 아무리 잘 짜도 계속 거절당하고, 뒤의 것이 없으면 한 번의 거절이 실패로 굳습니다.

### 때리는 속도는 스레드풀로 제한했습니다

```java
private static final int INGEST_CONCURRENCY = 2;
private static final int INGEST_QUEUE_CAPACITY = 200;

@Bean("mediaIngestExecutor")
public ThreadPoolTaskExecutor mediaIngestExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(INGEST_CONCURRENCY);
    executor.setMaxPoolSize(INGEST_CONCURRENCY);
    executor.setQueueCapacity(INGEST_QUEUE_CAPACITY);
    executor.setThreadNamePrefix("media-ingest-");
    // 버려도 잃는 것이 없다. 자산은 PENDING 으로 남고 스케줄러가 회수한다
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
    executor.initialize();
    return executor;
}
```

동시 2 로 정한 이유는 상대가 우리 것이 아니기 때문입니다. 드라이브 공개 링크는 우리 자격증명으로 부르는 API 가 아니에요. 쿼터가 우리 계정에 달린 것이 아니라서 한도를 우리가 볼 수도, 올릴 수도 없습니다. 217편을 동시에 긁으면 무엇이 먼저 막히는지 확인할 방법이 없으니, 확인할 수 없는 한도 앞에서는 좁게 시작하는 쪽을 골랐어요. 어차피 217편은 한 번 태우면 끝나는 1회성 적재라 처리량을 짜낼 이유도 없었습니다.

`DiscardPolicy` 가 이 설계의 열쇠입니다. 보통 작업을 버리는 정책은 위험하지만, 여기서는 **버려도 잃는 것이 없어요.** 자산 행은 `PENDING` 으로 DB 에 남아 있고 60초 뒤 스케줄러가 다시 집습니다. 큐를 무한으로 두거나 호출자 스레드에서 실행하는 대신 그냥 버릴 수 있는 건, 상태를 메모리가 아니라 DB 에 뒀기 때문입니다. [21번 글](/posts/21-transactional-outbox-push-recovery/)의 Outbox 와 같은 성질이에요.

접수 쪽에도 상한을 뒀습니다. 엑셀 한 장은 500행까지고, 넘으면 파일 전체를 거절합니다. 행 하나의 오류는 그 행만 거절하고 나머지는 접수하는데, 500행 초과는 파일 전체를 막는 두 경우 중 하나예요.

### 물러나는 방식은 Full Jitter 입니다

```java
public static Duration nextDelay(int attempt, long baseMillis, Long retryAfter) {
    if (retryAfter != null && retryAfter > 0) {
        return capped(Duration.ofSeconds(retryAfter));
    }
    long ceiling = capped(Duration.ofMillis(baseMillis * (1L << Math.min(attempt, 10)))).toMillis();
    if (ceiling <= 0) {
        return Duration.ZERO;
    }

    return Duration.ofMillis(ThreadLocalRandom.current().nextLong(ceiling));
}
```

세 줄인데 결정이 네 개 들어 있어요.

**첫째, 지수 백오프의 계산값을 상한으로 쓰고 실제 대기는 0 과 그 사이에서 뽑습니다.** 이게 Full Jitter 입니다. 고정 지연이면 500행을 한 번에 접수했을 때 워커 둘과 스케줄러 재투입이 같은 밀리초에 백오프를 시작하고 같은 밀리초에 함께 깨어나요. 물러났다가 다시 몰리는 셈이라, 재시도가 상대를 다시 밀어냅니다. 대기 시간을 흩어 놓으면 두드리는 시점이 겹치지 않습니다.

Equal Jitter(절반은 고정, 절반만 무작위)나 Decorrelated Jitter 도 후보였습니다. 최소 대기를 보장해야 하는 상황이면 그쪽이 맞아요. 그런데 우리는 시도가 3회뿐이고 상대가 자기 창을 광고하지 않습니다. 최소 대기를 지켜서 얻을 게 없다고 봤어요.

**둘째, `Retry-After` 가 오면 계산값을 버립니다.** 상대가 "이만큼 있다가 와라"라고 말했는데 우리 공식을 고집하는 건 재시도가 아니라 가중이니까요. 다만 헤더는 숫자만 읽습니다. HTTP 날짜 형식도 규격상 허용되는데, 그걸 파싱해서 시계 오차까지 다루기보다 못 읽으면 우리 공식으로 돌아가는 쪽이 안전했습니다.

**셋째, 상한 30초입니다.** 지수는 조금만 시도가 늘어도 분 단위가 돼요. 워커가 둘뿐인데 하나가 한 건에 몇 분씩 묶이면 처리량이 절반으로 내려앉습니다. `Retry-After` 도 이 상한에 걸립니다.

**넷째, 재시도할 실패와 하지 않을 실패를 갈랐습니다.** 429 와 5xx 와 연결 예외만 재시도하고, 4xx 는 재시도하지 않아요. 링크가 잘못됐거나 공유 설정이 닫힌 것을 세 번 물어봐도 답은 같습니다. 확인 페이지는 재시도가 아니라 **경로 교체**로 다뤘습니다. 다른 다운로드 URL 로 한 번만 바꿔 보고, 그래도 HTML 이면 포기합니다.

```yaml
google:
  drive:
    # 대용량 확인 페이지를 우회하는 경로. %s 자리에 파일 ID 가 들어간다.
    download-url-template: "https://drive.usercontent.google.com/download?id=%s&export=download&confirm=t"
    # 그래도 확인 페이지(text/html)가 돌아왔을 때 한 번 더 시도할 경로.
    fallback-url-template: "https://drive.google.com/uc?id=%s&export=download&confirm=t"
    connect-timeout-seconds: 10
    # 소켓 읽기 단위 타임아웃이라 전체 다운로드 시간 상한이 아니다.
    read-timeout-seconds: 300
    max-attempts: 3
    backoff-base-millis: 1000
```

`read-timeout-seconds: 300` 옆의 주석이 제가 한 번 헷갈렸던 지점이에요. 이건 전체 다운로드가 300초를 넘으면 끊는다는 뜻이 아닙니다. 소켓에서 다음 데이터가 300초 동안 안 오면 끊는다는 뜻이라, 느리게라도 계속 흘러오는 137MB 는 300초를 넘겨도 끊기지 않습니다. 전체 시간 상한은 여기에 없고, 대신 10분 고아 회수가 그 역할을 대신하고 있습니다.

무작위를 쓰는 코드는 테스트가 까다로운데, 범위를 잠그는 쪽으로 갔습니다.

```java
@Test
void 지터는_0과_상한_사이에_머문다() {
    // 시도가 늘수록 상한이 2배씩 커진다. 200번 굴려도 그 범위를 넘지 않아야 한다
    for (int attempt = 0; attempt < 4; attempt++) {
        long ceiling = BASE_MILLIS * (1L << attempt);
        for (int i = 0; i < 200; i++) {
            long delay = DriveDownloadBackoff.nextDelay(attempt, BASE_MILLIS, null).toMillis();
            assertTrue(delay >= 0 && delay < ceiling, ...);
        }
    }
}

@Test
void RetryAfter_가_있으면_계산값_대신_그_값을_쓴다() {
    // 상대가 말한 시간보다 일찍 두드리는 것은 재시도가 아니라 가중이다
    assertEquals(Duration.ofSeconds(7), DriveDownloadBackoff.nextDelay(0, BASE_MILLIS, 7L));
}
```

값을 고정하는 대신 **불변식을 고정하는** 방식이에요. 지터가 사라지거나 상한이 풀리면 이 테스트가 깨집니다.

## [성과 - 접수에서 편성까지 2분 41초]

8월 31일에 dev 환경에서 끝에서 끝까지 관통시켰습니다. 엑셀 한 행(레벨1, 3과, 순서1)을 올리고 사람 손을 대지 않았어요.

```
19:30:44  엑셀 접수 (202, assetId=2)
19:31:01  UPLOADING          <- 드라이브 다운로드 + PutObject
19:31:05  잡 생성            <- createobject 이벤트 -> Events 규칙 -> PBF
19:33:25  DONE, lbvIdx=2     <- job-ended -> ONS -> 웹훅 -> 재조회 -> 편성
```

| 구간 | 실측 |
|---|---|
| 접수에서 편성까지 | 2분 41초 |
| 반입 (드라이브 다운로드 + 버킷 업로드) | 17초 |
| 버킷 적재에서 잡 생성까지 | 4초 |
| 잡 생성에서 완료 반영까지 | 2분 20초 |
| 사람이 손댄 횟수 | 0회 |

앞선 시도에서 잰 값도 같이 적어 둡니다. 원본 **137MB** 를 반입하는 데 **8초** 가 걸렸고, `source/portrait/lv1/ch02/grammar-briefing/01-{uuid}.mp4` 로 올라갔습니다. 앞에서 힙 이야기를 할 때 쓴 137MB 가 이 값이에요. 두 번째 관통에서 17초가 걸린 편의 용량은 기록해 두지 않았습니다.

측정 환경은 dev 단일 인스턴스이고, 세로 9:16 워크플로에 rung 3단, 세그먼트 3초 구성입니다. 테스트는 485개가 통과했고, `ddl-auto: validate` 로 dev DB 에 붙여 띄워 전 엔티티 스키마 대조를 통과했습니다(기동 20.625초).

**한계를 분명히 적어 둘게요.** 이 숫자는 1편을 관통한 값입니다. 217편을 동시에 밀어 넣었을 때 무엇이 먼저 막히는지는 아직 모릅니다. 드라이브가 429 를 줄지, 워커 둘이 병목일지, 배치 INSERT 가 안 걸려 있을지가 전부 열려 있어요.

<!-- 측정 필요: 100행 엑셀 접수 후 insert into hama_media_asset 문장 수를 센다. 1~2건이면 배치가 걸린 것이고 100건이면 안 걸린 것 -->
<!-- 측정 필요: 반입 중 힙 사용량. jcmd <pid> GC.heap_info 를 워커 2개가 도는 동안 5초 간격으로 뜬다 -->
<!-- 측정 필요: 217편 전량 적재 소요 시간과 그 사이 드라이브 429 발생 횟수 -->
<!-- 측정 필요: 배열로 받는 안과 임시 파일 안의 힙 사용량 실측 비교. 지금 274MB 는 산술값이다 -->

## [결론]

네 가지를 정리하면 이렇습니다.

**137MB 는 힙에 두지 않았습니다.** 응답 스트림을 임시 파일로 흘려보내고 길이를 파일에서 읽었어요. 힙에 앉는 크기를 관리자가 정하게 두면 안 된다는 게 판단의 근거였습니다.

**파이프라인은 다섯 구간으로 자르고 셋을 관리형에 맡겼습니다.** 우리가 쓴 함수 코드는 0줄이고, 그 대가로 잡 생성을 통지받지 못했습니다. 그래서 없는 상태(`RUNNING`)를 만들지 않고 입력 객체 키로 잡과 자산을 이었어요.

**다중 인스턴스는 락 대신 조건부 UPDATE 로 다뤘습니다.** 잠글 대상이 메서드가 아니라 행이라는 걸 알아차린 게 전환점이었어요. 라이브러리도 표도 늘지 않았고, 인스턴스가 늘면 처리량도 같이 늘어납니다. 대가는 회수 장치가 필요해진 것이고, 10분 고아 회수를 같은 스케줄러에 붙였습니다.

**부하 제어는 때리는 속도와 물러나는 방식을 나눠 짰습니다.** 동시 2 와 큐 200 에 `DiscardPolicy` 를 걸어 상한을 잡고, 재시도는 Full Jitter 로 흩었어요. 버려도 되는 이유는 상태가 DB 에 있기 때문입니다.

남은 것도 적어 둡니다. 고아 임계값 10분은 "정상 반입이 10분 안에 끝난다"는 가정 위에 있고, 그 가정은 137MB 를 8초에 받은 한 번의 관측으로 세웠습니다. 500MB 짜리가 느린 회선으로 들어오면 반입 중인 행을 고아로 오인해 되돌릴 수 있어요. `UPLOADING` 에서 잡이 영원히 안 끝나는 경우를 감지하는 장치도 아직 없습니다. 217편 1회성 적재라 사람 눈이 있다고 보고 미뤘는데, 상시 운영으로 넘어가면 그때 다시 봐야 할 자리입니다.

이번에 가장 크게 바뀐 생각은 **"분산 환경이니까 분산 락"이 결론이 아니라 질문이었다**는 겁니다. 무엇을 잠그려는지 먼저 정하면 잠글 필요가 없는 경우도 있었어요. 상태 컬럼 하나가 이미 락이었으니까요.
