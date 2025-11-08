# Sutra 프로젝트 – Codex용 에이전트 가이드 (v1)

## 1. 현재 상태 & 목표

- **현 상태**: `sutra.sqlite` 데이터베이스가 생성되어 있음. (SQLite, WAL 모드, FK on)
- **현재 목표 (Phase 1)**: VipassanaTech의 `tipitaka-xml` 저장소(TEI, UTF-16)를 소스로 하여 팔리어 원문을 DB에 안전하게 적재한다.
- **향후 단계 (미포함)**: 문장/단어 분해 자동화, 번역 입력/검수 UI, 사전(lemma/sense) 구축, 교감(variants) 비교 뷰, 검색/필터 UI 등.

### 작업 범위 (Phase 1)

- TEI XML을 파싱하여 페이지/포스트(단락) 단위로 DB 저장
- 논리 구조(nodes), 물리 페이지(pages), 포스트(posts) 중심 스키마 사용
- 인코딩/정규화(NFC, 공백 정리) 최소 가공으로 원문 보존 우선

### 비범위 (Out of scope)

- 문장 분할/토큰화 자동화 품질 튜닝
- 번역 데이터 입력/동기화
- 사전/품사 자동 태깅 모델링

## 2. 데이터 소스

- 저장소: https://github.com/vipassanatech/tipitaka-xml
- 폴더: 주로 `romn/` (로마자 팔리), TEI(XML), UTF-16
- 특이사항: 일부 문서의 엔디안/인코딩 차이 가능(UTF-16LE/BE), `<pb/>`로 페이지, `<div>` 계층, `<p>`, `<lg>/<l>` 시구 등

## 3. 스키마 개요 (핵심 테이블)

- `source_files`: 원천 파일 메타(`rel_path`, `sha1`, `tei_header`)
- `nodes`: 논리 계층(니까야/북/왓가/수따/섹션) 트리 구조
- `pages`: 물리 페이지(`pb`) 정보
- `posts`: 단락/시행(블록) 단위 원문(`content_pali`, `content_norm`)
- (확장) `sentences`/`tokens`: 후속 단계에서 사용(문장/단어 단위)
- (확장) `lemmas`/`senses`/`token_glosses`/`translations`/`variants`/`citations`: 번역사전·교감·페이지 매핑용

## 4. 적재(ingest) 규칙

1. **인코딩**: 바이트를 읽어 UTF-16(우선 LE)로 디코드. 실패 시 BE를 재시도. BOM 존재 여부 확인.
2. **페이지 분할**: `<pb/>` 등장 시 `page_no` 증가 → `pages`에 upsert.
3. **논리 계층**: `<div type="..." n="...">`를 따라 `nodes` upsert. `head`/제목은 가능하면 저장.
4. **블록 추출**:
   - `<p>`: 단락으로 저장 → `posts(kind='p')`
   - `<lg>/<l>`: 시구를 줄 단위 합쳐 하나 블록 → `posts(kind='lg')`
   - `order_in_file`: 파일 내 등장 순서(1..)
   - `xml_id`: 해당 블록의 `@xml:id` 보존
5. **정규화**: `content_pali`는 원문 최대 보존, `content_norm`에는 NFC/공백 치환 등 경미한 정규화 적용(선택)
6. **무결성**:
   - `source_files(rel_path)` UNIQUE
   - `pages(source_file_id, page_no)` UNIQUE
   - `posts(source_file_id, order_in_file)` 인덱스 유지
7. **트랜잭션**: 파일 단위 트랜잭션 → 부분 실패 시 롤백

## 5. 작업 템플릿 (Node.js)

```bash
npm i better-sqlite3 fast-xml-parser iconv-lite glob
```

### 디렉터리 구조 권장

```
project/
  ├── data/tipitaka-xml/romn/          # 원본 XML 클론 위치
  ├── db/sutra.sqlite                  # SQLite 파일
  ├── scripts/import-tei.js            # 적재 스크립트
  └── schema/schema.sql                # 전체 DDL
```

### import-tei.js – 필수 체크리스트

- `sutra.sqlite` 연결 + PRAGMA(WAL, FK)
- `schema.sql` 적용(없으면 코드에서 DDL 실행)
- `glob("**/*.xml")`로 소스 순회
- 파일 단위 트랜잭션 시작
- UTF-16 디코드(LE → 실패 시 BE)
- `fast-xml-parser`로 파싱, 루트→`text/body` 진입
- `<pb>` 처리: `pages` upsert, `page_no`/`page_id` 유지
- `<div>` 스택으로 `nodes` upsert(`type`,`n`,`head`)
- `<p>`/`<lg>/<l>`을 등장 순으로 `posts` insert
- 커밋, 에러 시 롤백

## 6. 품질 기준 (Definition of Done)

- `romn/` 내 샘플 n개 파일에서 에러 없이 적재 완료
- 각 파일당 `pages.page_no`가 1부터 연속 증가
- `posts.order_in_file`가 1부터 연속 증가
- `<div>` 계층을 반영한 `nodes`가 생성되고, 상위/하위 탐색 가능
- 임의 샘플의 원문 텍스트가 손상 없이 `content_pali`에 보존됨
- 정규화(`content_norm`)가 있다면 원문 대비 차이 최소화(옵션)
- 전체 적재 시간/건수/오류 통계 로그 출력

## 7. 예외/엣지 케이스

- 일부 파일에서 UTF-16BE/깨진 BOM → 디코딩 분기 필요
- `<div>` 메타가 빈약한 파일 → `type/n/head` 누락 시 빈 값 허용, 순서 기반 `order_in_parent` 유지
- `<lg>` 안에 `<l>`이 없는 경우 → 통문자 처리 후 `kind='lg'`로 저장
- `<pb>`가 드문 파일 → `pages`가 비어도 `posts`는 정상 저장

## 8. 로그 & 추적 권장

- 파일별: 처리 시작/종료, `source_file_id`, `sha1`, 총 pages/posts 삽입 수
- 경고: 빈 `div`/미지원 태그/디코딩 재시도/장문 생략 등
- 에러: 파싱 실패, FK 위반, UNIQUE 충돌 → 파일 단위 롤백 후 다음 파일 진행

## 9. 후속 단계 로드맵 (요약)

1. 문장 분할(`sentences`) & 토큰화(`tokens`)
2. 표제어(`lemmas`) & 의미(`senses`) 구축/매핑
3. 단어별 정렬(`token_glosses`) – ko/en 병행
4. 교감 데이터(`variants`, `citations`) 매핑
5. 번역(`translations`) 입력/버전 관리
6. 검색(FTS) 최적화 및 API/뷰어 연동

## 10. 용어 정리 (Glossary)

- **TEI**: Text Encoding Initiative. 인문학 텍스트용 XML 규격
- **pb**: page break (페이지 구분)
- **div**: 문헌 내 논리 블록(책/장/절/수따 등)
- **post(블록)**: 사용자 뷰에 노출할 최소 텍스트 단위(단락/시구 등)
- **NFC**: 유니코드 정규화 형식 (Canonical Composition)

## 11. 이슈 처리

- 스키마 변경은 PR로 제안 후, 마이그레이션 스크립트 동반 제출
- ingest 실패 케이스는 원본 파일 경로와 에러 로그를 이슈로 등록
