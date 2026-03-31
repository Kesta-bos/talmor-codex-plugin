#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  hasMorphSdkInstalled,
  pluginRoot,
  readCredentials,
  readHonchoConfig,
  readMorphConfig,
  readSessionState,
  safeJson,
  toolResultText,
  truncateText,
  writeHonchoConfig,
} from "./talmor-codex-plugin-common.mjs";
import { ensureHonchoSession, loadHonchoRuntime } from "./talmor-codex-plugin-honcho.mjs";

const protocolVersion = "2025-03-26";
const serverInfo = {
  name: "talmor-codex-plugin-runtime",
  title: "Talmor Codex Plugin Runtime",
  version: "0.2.0",
};

const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_TIMEOUT = 30000;
const MORPH_WARP_GREP_TIMEOUT = 60000;
const EXISTING_CODE_MARKER = "// ... existing code ...";
const READONLY_AGENTS = ["plan", "explore"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let morphClient = null;
let warpGrepClient = null;

function sendMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function sendResponse(id, result) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

let buffer = Buffer.alloc(0);
const pendingRequests = new Set();

async function handleAdminCommand(command) {
  const child = spawn(process.execPath, [path.join(__dirname, "talmor-codex-plugin-admin.mjs"), command], {
    cwd: path.dirname(__dirname),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const text = Buffer.concat(stdout).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8").trim() || text || `exit ${exitCode}`);
  }
  return text ? JSON.parse(text) : {};
}

async function getMorphClients() {
  const credentials = await readCredentials();
  const morphConfig = await readMorphConfig();
  if (!credentials?.morphApiKey) {
    return null;
  }
  if (morphClient && warpGrepClient) {
    return {
      morph: morphClient,
      warpGrep: warpGrepClient,
      apiKey: credentials.morphApiKey,
      config: morphConfig,
    };
  }
  const { MorphClient, WarpGrepClient } = await import("@morphllm/morphsdk");
  morphClient = new MorphClient({
    apiKey: credentials.morphApiKey,
    timeout: MORPH_TIMEOUT,
  });
  warpGrepClient = new WarpGrepClient({
    morphApiKey: credentials.morphApiKey,
    morphApiUrl: MORPH_API_URL,
    timeout: MORPH_WARP_GREP_TIMEOUT,
  });
  return {
    morph: morphClient,
    warpGrep: warpGrepClient,
    apiKey: credentials.morphApiKey,
    config: morphConfig,
  };
}

async function resolveToolCwd(args) {
  if (typeof args?.cwd === "string" && args.cwd.trim()) {
    return path.resolve(args.cwd);
  }
  const sessionState = await readSessionState();
  if (typeof sessionState?.lastActiveCwd === "string" && sessionState.lastActiveCwd.trim()) {
    return sessionState.lastActiveCwd;
  }
  return process.cwd();
}

function normalizeCodeEditInput(codeEdit) {
  const trimmed = `${codeEdit ?? ""}`.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return trimmed;
  }
  if (/^```[\w-]*$/.test(lines[0]) && /^```$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n");
  }
  return trimmed;
}

function resolvePublicRepoLocator(args) {
  const ownerRepo = `${args?.owner_repo ?? ""}`.trim();
  const githubUrl = `${args?.github_url ?? ""}`.trim();

  if (ownerRepo && githubUrl) {
    return { error: "owner_repo와 github_url 중 하나만 제공해야 합니다." };
  }
  if (!ownerRepo && !githubUrl) {
    return { error: "owner_repo 또는 github_url이 필요합니다." };
  }
  if (ownerRepo) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(ownerRepo)) {
      return { error: `유효한 owner/repo 형식이 아닙니다: ${ownerRepo}` };
    }
    return { repo: ownerRepo };
  }

  try {
    const parsed = new URL(githubUrl);
    if (!["github.com", "www.github.com"].includes(parsed.hostname)) {
      return { error: `github_url은 github.com 이어야 합니다: ${githubUrl}` };
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return { error: `github_url에서 owner/repo를 추출할 수 없습니다: ${githubUrl}` };
    }
    return { repo: `${parts[0]}/${parts[1].replace(/\.git$/, "")}` };
  } catch {
    return { error: `유효한 GitHub URL이 아닙니다: ${githubUrl}` };
  }
}

function isValidContext(ctx) {
  return Boolean(ctx?.file) && (ctx.file.includes("/") || /\.[a-z0-9]+$/i.test(ctx.file)) && `${ctx.content ?? ""}`.length > 0;
}

function formatWarpGrepResult(result) {
  if (!result?.success) {
    return `Search failed: ${result?.error || "search returned no error details."}`;
  }
  if (!Array.isArray(result.contexts) || result.contexts.length === 0) {
    return "No relevant code found. Try rephrasing your search term.";
  }

  const valid = result.contexts.filter(isValidContext);
  if (valid.length === 0) {
    return "Search returned malformed file contexts. Fallback: use rg and file reads directly.";
  }

  return valid
    .map((context) => {
      const lineInfo = context.startLine && context.endLine ? ` lines ${context.startLine}-${context.endLine}` : "";
      return `<file path="${context.file}"${lineInfo ? ` range="${lineInfo.trim()}"` : ""}>\n${truncateText(context.content, 4000)}\n</file>`;
    })
    .join("\n\n");
}

async function handleMorphEdit(args) {
  const clients = await getMorphClients();
  if (!clients) {
    return toolResultText("MORPH_API_KEY가 설정되지 않아 morph_edit를 사용할 수 없습니다.", true);
  }
  if (clients.config.editEnabled === false) {
    return toolResultText("MORPH_EDIT=false 로 설정되어 morph_edit가 비활성화되어 있습니다.", true);
  }

  const cwd = await resolveToolCwd(args);
  const targetFilepath = `${args?.target_filepath ?? ""}`.trim();
  const instructions = `${args?.instructions ?? ""}`.trim();
  const codeEdit = normalizeCodeEditInput(args?.code_edit ?? "");
  const agent = `${args?.agent ?? ""}`.trim().toLowerCase();

  if (!targetFilepath || !instructions || !codeEdit) {
    return toolResultText("target_filepath, instructions, code_edit는 모두 필요합니다.", true);
  }
  if (READONLY_AGENTS.includes(agent)) {
    return toolResultText(`morph_edit는 ${agent} 모드에서 차단됩니다.`, true);
  }

  const filepath = path.isAbsolute(targetFilepath) ? targetFilepath : path.resolve(cwd, targetFilepath);
  let originalCode = "";
  let fileExists = true;
  try {
    originalCode = await fs.readFile(filepath, "utf8");
  } catch {
    fileExists = false;
  }

  if (!fileExists && codeEdit.includes(EXISTING_CODE_MARKER)) {
    return toolResultText(`새 파일 생성 시에는 ${EXISTING_CODE_MARKER} 마커 없이 전체 내용을 제공해야 합니다.`, true);
  }

  if (!fileExists) {
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, `${codeEdit}\n`, "utf8");
    return toolResultText(`Created new file: ${filepath}\nLines: ${codeEdit.split("\n").length}`);
  }

  const startTime = Date.now();
  const result = await clients.morph.fastApply.applyEdit(
    {
      originalCode,
      codeEdit,
      instruction: instructions,
      filepath: targetFilepath,
    },
    {
      morphApiUrl: MORPH_API_URL,
      generateUdiff: true,
    },
  );
  const apiDuration = Date.now() - startTime;

  if (!result?.success || !result?.mergedCode) {
    return toolResultText(`Morph API failed: ${result?.error || "unknown error"}`, true);
  }

  await fs.writeFile(filepath, result.mergedCode, "utf8");
  const { linesAdded = 0, linesRemoved = 0 } = result.changes || {};
  return toolResultText(
    `Applied edit to ${filepath}\n\n+${linesAdded} -${linesRemoved} lines | ${apiDuration}ms\n\n\`\`\`diff\n${truncateText(result.udiff || "No changes detected", 3000)}\n\`\`\``,
  );
}

async function handleWarpGrepCodebaseSearch(args) {
  const clients = await getMorphClients();
  if (!clients) {
    return toolResultText("MORPH_API_KEY가 설정되지 않아 warpgrep_codebase_search를 사용할 수 없습니다.", true);
  }
  if (clients.config.warpGrepEnabled === false) {
    return toolResultText("MORPH_WARPGREP=false 로 설정되어 warpgrep_codebase_search가 비활성화되어 있습니다.", true);
  }
  const cwd = await resolveToolCwd(args);
  const searchTerm = `${args?.search_term ?? args?.query ?? ""}`.trim();
  if (!searchTerm) {
    return toolResultText("search_term이 필요합니다.", true);
  }

  try {
    const generator = clients.warpGrep.execute({
      searchTerm,
      repoRoot: cwd,
      streamSteps: true,
    });
    let result = null;
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    return toolResultText(formatWarpGrepResult(result));
  } catch (error) {
    return toolResultText(`WarpGrep search failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function handleWarpGrepGithubSearch(args) {
  const clients = await getMorphClients();
  if (!clients) {
    return toolResultText("MORPH_API_KEY가 설정되지 않아 warpgrep_github_search를 사용할 수 없습니다.", true);
  }
  if (clients.config.warpGrepGithubEnabled === false) {
    return toolResultText(
      "MORPH_WARPGREP_GITHUB=false 로 설정되어 warpgrep_github_search가 비활성화되어 있습니다.",
      true,
    );
  }
  const locator = resolvePublicRepoLocator(args);
  if ("error" in locator) {
    return toolResultText(locator.error, true);
  }
  const searchTerm = `${args?.search_term ?? ""}`.trim();
  if (!searchTerm) {
    return toolResultText("search_term이 필요합니다.", true);
  }

  try {
    const result = await clients.warpGrep.searchGitHub({
      searchTerm,
      github: locator.repo,
      branch: args?.branch,
    });
    return toolResultText(`Repository: ${locator.repo}\n\n${formatWarpGrepResult(result)}`, !result?.success);
  } catch (error) {
    return toolResultText(`Public repo context search failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function handleHonchoSearch(args) {
  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return toolResultText("Honcho가 활성화되어 있지 않습니다.", true);
  }
  const cwd = await resolveToolCwd(args);
  const query = `${args?.query ?? ""}`.trim();
  if (!query) {
    return toolResultText("query가 필요합니다.", true);
  }
  const limit = Number.parseInt(`${args?.limit ?? 10}`, 10);
  const sessionBundle = await ensureHonchoSession(runtime, cwd, null);
  const messages = await sessionBundle.session.search(query, { limit });
  const results = messages.map((message) => ({
    content: message.content,
    peer: message.peer,
    createdAt: message.createdAt || message.created_at,
  }));
  return toolResultText(safeJson(results));
}

async function handleHonchoChat(args) {
  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return toolResultText("Honcho가 활성화되어 있지 않습니다.", true);
  }
  const cwd = await resolveToolCwd(args);
  const query = `${args?.query ?? ""}`.trim();
  if (!query) {
    return toolResultText("query가 필요합니다.", true);
  }
  const reasoningLevel = `${args?.reasoning_level || runtime.config.reasoningLevel || "low"}`;
  const sessionBundle = await ensureHonchoSession(runtime, cwd, null);
  const response = await sessionBundle.userPeer.chat(query, {
    session: sessionBundle.session,
    reasoningLevel,
  });
  return toolResultText(`${response ?? "No response from Honcho"}`);
}

async function handleHonchoCreateConclusion(args) {
  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return toolResultText("Honcho가 활성화되어 있지 않습니다.", true);
  }
  const cwd = await resolveToolCwd(args);
  const content = `${args?.content ?? ""}`.trim();
  if (!content) {
    return toolResultText("content가 필요합니다.", true);
  }
  const sessionBundle = await ensureHonchoSession(runtime, cwd, null);
  const conclusions = await sessionBundle.userPeer.conclusions.create({
    content,
    sessionId: sessionBundle.session.id,
  });
  return toolResultText(`Saved conclusion: ${conclusions?.[0]?.content || content}`);
}

async function handleHonchoGetConfig() {
  const runtime = await loadHonchoRuntime();
  const morphConfig = await readMorphConfig();
  const sessionState = await readSessionState();
  return toolResultText(
    safeJson({
      enabled: runtime.enabled,
      morphConfig,
      config: runtime.config,
      sessionState,
    }),
  );
}

async function handleHonchoSetConfig(args) {
  const current = await readHonchoConfig();
  const field = `${args?.field ?? ""}`.trim();
  if (!field) {
    return toolResultText("field가 필요합니다.", true);
  }
  const dangerous = new Set(["workspace", "baseUrl"]);
  if (dangerous.has(field) && args?.confirm !== true) {
    return toolResultText(`${field} 변경은 confirm=true가 필요합니다.`, true);
  }
  if (!(field in current)) {
    return toolResultText(`알 수 없는 Honcho 설정 필드입니다: ${field}`, true);
  }

  const next = { ...current };
  const previousValue = next[field];
  if (typeof previousValue === "boolean") {
    next[field] = Boolean(args?.value);
  } else if (typeof previousValue === "number") {
    next[field] = Number(args?.value);
  } else {
    next[field] = args?.value;
  }

  await writeHonchoConfig(next);
  return toolResultText(
    safeJson({
      success: true,
      field,
      previousValue,
      newValue: next[field],
    }),
  );
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      try {
        await handleAdminCommand("ensure-proxy");
      } catch {}
      sendResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo,
      });
      return;
    }
    case "notifications/initialized":
      return;
    case "tools/list":
      sendResponse(id, {
        tools: [
          {
            name: "talmor_codex_plugin_status",
            description: "Talmor Codex Plugin runtime과 설치 상태를 확인합니다.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "talmor_codex_plugin_restart_runtime",
            description: "Talmor Codex Plugin compact runtime을 재시작합니다.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "talmor_codex_plugin_stop_runtime",
            description: "Talmor Codex Plugin compact runtime을 중지합니다.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "morph_edit",
            description:
              "Edit existing files using Morph Fast Apply. Prefer this for large files, scattered edits, or refactors inside an existing file. For tiny exact replacements, use native edit instead. Pass cwd when possible so relative target paths resolve correctly.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                agent: { type: "string" },
                target_filepath: { type: "string" },
                instructions: { type: "string" },
                code_edit: { type: "string" },
              },
              required: ["target_filepath", "instructions", "code_edit"],
              additionalProperties: false,
            },
          },
          {
            name: "warpgrep_codebase_search",
            description:
              "Fast exploratory local codebase search powered by Morph WarpGrep. Use this for natural-language codebase questions, not exact keyword lookup.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                search_term: { type: "string" },
              },
              required: ["search_term"],
              additionalProperties: false,
            },
          },
          {
            name: "warpgrep_github_search",
            description:
              "Search indexed public GitHub repositories without cloning them. Use owner_repo or github_url, plus a natural-language search_term.",
            inputSchema: {
              type: "object",
              properties: {
                search_term: { type: "string" },
                owner_repo: { type: "string" },
                github_url: { type: "string" },
                branch: { type: "string" },
              },
              required: ["search_term"],
              additionalProperties: false,
            },
          },
          {
            name: "honcho_search",
            description: "Search the current Honcho session memory using semantic retrieval.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                query: { type: "string" },
                limit: { type: "number" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            name: "honcho_chat",
            description: "Ask Honcho what it knows about the user and prior work in the current session context.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                query: { type: "string" },
                reasoning_level: { type: "string" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            name: "honcho_create_conclusion",
            description: "Persist a new user preference, decision, or stable fact into Honcho memory.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                content: { type: "string" },
              },
              required: ["content"],
              additionalProperties: false,
            },
          },
          {
            name: "honcho_get_config",
            description: "Return the current Honcho runtime configuration and last observed session state.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "honcho_set_config",
            description: "Update Honcho runtime settings. workspace and baseUrl changes require confirm=true.",
            inputSchema: {
              type: "object",
              properties: {
                field: { type: "string" },
                value: {},
                confirm: { type: "boolean" },
              },
              required: ["field", "value"],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        let payload;
        if (name === "talmor_codex_plugin_status") {
          payload = toolResultText(safeJson(await handleAdminCommand("status")));
        } else if (name === "talmor_codex_plugin_restart_runtime") {
          payload = toolResultText(safeJson(await handleAdminCommand("restart-proxy")));
        } else if (name === "talmor_codex_plugin_stop_runtime") {
          payload = toolResultText(safeJson(await handleAdminCommand("stop-proxy")));
        } else if (name === "morph_edit") {
          payload = await handleMorphEdit(args);
        } else if (name === "warpgrep_codebase_search") {
          payload = await handleWarpGrepCodebaseSearch(args);
        } else if (name === "warpgrep_github_search") {
          payload = await handleWarpGrepGithubSearch(args);
        } else if (name === "honcho_search") {
          payload = await handleHonchoSearch(args);
        } else if (name === "honcho_chat") {
          payload = await handleHonchoChat(args);
        } else if (name === "honcho_create_conclusion") {
          payload = await handleHonchoCreateConclusion(args);
        } else if (name === "honcho_get_config") {
          payload = await handleHonchoGetConfig(args);
        } else if (name === "honcho_set_config") {
          payload = await handleHonchoSetConfig(args);
        } else {
          sendError(id, -32602, `unknown tool: ${name}`);
          return;
        }
        sendResponse(id, payload);
      } catch (error) {
        sendResponse(id, toolResultText(error instanceof Error ? error.message : String(error), true));
      }
      return;
    }
    default:
      sendError(id, -32601, `unsupported method: ${method}`);
  }
}

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number.parseInt(lengthMatch[1], 10);
    const frameLength = headerEnd + 4 + contentLength;
    if (buffer.length < frameLength) {
      return;
    }
    const body = buffer.slice(headerEnd + 4, frameLength).toString("utf8");
    buffer = buffer.slice(frameLength);
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      sendError(null, -32700, error instanceof Error ? error.message : String(error));
      continue;
    }

    const pending = handleRequest(message).catch((error) => {
      if (message?.id != null) {
        sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    });
    pendingRequests.add(pending);
    pending.finally(() => pendingRequests.delete(pending));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", async () => {
  await Promise.allSettled([...pendingRequests]);
  process.exit(0);
});
