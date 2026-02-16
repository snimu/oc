import type { RLMConfig, SessionState } from "../types";
import {
  appendTurn,
  createTurn,
  enqueueWrite,
  writeTrajectory,
} from "../trajectory/manager";

/**
 * Called on session.idle - after every completed turn.
 * Fetches new messages, appends them to the active trajectory segment,
 * and writes trajectory.json to disk.
 */
export async function handleSessionIdle(
  sessionId: string,
  config: RLMConfig,
  sessionStates: Map<string, SessionState>,
  client: any,
): Promise<void> {
  const state = sessionStates.get(sessionId);
  if (!state) return;

  // Fetch messages for this session
  // Returns Array<{ info: Message, parts: Array<Part> }>
  const resp = await client.session.messages({
    path: { id: sessionId },
  });

  const allMessages = resp.data;
  if (!allMessages) return;

  const newCount = allMessages.length;
  if (newCount <= state.lastKnownMessageCount) return;

  // Process only new messages since last idle
  const newMessages = allMessages.slice(state.lastKnownMessageCount);
  state.lastKnownMessageCount = newCount;

  let globalTurnIndex = state.document.stats.totalTurns;

  for (const msg of newMessages) {
    const role = msg.info.role; // "user" | "assistant"

    // Skip summary messages (these are compaction artifacts)
    if (role === "assistant" && (msg.info as any).summary) {
      continue;
    }

    for (const part of msg.parts) {
      if (part.type === "text") {
        const content = (part as any).text ?? "";
        if (!content) continue;

        const turn = createTurn(
          globalTurnIndex++,
          role as "user" | "assistant",
          content,

        );
        appendTurn(state.document, turn);
      } else if (part.type === "tool") {
        const toolPart = part as any;
        const toolState = toolPart.state;
        const toolName = toolPart.tool ?? "unknown";

        // Record the tool invocation
        const inputStr = toolState?.input
          ? JSON.stringify(toolState.input)
          : "";
        const invocationTurn = createTurn(
          globalTurnIndex++,
          "tool_use",
          `Tool call: ${toolName}`,

          toolName,
          inputStr,
        );
        appendTurn(state.document, invocationTurn);

        // Record the tool result if completed
        if (toolState?.status === "completed" && toolState.output) {
          const output =
            typeof toolState.output === "string"
              ? toolState.output
              : JSON.stringify(toolState.output);

          const truncated =
            output.length > config.maxToolOutputChars
              ? output.slice(0, config.maxToolOutputChars) + "\n[truncated]"
              : output;

          const resultTurn = createTurn(
            globalTurnIndex++,
            "tool_result",
            truncated,
  
            toolName,
          );
          appendTurn(state.document, resultTurn);
        } else if (toolState?.status === "error" && toolState.error) {
          const resultTurn = createTurn(
            globalTurnIndex++,
            "tool_result",
            `Error: ${toolState.error}`,
  
            toolName,
          );
          appendTurn(state.document, resultTurn);
        }
      }
      // Skip other part types (reasoning, step-start, step-finish, etc.)
    }
  }

  // Write trajectory.json (enqueued to prevent concurrent writes)
  await enqueueWrite(state, () =>
    writeTrajectory(state.trajectoryPath, state.document),
  );
}
