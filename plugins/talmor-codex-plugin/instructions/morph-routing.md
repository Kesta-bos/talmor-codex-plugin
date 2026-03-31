# Talmor Codex Plugin Routing Policy

이 파일은 `opencode-morph-plugin`의 `instructions/morph-tools.md` 패턴을 Codex에 옮기기 위한 초안입니다.

Codex에서는 plugin manifest만으로 이 파일이 항상 자동 주입되지는 않습니다. 따라서 실제 상시 적용은 install 단계에서 `developer_instructions` 로 관리형 삽입을 해야 합니다.

## 편집 도구 선택

- 큰 파일 편집, 여러 군데에 흩어진 수정, exact-string 편집이 불안정한 경우에는 향후 `morph_edit` 계열 도구를 우선 사용합니다.
- 작은 exact replacement는 Codex 기본 `edit` 를 우선 사용합니다.
- 새 파일 생성은 `write` 를 사용합니다.

## 검색 도구 선택

- 현재 체크아웃된 로컬 코드베이스의 탐색형 질문에는 향후 `warpgrep_codebase_search` 를 우선 사용합니다.
- 정확한 함수명, 변수명, 에러 문자열 검색에는 기본 `grep` 또는 `rg` 를 우선 사용합니다.
- 외부 공개 GitHub 저장소 내부 구현 질문에는 향후 `warpgrep_github_search` 를 우선 사용합니다.
- 현재 로컬로 체크아웃된 저장소에는 `warpgrep_github_search` 를 사용하지 않습니다.

## fallback

- Morph 도구가 비활성화되어 있거나 인증이 없으면 Codex 기본 도구로 즉시 fallback 합니다.
- Morph 편집이 실패하면 `edit` 또는 `write` 로 fallback 합니다.
- WarpGrep가 실패하면 `rg` + `read` 조합으로 fallback 합니다.
