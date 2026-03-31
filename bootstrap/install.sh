#!/usr/bin/env bash
set -euo pipefail

NON_INTERACTIVE=0
if [[ "${1:-}" == "--non-interactive" ]]; then
  NON_INTERACTIVE=1
  shift
fi

bootstrap_args=()
if [[ "${NON_INTERACTIVE}" == "1" ]]; then
  bootstrap_args+=(--non-interactive)
fi

if [[ ! -t 1 ]]; then
  NO_COLOR=1
fi

if [[ -z "${NO_COLOR:-}" ]]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  CYAN="$(printf '\033[36m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  CYAN=""
  RESET=""
fi

REPO_SLUG="${TALMOR_CODEX_PLUGIN_GITHUB_REPO:-Kesta-bos/talmor-codex-plugin}"
REPO_URL="${TALMOR_CODEX_PLUGIN_REPO_URL:-https://github.com/${REPO_SLUG}.git}"
INSTALL_DIR="${TALMOR_CODEX_PLUGIN_HOME_DIR:-$HOME/.talmor-codex-plugin-repo}"
PLUGIN_NAME="talmor-codex-plugin"
PLUGIN_DIR="${INSTALL_DIR}/plugins/${PLUGIN_NAME}"
ADMIN_SCRIPT="${PLUGIN_DIR}/scripts/talmor-codex-plugin-admin.mjs"
HOME_MARKETPLACE="${HOME}/.agents/plugins/marketplace.json"

info() {
  printf "%s%s%s\n" "${CYAN}" "$1" "${RESET}"
}

success() {
  printf "%s%s%s\n" "${GREEN}" "$1" "${RESET}"
}

warn() {
  printf "%s%s%s\n" "${YELLOW}" "$1" "${RESET}"
}

fail() {
  printf "%s%s%s\n" "${RED}" "$1" "${RESET}" >&2
  exit 1
}

banner() {
  printf "\n%sTalmor Codex Plugin Bootstrap%s\n" "${BOLD}" "${RESET}"
  printf "%sMorph, WarpGrep, Fast Apply, Honcho memory용 Codex bootstrap installer%s\n\n" "${DIM}" "${RESET}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "필수 명령을 찾을 수 없습니다: $1"
}

prompt_value() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local secret="${4:-0}"
  local current="${!var_name:-$default_value}"

  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    [[ -n "${current}" ]] || fail "${label} 값이 필요합니다. --non-interactive 에서는 환경변수로 미리 제공해야 합니다."
    printf -v "$var_name" "%s" "$current"
    return
  fi

  local prompt="${label}"
  if [[ -n "${default_value}" ]]; then
    prompt="${prompt} [${default_value}]"
  fi
  prompt="${prompt}: "

  local input=""
  if [[ "${secret}" == "1" ]]; then
    read -r -s -p "${prompt}" input
    printf "\n"
  else
    read -r -p "${prompt}" input
  fi
  if [[ -z "${input}" ]]; then
    input="${current}"
  fi
  [[ -n "${input}" ]] || fail "${label} 값이 필요합니다."
  printf -v "$var_name" "%s" "$input"
}

prompt_yes_no() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-y}"
  local existing="${!var_name:-}"
  local current="${existing}"
  if [[ -z "${current}" ]]; then
    current="${default_value}"
  fi

  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    printf -v "$var_name" "%s" "$current"
    return
  fi

  local suffix="Y/n"
  if [[ "${default_value}" =~ ^([nN]|no|NO|No|false|0)$ ]]; then
    suffix="y/N"
  fi
  read -r -p "${label} (${suffix}): " input
  input="${input:-$current}"
  input="$(printf "%s" "${input}" | tr '[:upper:]' '[:lower:]')"
  case "${input}" in
    y|yes|1|true|on) printf -v "$var_name" "true" ;;
    n|no|0|false|off) printf -v "$var_name" "false" ;;
    *) fail "${label} 에는 yes/no 로 답해주세요." ;;
  esac
}

prompt_optional_value() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local current="${!var_name:-$default_value}"

  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    printf -v "$var_name" "%s" "$current"
    return
  fi

  local prompt="${label}"
  if [[ -n "${default_value}" ]]; then
    prompt="${prompt} [${default_value}]"
  fi
  prompt="${prompt}: "

  read -r -p "${prompt}" input
  if [[ -z "${input}" ]]; then
    input="${current}"
  fi
  printf -v "$var_name" "%s" "$input"
}

clone_or_update_repo() {
  [[ "${INSTALL_DIR}" == "${HOME}"/* ]] || fail "INSTALL_DIR 는 홈 디렉터리 내부여야 합니다: ${INSTALL_DIR}"
  mkdir -p "$(dirname "${INSTALL_DIR}")"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "기존 bootstrap repo를 업데이트합니다: ${INSTALL_DIR}"
    if [[ -n "$(git -C "${INSTALL_DIR}" status --short)" ]]; then
      warn "관리용 bootstrap repo에 로컬 변경사항이 있어 origin/main 기준으로 정리합니다."
      git -C "${INSTALL_DIR}" reset --hard HEAD >/dev/null
      git -C "${INSTALL_DIR}" clean -fd >/dev/null
    fi
    git -C "${INSTALL_DIR}" fetch --prune origin
    git -C "${INSTALL_DIR}" checkout -q main
    git -C "${INSTALL_DIR}" reset --hard origin/main
  elif [[ -d "${INSTALL_DIR}" ]]; then
    fail "이미 존재하지만 git repo가 아닌 디렉터리입니다: ${INSTALL_DIR}"
  else
    info "bootstrap repo를 내려받습니다: ${REPO_URL}"
    git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  fi

  [[ -f "${ADMIN_SCRIPT}" ]] || fail "plugin admin script를 찾을 수 없습니다: ${ADMIN_SCRIPT}"
}

register_home_marketplace() {
  mkdir -p "$(dirname "${HOME_MARKETPLACE}")"
  local relative_install="${INSTALL_DIR#${HOME}/}"
  [[ "${relative_install}" != "${INSTALL_DIR}" ]] || fail "INSTALL_DIR 는 HOME 내부 경로여야 합니다."
  local plugin_source="./${relative_install}/plugins/${PLUGIN_NAME}"

  node - "${HOME_MARKETPLACE}" "${plugin_source}" "${PLUGIN_NAME}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [marketplacePath, pluginSource, pluginName] = process.argv.slice(2);
let marketplace = {
  name: "home-marketplace",
  interface: { displayName: "Home Plugins" },
  plugins: [],
};

if (fs.existsSync(marketplacePath)) {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  if (!marketplace || typeof marketplace !== "object" || Array.isArray(marketplace)) {
    throw new Error("기존 marketplace.json 형식이 올바르지 않습니다.");
  }
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
}

const nextEntry = {
  name: pluginName,
  source: {
    source: "local",
    path: pluginSource,
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "Productivity",
};

const index = marketplace.plugins.findIndex((plugin) => plugin && plugin.name === pluginName);
if (index >= 0) {
  marketplace.plugins[index] = {
    ...marketplace.plugins[index],
    ...nextEntry,
    source: nextEntry.source,
    policy: {
      ...marketplace.plugins[index].policy,
      ...nextEntry.policy,
    },
  };
} else {
  marketplace.plugins.push(nextEntry);
}

fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
}

install_plugin() {
  local cmd=(
    node "${ADMIN_SCRIPT}" install
    --morph-api-key "${MORPH_API_KEY}"
    --morph-compact "${MORPH_COMPACT}"
    --morph-compact-token-limit "${MORPH_COMPACT_TOKEN_LIMIT}"
    --morph-compact-context-threshold "${MORPH_COMPACT_CONTEXT_THRESHOLD}"
    --morph-compact-preserve-recent "${MORPH_COMPACT_PRESERVE_RECENT}"
    --morph-compact-ratio "${MORPH_COMPACT_RATIO}"
    --morph-edit "${MORPH_EDIT}"
    --morph-warpgrep "${MORPH_WARPGREP}"
    --morph-warpgrep-github "${MORPH_WARPGREP_GITHUB}"
  )

  if [[ "${HONCHO_ENABLED}" == "true" ]]; then
    cmd+=(
      --enable-honcho true
      --honcho-api-key "${HONCHO_API_KEY}"
      --honcho-peer-name "${HONCHO_PEER_NAME}"
      --honcho-workspace "${HONCHO_WORKSPACE}"
    )
  else
    cmd+=(--enable-honcho false)
  fi

  "${cmd[@]}"
}

print_summary() {
  printf "\n%s저장될 설정%s\n" "${BOLD}" "${RESET}"
  printf "  repo: %s\n" "${INSTALL_DIR}"
  printf "  home marketplace: %s\n" "${HOME_MARKETPLACE}"
  printf "  plugin id: %s\n" "${PLUGIN_NAME}"
  printf "  morph compact: %s\n" "${MORPH_COMPACT}"
  printf "  morph edit: %s\n" "${MORPH_EDIT}"
  printf "  warpgrep: %s\n" "${MORPH_WARPGREP}"
  printf "  warpgrep github: %s\n" "${MORPH_WARPGREP_GITHUB}"
  printf "  honcho enabled: %s\n" "${HONCHO_ENABLED}"
  if [[ "${HONCHO_ENABLED}" == "true" ]]; then
    printf "  honcho peer: %s\n" "${HONCHO_PEER_NAME}"
    printf "  honcho workspace: %s\n" "${HONCHO_WORKSPACE}"
  fi
}

banner
require_command git
require_command node
require_command npm

clone_or_update_repo

CURRENT_SCRIPT="${BASH_SOURCE[0]:-$0}"
REEXEC_TARGET="${INSTALL_DIR}/bootstrap/install.sh"
CURRENT_SCRIPT_REAL="$(realpath "${CURRENT_SCRIPT}" 2>/dev/null || printf '%s' "${CURRENT_SCRIPT}")"
REEXEC_TARGET_REAL="$(realpath "${REEXEC_TARGET}" 2>/dev/null || printf '%s' "${REEXEC_TARGET}")"

if [[ "${TALMOR_CODEX_PLUGIN_BOOTSTRAP_REEXECED:-0}" != "1" ]] && [[ "${CURRENT_SCRIPT_REAL}" != "${REEXEC_TARGET_REAL}" ]]; then
  info "최신 bootstrap 스크립트로 다시 실행합니다."
  export TALMOR_CODEX_PLUGIN_BOOTSTRAP_REEXECED=1
  exec bash "${REEXEC_TARGET}" "${bootstrap_args[@]}"
fi

MORPH_API_KEY="${MORPH_API_KEY:-}"
HONCHO_API_KEY="${HONCHO_API_KEY:-}"
HONCHO_ENABLED="${HONCHO_ENABLED:-}"
HONCHO_PEER_NAME="${HONCHO_PEER_NAME:-${USER:-user}}"
HONCHO_WORKSPACE="${HONCHO_WORKSPACE:-talmor_codex_plugin}"
MORPH_COMPACT="${MORPH_COMPACT:-true}"
MORPH_COMPACT_TOKEN_LIMIT="${MORPH_COMPACT_TOKEN_LIMIT:-auto}"
MORPH_COMPACT_CONTEXT_THRESHOLD="${MORPH_COMPACT_CONTEXT_THRESHOLD:-0.7}"
MORPH_COMPACT_PRESERVE_RECENT="${MORPH_COMPACT_PRESERVE_RECENT:-3}"
MORPH_COMPACT_RATIO="${MORPH_COMPACT_RATIO:-0.3}"
MORPH_EDIT="${MORPH_EDIT:-true}"
MORPH_WARPGREP="${MORPH_WARPGREP:-true}"
MORPH_WARPGREP_GITHUB="${MORPH_WARPGREP_GITHUB:-true}"

prompt_value MORPH_API_KEY "Morph API Key" "" 1

if [[ -z "${HONCHO_ENABLED}" ]]; then
  if [[ -n "${HONCHO_API_KEY}" ]]; then
    HONCHO_ENABLED="true"
  else
    HONCHO_ENABLED="false"
  fi
fi
prompt_yes_no HONCHO_ENABLED "Honcho memory를 함께 활성화할까요?" "${HONCHO_ENABLED}"

if [[ "${HONCHO_ENABLED}" == "true" ]]; then
  prompt_value HONCHO_API_KEY "Honcho API Key" "" 1
  prompt_value HONCHO_PEER_NAME "Honcho peer name" "${HONCHO_PEER_NAME}" 0
  prompt_value HONCHO_WORKSPACE "Honcho workspace" "${HONCHO_WORKSPACE}" 0
fi

ADVANCED_MORPH="${ADVANCED_MORPH:-false}"
prompt_yes_no ADVANCED_MORPH "고급 Morph 설정을 편집할까요?" "${ADVANCED_MORPH}"

if [[ "${ADVANCED_MORPH}" == "true" ]]; then
  prompt_yes_no MORPH_COMPACT "Morph compact를 활성화할까요?" "${MORPH_COMPACT}"
  prompt_optional_value MORPH_COMPACT_TOKEN_LIMIT "MORPH_COMPACT_TOKEN_LIMIT (auto 가능)" "${MORPH_COMPACT_TOKEN_LIMIT}"
  prompt_value MORPH_COMPACT_CONTEXT_THRESHOLD "MORPH_COMPACT_CONTEXT_THRESHOLD" "${MORPH_COMPACT_CONTEXT_THRESHOLD}" 0
  prompt_value MORPH_COMPACT_PRESERVE_RECENT "MORPH_COMPACT_PRESERVE_RECENT" "${MORPH_COMPACT_PRESERVE_RECENT}" 0
  prompt_value MORPH_COMPACT_RATIO "MORPH_COMPACT_RATIO" "${MORPH_COMPACT_RATIO}" 0
  prompt_yes_no MORPH_EDIT "Morph Fast Apply를 활성화할까요?" "${MORPH_EDIT}"
  prompt_yes_no MORPH_WARPGREP "WarpGrep codebase search를 활성화할까요?" "${MORPH_WARPGREP}"
  prompt_yes_no MORPH_WARPGREP_GITHUB "WarpGrep GitHub search를 활성화할까요?" "${MORPH_WARPGREP_GITHUB}"
fi

print_summary
if [[ "${NON_INTERACTIVE}" != "1" ]]; then
  CONFIRM_INSTALL="true"
  prompt_yes_no CONFIRM_INSTALL "이 설정으로 bootstrap을 진행할까요?" "true"
  [[ "${CONFIRM_INSTALL}" == "true" ]] || fail "사용자가 bootstrap을 취소했습니다."
fi

info "홈 스코프 marketplace를 등록합니다."
register_home_marketplace

info "플러그인을 설치하고 Codex 설정과 연결합니다."
INSTALL_OUTPUT="$(install_plugin)"
printf "%s\n" "${INSTALL_OUTPUT}"

success "bootstrap 설치가 완료되었습니다."
printf "\n%s다음 단계%s\n" "${BOLD}" "${RESET}"
printf "  1. 실행 중인 Codex가 있다면 완전히 종료합니다.\n"
printf "  2. Codex를 다시 실행합니다.\n"
printf "  3. 필요하면 Codex에게 Talmor Codex Plugin 상태를 확인해 달라고 요청합니다.\n"
printf "\n%s참고%s\n" "${BOLD}" "${RESET}"
printf "  - 이 bootstrap은 marketplace 등록, plugin 활성화, openai_base_url 전환, hooks 주입, runtime health 확인까지 한 번에 수행합니다.\n"
printf "  - 현재 Codex CLI에서는 plugin skill이 slash command로 노출되지 않으므로 별도 /talmor-codex-plugin:install 단계는 사용하지 않습니다.\n"
