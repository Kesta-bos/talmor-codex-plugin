#!/usr/bin/env node
import {
  enqueueHonchoMessage,
  getHonchoSessionName,
  getPromptContext,
  loadHonchoRuntime,
  makeHookOutput,
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
    lastPrompt: input.prompt,
  });

  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return;
  }

  if (typeof input.prompt === "string" && input.prompt.trim()) {
    const sessionName = getHonchoSessionName(runtime, input.cwd, input.session_id);
    await enqueueHonchoMessage({
      role: "user",
      kind: "user_prompt",
      cwd: input.cwd,
      content: input.prompt.trim(),
      sessionName,
      metadata: {
        turn_id: input.turn_id,
      },
    });
  }

  const context = await getPromptContext(runtime, input.cwd, input.prompt || "", input.session_id);
  const output = makeHookOutput("UserPromptSubmit", context);
  if (output) {
    process.stdout.write(output);
  }
}

main().catch(() => {
  process.exitCode = 0;
});
