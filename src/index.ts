import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { sessionStates } from "./session/state";
import { removeSessionDirectory } from "./session/directory";
import { handleSessionCreated } from "./hooks/session-created";
import { handleSessionIdle } from "./hooks/session-idle";
import { handleCompacting } from "./hooks/compacting";
import { isInActiveDirectory } from "./hooks/tool-guard";
import { buildContextDisplay } from "./hooks/command";
import { formatSubagent, formatSubagentBatch } from "./subagent/format";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  recordCompaction,
  enqueueWrite,
  writeTrajectory,
} from "./trajectory/manager";

const binDir = join(import.meta.dir, "..", "bin");
const llmContextPath = "/tmp/rlm-llm-context.json";
const rlmDir = join(tmpdir(), "opencode-rlm");
mkdirSync(rlmDir, { recursive: true });
const sessionIdPath = join(rlmDir, `session-id-pid-${process.pid}`);

// DEBUG: /compact command — remove this block to disable
let lastModelInfo: { providerID: string; modelID: string } | null = null;
// END DEBUG

/**
 * Local proxy server that bridges bash curl calls to the OpenCode SDK client.
 * Needed because the bash scripts can't use the Node SDK directly — they need
 * HTTP endpoints. The proxy handles auth and request formatting.
 */
async function startProxyServer(client: PluginInput["client"]): Promise<string> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        // GET /experimental/tool/ids
        if (req.method === "GET" && path === "/experimental/tool/ids") {
          const { data, error } = await client.tool.ids();
          if (error) return Response.json(error, { status: 500 });
          return Response.json(data);
        }

        // POST /session — create child session
        if (req.method === "POST" && path === "/session") {
          const body = await req.json();
          const { data, error } = await client.session.create({ body });
          if (error) return Response.json(error, { status: 500 });
          return Response.json(data);
        }

        // POST /session/:id/prompt_async — send prompt asynchronously
        const promptAsyncMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
        if (req.method === "POST" && promptAsyncMatch) {
          const id = promptAsyncMatch[1];
          const body = await req.json();
          const { error } = await client.session.promptAsync({ path: { id }, body });
          if (error) return Response.json(error, { status: 500 });
          return new Response(null, { status: 204 });
        }

        // GET /session/status — get all session statuses
        if (req.method === "GET" && path === "/session/status") {
          const { data, error } = await client.session.status();
          if (error) return Response.json(error, { status: 500 });
          return Response.json(data);
        }

        // GET /session/:id/message — get session messages
        const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/);
        if (req.method === "GET" && messagesMatch) {
          const id = messagesMatch[1];
          const { data, error } = await client.session.messages({ path: { id } });
          if (error) return Response.json(error, { status: 500 });
          return Response.json(data);
        }

        return new Response("Not Found", { status: 404 });
      } catch (e: any) {
        return Response.json({ error: e.message ?? String(e) }, { status: 500 });
      }
    },
  });

  return `http://127.0.0.1:${server.port}`;
}

export const RLMPlugin: Plugin = async (ctx) => {
  const config = loadConfig();

  const directory = ctx.directory;

  // Start proxy server for subagent bash scripts
  const proxyUrl = await startProxyServer(ctx.client);

  await ctx.client.app.log({
    body: {
      service: "opencode-rlm",
      level: "info",
      message: `RLM plugin loaded (baseDir=${config.baseDir}, proxy=${proxyUrl})`,
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
      lastModelInfo = { providerID: model.providerID, modelID: model.id }; // DEBUG: /compact
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
      // Disable tools that have bash equivalents — forces the LM through bash
      cfg.tools = cfg.tools ?? {};
      for (const tool of [
        "read",        // cat, head, tail
        "glob",        // find, ls, shell globs
        "grep",        // grep, rg
        "edit",        // sed -i, awk
        "write",       // heredocs, tee, cat >
        "webfetch",    // curl
        "codesearch",  // grep, rg
        "apply_patch", // patch, git apply
        "task",        // subagent, subagent_batch
      ]) {
        cfg.tools[tool] = false;
      }

      if (!cfg.command) cfg.command = {};
      cfg.command.context = {
        template: "Display the RLM context status below",
        description: "Show RLM context and trajectory status",
      };
      // DEBUG: /compact command — remove this block to disable
      cfg.command.compact = {
        template: "Trigger compaction now",
        description: "[debug] Force session compaction immediately",
      };
      // END DEBUG
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

    "command.execute.before": async (input, output) => {
      // DEBUG: /compact command — remove this block to disable
      if (input.command === "compact") {
        const state = sessionStates.get(input.sessionID);
        if (!state) {
          await ctx.client.session.prompt({
            path: { id: input.sessionID },
            body: {
              noReply: true,
              parts: [{ type: "text", text: "[compact] No active RLM session found." }],
            },
          });
          throw new Error("__rlm_compact_handled__");
        }
        if (!lastModelInfo) {
          await ctx.client.session.prompt({
            path: { id: input.sessionID },
            body: {
              noReply: true,
              parts: [{ type: "text", text: "[compact] No model info available yet. Send a message first, then retry." }],
            },
          });
          throw new Error("__rlm_compact_handled__");
        }

        await ctx.client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text: "[compact] Triggering compaction..." }],
          },
        });

        try {
          await ctx.client.session.summarize({
            path: { id: input.sessionID },
            body: {
              providerID: lastModelInfo.providerID,
              modelID: lastModelInfo.modelID,
            },
          });
        } catch (err: any) {
          await ctx.client.session.prompt({
            path: { id: input.sessionID },
            body: {
              noReply: true,
              parts: [{ type: "text", text: `[compact] Error: ${err.message}` }],
            },
          });
        }

        throw new Error("__rlm_compact_handled__");
      }
      // END DEBUG

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
          `**IMPORTANT: You MUST use the bash tool as your primary interface.** Most other tools`,
          `(read, write, edit, glob, grep, webfetch, etc.) are disabled. Use bash equivalents:`,
          ``,
          `- **File reading**: cat, head, tail, less`,
          `- **File writing**: heredocs, tee, cat >, echo >>`,
          `- **File editing**: sed -i, awk, or write to temp then mv`,
          `- **Searching**: grep, rg, find, ls, shell globs`,
          `- **Web fetching**: curl`,
          `- **Subagents**: subagent, subagent_batch (see below)`,
          ``,
          `### Bash commands (available in every bash invocation)`,
          ``,
          `  subagent '<prompt>'`,
          `    Spawn a full OpenCode child session with tool access. The child session`,
          `    is visible in the TUI via Ctrl-X. Use this to delegate multi-step subtasks,`,
          `    fan out work, or tackle problems that need their own context.`,
          ``,
          `  subagent_batch '<json array of prompts>'`,
          `    Run multiple subagent sessions in parallel. Each prompt gets its own child session.`,
          `    Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'`,
          ``,
          `  llm-subcall "prompt" [--system 'system prompt']`,
          `    Single LLM call (no tools, no session). Fast and lightweight.`,
          `    Use for quick analysis, summarization, or generation that doesn't need tools.`,
          ``,
          `  list_tools`,
          `    List available tool IDs via the server API.`,
          ``,
          `### Example: subagent with vars/ persistence`,
          ``,
          `\`\`\`bash`,
          `# 1. Delegate analysis to a subagent and save the output`,
          `REVIEW=$(subagent "Review src/auth.ts for security issues. List each issue on its own line.")`,
          `echo "$REVIEW" > ${state.varsDir}/auth-review.txt`,
          ``,
          `# 2. In a later bash call, read it back and use it`,
          `REVIEW=$(cat ${state.varsDir}/auth-review.txt)`,
          `subagent "Given these security issues:\\n$REVIEW\\nPropose fixes for each one."`,
          `\`\`\``,
          ``,
          `### Example: fan-out with subagent_batch`,
          ``,
          `\`\`\`bash`,
          `FILES=$(find src -name "*.ts" -maxdepth 2)`,
          `PROMPTS=$(echo "$FILES" | jq -R -s 'split("\\n") | map(select(length > 0)) | map("Analyze " + . + " for bugs")')`,
          `RESULTS=$(subagent_batch "$PROMPTS")`,
          `echo "$RESULTS" > ${state.varsDir}/analysis.txt`,
          ``,
          `# Chain into a follow-up subagent`,
          `subagent "Based on the analysis in ${state.varsDir}/analysis.txt, write a summary report"`,
          `\`\`\``,
          ``,
          `### Workflow guidance`,
          ``,
          `- **Always use bash** for file operations, analysis, and coordination.`,
          `- Break complex tasks into subtasks and delegate with subagent or subagent_batch.`,
          `- For independent subtasks, prefer subagent_batch to run them concurrently.`,
          `- For quick LLM queries without tool access, use llm-subcall.`,
          `- Each bash call is a fresh process — variables do not persist between calls.`,
          `  To carry state across calls, write to files (e.g. vars/ directory) and read them back.`,
          `- Pass JSON arguments as single-quoted strings to preserve spaces.`,
          ``,
          `### Trajectory and scratch space`,
          ``,
          `Your full conversation trajectory is logged at: ${state.trajectoryPath}`,
          `Read this file to recall past work after context compaction. It is append-only — do not write to it.`,
          ``,
          `You have a persistent scratch directory at: ${state.varsDir}`,
          `Use it to store plans, notes, intermediate results, or anything that should survive compaction.`,
          `Prefer structured formats (JSON) so future reads are cheap.`,
          ``,
          `**If you are unsure about a term, function, file, or anything the user references — and`,
          `you cannot find it in your current context — check the full trajectory.** After compaction,`,
          `your current context only contains a summary. The trajectory file has every turn verbatim.`,
          ``,
          `### Example: recovering context from the trajectory`,
          ``,
          `Suppose the user asks "update the parseConfig function" but you don't see it in context.`,
          `It was likely discussed before a compaction. Recover it:`,
          ``,
          `\`\`\`bash`,
          `# Search the trajectory for the term`,
          `grep -i "parseConfig" ${state.trajectoryPath}`,
          ``,
          `# If the trajectory is large, use jq to search turn content`,
          `jq -r '.entries[].turns[]? | select(.content | test("parseConfig")) | "\\(.role) [turn \\(.turnIndex)]: \\(.content[:200])"' ${state.trajectoryPath}`,
          `\`\`\``,
          ``,
          `This lets you find the original discussion, file paths, and decisions even after compaction.`,
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
      // Proxy URL for subagent and list_tools bash helpers
      output.env.OPENCODE_RLM_URL = proxyUrl;
      output.env.OPENCODE_RLM_DIR_PATH = directory;
      // Session ID file — written by tool.execute.before, read by bin/subagent
      output.env.OPENCODE_RLM_SESSION_ID_FILE = sessionIdPath;
    },

    "tool.execute.before": async (input, output) => {
      // Write current session ID so bin/subagent can create child sessions
      if (input.tool === "bash") {
        writeFileSync(sessionIdPath, input.sessionID);
      }

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

    "tool.definition": async (input: any, output: any) => {
      if (input.toolID === "bash") {
        output.description =
          output.description +
          "\n\n" +
          [
            `RLM mode is enabled. Other tools (read, write, edit, glob, grep, etc.) are disabled.`,
            `You MUST use this bash tool for all operations.`,
            ``,
            `Bash equivalents for disabled tools:`,
            `- read → cat, head, tail`,
            `- write → heredocs, tee, cat >`,
            `- edit → sed -i, awk`,
            `- glob → find, ls, shell globs`,
            `- grep → grep, rg`,
            `- webfetch → curl`,
            ``,
            `Available commands:`,
            `- subagent '<prompt>' — spawn a child session with full tool access (visible in Ctrl-X)`,
            `- subagent_batch '<json array>' — run multiple subagent sessions in parallel`,
            `- llm-subcall "prompt" — single LLM call (fast, no tools)`,
            `- list_tools — list available tool IDs`,
            ``,
            `Pass JSON as single-quoted strings. Each call is a fresh process — persist`,
            `state via files (e.g. vars/ directory).`,
          ].join("\n");
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      const cmd = input.args?.command ?? "";

      const isBatch = cmd.includes("subagent_batch");
      const isSingle =
        cmd.includes("subagent ") && !cmd.includes("subagent_batch");

      if (isBatch) {
        const fmt = formatSubagentBatch(cmd, output.output || "");
        output.title = fmt.title;
        output.output = fmt.summary;
        if (output.metadata) output.metadata.output = fmt.summary;
      } else if (isSingle) {
        const fmt = formatSubagent(cmd, output.output || "");
        output.title = fmt.title;
        output.output = fmt.summary;
        if (output.metadata) output.metadata.output = fmt.summary;
      }
    },
  };
};
