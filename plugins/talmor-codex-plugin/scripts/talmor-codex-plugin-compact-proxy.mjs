#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import { URL } from "node:url";
import {
  buildCompactMessagesWithMemory,
  defaultProxyPort,
  defaultUpstreamBaseUrl,
  ensureDir,
  findLastUserMessage,
  getStatePaths,
  healthcheckProxy,
  normalizePort,
  pluginRoot,
  readCredentials,
  readMorphConfig,
  readSessionState,
  readState,
  responseItemsToMorphMessages,
  summaryPrefix,
} from "./talmor-codex-plugin-common.mjs";
import { buildMemoryAnchorForCompact, loadHonchoRuntime } from "./talmor-codex-plugin-honcho.mjs";

let cachedCompactClient = null;

async function loadRuntime() {
  const state = (await readState()) || {};
  const credentials = (await readCredentials()) || {};
  if (!credentials.morphApiKey) {
    throw new Error("Morph API 키가 설정되지 않았습니다. /talmor-codex-plugin:install 을 먼저 실행하세요.");
  }
  return {
    proxyPort: normalizePort(
      process.env.TALMOR_CODEX_PLUGIN_PROXY_PORT || state.proxyPort || defaultProxyPort,
    ),
    upstreamBaseUrl: state.upstreamBaseUrl || defaultUpstreamBaseUrl,
    failOpen: state.failOpen !== false,
    morphApiKey: credentials.morphApiKey,
    morphConfig: await readMorphConfig(),
  };
}

async function getCompactClient(morphApiKey) {
  if (cachedCompactClient) {
    return cachedCompactClient;
  }
  const { CompactClient } = await import("@morphllm/morphsdk");
  cachedCompactClient = new CompactClient({
    morphApiKey,
    timeout: 60000,
  });
  return cachedCompactClient;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildTargetUrl(reqUrl, upstreamBaseUrl) {
  const base = new URL(upstreamBaseUrl);
  const incoming = new URL(reqUrl, "http://127.0.0.1");
  const basePath = base.pathname.replace(/\/$/, "");
  const pathName = incoming.pathname.startsWith("/v1/")
    ? incoming.pathname
    : `${basePath}${incoming.pathname}`;
  const target = new URL(base.origin);
  target.pathname = pathName;
  target.search = incoming.search;
  return target;
}

function copyHeadersFromRequest(req, overrideContentLength = null) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  if (overrideContentLength != null) {
    headers["content-length"] = String(overrideContentLength);
  }
  return headers;
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

async function proxyBufferedRequest(req, res, targetUrl, bodyBuffer) {
  const transport = targetUrl.protocol === "https:" ? https : http;
  await new Promise((resolve, reject) => {
    const upstreamReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers: copyHeadersFromRequest(req, bodyBuffer.length),
      },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders.connection;
        delete responseHeaders["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
      },
    );
    upstreamReq.on("error", reject);
    upstreamReq.end(bodyBuffer);
  });
}

function proxyStreamingRequest(req, res, targetUrl) {
  const transport = targetUrl.protocol === "https:" ? https : http;
  const upstreamReq = transport.request(
    targetUrl,
    {
      method: req.method,
      headers: copyHeadersFromRequest(req),
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders.connection;
      delete responseHeaders["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (error) => {
    writeJson(res, 502, {
      error: "upstream_proxy_error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
  req.pipe(upstreamReq);
}

async function buildMessagesForCompact(payload) {
  const messages = responseItemsToMorphMessages(payload.input, payload.instructions);
  const sessionState = await readSessionState();
  const honchoRuntime = await loadHonchoRuntime();
  if (!honchoRuntime.enabled || !sessionState?.lastActiveCwd) {
    return messages;
  }
  const memoryAnchor = await buildMemoryAnchorForCompact(
    honchoRuntime,
    sessionState.lastActiveCwd,
    sessionState.lastSessionId,
  );
  return buildCompactMessagesWithMemory(messages, memoryAnchor);
}

async function handleCompact(runtime, bodyBuffer) {
  const payload = JSON.parse(bodyBuffer.toString("utf8"));
  const messages = await buildMessagesForCompact(payload);
  const query = findLastUserMessage(messages);
  const client = await getCompactClient(runtime.morphApiKey);
  const result = await client.compact({
    messages,
    query,
    compressionRatio: runtime.morphConfig.compactRatio,
    preserveRecent: runtime.morphConfig.compactPreserveRecent,
    includeMarkers: false,
  });

  const summary = typeof result?.output === "string" ? result.output : "";
  return {
    output: [
      {
        type: "compaction_summary",
        encrypted_content: `${summaryPrefix}\n${summary}`,
      },
    ],
  };
}

async function createServer() {
  const runtime = await loadRuntime();
  const { pidFile, stateDir } = getStatePaths();
  await ensureDir(stateDir);
  await fs.writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      writeJson(res, 400, { error: "missing_url" });
      return;
    }

    if (req.url === "/health") {
      writeJson(res, 200, {
        ok: true,
        pid: process.pid,
        port: runtime.proxyPort,
        upstreamBaseUrl: runtime.upstreamBaseUrl,
        stateDir,
        pluginRoot,
      });
      return;
    }

    const compactPath = req.url.startsWith("/v1/responses/compact") || req.url.startsWith("/responses/compact");
    if (compactPath && req.method === "POST") {
      const bodyBuffer = await collectBody(req);
      if (runtime.morphConfig.compactEnabled === false) {
        const targetUrl = buildTargetUrl(req.url, runtime.upstreamBaseUrl);
        await proxyBufferedRequest(req, res, targetUrl, bodyBuffer);
        return;
      }
      try {
        const payload = await handleCompact(runtime, bodyBuffer);
        writeJson(res, 200, payload);
      } catch (error) {
        if (!runtime.failOpen) {
          writeJson(res, 502, {
            error: "talmor_codex_plugin_compact_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const targetUrl = buildTargetUrl(req.url, runtime.upstreamBaseUrl);
        await proxyBufferedRequest(req, res, targetUrl, bodyBuffer);
      }
      return;
    }

    const targetUrl = buildTargetUrl(req.url, runtime.upstreamBaseUrl);
    proxyStreamingRequest(req, res, targetUrl);
  });

  server.on("upgrade", (req, socket) => {
    socket.destroy(
      new Error(
        "talmor-codex-plugin compact proxy does not proxy websocket traffic; Codex should fall back to HTTP streaming",
      ),
    );
  });

  const cleanup = async () => {
    try {
      const health = await healthcheckProxy(runtime.proxyPort, 300);
      if (health.ok && health.body?.pid !== process.pid) {
        return;
      }
    } catch {}
    try {
      await fs.rm(pidFile, { force: true });
    } catch {}
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  server.listen(runtime.proxyPort, "127.0.0.1");
  return server;
}

createServer().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
