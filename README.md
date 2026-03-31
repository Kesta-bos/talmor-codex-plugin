# Talmor Codex Plugin

`talmor-codex-plugin`은 Codex에 Morph와 Honcho를 연결해 주는 통합 플러그인입니다.

이 플러그인은 다음 흐름을 기준으로 배포됩니다.

- bootstrap 스크립트 한 번으로 설치와 설정 완료
- Codex 재시작 후 바로 사용

## 주요 기능

- Morph Compact 기반 원격 compact 대체
- Morph 편집 및 검색 도구 연동
- Honcho 메모리 레이어 연동
- 런타임 자동 시작 및 상태 복구
- 설치, 상태 확인, 제거 자동화

## 빠른 설치

가장 쉬운 설치 방법은 bootstrap 스크립트를 실행하는 것입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/Kesta-bos/talmor-codex-plugin/main/bootstrap/install.sh | bash
```

bootstrap이 끝나면 아래 순서로 진행합니다.

1. 실행 중이던 Codex 종료
2. Codex 재실행
3. 필요시 상태 확인

## 저장소 구성

- `.agents/plugins/marketplace.json`: Codex marketplace 정의
- `bootstrap/install.sh`: 초기 설치 스크립트
- `plugins/talmor-codex-plugin/`: 실제 플러그인 본체

플러그인 사용 방법과 설정 항목은 `plugins/talmor-codex-plugin/README.md`를 참고하세요.
