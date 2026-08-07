---
title: "어휘 검색과 벡터 검색을 RRF로 합쳤습니다 (하이브리드 메일 검색)"
description: "\"작년에 계약 얘기 나눴던 메일\"은 단어가 하나도 안 겹칩니다. 임베딩 검색을 붙이고, 스케일이 다른 두 점수를 순위만으로 합치는 RRF를 적용한 과정."
date: 2026-08-07
project: "메일상자"
tags: ["하이브리드 검색", "RRF", "pgvector", "임베딩", "PostgreSQL", "Spring AI"]
---

## [배경 - 단어가 안 겹치면 못 찾는다]

앞 글에서 PostgreSQL 전문 검색으로 메일 검색을 만들었습니다. 형태소 분석으로 조사·어미를 떼고, 트라이그램으로 부분 문자열까지 덮었어요.

그런데 이런 검색은 여전히 안 됩니다.

> "작년에 계약 관련해서 주고받은 메일"

정작 그 메일에는 "계약"이라는 단어가 없을 수 있어요. 본문은 "말씀하신 조건으로 진행하겠습니다. 서명본 첨부드립니다"라고 쓰여 있을지도 모릅니다. 사람은 이게 계약 얘기인 걸 알지만, 역색인은 모릅니다.

역색인은 **글자가 겹쳐야** 찾습니다. 단어가 다르면 의미가 같아도 못 찾아요. 정보검색에서는 이걸 **어휘 불일치(vocabulary mismatch)** 문제라고 부릅니다. 동의어, 완곡어법, 다른 표현 — 전부 여기 걸립니다.

동의어 사전을 만드는 방법도 있지만 끝이 없어요. 그래서 접근을 바꿨습니다. **글자가 아니라 의미를 색인하기로** 했어요.

## [문제 상황 분석 - 의미를 어떻게 색인하나]

### 임베딩은 텍스트를 좌표로 바꿉니다

임베딩 모델은 텍스트를 고정 길이 숫자 배열(벡터)로 바꿉니다. 예를 들어 1,536차원이면 숫자 1,536개짜리 배열이에요.

핵심은 이 좌표가 **의미에 따라 배치된다**는 점입니다. 비슷한 뜻의 문장은 가까운 좌표에, 무관한 문장은 먼 좌표에 놓입니다. "서명본 첨부드립니다"와 "계약서 보냅니다"는 글자가 하나도 안 겹치지만 벡터 공간에서는 가깝습니다.

그래서 검색이 이렇게 바뀝니다.

1. 검색어도 같은 모델로 벡터로 바꾼다
2. 저장된 메일 벡터들 중 **가장 가까운 것**을 찾는다

거리는 보통 코사인 유사도를 씁니다. 두 벡터가 이루는 각도를 보는 방식이라 문서 길이에 덜 휘둘려요.

### 정확히 다 비교할 수는 없습니다

메일 10만 통이면 벡터 10만 개와 일일이 거리를 재야 합니다. 차원이 1,536이면 곱셈만 1억 5천만 번이에요. 검색 한 번에 그건 불가능합니다.

그래서 **근사 최근접 이웃(ANN)** 을 씁니다. 정확한 1등을 보장하지 않는 대신 훨씬 빠르게 "거의 1등"을 찾는 방법이에요. PostgreSQL에서는 `pgvector` 확장이 이걸 제공합니다.

앞 글에서 베이스 이미지가 `pgvector`였던 이유가 이거예요.

```dockerfile
FROM pgvector/pgvector:0.8.2-pg18
```

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

검색 엔진을 따로 안 늘리겠다는 원칙이 여기서도 유지됐습니다. 역색인도 벡터도 같은 Postgres 안에 있어요.

### 그런데 벡터 검색만 쓰면 더 나빠집니다

벡터로 다 바꾸면 될 것 같지만, 벡터가 오히려 못하는 게 있습니다.

**정확한 문자열.** `invoice-2024-0417.pdf`를 찾을 때 벡터 검색은 "비슷한 느낌의 청구서 파일들"을 가져옵니다. 정작 원하는 그 파일이 아닐 수 있어요.

**고유명사와 숫자.** 사람 이름, 프로젝트 코드, 주문번호는 의미 공간에서 서로 구분이 잘 안 됩니다. 임베딩 모델이 학습한 적 없는 사내 용어면 더 그래요.

**정확도가 보장되지 않음.** ANN은 근사라 진짜 1등을 놓칠 수 있습니다.

정리하면 이렇습니다.

| | 어휘 검색 (FTS) | 벡터 검색 |
| --- | --- | --- |
| 강함 | 고유명사, 숫자, 파일명, 정확한 인용 | 동의어, 완곡어법, 개념 검색 |
| 약함 | 단어가 다르면 못 찾음 | 정확한 문자열, 희귀 고유명사 |
| 결과 | 있거나 없거나 (불리언 매칭) | 항상 topK개 나옴 (가까운 순) |
| 설명 | 왜 걸렸는지 명확 | 왜 걸렸는지 설명 어려움 |

**서로 반대로 강합니다.** 그래서 하나를 고르는 대신 둘 다 돌리고 결과를 합치기로 했어요. 이게 하이브리드 검색입니다.

## [문제 - 두 점수는 더할 수 없습니다]

둘 다 돌리는 건 쉽습니다. 어려운 건 합치는 거예요.

어휘 검색은 `ts_rank_cd` 점수를 줍니다. 0.0x대 값이고, 검색어 개수와 문서 길이에 따라 범위가 제멋대로예요. 벡터 검색은 코사인 유사도를 줍니다. 보통 0~1 사이인데 실제로는 0.7~0.9에 몰려 있습니다.

이 둘을 그냥 더하면 안 됩니다. **스케일이 다르고 분포도 다르니까요.**

정규화하는 방법이 있긴 합니다. 각 결과 집합에서 min-max로 0~1에 맞추는 방식이요. 그런데 이것도 문제가 있어요. 결과가 하나뿐이면 min과 max가 같아서 0으로 나누게 되고, **검색어마다 점수 분포가 달라져서** 같은 가중치가 매번 다른 의미를 갖습니다.

그래서 점수를 버리기로 했습니다. **순위만 쓰는** 방법이 있어요.

## [해결 방법 - RRF]

### 순위의 역수를 더합니다

RRF(Reciprocal Rank Fusion)는 각 결과 목록에서 **몇 등인지만** 보고 점수를 매깁니다.

```
score(문서) = Σ  weight / (k + rank)
              각 목록에 대해
```

1등이면 `1/(k+1)`, 2등이면 `1/(k+2)`… 이렇게 순위가 낮아질수록 기여가 줄어듭니다. 그리고 **여러 목록에서 동시에 나온 문서는 점수가 합산돼서** 위로 올라와요.

원 점수를 안 쓰니 스케일 문제가 사라집니다. 어휘 점수가 0.03이든 벡터 유사도가 0.87이든 상관없어요. 순위만 있으면 됩니다.

```java
private static final int RRF_K = 60;
private static final double VECTOR_RRF_WEIGHT = 0.6;
private static final double LEXICAL_RRF_WEIGHT = 0.4;

private void addRrfScores(
        Map<UUID, RankedMessage> scores,
        List<UUID> ids,
        HybridMailSearchMatchType matchType,
        double weight
) {
    if (ids == null || ids.isEmpty()) {
        return;
    }
    for (int index = 0; index < ids.size(); index++) {
        UUID id = ids.get(index);
        RankedMessage ranked = scores.computeIfAbsent(id, ignored -> new RankedMessage());
        ranked.addScore(weight / (RRF_K + index + 1));
        ranked.addMatchType(matchType);
    }
}
```

구현이 열 줄입니다. 정규화도 학습도 없어요.

### k는 무엇을 하는 값인가

`k = 60`은 RRF 원 논문에서 제시한 값이고 관례처럼 쓰입니다. 이 값이 하는 일은 **상위권의 점수 격차를 완만하게 만드는 것**이에요.

k가 없으면(k=0) 1등은 1.0, 2등은 0.5입니다. 1등이 2배나 강해요. 어느 한 목록의 1등이 무조건 최종 1등이 됩니다.

k=60이면 1등은 `1/61 ≈ 0.0164`, 2등은 `1/62 ≈ 0.0161`입니다. 차이가 2%도 안 돼요. 그래서 **한 목록에서 1등인 것보다, 두 목록 모두에서 상위권인 것이 더 강해집니다.** 이게 RRF의 핵심 동작이에요.

k를 키우면 순위 차이가 더 무의미해지고 "여러 목록에 등장했는가"가 지배적이 됩니다. 줄이면 각 목록의 1등이 강해지고요.

### 가중치로 어느 쪽을 믿을지 정합니다

벡터 0.6, 어휘 0.4로 뒀습니다. 벡터를 조금 더 믿는다는 뜻이에요.

메일 검색에서는 사용자가 정확한 단어를 기억하지 못하는 경우가 많다고 판단해서 이렇게 잡았습니다. 다만 **이 값은 측정으로 정한 게 아니라 가정입니다.** 뒤에 한계로 다시 적을게요.

<svg class="diagram" viewBox="0 0 720 296" role="img" aria-label="RRF 로 두 순위 목록을 합치는 과정">
  <defs>
    <marker id="ar-rrf" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">두 목록에 모두 있는 문서가 위로 올라온다</text>
  <text x="0" y="32" font-size="11.5" fill="var(--clay, #BF5F3B)" font-family="var(--font-mono)">score = Σ weight / (k + rank),   k = 60</text>

  <text x="0" y="58" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">벡터 검색 · w 0.6</text>
  <text x="240" y="58" font-size="11" font-weight="700" fill="var(--ink-2, #63605A)">어휘 검색 · w 0.4</text>
  <text x="480" y="58" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">RRF 융합 결과</text>

  <rect x="0" y="66" width="200" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="14" y="85" font-size="11" fill="var(--clay, #BF5F3B)">1위   메일 A</text>
  <rect x="0" y="100" width="200" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="119" font-size="11" fill="var(--ink-2, #63605A)">2위   메일 B</text>
  <rect x="0" y="134" width="200" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="14" y="153" font-size="11" fill="var(--clay, #BF5F3B)">3위   메일 C</text>
  <rect x="0" y="168" width="200" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="14" y="187" font-size="11" fill="var(--ink-2, #63605A)">4위   메일 D</text>

  <rect x="240" y="66" width="200" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="254" y="85" font-size="11" fill="var(--clay, #BF5F3B)">1위   메일 C</text>
  <rect x="240" y="100" width="200" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="254" y="119" font-size="11" fill="var(--clay, #BF5F3B)">2위   메일 A</text>
  <rect x="240" y="134" width="200" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="254" y="153" font-size="11" fill="var(--ink-2, #63605A)">3위   메일 E</text>

  <line x1="446" y1="130" x2="474" y2="130" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-rrf)"/>

  <rect x="480" y="66" width="240" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="494" y="85" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">메일 A</text>
  <text x="706" y="85" font-size="10.5" text-anchor="end" fill="var(--ink-3, #9A958B)" font-family="var(--font-mono)">.0098 + .0065 = .0163</text>
  <rect x="480" y="100" width="240" height="28" rx="5" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="494" y="119" font-size="11" font-weight="700" fill="var(--clay, #BF5F3B)">메일 C</text>
  <text x="706" y="119" font-size="10.5" text-anchor="end" fill="var(--ink-3, #9A958B)" font-family="var(--font-mono)">.0095 + .0066 = .0161</text>
  <rect x="480" y="134" width="240" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="494" y="153" font-size="11" fill="var(--ink-2, #63605A)">메일 B</text>
  <text x="706" y="153" font-size="10.5" text-anchor="end" fill="var(--ink-3, #9A958B)" font-family="var(--font-mono)">.0097</text>
  <rect x="480" y="168" width="240" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="494" y="187" font-size="11" fill="var(--ink-2, #63605A)">메일 D</text>
  <text x="706" y="187" font-size="10.5" text-anchor="end" fill="var(--ink-3, #9A958B)" font-family="var(--font-mono)">.0094</text>
  <rect x="480" y="202" width="240" height="28" rx="5" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="494" y="221" font-size="11" fill="var(--ink-2, #63605A)">메일 E</text>
  <text x="706" y="221" font-size="10.5" text-anchor="end" fill="var(--ink-3, #9A958B)" font-family="var(--font-mono)">.0063</text>

  <line x1="0" y1="250" x2="720" y2="250" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="0" y="268" font-size="11" fill="var(--ink-3, #9A958B)">벡터에서 2위였던 B 보다, 양쪽 상위권인 C 가 앞선다. k=60 이 상위권 격차를 눌러 준 결과다.</text>
  <text x="0" y="286" font-size="11" fill="var(--ink-3, #9A958B)">원 점수(ts_rank_cd, 코사인 유사도)는 쓰지 않는다. 스케일이 달라 더할 수 없기 때문이다.</text>
</svg>

### 후보를 넉넉히 뽑습니다

RRF는 두 목록을 겹쳐 보는 방식이라 **목록이 짧으면 겹칠 기회가 없습니다.** 20개를 보여줘야 하는데 각 목록에서 20개만 뽑으면, 어휘 21등이자 벡터 21등인 좋은 문서를 놓쳐요.

그래서 각 검색기에서 결과 개수보다 훨씬 많이 뽑습니다.

```java
private static final int CANDIDATE_MULTIPLIER = 5;
private static final int MIN_CANDIDATE_LIMIT = 40;

int resultLimit = Math.max(size, 1);
int candidateLimit = Math.max(MIN_CANDIDATE_LIMIT, resultLimit * CANDIDATE_MULTIPLIER);
```

20개를 보여주려면 각 목록에서 100개씩 뽑아 융합한 뒤 상위 20개를 냅니다. 검색 결과가 적을 때를 위해 최소 40개는 보장하고요.

### 한쪽이 죽어도 검색은 됩니다

벡터 검색은 외부 임베딩 API를 부릅니다. 느려질 수도, 실패할 수도 있어요. 그렇다고 검색 전체가 실패하면 안 됩니다.

```java
private List<UUID> findVectorMessageIds(...) {
    try {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(limit)
                .filterExpression(vectorFilter(userId, direction, mailAccountId))
                .build();
        return vectorStore.similaritySearch(request).stream()
                .map(this::messageId)
                .filter(id -> id != null)
                .distinct()
                .toList();
    } catch (RuntimeException exception) {
        log.warn("Hybrid mail vector search failed. userId={} direction={} mailAccountId={}",
                userId, direction, mailAccountId, exception);
        return List.of();
    }
}
```

실패하면 **빈 목록**을 반환합니다. 그러면 RRF는 어휘 결과만 가지고 융합해요. 결과 품질은 떨어지지만 검색은 됩니다. 어휘 쪽도 똑같이 감쌌어요.

한쪽이 0점이면 다른 쪽 순위가 그대로 최종 순위가 됩니다. RRF가 **부분 실패에 자연스럽게 강한** 구조인 셈이에요.

### 검색어를 OR로 느슨하게 묶습니다

하이브리드 경로의 어휘 쿼리는 앞 글의 `websearch_to_tsquery`와 다릅니다. 직접 만들어요.

```java
@Component
public class HybridSearchLexicalQueryBuilder {

    private static final int MAX_TERMS = 12;
    private static final Pattern TERM_PATTERN = Pattern.compile("[가-힣A-Za-z0-9]+");

    public String build(String query) {
        if (query == null || query.isBlank()) {
            return "";
        }
        Set<String> terms = new LinkedHashSet<>();
        Matcher matcher = TERM_PATTERN.matcher(query);
        while (matcher.find() && terms.size() < MAX_TERMS) {
            String term = matcher.group().toLowerCase();
            if (term.length() >= 2) {
                terms.add(term);
            }
        }
        return String.join(" | ", terms);
    }
}
```

`|`는 `tsquery`의 OR입니다. **모든 단어를 AND가 아니라 OR로 묶어요.**

일반 검색이었다면 AND가 맞습니다. "계약서 검토"는 둘 다 있는 문서를 원하니까요. 하이브리드에서는 반대예요. **후보를 넓게 뽑고 순위는 RRF에 맡기는 게** 목적입니다. AND로 좁히면 후보가 적어져서 융합할 재료가 없어져요.

재현율(recall)을 올리고 정밀도(precision)는 융합 단계에서 회복하는 전략입니다.

나머지 방어도 짚어둘게요. 정규식으로 한글·영숫자만 남겨 `tsquery` 문법 문자(`&`, `|`, `!`, `(`)가 섞이는 걸 막았고, 1글자는 버리고, `LinkedHashSet`으로 중복을 없애면서 입력 순서를 지키고, 최대 12개로 잘라 쿼리가 무한정 커지는 걸 막았습니다.

정렬은 SQL에서 합니다.

```sql
AND m.search_vector @@ to_tsquery('korean', :tsQuery)
ORDER BY
  ts_rank_cd(m.search_vector, to_tsquery('korean', :tsQuery)) DESC,
  m.sent_at DESC NULLS LAST,
  m.id DESC
LIMIT :limit
```

`ts_rank_cd`의 `cd`는 **cover density**입니다. 검색어들이 문서 안에서 얼마나 가까이 모여 있는지를 봐요. "계약"과 "검토"가 한 문장에 있는 문서가, 서로 멀리 떨어진 문서보다 높게 나옵니다. 여기서 나온 점수는 최종 랭킹에 쓰지 않고 **순서를 정하는 데만** 쓰여요. 그 순서가 RRF의 입력이 됩니다.

## [벡터 스토어의 필터를 믿지 않습니다]

이 부분이 개인적으로 제일 중요하다고 생각하는 설계입니다.

벡터 검색에도 필터를 겁니다. 내 메일만 나와야 하니까요.

```java
private Filter.Expression vectorFilter(UUID userId, Direction direction, UUID mailAccountId) {
    FilterExpressionBuilder builder = new FilterExpressionBuilder();
    if (mailAccountId == null && direction == null) {
        return builder.eq("UserId", userId.toString()).build();
    }
    ...
}
```

그런데 이 필터는 **벡터 스토어에 저장된 메타데이터**를 봅니다. 임베딩할 때 같이 넣어둔 값이에요. 이게 최신이라는 보장이 없습니다. 메일이 삭제됐거나, 계정 연결이 끊겼거나, 민감 라벨이 새로 붙었다면 벡터 쪽 메타데이터는 아직 옛날 상태일 수 있어요.

그래서 융합이 끝난 뒤 **DB에서 다시 조회하면서 권한을 재검증**합니다.

```java
List<UUID> rankedIds = ranked.keySet().stream().toList();
List<Message> messages = mailSearchRepositoryPort.findHybridMessagesByIds(
        userId, rankedIds, mailAccountId, direction, labelIds, read
);
```

그 조회 쿼리가 이렇습니다.

```sql
SELECT m FROM Message m
WHERE m.id IN :messageIds
  AND m.thread.mailAccount.user.id = :userId
  AND m.thread.mailAccount.active = true
  AND m.deletedAt IS NULL
  AND m.thread.deletedAt IS NULL
  AND m.thread.mailAccount.deletedAt IS NULL
  AND (:mailAccountId IS NULL OR m.thread.mailAccount.id = :mailAccountId)
  AND (:direction IS NULL OR m.direction = :direction)
  AND (:read IS NULL OR m.read = :read)
  AND NOT EXISTS (
      SELECT 1 FROM MessageLabel ml
      WHERE ml.message.id = m.id
        AND ml.deletedAt IS NULL
        AND ml.label.deletedAt IS NULL
        AND ml.label.isSensitive = true
  )
```

소유자, 계정 활성 여부, 삭제 여부, 민감 라벨을 **전부 다시 확인**합니다. 벡터 검색이 뭘 가져왔든 여기를 통과 못 하면 결과에서 빠져요.

그리고 순서는 융합 결과를 따릅니다.

```java
private List<HybridMailSearchItemResult> orderByRank(
        List<Message> messages, Map<UUID, RankedMessage> ranked, int limit) {
    Map<UUID, Message> messageById = new LinkedHashMap<>();
    for (Message message : messages) {
        messageById.put(message.getId(), message);
    }
    List<HybridMailSearchItemResult> results = new ArrayList<>();
    for (Map.Entry<UUID, RankedMessage> entry : ranked.entrySet()) {
        Message message = messageById.get(entry.getKey());
        if (message == null) {
            continue;   // 권한 재검증에서 탈락한 문서
        }
        ...
    }
}
```

`IN` 조회는 순서를 보장하지 않으니 맵으로 바꿔서 RRF 순서대로 다시 꺼냅니다. `message == null`이면 재검증에서 탈락한 거라 조용히 건너뛰어요.

정리하면 **"검색기는 후보만 제안하고, 권한은 DB가 최종 판정한다"** 입니다. 검색 인덱스와 벡터 스토어를 신뢰 경계 밖에 두는 거예요. 인덱스가 조금 낡아도 남의 메일이 새지 않습니다.

## [남은 문제]

**첫째, 가중치 0.6 / 0.4에 근거가 없습니다.** 이 글에서 제일 약한 부분이에요. "메일 검색은 의미 검색이 더 유용할 것 같다"는 가정으로 정했고, 검증하지 않았습니다. 제대로 하려면 평가셋(검색어와 정답 문서 쌍)을 만들고 nDCG 같은 지표로 재야 하는데, 그러려면 실사용 로그가 필요해요. 지금은 데이터가 없습니다.

**둘째, `k = 60`도 관례를 따랐을 뿐입니다.** 원 논문이 자기들 실험에서 잘 나온 값으로 제시한 건데, 저희 데이터에서 최적이라는 근거는 없어요. 첫 번째 문제와 같이 풀어야 합니다.

**셋째, 페이지네이션이 없습니다.** 하이브리드 검색은 `size`만 받고 첫 페이지만 돌려줘요. 앞 글의 일반 검색에는 마커 기반 커서 페이징이 있는데 여기는 없습니다. RRF 점수는 후보 집합 전체가 있어야 계산되니까, 두 번째 페이지를 내려면 후보를 더 뽑아 처음부터 다시 융합해야 해요. 깊은 페이지로 갈수록 비싸집니다. 지금은 "검색은 상위 몇 개만 보면 된다"고 가정하고 미뤘습니다.

**넷째, 임베딩 갱신 시점을 관리하지 않습니다.** 메일 본문이 수정되거나 라벨이 바뀌었을 때 벡터를 다시 만드는 흐름이 명확하지 않아요. 권한은 재검증으로 막았지만 **검색 품질**은 낡은 벡터의 영향을 그대로 받습니다.

**다섯째, 매 검색마다 임베딩 API를 부릅니다.** 검색어를 벡터로 바꿔야 하니 외부 호출이 한 번 들어가요. 지연도 비용도 여기서 발생합니다. 같은 검색어를 캐싱하면 꽤 줄어들 텐데 아직 안 넣었습니다.

**여섯째, 두 검색을 순차로 실행합니다.** 벡터 검색과 어휘 검색이 서로 독립인데 순서대로 기다려요. 병렬로 돌리면 응답 시간이 둘 중 느린 쪽으로 줄어듭니다. 이건 명백한 개선점인데 아직 안 했습니다.

## [결론]

하이브리드 검색을 만들면서 가장 크게 배운 건 **"합치는 방법"이 별도의 문제**라는 점이었습니다.

두 검색기를 붙이는 건 어렵지 않았어요. 어려운 건 서로 다른 척도의 결과를 어떻게 하나의 순서로 만드느냐였고, 여기서 자연스럽게 정규화를 떠올렸다가 막혔습니다. 점수 분포가 쿼리마다 달라져서 안정적으로 섞이지 않았어요.

RRF의 발상이 좋았던 건 **점수를 버린 것**입니다. 순위만 남기면 척도 문제가 통째로 사라져요. 정보를 버려서 문제를 없앤 셈인데, 실제로 잘 동작하고 구현도 열 줄입니다.

정리하면 세 가지입니다.

1. **어휘와 벡터는 강점이 반대**입니다. 하나를 고르는 문제가 아니라 둘 다 쓰고 합치는 문제였어요.
2. **합칠 때는 점수보다 순위가 안정적**입니다. 스케일 정규화를 시도하다 막혔고, RRF가 그 문제를 우회했습니다.
3. **검색 인덱스는 권한의 정본이 아닙니다.** 벡터 스토어 메타데이터는 낡을 수 있으니 최종 조회에서 DB가 다시 판정하게 했어요. 성능을 조금 내주고 안전을 샀습니다.

남은 숙제는 결국 하나로 모입니다. **측정을 안 했다**는 거예요. 가중치도 k도 후보 배수도 전부 가정 위에 서 있습니다. 검색 품질은 "그럴듯하다"로는 알 수 없고 평가셋과 지표가 있어야 하는데, 그건 사용자가 실제로 검색을 하기 시작해야 만들 수 있습니다. 그때 다시 쓰겠습니다.
