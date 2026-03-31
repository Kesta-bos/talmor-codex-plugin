---
name: status
description: talmor-codex-plugin 설치 상태, runtime health, Morph/Honcho 주입 상태 확인
user-invocable: true
allowed-tools: [Read, Bash]
---

# Talmor Codex Plugin 상태 확인

이 스킬 파일 기준으로 아래 명령을 실행합니다.

```bash
node ../../scripts/talmor-codex-plugin-admin.mjs status
```

반환된 JSON을 읽고 다음만 간단히 정리합니다.
- 설치 여부
- 현재 `openai_base_url`
- Morph API 키 저장 여부
- Honcho API 키 저장 여부
- Honcho 활성화 여부
- `developer_instructions` 주입 여부
- `hooks.json` 설치 여부
- `AGENTS.override.md` 주입 여부
- runtime pid / health
- 사용자가 다음에 해야 할 일

health가 실패하면 `/talmor-codex-plugin:install` 또는 재시작 필요 여부를 같이 안내합니다.
