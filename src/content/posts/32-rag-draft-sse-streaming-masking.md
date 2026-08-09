---
title: "스트리밍 중간에 [PHO 까지만 온 토큰을 복원할 수는 없습니다 (SSE, 마스킹 복원, 스트림 취소)"
description: "AI 답장 초안을 스트리밍으로 내보내면서 마스킹 토큰을 되돌려야 했습니다. 토큰이 delta 경계에서 쪼개지는 문제와, 사용자가 창을 닫아도 LLM이 계속 도는 문제."
date: 2026-08-09
project: "메일상자"
tags: ["SSE", "스트리밍", "LLM", "RAG", "Reactor", "마스킹"]
---

## [배경 - 초안이 다 나올 때까지 기다리게 할 수 없다]

메일상자에는 답장 초안을 AI가 써주는 기능이 있습니다. "이 메일에 정중하게 거절하는 답장" 같은 요청을 받으면 제목과 본문을 만들어줘요.

LLM이 긴 답장을 쓰는 데는 시간이 걸립니다. 다 나올 때까지 로딩만 보여주면 사용자는 멈춘 걸로 느껴요. 그래서 SSE로 토큰이 나오는 대로 흘려보내기로 했습니다.

여기까지는 평범한 스트리밍입니다. 문제는 이 파이프라인에 [마스킹](/posts/31-pii-masking-embedding-pipeline/)이 끼어 있다는 점이었어요.

## [문제 상황 분석 - 마스킹과 스트리밍이 서로 부딪힌다]

### 보낼 때 가리면 받을 때 되돌려야 합니다

초안을 만들려면 참고 자료가 필요합니다. 과거에 이 사람과 주고받은 메일, 최근 메일, 스레드 문맥 같은 것들이에요. 이걸 프롬프트에 넣어서 LLM에 보냅니다.

그러면 그 메일들의 PII가 LLM으로 나가요. 그래서 마스킹을 거칩니다.

문제는 **LLM이 마스킹된 텍스트를 보고 답을 쓴다**는 거예요. 응답에 `[PHONE_1]` 같은 토큰이 그대로 섞여 나옵니다. "연락처는 [PHONE_1] 입니다" 처럼요.

사용자에게 이걸 그대로 보여줄 수는 없습니다. 되돌려야 해요.

임베딩 때와 정반대입니다. 임베딩은 **되돌리면 안 되는** 경로였는데, 초안은 **반드시 되돌려야 하는** 경로예요. 그래서 마스킹 서비스에 스코프가 두 개 있습니다.

| Scope | 맵 | 쓰는 곳 |
| --- | --- | --- |
| `PAST_CONTEXT` | `redactedTokenMap` | 임베딩. 복원 불가 |
| `CURRENT_CONTEXT` | `restoreTokenMap` | 초안. 복원 가능 |

### 스트리밍은 텍스트를 조각내서 줍니다

여기서 진짜 문제가 나옵니다.

복원은 문자열 치환이에요. `[PHONE_1]` 을 찾아서 원래 번호로 바꿉니다. 완성된 텍스트라면 간단해요.

그런데 스트리밍은 텍스트를 조각으로 줍니다. LLM이 토큰 단위로 뱉으니 이렇게 도착할 수 있어요.

```
delta 1: "연락처는 [PHO"
delta 2: "NE_1] 입니다"
```

각 delta에 치환을 걸면 **아무것도 안 걸립니다.** `[PHO` 는 토큰이 아니고 `NE_1]` 도 토큰이 아니에요. 그대로 사용자 화면에 나갑니다.

조각을 다 모아서 마지막에 치환하면 되지만, 그러면 스트리밍을 하는 의미가 없어집니다.

### 창을 닫아도 LLM은 계속 돕니다

세 번째 문제는 비용이에요.

사용자가 초안 생성 중에 화면을 벗어나거나 브라우저를 닫으면 SSE 연결이 끊깁니다. 그런데 **LLM 스트림은 서버 안에서 계속 돌아요.** 아무도 안 볼 텍스트를 끝까지 생성하고, 그만큼 토큰 비용이 나갑니다.

한 번은 작지만 반복되면 쌓입니다. 그리고 사용자가 결과가 마음에 안 들어 다시 시도하는 경우가 흔해요.

## [해결 방법 - 경계 버퍼와 취소 신호]

### 토큰이 될 수 있는 꼬리는 붙잡아 둡니다

첫 번째 문제는 버퍼로 풉니다. 아이디어는 단순해요. **지금까지 모은 문자열의 뒤쪽이 토큰의 앞부분일 수 있으면, 그만큼은 아직 내보내지 않습니다.**

```java
private static final class MailDraftTokenBoundaryBuffer {

    private final Set<String> tokens;
    private final StringBuilder pending = new StringBuilder();

    private String append(String delta) {
        pending.append(delta);
        return flushSafeText();
    }

    private String flushSafeText() {
        int keepLength = Math.max(partialTokenLength(), partialBracketLength());
        return flush(pending.length() - keepLength);
    }

    private int partialTokenLength() {
        int length = Math.min(maxTokenLength() - 1, pending.length());
        while (length > 0) {
            if (isPartialToken(pending.substring(pending.length() - length))) {
                return length;
            }
            length--;
        }
        return 0;
    }
    // ...
}
```

앞의 예시가 이렇게 처리됩니다.

```
delta 1 도착: pending = "연락처는 [PHO"
              뒤 4글자 "[PHO" 가 [PHONE_1] 의 앞부분이다
              → "연락처는 " 만 내보내고 "[PHO" 는 붙잡는다

delta 2 도착: pending = "[PHONE_1] 입니다"
              [PHONE_1] 완성 → 치환 → "010-1234-5678 입니다" 내보냄
```

붙잡는 길이는 **가장 긴 토큰 길이 - 1** 이 상한입니다. 그보다 길게 잡을 이유가 없어요. 어떤 토큰도 그보다 길게 걸쳐 있을 수 없으니까요.

`partialBracketLength` 가 따로 있는 것도 이유가 있습니다. `[` 로 시작하는 문자열은 아직 어떤 토큰이 될지 몰라도 일단 붙잡아야 해요. LLM이 존재하지 않는 토큰을 만들어낼 수도 있어서, 대괄호가 열린 상태는 보수적으로 다룹니다.

스트림이 끝나면 남은 걸 전부 내보냅니다.

```java
private String finish() {
    String text = pending.toString();
    pending.setLength(0);
    return text;
}
```

이게 없으면 마지막 조각이 영원히 버퍼에 남아요.

### 복원은 긴 토큰부터 합니다

버퍼가 조각을 모아주면 그다음은 치환인데, 여기에도 순서가 있습니다.

```java
private List<String> orderedRestoreTokens(MailDraftRestoreContextResult restoreContext) {
    return restoreContext.tokens().keySet().stream()
            .sorted(java.util.Comparator.comparingInt(String::length).reversed())
            .toList();
}
```

**길이 내림차순으로 정렬해서 치환합니다.** 이게 없으면 `[PHONE_1]` 이 `[PHONE_10]` 의 앞부분과 먼저 매칭돼요. 그러면 `[PHONE_10]` 이 `010-1234-5678` + `0]` 같은 쓰레기가 됩니다.

토큰이 열 개를 넘는 순간부터 생기는 문제라 적은 데이터로 테스트하면 안 드러나요.

### 복원 못 한 토큰은 그냥 흘려보내지 않습니다

치환이 끝난 뒤 남아 있는 대괄호를 한 번 더 검사합니다.

```java
String content = restoredDelta.substring(startIndex + 1, endIndex).strip();
if (isMaskingToken(content)) {
    logUnresolvedMaskingToken(rawDelta, restoredDelta, startIndex, endIndex);
    throw new MailDraftException(MailDraftErrorCode.UNRESOLVED_PLACEHOLDER);
}
if (isGeneratedPlaceholder(content)) {
    logSanitizedGeneratedPlaceholder(rawDelta, restoredDelta, startIndex, endIndex);
    builder.append(generatedPlaceholderReplacement(content));
    return endIndex + 1;
}
```

두 경우를 다르게 다뤄요.

**마스킹 토큰 모양인데 복원이 안 됐으면 예외를 던집니다.** `[PHONE_1]` 이 화면에 그대로 나가는 건 버그이자 정보 노출이니, 조용히 넘기지 않고 스트림을 실패시킵니다.

**LLM이 지어낸 자리표시자는 지웁니다.** 모델이 값을 모를 때 `[이름]`, `[담당자]`, `[회사명]` 같은 걸 써넣는 습관이 있어요. 서명 줄은 아예 정규식으로 잡습니다.

```java
private static final Pattern GENERATED_PLACEHOLDER_SIGNATURE_PATTERN = Pattern.compile(
        "(?m)^\\s*\\[[^\\]\\n]*(?:사용자|이름|담당자|회사|소속|직함|전화|연락처|이메일)[^\\]\\n]*]\\s*(?:드림|올림|배상)?\\s*$\\R?"
);
```

프롬프트로도 같이 막습니다. 결합 생성 프롬프트 끝에 이 문장이 붙어 있어요.

> Do not include any new placeholder, template variable, fill-in blank, or signature name if unknown.

**프롬프트로 부탁하고 코드로 다시 거르는** 이중 구조입니다. LLM 출력은 프롬프트만으로 보장되지 않으니까요.

### 지연이 생기지만 감당할 만합니다

이 방식의 대가는 지연입니다. 최대 (가장 긴 토큰 길이 - 1) 글자만큼 늦게 나가요.

토큰이 `[PHONE_1]` 같은 형태라 10글자 안팎이고, 사람이 읽는 속도에 비하면 무시할 수준입니다. **정확성을 위해 지연을 조금 받는 거래**인데, 여기서는 명확하게 정확성이 이겼어요. 전화번호가 `[PHO` 로 화면에 나가는 건 버그로 보이니까요.

### 취소 신호를 세 군데에 겁니다

두 번째 문제는 취소로 풉니다.

`SseEmitter` 는 연결이 끝날 때 콜백을 부릅니다. 그런데 끝나는 방식이 하나가 아니에요.

```java
private void registerCancel(SseEmitter emitter, MailDraftCommandService.StreamCancellation cancellation) {
    registerCompletionCancel(emitter, cancellation);
    registerTimeoutCancel(emitter, cancellation);
    registerErrorCancel(emitter, cancellation);
}
```

세 가지를 다 걸었습니다.

| 콜백 | 언제 |
| --- | --- |
| `onCompletion` | 정상 종료, 또는 클라이언트가 연결을 닫음 |
| `onTimeout` | 설정된 시간을 넘김 |
| `onError` | 전송 중 오류 |

**하나만 걸면 나머지 경로에서 LLM이 계속 돕니다.** 브라우저 탭을 닫는 것과 네트워크가 끊기는 것은 다른 콜백으로 들어와요.

취소 자체는 이렇게 생겼습니다.

```java
public static final class StreamCancellation {

    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final Sinks.Empty<Void> cancelSink = Sinks.empty();

    private void cancel() {
        if (cancelled.compareAndSet(false, true)) {
            cancelSink.tryEmitEmpty();
        }
    }

    private Mono<Void> cancelSignal() {
        return cancelSink.asMono();
    }

    public boolean isCancelled() {
        return cancelled.get();
    }
}
```

플래그와 신호를 둘 다 가집니다. 쓰임이 달라요.

**신호는 LLM 스트림을 실제로 끊는 데 씁니다.**

```java
private Flux<ChatResponse> cancellableStream(Prompt prompt, StreamCancellation cancellation) {
    return chatModel().stream(prompt).takeUntilOther(cancellation.cancelSignal());
}
```

`takeUntilOther` 는 다른 발행자가 신호를 내면 구독을 끊습니다. 구독이 끊기면 HTTP 연결도 닫히고, **그 시점부터 토큰이 안 나옵니다.**

**플래그는 이후 단계를 건너뛰는 데 씁니다.**

```java
MailDraftUsageResult subjectUsage = mailDraftCommandService.streamSubject(...);
if (cancellation.isCancelled()) {
    return;
}
MailDraftUsageResult bodyUsage = mailDraftCommandService.streamBody(...);
if (cancellation.isCancelled()) {
    return;
}
```

제목과 본문을 따로 만드는 경로가 있어서, 제목 생성 중에 취소됐으면 본문은 아예 시작하지 않아요.

`compareAndSet` 으로 중복 취소를 막은 것도 짚고 갈 부분입니다. 세 콜백이 동시에 불릴 수 있는데, 신호를 여러 번 보내면 안 되니까요.

### 한 번에 만들고, 안 되면 나눕니다

초안은 제목과 본문이 다 필요합니다. 두 가지 방법이 있어요.

```java
try {
    MailDraftUsageResult usage = mailDraftCommandService.streamCombined(emitter, prompt, restoreContext, cancellation, model);
    if (cancellation.isCancelled()) {
        return;
    }
    completeSuccess(emitter, usage);
    return;
} catch (MailDraftCommandService.MailDraftCombinedFormatException exception) {
    log.warn("Mail draft combined stream format invalid. fallback=separate ...");
    if (cancellation.isCancelled()) {
        return;
    }
}
MailDraftUsageResult subjectUsage = mailDraftCommandService.streamSubject(...);
MailDraftUsageResult bodyUsage = mailDraftCommandService.streamBody(...);
```

기본은 한 번의 호출로 둘 다 만듭니다. 프롬프트를 두 번 보내지 않으니 토큰이 절약돼요.

다만 하나의 응답에서 제목과 본문을 갈라내려면 형식 약속이 필요합니다. LLM이 그 형식을 안 지키면 파싱이 깨져요. 그때는 **나눠서 두 번 부르는 쪽으로 물러섭니다.**

싼 방법을 먼저 시도하고 안 되면 확실한 방법으로 가는 구조예요. 실패했을 때 사용자가 에러를 보는 게 아니라 조금 더 비싼 경로로 완성되는 게 낫다고 봤습니다.

### RAG는 네 종류를 섞습니다

프롬프트에 넣는 참고 자료는 종류를 나눠 넣어요.

```java
public MailDraftRagContextResult replyRagContext(MailDraftCommand command) {
    // recent, thread, recipientHistory 를 각각 조회
    logRagContext("reply", command, recent, List.of(), thread, recipientHistory);
    return MailDraftRagContextResult.of(recent, List.of(), thread, recipientHistory);
}
```

- `recent` 최근 메일
- `relevant` 질의와 의미가 가까운 메일 (일반 초안용)
- `thread` 답장 대상 스레드의 이전 대화 (답장용)
- `recipientHistory` 그 수신자와 주고받은 이력

각 참고 메일에는 출처가 붙습니다.

```java
builder.append("<reference_email source=\"").append(message.source()).append("\">\n");
```

프롬프트에 이런 지시가 같이 들어가요.

> Use recipient_history emails as the primary source for recipient-specific relationship, salutation, tone, and previous context with the target recipient.

**출처마다 쓰임을 다르게 지정합니다.** 호칭과 말투는 그 사람과의 이력에서 가져오고, 내용은 스레드에서 가져오는 식이에요. 전부 뭉뚱그려 넣는 것보다 이쪽이 결과가 안정적이었습니다.

## [성과 - 개선 전후 비교]

| 항목 | 단순 스트리밍 | 현재 구조 |
| --- | --- | --- |
| LLM에 나가는 참고 메일 | 원문 | 마스킹된 텍스트 |
| 응답의 마스킹 토큰 | 화면에 그대로 노출 | 원래 값으로 복원 |
| delta 경계에 걸친 토큰 | 복원 실패 | 경계 버퍼로 대기 후 복원 |
| 연결 종료 시 LLM | 끝까지 생성 (비용 발생) | `takeUntilOther` 로 구독 해제 |
| 형식 파싱 실패 | 에러 | 분리 호출로 폴백 |

정직하게 적으면 **수치가 없습니다.** 취소가 실제로 토큰을 얼마나 아끼는지, 경계 버퍼가 지연을 얼마나 만드는지 재지 않았어요.

<!-- 측정 필요:
     1) 스트리밍 도중 연결을 끊었을 때 usage 토큰 수 (취소 유무 비교)
     2) 경계 버퍼로 인한 첫 글자 출력 지연 (TTFB 대비)
     3) streamCombined 형식 실패율 (로그의 "combined stream format invalid" 비율)
     4) 토큰이 delta 경계에 걸치는 실제 빈도 -->

## [결론]

정리하면 이렇습니다.

- 마스킹은 되돌릴 경로와 되돌리지 않을 경로를 스코프로 나눠야 한다
- 스트리밍에서 문자열 치환을 하려면 경계에 걸친 조각을 붙잡아야 한다
- SSE 종료 경로는 하나가 아니다. 세 콜백 모두에 취소를 걸어야 한다
- 취소 플래그와 취소 신호는 역할이 다르다. 하나는 건너뛰기용, 하나는 구독 해제용

한계를 적어둘게요.

첫째, **`SseEmitter` 를 기본 생성자로 만듭니다.**

```java
SseEmitter emitter = new SseEmitter();
```

타임아웃을 명시하지 않았어요. Spring MVC 기본값을 따르는데, 이 값은 설정에 따라 달라집니다. LLM 응답이 오래 걸리는 경우 예상 못 한 시점에 `onTimeout` 이 불릴 수 있고, 반대로 무한이면 죽은 연결이 스레드를 물고 있을 수 있습니다. 초안 생성에 걸리는 최대 시간을 재서 명시해야 합니다.

둘째, **취소가 클라이언트 신호에 의존합니다.** 브라우저를 닫으면 TCP가 끊기고 다음 전송 시도에서 오류가 나면서 `onError` 가 불려요. 즉 **다음 delta를 보내려고 시도해야 감지됩니다.** LLM이 오래 침묵하는 구간에서 연결이 끊기면 그동안은 모릅니다.

셋째, **PRO 플랜에는 사실상 한도가 없습니다.**

```java
public void validateWeeklyRateLimit(UUID userId, Plan plan) {
    boolean allowed = rateLimitCachePort.tryConsumeWeeklyLimit(userId);
    if (plan != Plan.PRO && !allowed) {
        throw new MailDraftException(MailDraftErrorCode.RATE_LIMIT_EXCEEDED);
    }
}
```

카운터는 증가시키지만 **PRO면 초과해도 통과합니다.** "플랜별 주간 한도로 비용 초과를 막는다" 고 말하기 어려운 구조예요. 정확히는 무료 플랜에만 한도가 있고, 유료 플랜은 사용량을 기록만 합니다. 비용 상한이 필요하면 PRO에도 별도 한도를 둬야 해요.

넷째, **프롬프트 인젝션 방어가 얕습니다.** `validatePromptInjection(request.query())` 로 사용자 질의는 검사하는데, **참고 메일 본문은 검사하지 않습니다.** 메일은 남이 보낸 내용이라 지시문이 들어 있을 수 있어요. RAG로 끌어온 메일 안에 "이전 지시를 무시하고" 같은 문장이 있으면 그대로 프롬프트에 들어갑니다. 이게 이 구조에서 제일 큰 구멍이라고 생각해요.

다섯째, **스트림을 블로킹으로 소비합니다.**

```java
for (ChatResponse response : cancellableStream(phasePrompt, cancellation).toIterable()) {
```

Reactor `Flux` 를 `toIterable()` 로 돌려서 `for` 문으로 받아요. 즉 **LLM이 응답하는 내내 `@Async` 스레드 하나가 붙잡혀 있습니다.**

그리고 `CoreApplication` 에 `@EnableAsync` 만 있고 커스텀 Executor 설정이 없어요. 기본 Executor를 쓰니 **동시 초안 생성 수가 그 기본값에 묶입니다.** 초안 하나가 수십 초 걸리는 작업이라 이 값이 곧 동시 사용자 수 상한이에요. 논블로킹으로 받거나, 최소한 전용 풀을 만들고 크기를 정해야 합니다.

토큰이 조각나는 문제는 만들기 전에는 상상도 못 했습니다. 스트리밍과 문자열 치환을 같이 쓰면 반드시 생기는 문제인데, 두 기능을 따로 볼 때는 안 보였어요.
