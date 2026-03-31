#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  cleanupManagedConfigText,
  clearHonchoArtifacts,
  defaultHonchoConfig,
  defaultMorphConfig,
  defaultProxyPort,
  defaultUpstreamBaseUrl,
  ensureDir,
  getAgentsOverridePath,
  getConfigPath,
  getHooksPath,
  getInstalledPluginRoot,
  getNpmCommand,
  getStatePaths,
  healthcheckProxy,
  hooksManagedBy,
  isPidAlive,
  managedPluginConfigName,
  morphManagedBegin,
  morphManagedEnd,
  normalizePort,
  nowIso,
  parsePluginEnabled,
  parseTopLevelStringValue,
  pluginRoot,
  proxyBaseUrl,
  readCredentials,
  readMorphConfig,
  readHonchoConfig,
  readInstructionFile,
  readPid,
  readState,
  readText,
  removeIfExists,
  removeManagedBlock,
  removeManagedDeveloperInstructions,
  removePluginSection,
  removeTopLevelStringValue,
  setTopLevelStringValue,
  sleep,
  syncPluginIntoCodexCache,
  upsertDeveloperInstructions,
  upsertPluginEnabled,
  writeConfigText,
  writeCredentials,
  writeMorphConfig,
  writeHonchoConfig,
  writePid,
  writeState,
  writeText,
  honchoManagedBegin,
  honchoManagedEnd,
} from "./talmor-codex-plugin-common.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function readCurrentConfig() {
  const configPath = getConfigPath();
  const text = await readText(configPath, "");
  return {
    configPath,
    text,
    openaiBaseUrl: parseTopLevelStringValue(text, "openai_base_url"),
    developerInstructions: parseTopLevelStringValue(text, "developer_instructions"),
    pluginEnabled: parsePluginEnabled(text, managedPluginConfigName),
  };
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = `${value}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && `${value}` !== "") {
      return value;
    }
  }
  return undefined;
}

function parseIntegerSetting(value, fallback, fieldName, { min = null, allowNull = false } = {}) {
  if (value == null || `${value}`.trim() === "") {
    return fallback;
  }
  if (allowNull && `${value}`.trim().toLowerCase() === "auto") {
    return null;
  }
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} 값이 올바른 정수가 아닙니다: ${value}`);
  }
  if (min != null && parsed < min) {
    throw new Error(`${fieldName} 값은 ${min} 이상이어야 합니다.`);
  }
  return parsed;
}

function parseFloatSetting(value, fallback, fieldName, { min = null, max = null } = {}) {
  if (value == null || `${value}`.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(`${value}`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} 값이 올바른 숫자가 아닙니다: ${value}`);
  }
  if (min != null && parsed < min) {
    throw new Error(`${fieldName} 값은 ${min} 이상이어야 합니다.`);
  }
  if (max != null && parsed > max) {
    throw new Error(`${fieldName} 값은 ${max} 이하여야 합니다.`);
  }
  return parsed;
}

function runtimeDependenciesInstalled(rootPath) {
  return (
    fs.existsSync(path.join(rootPath, "node_modules", "@morphllm", "morphsdk")) &&
    fs.existsSync(path.join(rootPath, "node_modules", "@honcho-ai", "sdk"))
  );
}

async function installDependencies() {
  async function installDependenciesForRoot(rootPath) {
    if (runtimeDependenciesInstalled(rootPath)) {
      return { rootPath, installed: true, skipped: true };
    }
    const npmCommand = getNpmCommand();
    const result = spawnSync(npmCommand, ["install", "--omit=dev"], {
      cwd: rootPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `npm install 실패 (${rootPath}): ${result.stderr || result.stdout || `exit ${result.status}`}`.trim(),
      );
    }
    return { rootPath, installed: true, skipped: false };
  }

  const installedPluginRoot = getInstalledPluginRoot();
  const roots = [pluginRoot];
  if (installedPluginRoot !== pluginRoot) {
    roots.push(installedPluginRoot);
  }

  const results = [];
  for (const rootPath of roots) {
    results.push(await installDependenciesForRoot(rootPath));
  }

  return {
    installed: true,
    roots: results,
  };
}

async function stopProxyInternal() {
  const { pidFile } = getStatePaths();
  const pid = await readPid();
  if (!pid) {
    await removeIfExists(pidFile);
    return { stopped: false, reason: "pid file not found" };
  }
  if (!isPidAlive(pid)) {
    await removeIfExists(pidFile);
    return { stopped: false, reason: "process already stopped", pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { stopped: false, reason: error instanceof Error ? error.message : String(error), pid };
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isPidAlive(pid)) {
      await removeIfExists(pidFile);
      return { stopped: true, pid };
    }
    await sleep(150);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await removeIfExists(pidFile);
  return { stopped: true, pid, forced: true };
}

function isHealthyProxyCompatible(state, health) {
  if (!health?.ok || !health.body) {
    return false;
  }
  const { stateDir } = getStatePaths();
  return (
    health.body.port === state.proxyPort &&
    health.body.pluginRoot === pluginRoot &&
    health.body.stateDir === stateDir &&
    health.body.upstreamBaseUrl === state.upstreamBaseUrl
  );
}

async function spawnProxy(state) {
  const { logFile, errorLogFile, stateDir } = getStatePaths();
  await ensureDir(path.dirname(logFile));
  const stdoutFd = fs.openSync(logFile, "a");
  const stderrFd = fs.openSync(errorLogFile, "a");
  const child = spawn(
    process.execPath,
    [path.join(pluginRoot, "scripts", "talmor-codex-plugin-compact-proxy.mjs")],
    {
      cwd: pluginRoot,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        TALMOR_CODEX_PLUGIN_STATE_DIR: stateDir,
        TALMOR_CODEX_PLUGIN_PROXY_PORT: String(state.proxyPort),
      },
    },
  );
  child.unref();
  await writePid(child.pid);
  return child.pid;
}

async function ensureProxyRunning() {
  const state = await readState();
  if (!state) {
    return { installed: false, proxyHealthy: false, reason: "state missing" };
  }

  const healthy = await healthcheckProxy(state.proxyPort);
  if (isHealthyProxyCompatible(state, healthy)) {
    return {
      installed: true,
      proxyHealthy: true,
      port: state.proxyPort,
      reused: true,
      health: healthy.body,
    };
  }

  if (healthy.ok) {
    return {
      installed: true,
      proxyHealthy: false,
      port: state.proxyPort,
      reason:
        "같은 포트에 다른 talmor-codex-plugin runtime 또는 다른 상태 디렉터리를 사용하는 runtime이 이미 실행 중입니다.",
      conflictingHealth: healthy.body,
    };
  }

  const pid = await spawnProxy(state);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await healthcheckProxy(state.proxyPort);
    if (status.ok && isHealthyProxyCompatible(state, status)) {
      return {
        installed: true,
        proxyHealthy: true,
        port: state.proxyPort,
        pid,
        reused: false,
        health: status.body,
      };
    }
    await sleep(200);
  }

  return {
    installed: true,
    proxyHealthy: false,
    pid,
    port: state.proxyPort,
    reason: "proxy did not become healthy in time",
  };
}

function buildManagedHookGroup(commandPath, timeoutSec, matcher = undefined) {
  const group = {
    hooks: [
      {
        type: "command",
        command: `node "${commandPath}"`,
        timeout: timeoutSec,
        statusMessage: hooksManagedBy,
      },
    ],
  };
  if (matcher) {
    group.matcher = matcher;
  }
  return group;
}

function pruneManagedGroups(groups) {
  return (Array.isArray(groups) ? groups : []).filter((group) => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    return !hooks.some((hook) => {
      const command = `${hook?.command ?? ""}`;
      return command.includes("talmor-codex-plugin-hook-") || hook?.statusMessage === hooksManagedBy;
    });
  });
}

async function updateHooksFile(honchoEnabled) {
  const hooksPath = getHooksPath();
  const currentText = await readText(hooksPath, "");
  let parsed;
  if (currentText.trim()) {
    try {
      parsed = JSON.parse(currentText);
    } catch (error) {
      throw new Error(`hooks.json 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    parsed = { hooks: {} };
  }

  const next = {
    hooks: {
      ...parsed.hooks,
    },
  };

  for (const eventName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    next.hooks[eventName] = pruneManagedGroups(next.hooks[eventName]);
  }

  if (honchoEnabled) {
    const scriptsDir = path.join(pluginRoot, "scripts");
    next.hooks.SessionStart.push(
      buildManagedHookGroup(path.join(scriptsDir, "talmor-codex-plugin-hook-session-start.mjs"), 20),
    );
    next.hooks.UserPromptSubmit.push(
      buildManagedHookGroup(path.join(scriptsDir, "talmor-codex-plugin-hook-user-prompt.mjs"), 10),
    );
    next.hooks.PostToolUse.push(
      buildManagedHookGroup(path.join(scriptsDir, "talmor-codex-plugin-hook-post-tool-use.mjs"), 10, "Bash"),
    );
    next.hooks.Stop.push(
      buildManagedHookGroup(path.join(scriptsDir, "talmor-codex-plugin-hook-stop.mjs"), 12),
    );
  }

  const hasAnyHooks = Object.values(next.hooks).some((groups) => Array.isArray(groups) && groups.length > 0);
  if (!hasAnyHooks) {
    await removeIfExists(hooksPath);
    return { hooksPath, installed: false };
  }

  await writeText(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return { hooksPath, installed: honchoEnabled };
}

function buildHonchoConfig(args, previous) {
  return {
    ...defaultHonchoConfig,
    ...previous,
    enabled: parseBoolean(args["enable-honcho"], previous?.enabled ?? false),
    workspace:
      firstDefined(args["honcho-workspace"], process.env.HONCHO_WORKSPACE, previous?.workspace) ||
      defaultHonchoConfig.workspace,
    peerName:
      firstDefined(args["honcho-peer-name"], process.env.HONCHO_PEER_NAME, previous?.peerName) ||
      defaultHonchoConfig.peerName,
    aiPeer:
      firstDefined(args["honcho-ai-peer"], process.env.HONCHO_AI_PEER, previous?.aiPeer) ||
      defaultHonchoConfig.aiPeer,
    baseUrl:
      firstDefined(args["honcho-base-url"], process.env.HONCHO_BASE_URL, previous?.baseUrl) ||
      defaultHonchoConfig.baseUrl,
    sessionStrategy:
      firstDefined(
        args["honcho-session-strategy"],
        process.env.HONCHO_SESSION_STRATEGY,
        previous?.sessionStrategy,
      ) || defaultHonchoConfig.sessionStrategy,
    sessionPeerPrefix: parseBoolean(
      firstDefined(args["honcho-session-peer-prefix"], process.env.HONCHO_SESSION_PEER_PREFIX),
      previous?.sessionPeerPrefix ?? defaultHonchoConfig.sessionPeerPrefix,
    ),
    saveMessages: parseBoolean(
      firstDefined(args["honcho-save-messages"], process.env.HONCHO_SAVE_MESSAGES),
      previous?.saveMessages ?? defaultHonchoConfig.saveMessages,
    ),
    reasoningLevel:
      firstDefined(args["honcho-reasoning-level"], process.env.HONCHO_REASONING_LEVEL, previous?.reasoningLevel) ||
      defaultHonchoConfig.reasoningLevel,
    contextTtlSeconds: parseIntegerSetting(
      firstDefined(args["honcho-context-ttl-seconds"], process.env.HONCHO_CONTEXT_TTL_SECONDS),
      previous?.contextTtlSeconds ?? defaultHonchoConfig.contextTtlSeconds,
      "HONCHO_CONTEXT_TTL_SECONDS",
      { min: 1 },
    ),
    maxContextConclusions: parseIntegerSetting(
      firstDefined(
        args["honcho-max-context-conclusions"],
        process.env.HONCHO_MAX_CONTEXT_CONCLUSIONS,
      ),
      previous?.maxContextConclusions ?? defaultHonchoConfig.maxContextConclusions,
      "HONCHO_MAX_CONTEXT_CONCLUSIONS",
      { min: 1 },
    ),
    searchTopK: parseIntegerSetting(
      firstDefined(args["honcho-search-top-k"], process.env.HONCHO_SEARCH_TOP_K),
      previous?.searchTopK ?? defaultHonchoConfig.searchTopK,
      "HONCHO_SEARCH_TOP_K",
      { min: 1 },
    ),
    searchMaxDistance: parseFloatSetting(
      firstDefined(args["honcho-search-max-distance"], process.env.HONCHO_SEARCH_MAX_DISTANCE),
      previous?.searchMaxDistance ?? defaultHonchoConfig.searchMaxDistance,
      "HONCHO_SEARCH_MAX_DISTANCE",
      { min: 0, max: 1 },
    ),
    maxSessionMessages: parseIntegerSetting(
      firstDefined(args["honcho-max-session-messages"], process.env.HONCHO_MAX_SESSION_MESSAGES),
      previous?.maxSessionMessages ?? defaultHonchoConfig.maxSessionMessages,
      "HONCHO_MAX_SESSION_MESSAGES",
      { min: 1 },
    ),
  };
}

function buildMorphConfig(args, previous) {
  return {
    ...defaultMorphConfig,
    ...previous,
    compactEnabled: parseBoolean(
      firstDefined(args["morph-compact"], process.env.MORPH_COMPACT),
      previous?.compactEnabled ?? defaultMorphConfig.compactEnabled,
    ),
    compactTokenLimit: parseIntegerSetting(
      firstDefined(args["morph-compact-token-limit"], process.env.MORPH_COMPACT_TOKEN_LIMIT),
      previous?.compactTokenLimit ?? defaultMorphConfig.compactTokenLimit,
      "MORPH_COMPACT_TOKEN_LIMIT",
      { min: 1, allowNull: true },
    ),
    compactContextThreshold: parseFloatSetting(
      firstDefined(
        args["morph-compact-context-threshold"],
        process.env.MORPH_COMPACT_CONTEXT_THRESHOLD,
      ),
      previous?.compactContextThreshold ?? defaultMorphConfig.compactContextThreshold,
      "MORPH_COMPACT_CONTEXT_THRESHOLD",
      { min: 0.05, max: 1 },
    ),
    compactPreserveRecent: parseIntegerSetting(
      firstDefined(args["morph-compact-preserve-recent"], process.env.MORPH_COMPACT_PRESERVE_RECENT),
      previous?.compactPreserveRecent ?? defaultMorphConfig.compactPreserveRecent,
      "MORPH_COMPACT_PRESERVE_RECENT",
      { min: 0 },
    ),
    compactRatio: parseFloatSetting(
      firstDefined(args["morph-compact-ratio"], process.env.MORPH_COMPACT_RATIO),
      previous?.compactRatio ?? defaultMorphConfig.compactRatio,
      "MORPH_COMPACT_RATIO",
      { min: 0.05, max: 1 },
    ),
    editEnabled: parseBoolean(
      firstDefined(args["morph-edit"], process.env.MORPH_EDIT),
      previous?.editEnabled ?? defaultMorphConfig.editEnabled,
    ),
    warpGrepEnabled: parseBoolean(
      firstDefined(args["morph-warpgrep"], process.env.MORPH_WARPGREP),
      previous?.warpGrepEnabled ?? defaultMorphConfig.warpGrepEnabled,
    ),
    warpGrepGithubEnabled: parseBoolean(
      firstDefined(args["morph-warpgrep-github"], process.env.MORPH_WARPGREP_GITHUB),
      previous?.warpGrepGithubEnabled ?? defaultMorphConfig.warpGrepGithubEnabled,
    ),
  };
}

async function installManagedInstructions(honchoEnabled) {
  const currentConfig = await readCurrentConfig();
  const morphText = (await readInstructionFile("instructions/morph-routing.md")).trim();
  const nextConfigText = cleanupManagedConfigText(upsertDeveloperInstructions(currentConfig.text, morphText));
  await writeConfigText(nextConfigText ? `${nextConfigText}\n` : "");

  const agentsPath = getAgentsOverridePath();
  const currentAgents = await readText(agentsPath, "");
  if (honchoEnabled) {
    const honchoText = (await readInstructionFile("instructions/honcho-memory-policy.md")).trim();
    const nextAgents = currentAgents.includes(honchoManagedBegin)
      ? `${removeManagedBlock(currentAgents, honchoManagedBegin, honchoManagedEnd).trimEnd()}\n\n${honchoManagedBegin}\n${honchoText}\n${honchoManagedEnd}\n`
      : `${currentAgents.trimEnd() ? `${currentAgents.trimEnd()}\n\n` : ""}${honchoManagedBegin}\n${honchoText}\n${honchoManagedEnd}\n`;
    await writeText(agentsPath, nextAgents, 0o600);
  } else if (currentAgents.includes(honchoManagedBegin)) {
    const nextAgents = removeManagedBlock(currentAgents, honchoManagedBegin, honchoManagedEnd);
    if (nextAgents.trim()) {
      await writeText(agentsPath, `${nextAgents.trimEnd()}\n`, 0o600);
    } else {
      await removeIfExists(agentsPath);
    }
  }

  return {
    configPath: currentConfig.configPath,
    agentsPath,
  };
}

async function readInstructionStatus() {
  const config = await readCurrentConfig();
  const agentsText = await readText(getAgentsOverridePath(), "");
  return {
    developerInstructionsInstalled:
      typeof config.developerInstructions === "string" &&
      config.developerInstructions.includes(morphManagedBegin) &&
      config.developerInstructions.includes(morphManagedEnd),
    honchoAgentsInstalled:
      agentsText.includes(honchoManagedBegin) && agentsText.includes(honchoManagedEnd),
  };
}

async function installCommand(args) {
  const existingCredentials = await readCredentials();
  const morphApiKey = args["morph-api-key"] || process.env.MORPH_API_KEY || existingCredentials?.morphApiKey;
  if (!morphApiKey) {
    throw new Error("Morph API 키가 없습니다. --morph-api-key 또는 MORPH_API_KEY 를 제공하세요.");
  }

  const currentConfig = await readCurrentConfig();
  const previousState = await readState();
  const previousMorphConfig = await readMorphConfig();
  const previousHonchoConfig = await readHonchoConfig();

  const honchoApiKey =
    args["honcho-api-key"] ||
    process.env.HONCHO_API_KEY ||
    existingCredentials?.honchoApiKey ||
    null;
  const explicitHonchoEnable = args["enable-honcho"] != null || process.env.HONCHO_ENABLED != null;
  const honchoEnabled = explicitHonchoEnable
    ? parseBoolean(firstDefined(args["enable-honcho"], process.env.HONCHO_ENABLED), false)
    : Boolean(honchoApiKey || previousHonchoConfig?.enabled);

  if (honchoEnabled && !honchoApiKey) {
    throw new Error("Honcho를 활성화하려면 --honcho-api-key 또는 HONCHO_API_KEY 가 필요합니다.");
  }

  const proxyPort = normalizePort(args.port || previousState?.proxyPort || defaultProxyPort);
  const expectedProxyBaseUrl = proxyBaseUrl(proxyPort);
  const currentOpenaiBaseUrl = currentConfig.openaiBaseUrl;

  let upstreamBaseUrl =
    args["upstream-base-url"] ||
    previousState?.upstreamBaseUrl ||
    currentOpenaiBaseUrl ||
    defaultUpstreamBaseUrl;

  if (currentOpenaiBaseUrl === expectedProxyBaseUrl && previousState?.backupOpenaiBaseUrl) {
    upstreamBaseUrl = previousState.backupOpenaiBaseUrl || defaultUpstreamBaseUrl;
  }

  const managedInsertion = currentOpenaiBaseUrl == null;
  let nextConfigText = setTopLevelStringValue(currentConfig.text, "openai_base_url", expectedProxyBaseUrl);
  nextConfigText = upsertPluginEnabled(nextConfigText, true, managedPluginConfigName);
  const nextState = {
    installedAt: previousState?.installedAt || nowIso(),
    updatedAt: nowIso(),
    proxyPort,
    proxyBaseUrl: expectedProxyBaseUrl,
    upstreamBaseUrl,
    backupOpenaiBaseUrl:
      previousState?.backupOpenaiBaseUrl ??
      (currentOpenaiBaseUrl === expectedProxyBaseUrl ? null : currentOpenaiBaseUrl),
    hadOpenaiBaseUrl: previousState?.hadOpenaiBaseUrl ?? currentOpenaiBaseUrl != null,
    managedInsertion: previousState?.managedInsertion ?? managedInsertion,
    failOpen: true,
    honchoEnabled,
  };

  const honchoConfig = buildHonchoConfig(args, previousHonchoConfig);
  honchoConfig.enabled = honchoEnabled;
  const morphConfig = buildMorphConfig(args, previousMorphConfig);

  const cacheSync = await syncPluginIntoCodexCache();
  const dependencyStatus = await installDependencies();
  await writeState(nextState);
  await writeCredentials({
    morphApiKey,
    honchoApiKey,
    updatedAt: nowIso(),
  });
  await writeMorphConfig(morphConfig);
  await writeHonchoConfig(honchoConfig);

  const proxyStatus = await ensureProxyRunning();
  if (!proxyStatus.proxyHealthy) {
    throw new Error(proxyStatus.reason || "proxy를 정상적으로 시작하지 못했습니다.");
  }

  await writeConfigText(nextConfigText);
  await installManagedInstructions(honchoEnabled);
  const hooksStatus = await updateHooksFile(honchoEnabled);
  const instructionStatus = await readInstructionStatus();

  return {
    ok: true,
    configPath: currentConfig.configPath,
    expectedProxyBaseUrl,
    upstreamBaseUrl,
    morphConfig,
    dependencyStatus,
    cacheSync,
    proxyStatus,
    honchoEnabled,
    hooksStatus,
    instructionStatus,
    pluginEnabled: true,
    restartRecommended: true,
    message:
      "설치와 plugin 활성화가 완료되었습니다. 현재 실행 중인 Codex 세션에는 기존 설정이 남아 있을 수 있으므로 재시작을 권장합니다.",
  };
}

async function configureCommand(args) {
  const existingCredentials = await readCredentials();
  const previousMorphConfig = await readMorphConfig();
  const previousHonchoConfig = await readHonchoConfig();

  const morphApiKey = args["morph-api-key"] || process.env.MORPH_API_KEY || existingCredentials?.morphApiKey;
  if (!morphApiKey) {
    throw new Error("Morph API 키가 없습니다. --morph-api-key 또는 MORPH_API_KEY 를 제공하세요.");
  }

  const honchoApiKey =
    args["honcho-api-key"] ||
    process.env.HONCHO_API_KEY ||
    existingCredentials?.honchoApiKey ||
    null;
  const explicitHonchoEnable = args["enable-honcho"] != null || process.env.HONCHO_ENABLED != null;
  const honchoEnabled = explicitHonchoEnable
    ? parseBoolean(firstDefined(args["enable-honcho"], process.env.HONCHO_ENABLED), false)
    : Boolean(honchoApiKey || previousHonchoConfig?.enabled);

  if (honchoEnabled && !honchoApiKey) {
    throw new Error("Honcho를 활성화하려면 --honcho-api-key 또는 HONCHO_API_KEY 가 필요합니다.");
  }

  const nextCredentials = {
    ...existingCredentials,
    morphApiKey,
    honchoApiKey,
    updatedAt: nowIso(),
  };
  const morphConfig = buildMorphConfig(args, previousMorphConfig);
  const honchoConfig = buildHonchoConfig(
    {
      ...args,
      "enable-honcho": honchoEnabled,
    },
    previousHonchoConfig,
  );
  honchoConfig.enabled = honchoEnabled;

  await writeCredentials(nextCredentials);
  await writeMorphConfig(morphConfig);
  await writeHonchoConfig(honchoConfig);

  return {
    ok: true,
    configuredAt: nowIso(),
    hasMorphApiKey: Boolean(nextCredentials.morphApiKey),
    hasHonchoApiKey: Boolean(nextCredentials.honchoApiKey),
    honchoEnabled,
    morphConfig,
    honchoConfig,
    message:
      "설정값이 저장되었습니다. bootstrap-only 설치 흐름에서는 이후 install 단계에서 이 값을 자동으로 사용합니다.",
  };
}

async function statusCommand() {
  const currentConfig = await readCurrentConfig();
  const state = await readState();
  const credentials = await readCredentials();
  const morphConfig = await readMorphConfig();
  const honchoConfig = await readHonchoConfig();
  const pid = await readPid();
  const proxyHealthy = state ? await healthcheckProxy(state.proxyPort) : { ok: false };
  const instructionStatus = await readInstructionStatus();
  const hooksPath = getHooksPath();
  const hooksText = await readText(hooksPath, "");

  return {
    ok: true,
    installed: Boolean(state),
    pluginRoot,
    cachePluginRoot: getInstalledPluginRoot(),
    configPath: currentConfig.configPath,
    hooksPath,
    agentsOverridePath: getAgentsOverridePath(),
    currentOpenaiBaseUrl: currentConfig.openaiBaseUrl,
    pluginEnabled: currentConfig.pluginEnabled,
    state,
    morphConfig,
    honchoConfig,
    hasMorphApiKey: Boolean(credentials?.morphApiKey),
    hasHonchoApiKey: Boolean(credentials?.honchoApiKey),
    hasMorphSdkInstalled: runtimeDependenciesInstalled(pluginRoot),
    hasHonchoSdkInstalled: runtimeDependenciesInstalled(pluginRoot),
    cacheMorphSdkInstalled: runtimeDependenciesInstalled(getInstalledPluginRoot()),
    cacheHonchoSdkInstalled: runtimeDependenciesInstalled(getInstalledPluginRoot()),
    pid,
    pidAlive: isPidAlive(pid),
    proxyHealthy,
    instructionStatus,
    hooksInstalled: hooksText.includes("talmor-codex-plugin-hook-"),
  };
}

async function uninstallCommand() {
  const currentConfig = await readCurrentConfig();
  const state = await readState();
  const stopStatus = await stopProxyInternal();

  let nextConfig = removeManagedDeveloperInstructions(currentConfig.text);
  nextConfig = removePluginSection(nextConfig, managedPluginConfigName);
  let restored = false;
  if (state) {
    const expectedProxyBaseUrl = proxyBaseUrl(state.proxyPort || defaultProxyPort);
    if (currentConfig.openaiBaseUrl === expectedProxyBaseUrl) {
      if (state.hadOpenaiBaseUrl && state.backupOpenaiBaseUrl) {
        nextConfig = setTopLevelStringValue(nextConfig, "openai_base_url", state.backupOpenaiBaseUrl);
      } else {
        nextConfig = removeTopLevelStringValue(nextConfig, "openai_base_url");
      }
      restored = true;
    }
  }
  nextConfig = cleanupManagedConfigText(nextConfig);
  await writeConfigText(nextConfig ? `${nextConfig}\n` : "");

  const agentsPath = getAgentsOverridePath();
  const agentsText = await readText(agentsPath, "");
  if (agentsText.includes(honchoManagedBegin)) {
    const nextAgents = removeManagedBlock(agentsText, honchoManagedBegin, honchoManagedEnd);
    if (nextAgents.trim()) {
      await writeText(agentsPath, `${nextAgents.trimEnd()}\n`, 0o600);
    } else {
      await removeIfExists(agentsPath);
    }
  }

  const hooksStatus = await updateHooksFile(false);
  const { stateFile, credentialsFile, morphConfigFile } = getStatePaths();
  await removeIfExists(stateFile);
  await removeIfExists(credentialsFile);
  await removeIfExists(morphConfigFile);
  await clearHonchoArtifacts();

  return {
    ok: true,
    restoredConfig: restored,
    hooksStatus,
    stopStatus,
    pluginEnabled: false,
    restartRecommended: true,
    message:
      "제거가 완료되었습니다. plugin 활성화 해제와 openai_base_url 및 주입된 지침 변경을 확실히 반영하려면 Codex를 재시작하는 것이 안전합니다.",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "status";

  let result;
  switch (command) {
    case "install":
      result = await installCommand(args);
      break;
    case "status":
      result = await statusCommand();
      break;
    case "configure":
      result = await configureCommand(args);
      break;
    case "ensure-proxy":
      result = await ensureProxyRunning();
      break;
    case "restart-proxy":
      await stopProxyInternal();
      result = await ensureProxyRunning();
      break;
    case "stop-proxy":
      result = await stopProxyInternal();
      break;
    case "uninstall":
      result = await uninstallCommand();
      break;
    default:
      throw new Error(`지원하지 않는 명령입니다: ${command}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
