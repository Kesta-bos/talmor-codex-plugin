# Talmor Codex Plugin

`talmor-codex-plugin`은 Codex에 Morph와 Honcho를 연결해 주는 통합 플러그인입니다.

이 플러그인은 다음 흐름을 기준으로 배포됩니다.

- bootstrap 스크립트로 marketplace 등록과 초기 설정 저장
- Codex의 `/plugins`에서 플러그인 설치
- 최초 1회 `/talmor-codex-plugin:install` 실행

## 주요 기능

- Morph Compact 기반 원격 compact 대체
- Morph 편집 및 검색 도구 연동
- Honcho 메모리 레이어 연동
- 런타임 자동 시작 및 상태 복구
- 설치, 상태 확인, 제거 자동화

## 빠른 설치

가장 쉬운 설치 방법은 bootstrap 스크립트를 실행하는 것입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/talmormaker/talmor-codex-plugin/main/bootstrap/install.sh | bash
```

bootstrap이 끝나면 Codex에서 아래 순서로 진행합니다.

1. `/plugins`
2. `talmor-codex-plugin` 설치
3. `/talmor-codex-plugin:install`

## 저장소 구성

- `.agents/plugins/marketplace.json`: Codex marketplace 정의
- `bootstrap/install.sh`: 초기 설치 스크립트
- `plugins/talmor-codex-plugin/`: 실제 플러그인 본체

플러그인 사용 방법과 설정 항목은 `plugins/talmor-codex-plugin/README.md`를 참고하세요.
