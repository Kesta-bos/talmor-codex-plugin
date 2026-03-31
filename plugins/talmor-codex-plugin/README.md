# Talmor Codex Plugin

`talmor-codex-plugin`은 Codex에서 Morph와 Honcho를 함께 사용할 수 있도록 구성한 통합 플러그인입니다.

## 제공 기능

- Morph Compact를 이용한 원격 compact 처리
- Morph 편집 및 검색 도구 연동
- Honcho 메모리 조회 및 저장 연동
- 설치 후 자동으로 유지되는 로컬 런타임
- bootstrap 기반 설치 및 상태 복구

## 권장 설치 순서

### 1. bootstrap 실행

배포 저장소 루트에서 제공하는 bootstrap 스크립트를 먼저 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/Kesta-bos/talmor-codex-plugin/main/bootstrap/install.sh | bash
```

bootstrap은 다음 작업을 한 번에 수행합니다.

- 배포 repo 설치 또는 업데이트
- home marketplace 등록
- plugin 활성화
- Morph 및 Honcho 설정 저장
- 의존성 설치
- `openai_base_url` 전환
- `developer_instructions`, `AGENTS.override.md`, `hooks.json` 관리형 주입
- proxy health 확인

### 2. Codex 재시작

실행 중인 Codex가 있었다면 완전히 종료한 뒤 다시 실행합니다.

### 3. 사용 시작

이제 plugin은 자동으로 로드됩니다. 현재 Codex CLI에서는 plugin skill이 slash command로 노출되지 않으므로, `/talmor-codex-plugin:install` 같은 명령은 사용하지 않습니다.

상태 확인이 필요하면 Codex에게 Talmor Codex Plugin 상태를 확인해 달라고 요청하거나 `/mcp`에서 관련 도구를 확인하면 됩니다.

## 설정값

bootstrap 단계에서 다음 값을 사용할 수 있습니다.

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
- bootstrap 이후에는 런타임이 자동으로 상태를 유지하므로 사용자가 별도 프록시를 직접 실행할 필요가 없습니다.

## 상태 파일

플러그인 상태는 기본적으로 아래 위치에 저장됩니다.

```text
~/.codex/talmor-codex-plugin/
```
