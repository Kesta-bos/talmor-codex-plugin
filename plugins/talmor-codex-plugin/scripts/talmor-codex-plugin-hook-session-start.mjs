#!/usr/bin/env node
import { makeHookOutput, loadHonchoRuntime, updateSessionState, warmHonchoContext } from "./talmor-codex-plugin-honcho.mjs";
import { parseJsonInput } from "./talmor-codex-plugin-common.mjs";

async function main() {
  const input = parseJsonInput(await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  }), {});

  await updateSessionState({
    lastActiveCwd: input.cwd,
    lastSessionId: input.session_id,
    lastTranscriptPath: input.transcript_path,
    lastModel: input.model,
    lastSource: input.source,
  });

  const runtime = await loadHonchoRuntime();
  if (!runtime.enabled) {
    return;
  }

  const warmed = await warmHonchoContext(runtime, input.cwd, input.session_id);
  if (warmed?.sessionName) {
    await updateSessionState({
      sessionName: warmed.sessionName,
    });
  }
  const output = makeHookOutput("SessionStart", warmed?.additionalContext || "");
  if (output) {
    process.stdout.write(output);
  }
}

main().catch(() => {
  process.exitCode = 0;
});
