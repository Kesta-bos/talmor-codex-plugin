---
name: uninstall
description: talmor-codex-plugin 제거 - openai_base_url, instruction injection, hooks, runtime 정리
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash]
---

# Talmor Codex Plugin 제거

이 스킬은 talmor-codex-plugin 설정을 제거하고 `openai_base_url` 을 원복합니다.

중요:
- 이 스킬 파일은 `skills/uninstall/SKILL.md` 에 있습니다.
- `../../scripts/talmor-codex-plugin-admin.mjs` 는 이 파일 기준 상대 경로입니다.
- 제거 후에도 현재 세션에는 기존 설정이 남아 있을 수 있으므로 Codex 재시작을 권장합니다.

## 절차

1. 먼저 현재 상태를 확인합니다.

```bash
node ../../scripts/talmor-codex-plugin-admin.mjs status
```

2. 제거를 실행합니다.

```bash
node ../../scripts/talmor-codex-plugin-admin.mjs uninstall
```

3. 결과 JSON을 읽고 다음을 보고합니다.
- runtime 중지 여부
- `openai_base_url` 원복 여부
- `developer_instructions` 블록 제거 여부
- `hooks.json` 제거 여부
- `AGENTS.override.md` 관리형 블록 제거 여부
- Codex 재시작 권장 여부
