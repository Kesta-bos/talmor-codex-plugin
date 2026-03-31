# Talmor Codex Plugin Routing Policy

Morph 도구가 노출되어 있다면 작업 유형에 따라 아래 우선순위를 따릅니다.

## 편집 도구 선택

다음 경우에는 `morph_edit`를 우선 사용합니다.

- 큰 파일 내부를 수정할 때
- 한 파일 안의 여러 위치를 한 번에 바꿔야 할 때
- exact-string 기반 치환이 깨지기 쉬운 whitespace 민감 편집일 때
- 기존 파일 내부의 복잡한 리팩터링이나 구조 정리가 필요할 때

다음 경우에는 Codex 기본 편집 도구를 우선 사용합니다.

- 작은 exact replacement 한두 건만 필요할 때는 `edit`
- 한 줄 수정, 단순 문자열 교체, 짧은 rename은 `edit`
- 새 파일을 만들 때는 `write`

## `morph_edit`를 먼저 쓰지 말아야 하는 경우

- 새 파일 생성 작업
- 아주 작은 exact `oldString -> newString` 교체
- 현재 에이전트가 readonly라 파일 편집이 불가능한 경우
- `MORPH_API_KEY`가 없거나 `MORPH_EDIT=false`로 비활성화된 경우

## 검색 도구 선택

다음 경우에는 `warpgrep_codebase_search`를 우선 사용합니다.

- 현재 체크아웃된 로컬 코드베이스에 대한 탐색형 질문
- "인증 흐름이 어디서 시작되는가", "에러 처리가 어떻게 연결되는가" 같은 자연어 기반 코드 탐색
- 정의, 사용 위치, 흐름, 계층 구조를 빠르게 파악해야 하는 경우

다음 경우에는 기본 검색 도구를 우선 사용합니다.

- 정확한 함수명, 변수명, 에러 문자열, 설정 키를 찾을 때는 `grep` 또는 `rg`
- 이미 파일 경로가 좁혀졌고 짧은 확인만 필요할 때는 `read`

## 외부 공개 저장소 검색

다음 경우에는 `warpgrep_github_search`를 우선 사용합니다.

- 공개 오픈소스 라이브러리나 SDK의 내부 구현을 이해해야 할 때
- 공식 문서보다 실제 소스코드 동작을 확인해야 할 때
- 문서 링크가 불완전하거나 구현 레벨 근거가 필요한 경우

`warpgrep_github_search` 사용 원칙:

- 현재 로컬로 체크아웃된 저장소에는 사용하지 않습니다
- 공개 GitHub 저장소에만 사용합니다
- `owner_repo` 또는 `github_url` 중 하나만 제공해 저장소를 지정합니다

## 우선순위 요약

- 큰 편집, 흩어진 수정, whitespace 민감 편집: `morph_edit`
- 작은 exact replacement: `edit`
- 새 파일 생성: `write`
- 로컬 코드베이스 탐색형 검색: `warpgrep_codebase_search`
- 공개 GitHub 저장소 구현 탐색: `warpgrep_github_search`
- 정확한 키워드 검색: `grep` 또는 `rg`

## 실패 시 fallback

- `morph_edit`가 실패하면 `edit` 또는 `write`로 전환합니다
- `warpgrep_codebase_search`가 실패하면 `rg`와 `read` 조합으로 전환합니다
- `warpgrep_github_search`가 실패하면 필요한 경우에만 저장소를 별도 체크아웃하거나 공식 문서를 확인합니다
- Morph 도구가 비활성화되어 있거나 인증이 없으면 Codex 기본 도구로 즉시 전환합니다

## 금지 패턴

- 큰 파일이나 복잡한 리팩터링에 대해 습관적으로 `edit`를 먼저 쓰지 않습니다
- 새 파일 생성에 `morph_edit`를 사용하지 않습니다
- exact keyword lookup에 `warpgrep_codebase_search`를 사용하지 않습니다
- 현재 로컬 저장소 분석에 `warpgrep_github_search`를 사용하지 않습니다
