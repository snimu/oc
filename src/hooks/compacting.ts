import { readdir, readFile } from "fs/promises";
import type { SessionState } from "../types";
import { getRecentSummaries } from "../trajectory/manager";

/**
 * Handler for experimental.session.compacting.
 * Injects RLM trajectory context into OpenCode's compaction prompt
 * so the generated summary is RLM-aware.
 */
export async function handleCompacting(
  sessionId: string,
  sessionStates: Map<string, SessionState>,
  output: { context: string[]; prompt?: string },
): Promise<void> {
  const state = sessionStates.get(sessionId);
  if (!state) return;

  const recentSummaries = getRecentSummaries(state.document, 3);

  // Read active vars
  let varsInfo = "";
  try {
    const files = await readdir(state.varsDir);
    const varEntries: Record<string, unknown> = {};
    for (const file of files) {
      if (file.endsWith(".json")) {
        const key = file.replace(/\.json$/, "");
        const content = await readFile(`${state.varsDir}/${file}`, "utf-8");
        varEntries[key] = JSON.parse(content).value;
      }
    }
    if (Object.keys(varEntries).length > 0) {
      varsInfo = `\nActive variables:\n${JSON.stringify(varEntries, null, 2)}`;
    }
  } catch {
    // vars dir may be empty
  }

  const summaryBlock =
    recentSummaries.length > 0
      ? recentSummaries
          .map(
            (s, i) =>
              `--- Compaction ${s.segmentIndex} ---\n${s.summary}`,
          )
          .join("\n\n")
      : "(no previous compactions)";

  output.context.push(`## RLM Trajectory Context

This session is managed by the RLM (Recursive Language Model) scaffold.
Compaction cycle: ${state.document.stats.totalCompactions} compactions completed so far.
Total turns tracked: ${state.document.stats.totalTurns}
Trajectory file: ${state.trajectoryPath}

Previous compaction summaries (most recent first):
${summaryBlock}
${varsInfo}

When generating the continuation summary, please include:
1. What was being worked on and why
2. Key files, functions, and decisions made
3. Current state and immediate next steps
4. Any important context from the RLM variables above
`);
}
