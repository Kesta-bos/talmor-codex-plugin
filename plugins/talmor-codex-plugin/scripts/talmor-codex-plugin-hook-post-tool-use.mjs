#!/usr/bin/env node
import {
  enqueueHonchoMessage,
  getHonchoSessionName,
  loadHonchoRuntime,
  summarizeBashCommand,
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

async function main() {
  const input = parseJsonInput(await readStdin(), {});

  await updateSessionState({
    lastActiveCwd: input.cwd,
    lastSessionId: input.session_id,
    lastTurnId: input.turn_id,
    lastTranscriptPath: input.transcript_path,
  });

  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled || runtime.config.saveMessages === false) {
    return;
  }

  const summary = summarizeBashCommand(input.tool_input?.command || "", input.tool_response);
  if (!summary) {
    return;
  }
  const sessionName = getHonchoSessionName(runtime, input.cwd, input.session_id);

  await enqueueHonchoMessage({
    role: "assistant",
    kind: "bash_tool",
    cwd: input.cwd,
    content: summary,
    sessionName,
    metadata: {
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: input.tool_name,
    },
  });
}

main().catch(() => {
  process.exitCode = 0;
});
