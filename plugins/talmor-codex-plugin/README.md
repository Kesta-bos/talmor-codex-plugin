# Talmor Codex Plugin

`talmor-codex-plugin`은 Codex에서 Morph와 Honcho를 함께 사용할 수 있도록 구성한 통합 플러그인입니다.

## 제공 기능

- Morph Compact를 이용한 원격 compact 처리
- Morph 편집 및 검색 도구 연동
- Honcho 메모리 조회 및 저장 연동
- 설치 후 자동으로 유지되는 로컬 런타임
- 설치, 상태 확인, 제거 명령 제공

## 권장 설치 순서

### 1. bootstrap 실행

배포 저장소 루트에서 제공하는 bootstrap 스크립트를 먼저 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/talmormaker/talmor-codex-plugin/main/bootstrap/install.sh | bash
```

### 2. Codex에서 플러그인 설치

Codex에서 `/plugins`를 열고 `talmor-codex-plugin`을 설치합니다.

### 3. 최초 1회 초기화

설치 후 아래 명령을 한 번 실행합니다.

```text
/talmor-codex-plugin:install
```

이 단계에서 플러그인은 필요한 런타임 의존성을 설치하고 Codex 설정과 연동 상태를 준비합니다.

## 주요 명령

- `/talmor-codex-plugin:install`
- `/talmor-codex-plugin:status`
- `/talmor-codex-plugin:uninstall`

## 설정값

bootstrap 또는 설치 단계에서 다음 값을 사용할 수 있습니다.

- `MORPH_API_KEY`
- `HONCHO_API_KEY`
- `HONCHO_PEER_NAME`
- `HONCHO_WORKSPACE`
- `MORPH_COMPACT`
- `MORPH_COMPACT_TOKEN_LIMIT`
- `MORPH_COMPACT_CONTEXT_THRESHOLD`
- `MORPH_COMPACT_PRESERVE_RECENT`
- `MORPH_COMPACT_RATIO`
- `MORPH_EDIT`
- `MORPH_WARPGREP`
- `MORPH_WARPGREP_GITHUB`

현재 기본값은 다음과 같습니다.

- `MORPH_COMPACT_PRESERVE_RECENT=3`
- `MORPH_COMPACT_RATIO=0.3`
- `MORPH_COMPACT_CONTEXT_THRESHOLD=0.7`

참고로 `MORPH_COMPACT_TOKEN_LIMIT`와 `MORPH_COMPACT_CONTEXT_THRESHOLD`는 저장과 관리에는 사용되지만, 현재 Codex 자체의 auto compact 트리거 시점을 직접 바꾸지는 않습니다.

## 동작 개요

- 일반 OpenAI 요청은 기존 경로로 전달됩니다.
- `/responses/compact` 요청은 Morph Compact를 사용하도록 처리됩니다.
- Honcho가 활성화된 경우 세션 컨텍스트 조회와 메모리 저장을 함께 수행합니다.
- 설치 후에는 런타임이 자동으로 상태를 유지하므로 사용자가 별도 프록시를 직접 실행할 필요가 없습니다.

## 상태 파일

플러그인 상태는 기본적으로 아래 위치에 저장됩니다.

```text
~/.codex/talmor-codex-plugin/
```
