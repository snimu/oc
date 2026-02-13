import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { sessionStates } from "./session/state";
import { removeSessionDirectory } from "./session/directory";
import { handleSessionCreated } from "./hooks/session-created";
import { handleSessionIdle } from "./hooks/session-idle";
import { handleCompacting } from "./hooks/compacting";
import { isInActiveDirectory } from "./hooks/tool-guard";
import {
  recordCompaction,
  enqueueWrite,
  writeTrajectory,
} from "./trajectory/manager";
import { createReadTrajectoryTool } from "./tools/read-trajectory";
import { createSearchTrajectoryTool } from "./tools/search-trajectory";

export const RLMPlugin: Plugin = async (ctx) => {
  const config = loadConfig();

  await ctx.client.app.log({
    body: {
      service: "opencode-rlm",
      level: "info",
      message: `RLM plugin loaded (baseDir=${config.baseDir})`,
    },
  });

  return {
    tool: {
      rlm_read_trajectory: createReadTrajectoryTool(sessionStates),
      rlm_search_trajectory: createSearchTrajectoryTool(sessionStates),
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          const sessionId = event.properties.info.id;
          await handleSessionCreated(sessionId, config, sessionStates);
          await ctx.client.app.log({
            body: {
              service: "opencode-rlm",
              level: "info",
              message: `Session initialized: ${sessionId}`,
              extra: {
                dir: sessionStates.get(sessionId)?.sessionDir,
              },
            },
          });
        }

        if (event.type === "session.idle") {
          const sessionId = event.properties.sessionID;
          await handleSessionIdle(
            sessionId,
            config,
            sessionStates,
            ctx.client,
          );
        }

        if (event.type === "session.compacted") {
          const sessionId = event.properties.sessionID;
          const state = sessionStates.get(sessionId);
          if (state) {
            // Fetch messages to find the compaction summary.
            // After compaction, the latest assistant message with summary=true
            // contains the continuation summary.
            const resp = await ctx.client.session.messages({
              path: { id: sessionId },
            });
            const messages = resp.data ?? [];
            let summaryText = "";
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (
                msg.info.role === "assistant" &&
                (msg.info as any).summary === true
              ) {
                // Extract text from the summary message's parts
                const textParts = msg.parts
                  .filter((p) => p.type === "text")
                  .map((p) => (p as any).text ?? "");
                summaryText = textParts.join("\n");
                break;
              }
            }
            if (!summaryText) {
              summaryText = "(compaction occurred but summary not found)";
            }

            recordCompaction(
              state.document,
              summaryText,
              config.tokenEstimateMultiplier,
            );
            await enqueueWrite(state, () =>
              writeTrajectory(state.trajectoryPath, state.document),
            );
            await ctx.client.app.log({
              body: {
                service: "opencode-rlm",
                level: "info",
                message: `Compaction recorded for session ${sessionId} (cycle ${state.document.stats.totalCompactions})`,
              },
            });
          }
        }

        if (event.type === "session.deleted") {
          const sessionId = event.properties.info.id;
          const state = sessionStates.get(sessionId);
          if (state) {
            await enqueueWrite(state, () =>
              writeTrajectory(state.trajectoryPath, state.document),
            );
            if (config.cleanupOnDelete) {
              await removeSessionDirectory(state.sessionDir);
            }
            sessionStates.delete(sessionId);
          }
        }
      } catch (error: any) {
        await ctx.client.app.log({
          body: {
            service: "opencode-rlm",
            level: "error",
            message: `Error in event handler (${event.type}): ${error.message}`,
            extra: { stack: error.stack },
          },
        });
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const state = sessionStates.get(input.sessionID);
      if (!state) return;
      output.system.push(
        `You have a scratch directory for reading and writing intermediate files: ${state.varsDir}\n` +
          `Use this directory to persist any state, notes, or intermediates that should survive across context compaction.`,
      );
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        await handleCompacting(input.sessionID, sessionStates, output);
      } catch (error: any) {
        await ctx.client.app.log({
          body: {
            service: "opencode-rlm",
            level: "error",
            message: `Error in compacting hook: ${error.message}`,
            extra: { stack: error.stack },
          },
        });
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === "write" || input.tool === "edit") {
        const targetPath =
          output.args?.filePath ||
          output.args?.file_path ||
          output.args?.path;
        if (
          typeof targetPath === "string" &&
          isInActiveDirectory(targetPath, sessionStates)
        ) {
          throw new Error(
            "The active/ directory is managed by the RLM scaffold and is read-only. " +
              "Write intermediates to the vars/ directory instead.",
          );
        }
      }
    },
  };
};
