---
title: "메일 검색을 Elasticsearch 없이 PostgreSQL로 만들었습니다 (한국어 FTS와 역색인)"
description: "LIKE '%검색어%' 는 왜 느린가, 한국어는 왜 형태소 분석이 필요한가, GIN 역색인은 무엇을 저장하는가. mecab-ko 를 Postgres 에 심어 검색을 만든 과정."
date: 2026-08-07
project: "메일상자"
tags: ["PostgreSQL", "전문검색", "역색인", "형태소분석", "pg_trgm", "Elasticsearch"]
---

## [배경 - 메일 본문을 검색해야 한다]

메일상자는 Gmail·네이버메일 계정을 한곳에 모아 보는 서비스입니다. 계정 서너 개를 연결하면 메일이 금방 수만 통이 되고, 그러면 검색이 필수 기능이 돼요.

요구는 단순했습니다. 제목, 보낸 사람, 본문, 받는 사람, 첨부파일 이름에서 찾을 수 있으면 됩니다.

처음 짠 쿼리는 이랬어요.

```sql
SELECT * FROM messages
WHERE subject ILIKE '%계약서%' OR body_text ILIKE '%계약서%';
```

동작은 합니다. 그리고 데이터가 조금만 쌓여도 느려집니다. 왜 느린지 이해하는 게 이 글의 출발점이었어요.

## [문제 상황 분석]

### `LIKE '%x%'` 는 인덱스를 못 씁니다

B-tree 인덱스는 **정렬된 자료구조**입니다. 사전과 같아요. "ㄱ으로 시작하는 단어"는 사전에서 금방 찾지만, "중간에 '약'이 들어간 단어"는 사전을 처음부터 끝까지 넘겨야 합니다.

`LIKE '계약%'`는 앞이 고정이라 B-tree를 탈 수 있습니다. 하지만 `LIKE '%계약%'`는 시작점을 모르니 인덱스가 쓸모없어져요. 결국 **모든 행의 본문을 처음부터 끝까지 읽습니다.** 메일 10만 통이면 10만 개의 본문 텍스트를 다 훑는 거예요.

이건 인덱스를 안 걸어서가 아니라 **자료구조가 이 질문에 답할 수 없어서**입니다. 질문에 맞는 자료구조가 따로 있어요. 역색인입니다.

### 역색인은 방향을 뒤집습니다

일반 인덱스는 "문서 → 그 문서의 내용"입니다. 역색인(inverted index)은 반대예요. **"단어 → 그 단어가 등장한 문서 목록"** 을 저장합니다.

```
계약서 → { 12, 87, 203 }
검토   → { 12, 45 }
부탁   → { 12, 45, 99 }
```

"계약서"를 검색하면 목록 하나만 꺼내면 끝입니다. 문서 수가 10만이든 100만이든 그 단어의 목록 길이에만 비례해요. 이게 검색 엔진이 빠른 이유이고, Lucene도 Elasticsearch도 근본은 이 자료구조입니다.

문제는 **역색인을 만들려면 문장을 단어로 쪼개야** 한다는 겁니다. 그리고 한국어에서 이게 어렵습니다.

### 한국어는 공백으로 쪼갤 수 없습니다

영어는 공백 분리가 꽤 잘 통합니다. "contract review please" → `contract`, `review`, `please`. 어형 변화도 규칙적이라 `reviews`, `reviewed`를 `review`로 되돌리는 스테밍이 비교적 단순해요.

한국어는 **교착어**입니다. 어근에 조사와 어미가 계속 붙어요.

| 원문 | 공백으로 쪼개면 | 실제로 찾고 싶은 것 |
| --- | --- | --- |
| 계약서를 | `계약서를` | `계약서` |
| 계약서가 | `계약서가` | `계약서` |
| 계약서입니다 | `계약서입니다` | `계약서` |

공백 기준으로 색인하면 "계약서"로 검색했을 때 **하나도 안 걸립니다.** 색인에는 `계약서를`, `계약서가`, `계약서입니다`가 서로 다른 단어로 들어가 있으니까요.

그래서 조사와 어미를 떼어내고 어근을 뽑아야 합니다. 이걸 하는 게 **형태소 분석기**예요. 한국어 검색에서 형태소 분석기는 선택이 아니라 전제 조건입니다.

<svg class="diagram" viewBox="0 0 720 336" role="img" aria-label="원문에서 역색인까지의 처리 단계">
  <defs>
    <marker id="ar-fts" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">메일 한 통이 검색 가능해지기까지</text>

  <rect x="0" y="26" width="720" height="46" rx="7" fill="var(--sunk, #F1EDE3)" stroke="var(--rule-soft, rgba(34,31,27,.07))" stroke-width="0.5"/>
  <text x="16" y="45" font-size="10.5" font-weight="700" fill="var(--ink-3, #9A958B)">1 · 원문</text>
  <text x="16" y="63" font-size="12" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">"계약서를 검토 부탁드립니다"</text>

  <line x1="360" y1="72" x2="360" y2="88" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-fts)"/>

  <rect x="0" y="90" width="720" height="60" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="16" y="109" font-size="10.5" font-weight="700" fill="var(--clay, #BF5F3B)">2 · 형태소 분석 (mecab-ko + mecab-ko-dic)</text>
  <text x="16" y="127" font-size="12" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">계약서 / 를 / 검토 / 부탁 / 드리 / ㅂ니다</text>
  <text x="16" y="143" font-size="10.5" fill="var(--ink-3, #9A958B)">조사·어미를 떼어내고 어근만 남긴다. 사전 기반이라 신조어는 못 쪼갠다.</text>

  <line x1="360" y1="150" x2="360" y2="166" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-fts)"/>

  <rect x="0" y="168" width="720" height="60" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="16" y="187" font-size="10.5" font-weight="700" fill="var(--ink-2, #63605A)">3 · tsvector — 어휘소와 위치</text>
  <text x="16" y="205" font-size="12" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">'계약서':1 '검토':3 '부탁':4</text>
  <text x="16" y="221" font-size="10.5" fill="var(--ink-3, #9A958B)">중복은 합치고 위치를 함께 담는다. 위치가 있어야 구문 검색과 근접도 랭킹이 된다.</text>

  <line x1="360" y1="228" x2="360" y2="244" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-fts)"/>

  <rect x="0" y="246" width="720" height="66" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="16" y="265" font-size="10.5" font-weight="700" fill="var(--clay, #BF5F3B)">4 · GIN 역색인 — 단어에서 문서로</text>
  <text x="16" y="284" font-size="12" fill="var(--ink-2, #63605A)" font-family="var(--font-mono)">계약서 → {12, 87, 203}    검토 → {12, 45}</text>
  <text x="16" y="303" font-size="10.5" fill="var(--ink-3, #9A958B)">검색은 목록 하나를 꺼내는 일이 된다. 전체 문서 수와 무관해진다.</text>

  <text x="0" y="332" font-size="11" fill="var(--ink-3, #9A958B)">2~4 단계는 INSERT/UPDATE 트리거가 자동으로 수행한다. 애플리케이션은 원문만 저장한다.</text>
</svg>

## [해결 방법 - Postgres 안에 형태소 분석기를 심었습니다]

### mecab-ko를 이미지에 빌드해 넣었습니다

PostgreSQL의 전문 검색은 **텍스트 검색 설정(text search configuration)** 이라는 걸 씁니다. `english`, `simple` 같은 게 기본 제공되는데 한국어는 없어요.

한국어를 붙이려면 형태소 분석기를 Postgres 확장으로 감싸야 합니다. `textsearch_ko`가 그 역할을 하고, 실제 분석은 `mecab-ko`가 합니다. 셋 다 오픈소스예요.

- **mecab** — 일본에서 만든 형태소 분석 엔진
- **mecab-ko / mecab-ko-dic** — 은전한닢 프로젝트가 한국어에 맞게 고친 엔진과 사전
- **textsearch_ko** — mecab-ko를 PostgreSQL 확장으로 감싼 것

패키지로 설치되는 게 없어서 이미지를 직접 빌드했습니다.

```dockerfile
FROM pgvector/pgvector:0.8.2-pg18

# ── mecab-ko (Korean morphological analyzer) ──────────────────────────────────
RUN curl -fsSL "https://bitbucket.org/eunjeon/mecab-ko/downloads/mecab-0.996-ko-0.9.2.tar.gz" \
    -o mecab-ko.tar.gz \
    && tar xf mecab-ko.tar.gz \
    && cd mecab-0.996-ko-0.9.2 \
    && ./configure && make -j"$(nproc)" && make install && ldconfig

# ── mecab-ko-dic (Korean dictionary) ──────────────────────────────────────────
RUN curl -fsSL "https://bitbucket.org/eunjeon/mecab-ko-dic/downloads/mecab-ko-dic-2.1.1-20180720.tar.gz" \
    -o mecab-ko-dic.tar.gz \
    && tar xf mecab-ko-dic.tar.gz \
    && cd mecab-ko-dic-2.1.1-20180720 \
    && autoreconf && ./configure && make -j"$(nproc)" && make install && ldconfig

# ── textsearch_ko (PostgreSQL FTS extension for Korean) ───────────────────────
RUN git clone --depth 1 https://github.com/i0seph/textsearch_ko.git /tmp/textsearch_ko \
    && cd /tmp/textsearch_ko \
    && PATH="/usr/lib/postgresql/18/bin:$PATH" make USE_PGXS=1 install
```

베이스 이미지가 `pgvector`인 것도 이유가 있는데, 그건 다음 글에서 다룰게요.

확장은 컨테이너 초기화 때 설치됩니다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS hstore;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS textsearch_ko;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 색인 컬럼을 트리거로 채웁니다

`tsvector`는 분석 결과를 담는 전용 타입입니다. 검색할 때마다 본문을 분석하면 의미가 없으니, 저장 시점에 미리 만들어 컬럼에 넣어둡니다.

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION messages_search_vector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.search_vector = to_tsvector('korean',
        coalesce(NEW.subject, '')    || ' ' ||
        coalesce(NEW.from_name, '')  || ' ' ||
        coalesce(NEW.body_text, '')  || ' ' ||
        coalesce(array_to_string(
            ARRAY(SELECT jsonb_array_elements_text(coalesce(NEW.to_names, '[]'::jsonb))), ' '
        ), '') || ' ' ||
        coalesce(array_to_string(
            ARRAY(SELECT jsonb_array_elements_text(coalesce(NEW.cc_names, '[]'::jsonb))), ' '
        ), '')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_search_vector
    BEFORE INSERT OR UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_search_vector_update();

CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN(search_vector);
```

제목·보낸사람·본문·수신자 이름을 한 덩어리로 합쳐 하나의 `tsvector`에 넣었습니다. 필드별로 나누면 필드 가중치를 줄 수 있는데(`setweight`), 지금은 "어디에 있든 찾히기만 하면 된다"가 요구라 합쳤어요.

**트리거로 채우는 게 핵심입니다.** 애플리케이션 코드는 색인의 존재를 몰라요. 어떤 경로로 메일이 들어오든(API, 워커의 Gmail 동기화, 수동 백필) 색인이 자동으로 따라옵니다. 색인 갱신을 깜빡할 방법이 없어요.

이건 별도 검색 엔진을 쓸 때와 가장 크게 갈리는 지점이기도 합니다. Elasticsearch를 쓰면 DB에 쓰고 ES에도 쓰는 **이중 쓰기**가 생기고, 둘이 어긋날 수 있어요.

### GIN을 고른 이유

Postgres에서 `tsvector`에 쓸 수 있는 인덱스는 GIN과 GiST 두 가지입니다.

| | GIN | GiST |
| --- | --- | --- |
| 구조 | 어휘소마다 문서 ID 목록 (진짜 역색인) | 시그니처(비트맵) 기반 |
| 조회 속도 | 빠름 | 상대적으로 느림 |
| 정확도 | 정확 | 손실 있음 — 후보를 뽑고 재검사 필요 |
| 갱신 비용 | 높음 | 낮음 |
| 크기 | 큼 | 작음 |

메일 검색은 **쓰기보다 읽기가 훨씬 많고**, 한 번 들어온 메일 본문은 거의 안 바뀝니다. 조회 속도를 사고 갱신 비용을 파는 거래가 맞아서 GIN을 골랐어요.

### 사용자 입력을 그대로 받습니다

`tsquery`를 만드는 함수가 여러 개인데 각각 파싱 규칙이 다릅니다.

| 함수 | 입력 예 | 동작 |
| --- | --- | --- |
| `to_tsquery` | `'계약서 & 검토'` | 연산자를 직접 써야 함. 문법 틀리면 에러 |
| `plainto_tsquery` | `'계약서 검토'` | 모든 단어를 AND로 묶음 |
| `phraseto_tsquery` | `'계약서 검토'` | 순서까지 붙어 있어야 매칭 |
| `websearch_to_tsquery` | `'"계약서 검토" -스팸'` | 웹 검색 문법. 따옴표·OR·`-` 지원 |

사용자 검색창에 연결할 거라 `websearch_to_tsquery`를 골랐습니다. **문법이 틀려도 에러를 던지지 않는 게** 결정적이었어요. `to_tsquery`에 사용자 입력을 그대로 넣으면 괄호 하나만 안 맞아도 쿼리가 터집니다.

```java
/**
 * 첫 페이지: 마커 없이 한국어 FTS로 매칭되는 스레드 ID를 최신순으로 반환한다.
 * websearch_to_tsquery: 사용자 입력을 웹 검색 형식으로 파싱 (AND/OR/NOT/따옴표 지원).
 */
```

## [형태소 분석만으로는 부족했습니다]

여기까지 만들고 써보니 못 찾는 게 있었어요.

**영문 부분 일치.** `invoice2024.pdf`에서 `invoice`는 찾아도 `voice`는 못 찾습니다. 역색인은 **단어 단위**라 단어 중간부터는 매칭이 안 돼요.

**사전에 없는 말.** mecab-ko-dic은 사전 기반이라 신조어, 사내 은어, 프로젝트 코드명 같은 건 제대로 못 쪼갭니다.

**대소문자와 짧은 문자열.** 2글자 이하나 특수문자가 섞인 검색어는 형태소 분석에서 통째로 사라지기도 합니다.

그래서 **두 번째 경로**를 붙였습니다. 트라이그램입니다.

### 트라이그램은 3글자씩 잘라 색인합니다

`pg_trgm`은 문자열을 3글자 단위로 쪼갭니다. `invoice`는 `inv`, `nvo`, `voi`, `oic`, `ice`가 돼요.

이렇게 해두면 `LIKE '%voice%'`도 인덱스를 쓸 수 있습니다. 검색어 `voice`도 `voi`, `oic`, `ice`로 쪼개서 **이 트라이그램들을 전부 가진 행**을 역색인에서 찾은 뒤, 그 후보들만 실제로 `LIKE` 검사하면 되니까요. 전체 스캔이 후보 스캔으로 줄어듭니다.

```sql
-- messages.search_text: 영어 부분/대소문자 무시 검색을 위한 소문자 정규화 텍스트
-- body_text는 인덱스 크기 제한을 위해 앞 5000자만 포함
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_text text;

CREATE OR REPLACE FUNCTION messages_search_text_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.search_text = lower(
        coalesce(NEW.subject, '') || ' ' || coalesce(NEW.from_name, '') || ' ' ||
        ... || left(coalesce(NEW.body_text, ''), 5000)
    );
    RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_messages_search_text_trgm
    ON messages USING GIN(search_text gin_trgm_ops);
```

`lower()`로 미리 소문자화해서 대소문자 구분을 없앴고, **본문은 앞 5,000자만** 넣었습니다. 트라이그램 인덱스는 원문 길이에 비례해 커져요. 본문 전체를 넣으면 인덱스가 테이블보다 커집니다. 5,000자는 "메일 앞부분에 핵심이 있다"는 가정으로 자른 값이고, 여기서 재현율과 인덱스 크기를 맞바꿨습니다.

### 두 경로를 OR로 합칩니다

실제 검색 쿼리는 형태소 경로와 트라이그램 경로를 둘 다 봅니다.

```sql
EXISTS (
  SELECT 1 FROM messages m
  WHERE m.thread_id  = t.id
    AND m.deleted_at IS NULL
    AND (m.search_vector @@ websearch_to_tsquery('korean', :query)
         OR m.search_text LIKE '%' || replace(replace(replace(lower(:query),
              '!', '!!'), '%', '!%'), '_', '!_') || '%' ESCAPE '!')
)
```

`replace`가 세 번 겹친 부분은 **LIKE 와일드카드 이스케이프**입니다. 사용자가 `%`를 검색하면 `LIKE '%%%'`가 되어 전체 매칭이 돼버려요. `!`를 이스케이프 문자로 지정하고 `%`, `_`, `!` 자체를 막았습니다. SQL 인젝션은 바인딩 파라미터로 막히지만, **와일드카드 주입은 별개 문제**라 따로 처리해야 합니다.

첨부파일 이름도 같은 방식으로 두 경로를 겁니다.

<svg class="diagram" viewBox="0 0 720 268" role="img" aria-label="형태소 경로와 트라이그램 경로를 OR 로 합치는 구조">
  <defs>
    <marker id="ar-two" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3, #9A958B)"/>
    </marker>
  </defs>
  <text x="0" y="12" font-size="13" font-weight="600" fill="var(--ink-2, #63605A)">한 검색어가 두 색인을 동시에 두드린다</text>

  <rect x="250" y="26" width="220" height="30" rx="6" fill="var(--sunk, #F1EDE3)" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="0.5"/>
  <text x="360" y="45" font-size="11.5" text-anchor="middle" fill="var(--ink-2, #63605A)">검색어</text>

  <path d="M300 56 L300 74 Q300 84 285 84 L180 84" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-two)"/>
  <path d="M420 56 L420 74 Q420 84 435 84 L540 84" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-two)"/>

  <rect x="0" y="94" width="340" height="86" rx="7" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="16" y="114" font-size="11.5" font-weight="700" fill="var(--clay, #BF5F3B)">형태소 경로 · search_vector</text>
  <text x="16" y="133" font-size="10.5" fill="var(--ink-2, #63605A)">조사·어미를 뗀 어근 단위로 매칭한다</text>
  <text x="16" y="150" font-size="10.5" fill="var(--ink-2, #63605A)">"계약서를" 로 색인돼도 "계약서" 로 찾힌다</text>
  <text x="16" y="169" font-size="10.5" fill="var(--ink-3, #9A958B)">약점 — 단어 중간, 사전에 없는 말</text>

  <rect x="380" y="94" width="340" height="86" rx="7" fill="none" stroke="var(--rule, rgba(34,31,27,.11))" stroke-width="1"/>
  <text x="396" y="114" font-size="11.5" font-weight="700" fill="var(--ink-2, #63605A)">트라이그램 경로 · search_text</text>
  <text x="396" y="133" font-size="10.5" fill="var(--ink-2, #63605A)">3 글자씩 쪼개 부분 문자열을 매칭한다</text>
  <text x="396" y="150" font-size="10.5" fill="var(--ink-2, #63605A)">"invoice" 안의 "voice" 도 찾힌다</text>
  <text x="396" y="169" font-size="10.5" fill="var(--ink-3, #9A958B)">약점 — 인덱스가 크고, 2 글자 이하는 못 탄다</text>

  <path d="M170 180 L170 200 Q170 210 185 210 L330 210" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-two)"/>
  <path d="M550 180 L550 200 Q550 210 535 210 L390 210" fill="none" stroke="var(--ink-3, #9A958B)" stroke-width="1" marker-end="url(#ar-two)"/>

  <rect x="250" y="222" width="220" height="30" rx="6" fill="none" stroke="var(--clay, #BF5F3B)" stroke-width="1"/>
  <text x="360" y="241" font-size="11.5" font-weight="700" text-anchor="middle" fill="var(--clay, #BF5F3B)">OR — 합집합</text>

  <text x="0" y="266" font-size="11" fill="var(--ink-3, #9A958B)">서로의 사각지대를 덮는다. 대가는 색인 두 벌과 그만큼의 쓰기·저장 비용이다.</text>
</svg>

## [그래서 왜 Elasticsearch를 안 썼나]

가장 많이 받은 질문입니다. 검색이라고 하면 보통 Elasticsearch나 OpenSearch를 떠올리니까요.

### 두 진영 정리

먼저 오픈소스 상황을 짚고 갈게요. 이름이 비슷해서 헷갈리기 쉽습니다.

- **Lucene** — 자바로 만든 검색 라이브러리. 역색인 구현 그 자체이고 Apache 2.0입니다. Elasticsearch도 OpenSearch도 안에서 이걸 씁니다.
- **Elasticsearch** — Lucene을 분산 서버로 감싼 제품. 7.10까지 Apache 2.0이었다가 2021년에 SSPL/ELv2 듀얼 라이선스로 바뀌었습니다. 2024년에 AGPLv3 선택지가 추가됐어요.
- **OpenSearch** — 라이선스 변경 시점의 Elasticsearch 7.10을 AWS가 포크한 것. Apache 2.0이고, 2024년에 리눅스 재단으로 넘어갔습니다.

라이선스 변경이 포크를 낳은 대표 사례라 배경으로 알아둘 만합니다. 다만 저희가 안 쓴 이유는 라이선스가 아니었어요.

### 비교

| | PostgreSQL FTS | Elasticsearch / OpenSearch |
| --- | --- | --- |
| 운영 부담 | 쓰던 DB 그대로 | 클러스터가 하나 늘어난다 |
| 색인 동기화 | 트리거로 같은 트랜잭션 | 이중 쓰기 · 지연 · 정합성 관리 필요 |
| 일관성 | 커밋되면 즉시 검색됨 | near-realtime (기본 refresh 1초) |
| 랭킹 | `ts_rank` — IDF 없음 | BM25 기본, 튜닝 폭이 넓다 |
| 한국어 | textsearch_ko를 직접 빌드 | Nori 분석기 내장 |
| 확장 | DB 스케일에 묶임 | 샤딩·복제로 수평 확장 |
| 부가 기능 | 없음 | 하이라이팅, 자동완성, 오타 교정, 집계 |

**저희 상황에서 결정적이었던 건 위 두 줄입니다.**

검색이 서비스의 핵심 가치가 아니라 **부속 기능**이에요. 메일상자의 본체는 다중 계정 동기화와 AI 작성 지원입니다. 검색 때문에 클러스터를 하나 더 띄우고 그 운영을 떠안는 건 비용이 맞지 않았어요.

그리고 **정합성**입니다. 메일은 동기화 워커가 계속 쓰고, 삭제·라벨 변경도 잦습니다. 별도 엔진을 두면 "DB에는 지워졌는데 검색에는 남아 있는" 상태가 생겨요. 메일이라는 데이터 특성상 지운 게 검색에 뜨는 건 꽤 곤란합니다. 트리거로 같은 트랜잭션에서 색인하면 이 문제 자체가 없어져요.

### 언제 Elasticsearch로 가야 하나

반대로 이런 신호가 보이면 옮기는 게 맞다고 정리했습니다.

- **검색 품질이 제품의 핵심 가치**가 될 때. `ts_rank`로는 한계가 뚜렷합니다
- 하이라이팅·자동완성·오타 교정·패싯 집계가 필요해질 때. Postgres에서 다 직접 만들어야 합니다
- 검색 부하가 DB의 트랜잭션 부하를 방해할 때. 같은 인스턴스를 쓰니 서로 영향을 줍니다
- 문서 규모가 단일 인스턴스 한계를 넘을 때

지금은 어디에도 해당하지 않아서 Postgres에 남아 있습니다. **"작게 시작하고 신호가 오면 옮긴다"** 로 정한 셈이에요.

## [남은 문제]

**첫째, `ts_rank`에는 IDF가 없습니다.** 이게 제일 큰 한계예요. BM25는 "흔한 단어는 덜 중요하고 희귀한 단어는 더 중요하다"를 점수에 반영하는데(IDF), Postgres의 `ts_rank`는 **그 문서 안에서의 빈도만** 봅니다. 전체 문서에서 그 단어가 얼마나 희귀한지를 몰라요. 그래서 "회의 계약서"로 검색하면 흔한 "회의"만 잔뜩 나온 문서가 위로 올라올 수 있습니다. 지금은 랭킹 대신 **최신순 정렬**로 피해 가고 있어요. 메일은 최신이 중요하다는 도메인 특성 덕에 버티는 중입니다.

**둘째, 색인이 두 벌이라 쓰기 비용이 두 배입니다.** 메일 하나 저장할 때마다 `tsvector`와 `search_text`를 둘 다 만들고 GIN 인덱스 두 개를 갱신해요. 동기화 워커가 대량으로 넣을 때 이게 체감됩니다. 배치 삽입 중에는 인덱스를 끄고 나중에 재구축하는 방법이 있는데 아직 적용 안 했어요.

**셋째, 트라이그램 인덱스가 큽니다.** 본문 5,000자 제한으로 억제하고는 있지만 여전히 무겁고, 5,000자 뒤에 있는 내용은 영문 부분 검색으로 못 찾습니다. 잘린 사실을 사용자에게 알리지도 않아요.

**넷째, 사전이 2018년판입니다.** `mecab-ko-dic-2.1.1-20180720`을 쓰고 있어요. 최근 신조어는 제대로 안 쪼개집니다. 사용자 사전을 추가할 수 있는데 아직 안 했고, 어떤 단어를 넣어야 하는지는 실제 검색 로그를 봐야 알 수 있을 것 같습니다.

**다섯째, 검색 성능을 측정하지 않았습니다.** 지금 데이터 규모에서 느리지 않다는 것만 알고, 몇 통부터 느려지는지는 모릅니다. `EXPLAIN ANALYZE`로 실행 계획을 확인하고 데이터를 늘려가며 재보는 게 다음 할 일이에요.

## [결론]

검색 기능을 만든다고 했을 때 처음 떠오른 게 "Elasticsearch를 붙여야 하나"였습니다. 결과적으로는 붙이지 않았고, 그 판단의 근거는 **검색이 이 제품의 핵심이 아니라는 것** 하나였어요.

대신 얻은 게 명확합니다. 인프라가 안 늘었고, 색인 동기화 문제가 처음부터 없고, 커밋되면 바로 검색됩니다. 포기한 것도 명확해요. 랭킹 품질과 검색 전용 기능들입니다.

기술적으로 가장 크게 배운 건 세 가지입니다.

1. **`LIKE '%x%'`가 느린 건 인덱스가 없어서가 아니라 자료구조가 답할 수 없는 질문이어서**입니다. 질문에 맞는 자료구조(역색인, 트라이그램)를 고르는 게 먼저였어요.
2. **한국어 검색은 형태소 분석이 전제**입니다. 교착어라 공백 분리로는 아예 안 걸려요. 이건 최적화가 아니라 동작 요건입니다.
3. **하나의 색인으로는 모든 검색을 못 덮습니다.** 형태소는 단어 중간을 못 보고, 트라이그램은 무겁고 짧은 검색어에 약해요. 둘을 OR로 합친 건 타협이 아니라 각자의 사각지대를 아는 상태에서의 설계였습니다.

그런데 이 구조에도 못 찾는 게 있었습니다. **"작년에 계약 얘기 나눴던 그 메일"** 같은 검색이에요. 단어가 하나도 안 겹치니까요. 그래서 벡터 검색을 하나 더 붙였고, 두 결과를 합치는 방법이 다음 글 주제입니다.
