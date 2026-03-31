import { readFileSync } from "node:fs";
import {
  buildHookAdditionalContextOutput,
  buildHonchoClientOptions,
  computeHonchoSessionName,
  formatHonchoContext,
  formatMemoryAnchor,
  formatSessionSummary,
  nowIso,
  parseJsonInput,
  readCredentials,
  readHonchoCache,
  readHonchoConfig,
  readHonchoQueue,
  readSessionState,
  truncateText,
  writeHonchoCache,
  writeHonchoQueue,
  writeSessionState,
} from "./talmor-codex-plugin-common.mjs";

let cachedHonchoModule = null;

async function getHonchoModule() {
  if (cachedHonchoModule) {
    return cachedHonchoModule;
  }
  cachedHonchoModule = await import("@honcho-ai/sdk");
  return cachedHonchoModule;
}

export async function loadHonchoRuntime() {
  const [config, credentials, sessionState, cache] = await Promise.all([
    readHonchoConfig(),
    readCredentials(),
    readSessionState(),
    readHonchoCache(),
  ]);
  const clientOptions = buildHonchoClientOptions(config, credentials);
  const enabled = Boolean(config.enabled && credentials?.honchoApiKey && clientOptions);
  return {
    enabled,
    config,
    credentials,
    sessionState,
    cache,
    clientOptions,
  };
}

export async function getHonchoClient(runtime) {
  if (!runtime?.enabled || !runtime.clientOptions) {
    return null;
  }
  const { Honcho } = await getHonchoModule();
  return new Honcho(runtime.clientOptions);
}

export async function ensureHonchoSession(runtime, cwd, sessionId = null) {
  if (!runtime?.enabled) {
    return null;
  }

  const honcho = await getHonchoClient(runtime);
  if (!honcho) {
    return null;
  }

  const sessionName = computeHonchoSessionName(runtime.config, cwd, sessionId);
  const [session, userPeer, aiPeer] = await Promise.all([
    honcho.session(sessionName),
    honcho.peer(runtime.config.peerName),
    honcho.peer(runtime.config.aiPeer),
  ]);

  if (typeof session.addPeers === "function") {
    try {
      await session.addPeers([
        [userPeer, { observeMe: true, observeOthers: false }],
        [aiPeer, { observeMe: true, observeOthers: true }],
      ]);
    } catch {}
  }

  return { honcho, sessionName, session, userPeer, aiPeer };
}

export function getHonchoSessionName(runtime, cwd, sessionId = null) {
  return computeHonchoSessionName(runtime.config, cwd, sessionId);
}

export async function updateSessionState(partial) {
  const current = await readSessionState();
  const next = {
    ...current,
    ...partial,
    updatedAt: nowIso(),
  };
  await writeSessionState(next);
  return next;
}

function isTrivialPrompt(prompt) {
  if (!prompt?.trim()) {
    return true;
  }
  return /^(yes|no|ok|sure|thanks|y|n|continue|go ahead|do it|proceed)$/i.test(prompt.trim());
}

function extractTopics(prompt) {
  const topics = [];
  const filePaths = prompt.match(/[\w\-/.]+\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|sql)/gi) || [];
  topics.push(...filePaths.slice(0, 4));
  const quoted = prompt.match(/"([^"]+)"/g)?.map((item) => item.slice(1, -1)) || [];
  topics.push(...quoted.slice(0, 3));
  const words = prompt.toLowerCase().match(/\b[a-z][a-z0-9_-]{3,}\b/g) || [];
  topics.push(...words.slice(0, 6));
  return [...new Set(topics)].filter(Boolean).slice(0, 8);
}

function buildAdditionalContextText(runtime, parts) {
  const filtered = parts.map((item) => `${item ?? ""}`.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return "";
  }
  return `[Honcho Memory for ${runtime.config.peerName}]\n${filtered.join("\n\n")}`;
}

export async function warmHonchoContext(runtime, cwd, sessionId = null) {
  const sessionBundle = await ensureHonchoSession(runtime, cwd, sessionId);
  if (!sessionBundle) {
    return null;
  }

  const { sessionName, session, userPeer, aiPeer } = sessionBundle;
  const [userContextResult, aiContextResult, summaryResult] = await Promise.allSettled([
    userPeer.context({
      maxConclusions: runtime.config.maxContextConclusions,
      includeMostFrequent: true,
    }),
    aiPeer.context({
      maxConclusions: Math.max(6, Math.floor(runtime.config.maxContextConclusions / 2)),
      includeMostFrequent: true,
    }),
    typeof session.summaries === "function" ? session.summaries() : Promise.resolve(null),
  ]);

  const userContext = userContextResult.status === "fulfilled" ? userContextResult.value : null;
  const aiContext = aiContextResult.status === "fulfilled" ? aiContextResult.value : null;
  const sessionSummary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const additionalContext = buildAdditionalContextText(runtime, [
    formatHonchoContext(userContext, runtime.config.peerName),
    formatHonchoContext(aiContext, runtime.config.aiPeer),
    formatSessionSummary(sessionSummary),
  ]);

  await writeHonchoCache({
    sessionName,
    updatedAt: nowIso(),
    userContext,
    aiContext,
    sessionSummary,
    additionalContext,
  });

  return {
    sessionName,
    userContext,
    aiContext,
    sessionSummary,
    additionalContext,
  };
}

export async function getPromptContext(runtime, cwd, prompt, sessionId = null) {
  if (!runtime?.enabled || isTrivialPrompt(prompt)) {
    return "";
  }

  const cache = await readHonchoCache();
  const now = Date.now();
  const ttlMs = Number(runtime.config.contextTtlSeconds || 300) * 1000;
  const expectedSessionName = computeHonchoSessionName(runtime.config, cwd, sessionId);
  const cacheAge = cache?.updatedAt ? now - Date.parse(cache.updatedAt) : Number.POSITIVE_INFINITY;

  if (
    cache?.sessionName === expectedSessionName &&
    cacheAge < ttlMs &&
    typeof cache.additionalContext === "string" &&
    cache.additionalContext.trim()
  ) {
    return cache.additionalContext;
  }

  const sessionBundle = await ensureHonchoSession(runtime, cwd, sessionId);
  if (!sessionBundle) {
    return "";
  }

  const { sessionName, userPeer } = sessionBundle;
  const topics = extractTopics(prompt);
  let context = null;

  try {
    context = await userPeer.context({
      searchQuery: topics.length > 0 ? topics.join(" ") : undefined,
      searchTopK: runtime.config.searchTopK,
      searchMaxDistance: runtime.config.searchMaxDistance,
      maxConclusions: runtime.config.maxContextConclusions,
      includeMostFrequent: true,
    });
  } catch {
    try {
      context = await userPeer.context({
        maxConclusions: runtime.config.maxContextConclusions,
        includeMostFrequent: true,
      });
    } catch {
      context = null;
    }
  }

  const additionalContext = buildAdditionalContextText(runtime, [
    formatHonchoContext(context, runtime.config.peerName),
  ]);

  await writeHonchoCache({
    ...(await readHonchoCache()),
    sessionName,
    updatedAt: nowIso(),
    userContext: context,
    additionalContext,
  });

  return additionalContext;
}

export async function enqueueHonchoMessage(message) {
  const queue = await readHonchoQueue();
  const messages = Array.isArray(queue.messages) ? queue.messages : [];
  messages.push({
    ...message,
    createdAt: message.createdAt || nowIso(),
  });
  await writeHonchoQueue({ messages });
  return messages.length;
}

function buildPeerMessage(peer, message) {
  const metadata = {
    kind: message.kind || "note",
    cwd: message.cwd,
    session_affinity: message.sessionName,
    ...message.metadata,
  };
  return peer.message(message.content, {
    createdAt: message.createdAt || nowIso(),
    metadata,
  });
}

export async function flushHonchoQueue(runtime, cwd, sessionId = null, extraMessages = []) {
  if (!runtime?.enabled || runtime.config.saveMessages === false) {
    return { flushed: 0, skipped: true };
  }

  const sessionBundle = await ensureHonchoSession(runtime, cwd, sessionId);
  if (!sessionBundle) {
    return { flushed: 0, skipped: true };
  }

  const { sessionName, session, userPeer, aiPeer } = sessionBundle;
  const queue = await readHonchoQueue();
  const messages = Array.isArray(queue.messages) ? queue.messages : [];
  const matching = messages.filter((message) => !message.sessionName || message.sessionName === sessionName);
  const remaining = messages.filter((message) => message.sessionName && message.sessionName !== sessionName);
  const combined = [...matching, ...extraMessages].filter(Boolean);
  if (combined.length === 0) {
    return { flushed: 0, sessionName };
  }

  const materialized = combined
    .filter((message) => message.content && `${message.content}`.trim())
    .map((message) => {
      const peer = message.role === "user" ? userPeer : aiPeer;
      return buildPeerMessage(peer, {
        ...message,
        sessionName,
      });
    });

  if (materialized.length === 0) {
    return { flushed: 0, sessionName };
  }

  await session.addMessages(materialized);
  await writeHonchoQueue({ messages: remaining });
  return { flushed: materialized.length, sessionName };
}

export function summarizeBashCommand(command, toolResponse) {
  const cleanCommand = `${command ?? ""}`.trim();
  const head = cleanCommand.split(/[;&|]/)[0].trim();
  const success = !(toolResponse && typeof toolResponse === "object" && toolResponse.error);
  if (!head) {
    return "";
  }
  return `[Bash ${success ? "success" : "failure"}] ${truncateText(head, 180)}`;
}

export function extractAssistantMessageFromStopInput(input) {
  if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()) {
    return input.last_assistant_message.trim();
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    return "";
  }

  try {
    const lines = readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseJsonInput(lines[index], null);
      if (!parsed || parsed.type !== "response_item") {
        continue;
      }
      const payload = parsed.payload;
      if (payload?.type !== "message" || payload?.role !== "assistant") {
        continue;
      }
      const content = Array.isArray(payload.content)
        ? payload.content
            .map((part) => (part?.text ? `${part.text}` : ""))
            .filter(Boolean)
            .join("\n\n")
        : "";
      if (content.trim()) {
        return content.trim();
      }
    }
  } catch {}

  return "";
}

export async function buildMemoryAnchorForCompact(runtime, cwd, sessionId = null) {
  if (!runtime?.enabled) {
    return "";
  }

  const cache = await readHonchoCache();
  const expectedSessionName = computeHonchoSessionName(runtime.config, cwd, sessionId);
  if (
    cache?.sessionName === expectedSessionName &&
    cache.userContext &&
    cache.aiContext &&
    cache.sessionSummary
  ) {
    return formatMemoryAnchor({
      config: runtime.config,
      sessionName: expectedSessionName,
      userContext: cache.userContext,
      aiContext: cache.aiContext,
      sessionSummary: cache.sessionSummary,
    });
  }

  const warmed = await warmHonchoContext(runtime, cwd, sessionId);
  if (!warmed) {
    return "";
  }
  return formatMemoryAnchor({
    config: runtime.config,
    sessionName: warmed.sessionName,
    userContext: warmed.userContext,
    aiContext: warmed.aiContext,
    sessionSummary: warmed.sessionSummary,
  });
}

export function makeHookOutput(eventName, text) {
  return buildHookAdditionalContextOutput(eventName, text);
}
