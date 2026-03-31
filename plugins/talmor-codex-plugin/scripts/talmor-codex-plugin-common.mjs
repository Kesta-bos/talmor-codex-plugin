import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const pluginRoot = path.dirname(__dirname);
export const packageJsonPath = path.join(pluginRoot, "package.json");
export const homeMarketplaceName = "home-marketplace";
export const managedPluginName = "talmor-codex-plugin";
export const managedPluginConfigName = `talmor-codex-plugin@${homeMarketplaceName}`;

export const defaultProxyPort = 4319;
export const defaultUpstreamBaseUrl = "https://api.openai.com/v1";
export const defaultHonchoBaseUrl = "https://api.honcho.dev/v3";
export const defaultMorphConfig = Object.freeze({
  compactEnabled: true,
  compactTokenLimit: null,
  compactContextThreshold: 0.7,
  compactPreserveRecent: 3,
  compactRatio: 0.3,
  editEnabled: true,
  warpGrepEnabled: true,
  warpGrepGithubEnabled: true,
});
export const summaryPrefix =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const proxyManagedComment = "# Managed by talmor-codex-plugin";
export const morphManagedBegin = "# TALMOR_CODEX_PLUGIN_MORPH_ROUTING_BEGIN";
export const morphManagedEnd = "# TALMOR_CODEX_PLUGIN_MORPH_ROUTING_END";
export const honchoManagedBegin = "<!-- TALMOR_CODEX_PLUGIN_HONCHO_MEMORY_BEGIN -->";
export const honchoManagedEnd = "<!-- TALMOR_CODEX_PLUGIN_HONCHO_MEMORY_END -->";
export const hooksManagedBy = "talmor-codex-plugin";
export const defaultHonchoConfig = Object.freeze({
  enabled: false,
  workspace: "talmor_codex_plugin",
  peerName: os.userInfo().username || process.env.USER || "user",
  aiPeer: "codex",
  baseUrl: defaultHonchoBaseUrl,
  sessionStrategy: "per-directory",
  sessionPeerPrefix: true,
  saveMessages: true,
  reasoningLevel: "low",
  contextTtlSeconds: 300,
  maxContextConclusions: 12,
  searchTopK: 5,
  searchMaxDistance: 0.7,
  maxSessionMessages: 10,
});

export function getCodexHome() {
  const raw = process.env.CODEX_HOME;
  if (raw && raw.trim()) {
    return raw;
  }
  return path.join(os.homedir(), ".codex");
}

export function getStateDir() {
  if (process.env.TALMOR_CODEX_PLUGIN_STATE_DIR) {
    return process.env.TALMOR_CODEX_PLUGIN_STATE_DIR;
  }
  return path.join(getCodexHome(), "talmor-codex-plugin");
}

export function getConfigPath() {
  return path.join(getCodexHome(), "config.toml");
}

export function getPluginCacheBaseDir() {
  return path.join(getCodexHome(), "plugins", "cache", homeMarketplaceName, managedPluginName);
}

export function getInstalledPluginRoot() {
  return path.join(getPluginCacheBaseDir(), "local");
}

export function resolveNodeExecutable() {
  if (process.execPath && path.isAbsolute(process.execPath)) {
    return process.execPath;
  }

  const result = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const resolved = `${result.stdout ?? ""}`.trim();
  if (result.status === 0 && resolved && path.isAbsolute(resolved)) {
    return resolved;
  }

  return "node";
}

async function rewritePluginMcpConfigCommand(targetPluginRoot) {
  const mcpConfigPath = path.join(targetPluginRoot, ".mcp.json");
  const current = await readJson(mcpConfigPath, null);
  if (!current || typeof current !== "object" || !current.mcpServers || typeof current.mcpServers !== "object") {
    return;
  }

  const server = current.mcpServers.talmor_codex_plugin_runtime;
  if (!server || typeof server !== "object") {
    return;
  }

  const next = {
    ...current,
    mcpServers: {
      ...current.mcpServers,
      talmor_codex_plugin_runtime: {
        ...server,
        command: resolveNodeExecutable(),
      },
    },
  };
  await writeJson(mcpConfigPath, next);
}

export function getHooksPath() {
  return path.join(getCodexHome(), "hooks.json");
}

export function getAgentsOverridePath() {
  return path.join(getCodexHome(), "AGENTS.override.md");
}

export function getStatePaths() {
  const stateDir = getStateDir();
  return {
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    credentialsFile: path.join(stateDir, "credentials.json"),
    morphConfigFile: path.join(stateDir, "morph-config.json"),
    pidFile: path.join(stateDir, "proxy.pid"),
    logFile: path.join(stateDir, "proxy.log"),
    errorLogFile: path.join(stateDir, "proxy.err.log"),
    honchoConfigFile: path.join(stateDir, "honcho-config.json"),
    honchoQueueFile: path.join(stateDir, "honcho-queue.json"),
    honchoCacheFile: path.join(stateDir, "honcho-cache.json"),
    sessionStateFile: path.join(stateDir, "session-state.json"),
  };
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function copyDirRecursive(sourceDir, targetDir, shouldSkip) {
  await ensureDir(targetDir);
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (shouldSkip(sourcePath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyDirRecursive(sourcePath, targetPath, shouldSkip);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(sourcePath);
      await fsp.symlink(linkTarget, targetPath);
      continue;
    }
    await ensureDir(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  }
}

export async function syncPluginIntoCodexCache() {
  const cacheBaseDir = getPluginCacheBaseDir();
  const installedPluginRoot = getInstalledPluginRoot();
  const tempRoot = path.join(cacheBaseDir, `local.tmp-${process.pid}-${Date.now()}`);

  await ensureDir(cacheBaseDir);
  await fsp.rm(tempRoot, { recursive: true, force: true });

  const shouldSkip = (sourcePath, entry) => {
    if (entry.name === ".git" || entry.name === "node_modules") {
      return true;
    }
    if (sourcePath.startsWith(path.join(pluginRoot, "docs"))) {
      return false;
    }
    return false;
  };

  await copyDirRecursive(pluginRoot, tempRoot, shouldSkip);
  await rewritePluginMcpConfigCommand(tempRoot);
  await fsp.rm(installedPluginRoot, { recursive: true, force: true });
  await fsp.rename(tempRoot, installedPluginRoot);

  return {
    cacheBaseDir,
    installedPluginRoot,
  };
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value, mode = 0o600) {
  const tmpFile = `${filePath}.tmp-${process.pid}`;
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.rename(tmpFile, filePath);
  try {
    await fsp.chmod(filePath, mode);
  } catch {}
}

export async function removeIfExists(filePath) {
  try {
    await fsp.rm(filePath, { force: true, recursive: false });
  } catch {}
}

export async function readText(filePath, fallback = "") {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeText(filePath, value, mode = 0o600) {
  const tmpFile = `${filePath}.tmp-${process.pid}`;
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(tmpFile, value, { mode });
  await fsp.rename(tmpFile, filePath);
  try {
    await fsp.chmod(filePath, mode);
  } catch {}
}

function decodeTomlInlineString(rawValue) {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function findTopLevelAssignmentRange(tomlText, key) {
  const regex = new RegExp(`^${escapeRegex(key)}\\s*=\\s*`, "m");
  const match = regex.exec(tomlText);
  if (!match) {
    return null;
  }

  const start = match.index;
  const valueStart = start + match[0].length;
  const rest = tomlText.slice(valueStart);

  if (rest.startsWith('"""') || rest.startsWith("'''")) {
    const delimiter = rest.slice(0, 3);
    const endMarkerIndex = rest.indexOf(delimiter, 3);
    if (endMarkerIndex === -1) {
      return null;
    }
    const rawValue = rest.slice(0, endMarkerIndex + 3);
    const end = valueStart + endMarkerIndex + 3;
    const lineEnd = tomlText.indexOf("\n", end);
    return {
      start,
      end: lineEnd === -1 ? tomlText.length : lineEnd + 1,
      value: rawValue,
      multiline: true,
      delimiter,
    };
  }

  const lineEnd = tomlText.indexOf("\n", valueStart);
  const end = lineEnd === -1 ? tomlText.length : lineEnd + 1;
  return {
    start,
    end,
    value: tomlText.slice(valueStart, lineEnd === -1 ? tomlText.length : lineEnd),
    multiline: false,
    delimiter: null,
  };
}

function decodeTomlAssignmentValue(range) {
  if (!range) {
    return null;
  }
  if (!range.multiline) {
    return decodeTomlInlineString(range.value);
  }
  const raw = range.value;
  const delimiter = range.delimiter;
  if (!delimiter) {
    return raw;
  }
  return raw.slice(3, -3).replace(/^\n/, "").replace(/\n$/, "");
}

export function parseTopLevelStringValue(tomlText, key) {
  return decodeTomlAssignmentValue(findTopLevelAssignmentRange(tomlText, key));
}

function renderTomlInlineString(key, value) {
  return `${key} = ${JSON.stringify(value)}`;
}

function renderTomlMultilineString(key, value) {
  const escaped = `${value}`.replace(/"""/g, '\\"""');
  return `${key} = """\n${escaped}\n"""`;
}

export function setTopLevelStringValue(tomlText, key, value) {
  const rendered = renderTomlInlineString(key, value);
  const range = findTopLevelAssignmentRange(tomlText, key);
  if (range) {
    return `${tomlText.slice(0, range.start)}${rendered}\n${tomlText.slice(range.end)}`;
  }

  const trimmed = tomlText.trimEnd();
  if (!trimmed) {
    return `${proxyManagedComment}\n${rendered}\n`;
  }
  return `${trimmed}\n\n${proxyManagedComment}\n${rendered}\n`;
}

export function removeTopLevelStringValue(tomlText, key) {
  const range = findTopLevelAssignmentRange(tomlText, key);
  if (!range) {
    return tomlText;
  }
  let start = range.start;
  const before = tomlText.slice(0, start);
  const lines = before.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.trim() === proxyManagedComment) {
    start -= lastLine.length + 1;
  }
  return `${tomlText.slice(0, start)}${tomlText.slice(range.end)}`.replace(/\n{3,}/g, "\n\n");
}

function findNamedTableRange(tomlText, header) {
  const regex = new RegExp(`^${escapeRegex(header)}\\s*$`, "m");
  const match = regex.exec(tomlText);
  if (!match) {
    return null;
  }

  const start = match.index;
  const firstLineEnd = tomlText.indexOf("\n", start);
  if (firstLineEnd === -1) {
    return { start, end: tomlText.length, body: "" };
  }

  const bodyStart = firstLineEnd + 1;
  const remainder = tomlText.slice(bodyStart);
  const nextSectionMatch = /^\[[^\n]+\]\s*$/m.exec(remainder);
  const end = nextSectionMatch ? bodyStart + nextSectionMatch.index : tomlText.length;
  return {
    start,
    end,
    body: tomlText.slice(bodyStart, end),
  };
}

export function parsePluginEnabled(tomlText, pluginConfigName = managedPluginConfigName) {
  const header = `[plugins."${pluginConfigName}"]`;
  const range = findNamedTableRange(tomlText, header);
  if (!range) {
    return null;
  }
  const match = /^enabled\s*=\s*(true|false)\s*$/m.exec(range.body);
  if (!match) {
    return null;
  }
  return match[1] === "true";
}

export function upsertPluginEnabled(tomlText, enabled, pluginConfigName = managedPluginConfigName) {
  const header = `[plugins."${pluginConfigName}"]`;
  const renderedBody = `enabled = ${enabled ? "true" : "false"}\n`;
  const range = findNamedTableRange(tomlText, header);
  if (range) {
    const nextBody = /^enabled\s*=.*$/m.test(range.body)
      ? range.body.replace(/^enabled\s*=.*$/m, renderedBody.trimEnd())
      : `${range.body.trimEnd()}\n${renderedBody}`.replace(/^\n/, "");
    return `${tomlText.slice(0, range.start)}${header}\n${nextBody.replace(/\n*$/, "\n")}${tomlText.slice(range.end)}`;
  }

  const trimmed = tomlText.trimEnd();
  const block = `${proxyManagedComment}\n${header}\n${renderedBody}`;
  if (!trimmed) {
    return `${block}`;
  }
  return `${trimmed}\n\n${block}`;
}

export function removePluginSection(tomlText, pluginConfigName = managedPluginConfigName) {
  const header = `[plugins."${pluginConfigName}"]`;
  const range = findNamedTableRange(tomlText, header);
  if (!range) {
    return tomlText;
  }

  let start = range.start;
  const before = tomlText.slice(0, start);
  const lines = before.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.trim() === proxyManagedComment) {
    start -= lastLine.length + 1;
  }

  return `${tomlText.slice(0, start)}${tomlText.slice(range.end)}`.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function cleanupManagedConfigText(tomlText) {
  return `${tomlText ?? ""}`
    .replace(new RegExp(`^${escapeRegex(proxyManagedComment)}\\s*$\\n?`, "gm"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mergeManagedBlock(existingText, blockText, beginMarker, endMarker) {
  const cleaned = removeManagedBlock(existingText, beginMarker, endMarker).trimEnd();
  if (!blockText.trim()) {
    return cleaned;
  }
  const managedBlock = `${beginMarker}\n${blockText.trim()}\n${endMarker}`;
  if (!cleaned) {
    return `${managedBlock}\n`;
  }
  return `${cleaned}\n\n${managedBlock}\n`;
}

export function removeManagedBlock(existingText, beginMarker, endMarker) {
  const pattern = new RegExp(
    `${escapeRegex(beginMarker)}[\\s\\S]*?${escapeRegex(endMarker)}\\n?`,
    "g",
  );
  return `${existingText ?? ""}`.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function upsertDeveloperInstructions(tomlText, managedBlockText) {
  const current = parseTopLevelStringValue(tomlText, "developer_instructions") ?? "";
  const nextValue = mergeManagedBlock(current, managedBlockText, morphManagedBegin, morphManagedEnd).trim();
  if (!nextValue) {
    return removeTopLevelStringValue(tomlText, "developer_instructions");
  }

  const rendered = renderTomlMultilineString("developer_instructions", nextValue);
  const range = findTopLevelAssignmentRange(tomlText, "developer_instructions");
  if (range) {
    return `${tomlText.slice(0, range.start)}${rendered}\n${tomlText.slice(range.end)}`;
  }

  const trimmed = tomlText.trimEnd();
  if (!trimmed) {
    return `${proxyManagedComment}\n${rendered}\n`;
  }
  return `${trimmed}\n\n${proxyManagedComment}\n${rendered}\n`;
}

export function removeManagedDeveloperInstructions(tomlText) {
  const current = parseTopLevelStringValue(tomlText, "developer_instructions");
  if (current == null) {
    return tomlText;
  }
  const nextValue = removeManagedBlock(current, morphManagedBegin, morphManagedEnd).trim();
  if (!nextValue) {
    return removeTopLevelStringValue(tomlText, "developer_instructions");
  }
  const rendered = renderTomlMultilineString("developer_instructions", nextValue);
  const range = findTopLevelAssignmentRange(tomlText, "developer_instructions");
  return `${tomlText.slice(0, range.start)}${rendered}\n${tomlText.slice(range.end)}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function writeConfigText(tomlText) {
  await writeText(getConfigPath(), tomlText, 0o600);
}

export async function readState() {
  return readJson(getStatePaths().stateFile, null);
}

export async function readCredentials() {
  return readJson(getStatePaths().credentialsFile, null);
}

export async function readMorphConfig() {
  const raw = (await readJson(getStatePaths().morphConfigFile, {})) || {};
  return {
    ...defaultMorphConfig,
    ...raw,
  };
}

export async function readHonchoConfig() {
  const raw = (await readJson(getStatePaths().honchoConfigFile, {})) || {};
  return {
    ...defaultHonchoConfig,
    ...raw,
  };
}

export async function readHonchoQueue() {
  return (await readJson(getStatePaths().honchoQueueFile, { messages: [] })) || { messages: [] };
}

export async function readHonchoCache() {
  return (await readJson(getStatePaths().honchoCacheFile, {})) || {};
}

export async function readSessionState() {
  return (await readJson(getStatePaths().sessionStateFile, {})) || {};
}

export async function writeState(state) {
  await writeJson(getStatePaths().stateFile, state);
}

export async function writeCredentials(credentials) {
  await writeJson(getStatePaths().credentialsFile, credentials);
}

export async function writeMorphConfig(config) {
  await writeJson(getStatePaths().morphConfigFile, config);
}

export async function writeHonchoConfig(config) {
  await writeJson(getStatePaths().honchoConfigFile, config);
}

export async function writeHonchoQueue(queue) {
  await writeJson(getStatePaths().honchoQueueFile, queue);
}

export async function writeHonchoCache(cache) {
  await writeJson(getStatePaths().honchoCacheFile, cache);
}

export async function writeSessionState(sessionState) {
  await writeJson(getStatePaths().sessionStateFile, sessionState);
}

export async function clearHonchoArtifacts() {
  const { honchoConfigFile, honchoQueueFile, honchoCacheFile, sessionStateFile } = getStatePaths();
  await removeIfExists(honchoConfigFile);
  await removeIfExists(honchoQueueFile);
  await removeIfExists(honchoCacheFile);
  await removeIfExists(sessionStateFile);
}

export function proxyBaseUrl(port) {
  return `http://127.0.0.1:${port}/v1`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function getPidFromFile(text) {
  const trimmed = `${text ?? ""}`.trim();
  if (!trimmed) {
    return null;
  }
  const pid = Number.parseInt(trimmed, 10);
  return Number.isFinite(pid) ? pid : null;
}

export async function readPid() {
  return getPidFromFile(await readText(getStatePaths().pidFile, ""));
}

export async function writePid(pid) {
  await writeText(getStatePaths().pidFile, `${pid}\n`, 0o600);
}

export function isPidAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizePort(rawValue) {
  if (!rawValue) {
    return defaultProxyPort;
  }
  const port = Number.parseInt(`${rawValue}`, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`유효하지 않은 포트입니다: ${rawValue}`);
  }
  return port;
}

export async function healthcheckProxy(port, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function truncateText(value, maxLength = 8000) {
  const text = `${value ?? ""}`;
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

export function extractContentText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if ((item.type === "input_text" || item.type === "output_text" || item.type === "text") && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

export function summarizeResponseItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.type === "message") {
    return extractContentText(item.content);
  }
  if (item.type === "function_call" && typeof item.name === "string") {
    return `[function_call:${item.name}]\n${truncateText(item.arguments ?? "", 6000)}`;
  }
  if (item.type === "compaction_summary" && typeof item.encrypted_content === "string") {
    return item.encrypted_content;
  }
  return truncateText(JSON.stringify(item, null, 2), 6000);
}

export function responseItemsToMorphMessages(items, instructions = "") {
  const messages = [];
  if (instructions && instructions.trim()) {
    messages.push({
      role: "assistant",
      content: `[Developer instructions]\n${instructions.trim()}`,
    });
  }

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = summarizeResponseItem(item);
    if (!content) {
      continue;
    }
    let role = "assistant";
    if (item.type === "message" && typeof item.role === "string") {
      role = item.role === "user" ? "user" : "assistant";
    }
    messages.push({ role, content });
  }

  return messages;
}

export function findLastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index].content;
    }
  }
  return undefined;
}

export function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

export function hasMorphSdkInstalled() {
  return fs.existsSync(path.join(pluginRoot, "node_modules", "@morphllm", "morphsdk", "package.json"));
}

export function hasHonchoSdkInstalled() {
  return fs.existsSync(path.join(pluginRoot, "node_modules", "@honcho-ai", "sdk", "package.json"));
}

export function sanitizeSessionName(value) {
  return `${value ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

export function getGitBranch(cwd) {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    const branch = result.stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export function computeHonchoSessionName(config, cwd, sessionId = null) {
  const baseName = sanitizeSessionName(path.basename(cwd || "workspace") || "workspace");
  const strategy = config.sessionStrategy || "per-directory";
  let detail = baseName;

  if (strategy === "git-branch") {
    const branch = getGitBranch(cwd);
    if (branch) {
      detail = sanitizeSessionName(`${baseName}-${branch}`);
    }
  } else if (strategy === "chat-instance" && sessionId) {
    detail = sanitizeSessionName(`${baseName}-${sessionId.slice(0, 12)}`);
  }

  if (config.sessionPeerPrefix !== false) {
    return sanitizeSessionName(`${config.peerName}-${detail}`);
  }
  return detail;
}

export function buildHonchoClientOptions(config, credentials) {
  const apiKey = credentials?.honchoApiKey;
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    baseUrl: config.baseUrl || defaultHonchoBaseUrl,
  };
}

export function formatHonchoContext(context, peerName) {
  if (!context || typeof context !== "object") {
    return "";
  }

  const sections = [];
  const representation = typeof context.representation === "string" ? context.representation.trim() : "";
  const peerCard = Array.isArray(context.peerCard)
    ? context.peerCard.map((item) => `${item}`.trim()).filter(Boolean)
    : [];

  if (peerCard.length > 0) {
    sections.push(`[${peerName} profile]\n${peerCard.join("\n")}`);
  }
  if (representation) {
    sections.push(`[${peerName} conclusions]\n${representation}`);
  }
  return sections.join("\n\n").trim();
}

export function formatSessionSummary(summary) {
  const content = summary?.shortSummary?.content || summary?.content || "";
  return `${content}`.trim();
}

export function formatMemoryAnchor({ config, sessionName, userContext, aiContext, sessionSummary }) {
  const sections = [
    "## HONCHO MEMORY ANCHOR",
    `- workspace: ${config.workspace}`,
    `- session: ${sessionName}`,
    `- user: ${config.peerName}`,
    `- ai: ${config.aiPeer}`,
  ];

  const userText = formatHonchoContext(userContext, config.peerName);
  const aiText = formatHonchoContext(aiContext, config.aiPeer);
  const summaryText = formatSessionSummary(sessionSummary);

  if (userText) {
    sections.push(`### Preserve user memory\n${userText}`);
  }
  if (aiText) {
    sections.push(`### Preserve assistant work state\n${aiText}`);
  }
  if (summaryText) {
    sections.push(`### Preserve session summary\n${summaryText}`);
  }
  sections.push("Keep the above memory intact when summarizing older context.");
  return sections.join("\n\n").trim();
}

export function buildCompactMessagesWithMemory(messages, memoryAnchor) {
  if (!memoryAnchor?.trim()) {
    return messages;
  }

  const next = Array.isArray(messages) ? [...messages] : [];
  const lastUserIndex = next.findLastIndex((message) => message?.role === "user");
  const anchorMessage = {
    role: "assistant",
    content: `[Persistent memory]\n${memoryAnchor.trim()}`,
  };

  if (lastUserIndex === -1) {
    next.push(anchorMessage);
    return next;
  }

  next.splice(lastUserIndex, 0, anchorMessage);
  return next;
}

export function toolResultText(text, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function parseJsonInput(text, fallback = {}) {
  try {
    const trimmed = `${text ?? ""}`.trim();
    return trimmed ? JSON.parse(trimmed) : fallback;
  } catch {
    return fallback;
  }
}

export function buildHookAdditionalContextOutput(hookEventName, additionalContext) {
  if (!additionalContext?.trim()) {
    return "";
  }
  return JSON.stringify(
    {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: additionalContext.trim(),
      },
    },
    null,
    2,
  );
}

export async function readInstructionFile(relativePath) {
  return readText(path.join(pluginRoot, relativePath), "");
}
