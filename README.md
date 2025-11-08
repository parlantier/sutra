# sutra

팔리경전 저장프로젝트

## 준비

1. VipassanaTech의 [`tipitaka-xml`](https://github.com/vipassanatech/tipitaka-xml) 저장소를 `data/tipitaka-xml` 등 원하는 위치에 클론합니다.
2. 필요한 패키지를 설치합니다.

```bash
npm install
```

> 일부 패키지는 사내 프록시/네트워크 정책에 따라 직접 내려 받아야 할 수도 있습니다. `npm install`이 실패하면 수동으로 tarball을 내려 받아 `node_modules`를 구성한 뒤 스크립트를 실행하세요.

## 가져오기 스크립트 실행

```bash
node scripts/import-tei.js \
  --source ./data/tipitaka-xml \
  --db ./db/sutra.sqlite
```

주요 옵션:

- `--pattern`: 기본값은 `romn/**/*.xml`로 로마자 팔리 텍스트만 스캔합니다.
- `--korean-map`: `data/korean_titles.json`에서 식별자/제목을 찾아 한글 제목을 `nodes.head_korean` 컬럼에 채웁니다. 필요하면 파일을 수정해 각 `xml:id`나 `type|n` 조합을 한글 제목에 매핑하세요.
- `--limit`: 테스트 목적으로 처음 N개의 파일만 처리할 때 사용합니다.

스크립트는 파일 단위 트랜잭션으로 동작하며, 동일한 파일을 다시 실행하면 기존 레코드를 삭제하고 다시 적재합니다. `nodes`, `pages`, `posts`의 참조 관계는 외래키(FK)로 보호되며, 페이지(`pb`)와 본문 블록(`<p>`, `<lg>/<l>`)을 순서대로 저장합니다.

## 데이터베이스 스키마

`schema/schema.sql`에 정의되어 있으며, 주요 테이블은 다음과 같습니다.

- `source_files`: 원본 TEI 파일의 경로, 해시, 헤더 정보를 기록합니다.
- `nodes`: 논리 구조(`div`)를 계층적으로 저장하며, `head_korean` 필드에 한글 제목을 보관합니다.
- `pages`: `<pb/>` 태그를 페이지로 저장합니다.
- `posts`: 단락(`<p>`)과 시구(`<lg>/<l>`)를 순서대로 저장합니다.

필요에 따라 `data/korean_titles.json`을 확장하거나 다른 보조 테이블을 추가해 사용할 수 있습니다.
