import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { sessionStates, sessionDepths } from "./session/state";
import { removeSessionDirectory } from "./session/directory";
import { handleSessionCreated } from "./hooks/session-created";
import { handleSessionIdle } from "./hooks/session-idle";
import { handleCompacting } from "./hooks/compacting";
import { isInActiveDirectory } from "./hooks/tool-guard";
import { buildContextDisplay } from "./hooks/command";
import { setupSubagentFunctions } from "./subagent/functions";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  recordCompaction,
  enqueueWrite,
  writeTrajectory,
} from "./trajectory/manager";

const binDir = join(import.meta.dir, "..", "bin");
const llmContextPath = "/tmp/rlm-llm-context.json";

export const RLMPlugin: Plugin = async (ctx) => {
  const config = loadConfig();

  // Recursion depth for this process. Set by the parent's subagent function
  // via env var prefix on `opencode run`. Root processes default to 0.
  const processDepth = parseInt(process.env.OPENCODE_RLM_DEPTH || "0", 10);

  // Server URL for list_tools bash helper
  const serverUrl = ctx.serverUrl.toString().replace(/\/+$/, "");
  const directory = ctx.directory;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const authHeader = password
    ? `authorization: Basic ${btoa(`${username}:${password}`)}`
    : "";

  // Set up subagent bash functions
  const { functionsPath } = setupSubagentFunctions();

  await ctx.client.app.log({
    body: {
      service: "opencode-rlm",
      level: "info",
      message: `RLM plugin loaded (baseDir=${config.baseDir})`,
    },
  });

  return {
    "chat.params": async (input: any) => {
      const model = input.model;
      const provider = input.provider;
      const apiKey =
        provider?.info?.key ||
        (provider?.info?.env?.length
          ? process.env[provider.info.env[0]]
          : undefined) ||
        "";
      writeFileSync(
        llmContextPath,
        JSON.stringify({
          modelId: model.id,
          apiId: model.api.id,
          apiUrl: model.api.url,
          apiKey,
        }),
      );
    },

    config: async (cfg: any) => {
      if (!cfg.command) cfg.command = {};
      cfg.command.context = {
        template: "Display the RLM context status below",
        description: "Show RLM context and trajectory status",
      };
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          const sessionId = event.properties.info.id;
          sessionDepths.set(sessionId, processDepth);

          await handleSessionCreated(sessionId, config, sessionStates);
          await ctx.client.app.log({
            body: {
              service: "opencode-rlm",
              level: "info",
              message: `Session initialized: ${sessionId} (depth=${processDepth})`,
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
            sessionDepths.delete(sessionId);
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

    "command.execute.before": async (input, output) => {
      if (input.command === "context") {
        const state = sessionStates.get(input.sessionID);
        if (!state) return;

        // Fetch real token usage from the most recent assistant message.
        let modelInputTokens: number | undefined;
        let contextLimit: number | undefined;
        try {
          const resp = await ctx.client.session.messages({
            path: { id: input.sessionID },
          });
          const msgs = resp.data ?? [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.info.role === "assistant" && (m.info as any).tokens) {
              modelInputTokens = (m.info as any).tokens.input;
              break;
            }
          }
        } catch {
          /* best-effort */
        }

        // Fetch model context limit.
        try {
          const providers = await ctx.client.config.providers({});
          const providerList = (providers.data as any)?.providers ?? [];
          for (const p of providerList) {
            for (const m of p.models ?? []) {
              if (m.limit?.context) {
                contextLimit = m.limit.context;
                break;
              }
            }
            if (contextLimit) break;
          }
        } catch {
          /* best-effort */
        }

        const display = await buildContextDisplay(state, {
          modelInputTokens,
          contextLimit,
        });

        // Display directly as a message, no LLM call.
        await ctx.client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text: display }],
          },
        });
        throw new Error("__rlm_context_handled__");
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const state = sessionStates.get(input.sessionID);
      if (!state) return;
      output.system.push(
        [
          `## RLM (Recursive Language Model) scaffold`,
          ``,
          `Your full conversation trajectory is logged at: ${state.trajectoryPath}`,
          `Read this file to recall past work after context compaction. It is append-only and managed by the scaffold — do not write to it.`,
          ``,
          `You have a persistent scratch directory at: ${state.varsDir}`,
          `Use it to store plans, notes, intermediate results, or anything that should survive compaction. Prefer structured formats (JSON) so future reads are cheap.`,
          ``,
          `For a single LLM call (no tools, no session), run in bash: llm-subcall "prompt"`,
          `It calls the same model and returns the response directly. Supports --system "system prompt" as an optional flag.`,
          ``,
          `To spawn a subagent (full OpenCode session with tools), run in bash: subagent '<prompt>'`,
          `The subagent creates a child session, runs the prompt with full tool access, and returns the result.`,
          `Beyond depth ${config.maxSubagentDepth}, subagent automatically falls back to llm-subcall.`,
          ``,
          `To run multiple subagents in parallel, run in bash: subagent_batch '<json array of prompts>'`,
          `Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'`,
          `Each prompt runs as a separate subagent concurrently. Results are returned in order.`,
          ``,
          `To list available tool IDs, run in bash: list_tools`,
          ``,
          `These bash helpers are available in every bash invocation, including scripts run via bash.`,
        ].join("\n"),
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

    "shell.env": async (_input: any, output: any) => {
      output.env.RLM_LLM_CONTEXT = llmContextPath;
      output.env.PATH = `${binDir}:${process.env.PATH}`;
      output.env.RLM_MAX_SUBAGENT_DEPTH = String(config.maxSubagentDepth);
      // For list_tools bash helper
      output.env.OPENCODE_RLM_URL = serverUrl;
      output.env.OPENCODE_RLM_DIR_PATH = directory;
      output.env.OPENCODE_AUTH_HEADER = authHeader;
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

      // Inject session ID, depth, and source subagent functions into every bash invocation.
      // Depth is tracked server-side (per-session) so the LM cannot tamper with it.
      if (input.tool === "bash" && output.args?.command) {
        // Block LM attempts to override the depth variable
        if (/OPENCODE_RLM_DEPTH\s*=/.test(output.args.command)) {
          throw new Error(
            "OPENCODE_RLM_DEPTH is managed by the RLM scaffold and cannot be modified. " +
              "Subagent recursion depth is tracked automatically.",
          );
        }

        const depth = sessionDepths.get(input.sessionID) ?? 0;
        output.args.command =
          `export OPENCODE_RLM_SESSION="${input.sessionID}"\n` +
          `export OPENCODE_RLM_DEPTH=${depth}\n` +
          `export BASH_ENV="${functionsPath}"\n` +
          `source "${functionsPath}"\n` +
          output.args.command;
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      const cmd = input.args?.command ?? "";
      if (cmd.includes("subagent_batch")) {
        output.title = "subagent_batch";
      } else if (cmd.includes("subagent ") && !cmd.includes("subagent_batch")) {
        output.title = "subagent";
      }
    },
  };
};
