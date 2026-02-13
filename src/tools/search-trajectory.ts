import { tool } from "@opencode-ai/plugin";
import type { SessionState } from "../types";
import { searchTrajectory } from "../trajectory/manager";

export function createSearchTrajectoryTool(
  sessionStates: Map<string, SessionState>,
) {
  return tool({
    description:
      "Search through trajectory history for specific content. Searches turn content and compaction summaries by keyword.",
    args: {
      query: tool.schema.string().describe("Search term or phrase"),
      maxResults: tool.schema
        .number()
        .optional()
        .describe("Maximum results to return (default 10)"),
    },
    async execute(args, ctx) {
      const state = sessionStates.get(ctx.sessionID);
      if (!state) return "RLM not initialized for this session.";

      const results = searchTrajectory(
        state.document,
        args.query,
        args.maxResults ?? 10,
      );

      if (results.length === 0) {
        return `No results found for "${args.query}".`;
      }

      return JSON.stringify(results, null, 2);
    },
  });
}
