import { tool } from "@opencode-ai/plugin";
import type { SessionState } from "../types";
import { getOverview, getSegment, getCompaction } from "../trajectory/manager";

export function createReadTrajectoryTool(
  sessionStates: Map<string, SessionState>,
) {
  return tool({
    description:
      "Read trajectory history from the RLM scaffold. Returns past segments and their compaction summaries. Use this to recall what happened before context compaction.",
    args: {
      segmentIndex: tool.schema
        .number()
        .optional()
        .describe(
          "Specific segment index to read. Omit to get an overview of all segments.",
        ),
      includeFullTurns: tool.schema
        .boolean()
        .optional()
        .describe(
          "If true, include all turns in the segment. If false (default), include only the summary and metadata.",
        ),
    },
    async execute(args, ctx) {
      const state = sessionStates.get(ctx.sessionID);
      if (!state) return "RLM not initialized for this session.";

      if (args.segmentIndex !== undefined) {
        const segment = getSegment(state.document, args.segmentIndex);
        if (!segment) return `Segment ${args.segmentIndex} not found.`;

        const compaction = getCompaction(state.document, args.segmentIndex);

        if (args.includeFullTurns) {
          return JSON.stringify({ segment, compaction }, null, 2);
        }

        return JSON.stringify(
          {
            segmentIndex: segment.segmentIndex,
            turnCount: segment.turns.length,
            tokens: segment.totalEstimatedTokens,
            compacted: segment.compactedAt !== null,
            summary: compaction?.summary ?? "(active segment, not yet compacted)",
            startedAt: segment.startedAt,
            compactedAt: segment.compactedAt,
          },
          null,
          2,
        );
      }

      return JSON.stringify(getOverview(state.document), null, 2);
    },
  });
}
