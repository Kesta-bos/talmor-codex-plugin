---
name: install
description: talmor-codex-plugin 최초 설치 - Morph compact, Honcho memory, instruction injection, hooks 설정
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash, AskUserQuestion]
---

# Talmor Codex Plugin 설치

이 스킬은 이 플러그인의 최초 1회 설치를 끝냅니다.

중요:
- 이 스킬 파일은 `skills/install/SKILL.md` 에 있습니다.
- `../../scripts/talmor-codex-plugin-admin.mjs` 는 이 파일 기준 상대 경로입니다.
- 설치가 끝나면 `openai_base_url` 이 로컬 compact runtime을 가리키게 되므로, 보통 Codex 재시작이 필요합니다.

## 절차

1. 먼저 `node --version` 과 `npm --version` 을 확인합니다.
2. `node ../../scripts/talmor-codex-plugin-admin.mjs status` 를 실행해 현재 상태를 확인합니다.
3. bootstrap이 이미 실행되었다면 먼저 저장된 설정값을 재사용합니다.
4. 이미 저장된 Morph API 키가 없다면 사용자에게 키를 물어봅니다.
5. Honcho memory까지 함께 쓰려면 Honcho API 키도 받습니다. 없다면 Honcho 없이 설치할 수 있습니다.
6. API 키와 설정이 준비되면 아래 형식으로 설치를 실행합니다.

```bash
MORPH_API_KEY='<USER_KEY>' HONCHO_API_KEY='<OPTIONAL_HONCHO_KEY>' node ../../scripts/talmor-codex-plugin-admin.mjs install
```

또는 bootstrap이 미리 값을 저장했다면 아래처럼 실행해도 됩니다.

```bash
node ../../scripts/talmor-codex-plugin-admin.mjs install
```

7. 설치 결과 JSON을 읽고 다음을 짧게 보고합니다.
- `openai_base_url` 이 runtime proxy로 바뀌었는지
- runtime health가 성공했는지
- Honcho가 활성화되었는지
- Morph 설정이 저장된 값대로 반영되었는지
- `developer_instructions`, `hooks.json`, `AGENTS.override.md` 가 주입되었는지
- Codex 재시작이 필요한지

## 실패 처리

- `npm install` 실패 시 stderr 핵심 메시지를 그대로 요약합니다.
- 같은 포트에 다른 runtime이 이미 떠 있다는 오류가 나면, 기존 `talmor-codex-plugin` 인스턴스 정리 또는 다른 포트로 재설치를 안내합니다.
- 필요하면 아래처럼 포트를 바꿔 재실행할 수 있습니다.

```bash
MORPH_API_KEY='<USER_KEY>' node ../../scripts/talmor-codex-plugin-admin.mjs install --port 4321
```

- 이미 설치된 상태여도 재실행은 허용됩니다. 단, 결과 JSON 기준으로 현재 상태를 설명합니다.
