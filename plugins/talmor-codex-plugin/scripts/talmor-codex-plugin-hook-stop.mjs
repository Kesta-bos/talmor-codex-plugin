#!/usr/bin/env node
import {
  enqueueHonchoMessage,
  extractAssistantMessageFromStopInput,
  flushHonchoQueue,
  getHonchoSessionName,
  loadHonchoRuntime,
  updateSessionState,
} from "./talmor-codex-plugin-honcho.mjs";
import { parseJsonInput } from "./talmor-codex-plugin-common.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function isMeaningfulAssistantMessage(text) {
  const trimmed = `${text ?? ""}`.trim();
  if (trimmed.length < 20) {
    return false;
  }
  return !/^(I'll|Let me|I will|Now I'll)\s+(run|check|use|inspect|look)/i.test(trimmed);
}

async function main() {
  const input = parseJsonInput(await readStdin(), {});

  await updateSessionState({
    lastActiveCwd: input.cwd,
    lastSessionId: input.session_id,
    lastTurnId: input.turn_id,
    lastTranscriptPath: input.transcript_path,
  });

  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return;
  }

  const assistantMessage = extractAssistantMessageFromStopInput(input);
  const sessionName = getHonchoSessionName(runtime, input.cwd, input.session_id);
  if (isMeaningfulAssistantMessage(assistantMessage)) {
    await enqueueHonchoMessage({
      role: "assistant",
      kind: "assistant_response",
      cwd: input.cwd,
      content: assistantMessage,
      sessionName,
      metadata: {
        turn_id: input.turn_id,
      },
    });
  }

  await flushHonchoQueue(runtime, input.cwd, input.session_id);
}

main().catch(() => {
  process.exitCode = 0;
});
