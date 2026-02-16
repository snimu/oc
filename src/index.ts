import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { sessionStates } from "./session/state";
import { removeSessionDirectory } from "./session/directory";
import { handleSessionCreated } from "./hooks/session-created";
import { handleSessionIdle } from "./hooks/session-idle";
import { handleCompacting } from "./hooks/compacting";
import { isInActiveDirectory } from "./hooks/tool-guard";
import { buildContextDisplay } from "./hooks/command";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  recordCompaction,
  enqueueWrite,
  writeTrajectory,
} from "./trajectory/manager";

const llmContextPath = "/tmp/rlm-llm-context.json";

/**
 * Generate the bash functions script that gets sourced into every bash invocation.
 * This is the same pattern snimu/opencode-rlm uses — functions are defined at source
 * time so they're available immediately in the bash process.
 */
function buildBashFunctionsScript(sessionIdPath: string, llmCliPath: string): string {
  return `#!/usr/bin/env bash
export OPENCODE_RLM_SESSION="\$(cat "${sessionIdPath}")"
export OPENCODE_RLM_DEPTH="\${OPENCODE_RLM_DEPTH:-0}"

# llm-subcall: single LLM call (no tools, no session)
llm-subcall() {
  bun "${llmCliPath}" "$@"
}

# Build indent prefix based on nesting depth
_rlm_indent() {
  local d=\${OPENCODE_RLM_DEPTH:-0}
  local prefix=""
  for ((k=0; k<d; k++)); do prefix="  \${prefix}"; done
  printf '%s' "$prefix"
}

list_tools() {
  local auth_args=()
  if [[ -n "$OPENCODE_AUTH_HEADER" ]]; then auth_args=(-H "$OPENCODE_AUTH_HEADER"); fi
  curl -sS "$OPENCODE_RLM_URL/experimental/tool/ids" \\
    "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH"
}

# subagent: calls the streaming /session/run endpoint.
# The proxy handles session creation, prompting, polling, and progress streaming.
# Progress lines (tool calls) go to stderr; the final result goes to stdout.
#
# Usage:
#   subagent 'prompt'            — prompt as argument
#   subagent <<'EOF'             — prompt via heredoc (safest for complex prompts)
#   ...complex prompt...
#   EOF
#   echo "prompt" | subagent     — prompt via pipe
subagent() {
  local prompt="\${1:-}"
  if [[ -z "$prompt" && ! -t 0 ]]; then
    prompt=\$(cat)
  fi
  if [[ -z "$prompt" ]]; then echo "Usage: subagent '<prompt>' or subagent <<'EOF'" >&2; return 2; fi
  local H="content-type: application/json"
  local auth_args=()
  if [[ -n "$OPENCODE_AUTH_HEADER" ]]; then auth_args=(-H "$OPENCODE_AUTH_HEADER"); fi
  local indent
  indent=$(_rlm_indent)

  # Build JSON body safely with jq (handles all special chars in prompt)
  local body
  body=$(jq -n --arg pid "$OPENCODE_RLM_SESSION" --arg p "$prompt" \\
    '{parentID: $pid, prompt: $p}')

  # Header
  local prompt_preview
  prompt_preview=$(printf '%s' "$prompt" | head -c 80)
  [[ \${#prompt} -gt 80 ]] && prompt_preview="\${prompt_preview}..."
  printf '%s┌─ subagent ─────────────────────\\n' "$indent" >&2
  printf '%s│ %s\\n' "$indent" "$prompt_preview" >&2
  printf '%s├───────────────────────────────\\n' "$indent" >&2

  # Call streaming endpoint — each line is a JSON event
  local result=""
  local had_error=0
  while IFS= read -r line; do
    local etype
    etype=$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null)
    local etext
    etext=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null)

    case "$etype" in
      progress)
        printf '%s│ %s\\n' "$indent" "$etext" >&2
        ;;
      result)
        result="$etext"
        ;;
      error)
        printf '%s│ [error] %s\\n' "$indent" "$etext" >&2
        had_error=1
        ;;
    esac
  done < <(curl -sS -N -X POST "$OPENCODE_RLM_URL/session/run" \\
    -H "$H" "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH" \\
    -d "$body")

  # Footer with output preview
  printf '%s├─ output ──────────────────────\\n' "$indent" >&2
  if [[ -n "$result" ]]; then
    local result_preview
    result_preview=$(printf '%s' "$result" | head -c 120 | tr '\\n' ' ')
    [[ \${#result} -gt 120 ]] && result_preview="\${result_preview}..."
    printf '%s│ %s\\n' "$indent" "$result_preview" >&2
  else
    printf '%s│ (no output)\\n' "$indent" >&2
  fi
  printf '%s└───────────────────────────────\\n' "$indent" >&2

  if [[ $had_error -eq 1 && -z "$result" ]]; then
    return 1
  fi
  printf '%s' "$result"
}

subagent_batch() {
  local json="$1"
  if [[ -z "$json" ]]; then echo "subagent_batch <json array>" >&2; return 2; fi
  local tmpdir
  tmpdir=$(mktemp -d)
  local pids=()
  local i=0
  local depth=\${OPENCODE_RLM_DEPTH:-0}
  local indent
  indent=$(_rlm_indent)

  local count
  count=$(printf '%s' "$json" | jq 'length')
  printf '%s┌─ subagent_batch (%s agents) ──\\n' "$indent" "$count" >&2

  # Increment depth for child subagents
  export OPENCODE_RLM_DEPTH=$((depth + 1))

  while IFS= read -r prompt; do
    ( subagent "$prompt" > "$tmpdir/$i.out" 2>"$tmpdir/$i.err" ) &
    pids+=($!)
    i=$((i + 1))
  done < <(printf '%s' "$json" | jq -r '.[]')

  local total=$i
  for pid in "\${pids[@]}"; do wait "$pid"; done

  # Restore depth
  export OPENCODE_RLM_DEPTH=$depth

  local succeeded=0
  local failed=0
  local out err
  for ((j=0; j<total; j++)); do
    printf '%s├─ Agent %d/%d ─────────────────\\n' "$indent" "$((j + 1))" "$total" >&2
    out=$(cat "$tmpdir/$j.out")
    err=$(cat "$tmpdir/$j.err")
    if [[ -n "$out" ]]; then
      # Show progress from stderr (contains the subagent's box output)
      if [[ -n "$err" ]]; then
        printf '%s' "$err" | while IFS= read -r line; do
          printf '%s│ %s\\n' "$indent" "$line" >&2
        done
      fi
      printf '%s\\n' "$out"
      succeeded=$((succeeded + 1))
    elif [[ -n "$err" ]]; then
      printf '%s│ %s\\n' "$indent" "$err" >&2
      printf '[error] %s\\n' "$err"
      failed=$((failed + 1))
    else
      printf '%s│ [no output]\\n' "$indent" >&2
      printf '[no output]\\n'
      failed=$((failed + 1))
    fi
  done
  printf '%s└─ %d/%d agents completed ──────\\n' "$indent" "$succeeded" "$total" >&2
  rm -rf "$tmpdir"
}
`;
}

/** Set of session IDs created via the proxy (i.e. child/subagent sessions). */
const childSessionIds = new Set<string>();

/**
 * Format a tool call part for streaming display.
 */
function formatToolPart(part: any): string | null {
  const toolState = part.state;
  const toolName = part.tool ?? "unknown";
  const status = toolState?.status ?? "running";

  if (status === "running" || status === "pending") {
    const input = toolState?.input;
    let detail = "";
    if (toolName === "bash" && input?.command) {
      // Strip the sourced functions.sh prefix from display
      let cmd = input.command.replace(/^source "[^"]*functions\.sh"\n/, "").trim();
      cmd = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
      detail = `: ${cmd}`;
    } else if (input) {
      const s = JSON.stringify(input);
      detail = s.length > 80 ? `: ${s.slice(0, 80)}…` : `: ${s}`;
    }
    return `  ⟳ ${toolName}${detail}`;
  }

  if (status === "completed") {
    const rawOutput = typeof toolState.output === "string"
      ? toolState.output
      : JSON.stringify(toolState.output ?? "");
    // Truncate output for preview
    const preview = rawOutput.length > 120 ? rawOutput.slice(0, 120) + "…" : rawOutput;
    return `  ✓ ${toolName} → ${preview.replace(/\n/g, " ")}`;
  }

  if (status === "error") {
    return `  ✗ ${toolName}: ${toolState.error ?? "unknown error"}`;
  }

  return null;
}

/**
 * Local proxy server that bridges bash curl calls to the OpenCode SDK client.
 * The key endpoint is POST /session/run which creates a child session,
 * sends a prompt, polls for completion, and streams tool call progress
 * as newline-delimited JSON events.
 */
async function startProxyServer(
  client: PluginInput["client"],
): Promise<string> {
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
          if (data && (data as any).id) {
            childSessionIds.add((data as any).id);
          }
          return Response.json(data);
        }

        // POST /session/run — create session, prompt, stream progress, return result
        // Body: { parentID, prompt }
        // Response: newline-delimited JSON events:
        //   {"type":"progress","text":"..."} — tool call progress (for stderr)
        //   {"type":"result","text":"..."}   — final assistant message (for stdout)
        //   {"type":"error","text":"..."}    — error message
        if (req.method === "POST" && path === "/session/run") {
          const body = await req.json();
          const { parentID, prompt } = body;

          // Stream response
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              const send = (obj: any) => {
                controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
              };

              try {
                // 1. Create child session
                const { data: sess, error: createErr } = await client.session.create({
                  body: { parentID },
                });
                if (createErr || !sess) {
                  send({ type: "error", text: `Failed to create session: ${JSON.stringify(createErr)}` });
                  controller.close();
                  return;
                }
                const sid = (sess as any).id;
                childSessionIds.add(sid);

                // 2. Send prompt async
                const { error: promptErr } = await client.session.promptAsync({
                  path: { id: sid },
                  body: {
                    parts: [{ type: "text", text: prompt }],
                    agent: "general",
                  },
                });
                if (promptErr) {
                  send({ type: "error", text: `Failed to send prompt: ${JSON.stringify(promptErr)}` });
                  controller.close();
                  return;
                }

                // 3. Poll for completion, streaming tool call progress
                // Race condition fix: after promptAsync returns, the session may still
                // show "idle" for a brief moment before transitioning to "busy".
                // We must wait until we've seen "busy" at least once before treating
                // a non-busy status as completion.
                let seenParts = new Set<string>();
                let seenBusy = false;
                let idleRetries = 0;
                const MAX_IDLE_RETRIES = 20; // up to 10s waiting for session to start
                while (true) {
                  // Check status
                  const { data: statuses } = await client.session.status();
                  const status = statuses ? (statuses as any)[sid]?.type ?? "idle" : "idle";
                  if (status === "busy") {
                    seenBusy = true;
                    idleRetries = 0;
                  } else if (!seenBusy) {
                    // Haven't seen busy yet — session might not have started processing
                    idleRetries++;
                    if (idleRetries >= MAX_IDLE_RETRIES) {
                      send({ type: "error", text: "Timed out waiting for session to start" });
                      break;
                    }
                    await new Promise((r) => setTimeout(r, 500));
                    continue;
                  } else {
                    // Was busy, now done
                    break;
                  }

                  // Fetch messages and stream new tool calls
                  try {
                    const { data: msgs } = await client.session.messages({ path: { id: sid } });
                    if (msgs && Array.isArray(msgs)) {
                      for (const msg of msgs) {
                        if (msg.info?.role !== "assistant") continue;
                        for (const part of msg.parts ?? []) {
                          if (part.type !== "tool") continue;
                          const partKey = `${(part as any).id ?? ""}:${(part as any).state?.status ?? ""}`;
                          if (seenParts.has(partKey)) continue;
                          seenParts.add(partKey);
                          const line = formatToolPart(part);
                          if (line) send({ type: "progress", text: line });
                        }
                      }
                    }
                  } catch {
                    // Best-effort progress
                  }

                  await new Promise((r) => setTimeout(r, 500));
                }

                // 4. Fetch final result
                const { data: finalMsgs } = await client.session.messages({ path: { id: sid } });
                let result = "";
                if (finalMsgs && Array.isArray(finalMsgs)) {
                  // Get last assistant message's text
                  for (let i = finalMsgs.length - 1; i >= 0; i--) {
                    const msg = finalMsgs[i];
                    if (msg.info?.role === "assistant") {
                      const textParts = (msg.parts ?? [])
                        .filter((p: any) => p.type === "text")
                        .map((p: any) => p.text ?? "");
                      result = textParts.join("\n");

                      // Also send final tool call states
                      for (const part of msg.parts ?? []) {
                        if (part.type !== "tool") continue;
                        const line = formatToolPart(part);
                        if (line) send({ type: "progress", text: line });
                      }
                      break;
                    }
                  }
                }

                send({ type: "result", text: result || "(no response)" });
              } catch (e: any) {
                send({ type: "error", text: e.message ?? String(e) });
              }

              controller.close();
            },
          });

          return new Response(stream, {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        // POST /session/:id/prompt_async
        const promptAsyncMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
        if (req.method === "POST" && promptAsyncMatch) {
          const id = promptAsyncMatch[1];
          const body = await req.json();
          const { error } = await client.session.promptAsync({ path: { id }, body });
          if (error) return Response.json(error, { status: 500 });
          return new Response(null, { status: 204 });
        }

        // GET /session/status
        if (req.method === "GET" && path === "/session/status") {
          const { data, error } = await client.session.status();
          if (error) return Response.json(error, { status: 500 });
          return Response.json(data);
        }

        // GET /session/:id/message
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

  const log = async (msg: string) => {
    await ctx.client.app.log({
      body: { service: "opencode-rlm", level: "info", message: msg },
    });
  };

  // Auth header for proxy (same as snimu)
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const authHeader = password
    ? `authorization: Basic ${btoa(`${username}:${password}`)}`
    : "";

  // Start proxy server for subagent bash functions
  const proxyUrl = await startProxyServer(ctx.client);

  // Write bash functions to a file; source it in tool.execute.before (snimu pattern)
  const rlmDir = join(tmpdir(), "opencode-rlm");
  mkdirSync(rlmDir, { recursive: true });
  const functionsPath = join(rlmDir, "functions.sh");
  const sessionIdPath = join(rlmDir, "session_id");
  const llmCliPath = join(import.meta.dir, "llm-cli.ts");
  writeFileSync(functionsPath, buildBashFunctionsScript(sessionIdPath, llmCliPath), { mode: 0o755 });

  const maxOutput = parseInt(process.env.OPENCODE_RLM_MAX_OUTPUT ?? "8192", 10);

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
      for (const disabledTool of [
        "read",        // cat, head, tail
        "glob",        // find, ls, shell globs
        "grep",        // grep, rg
        "edit",        // sed -i, awk
        "write",       // heredocs, tee, cat >
        "webfetch",    // curl
        "codesearch",  // grep, rg
        "apply_patch", // patch, git apply
        "task",        // use bash subagent instead
      ]) {
        cfg.tools[disabledTool] = false;
      }

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

          // Skip child sessions (created by subagent via proxy) — they don't need
          // trajectory tracking, directories, or compaction handling.
          // This matches snimu's behavior where only root sessions are tracked.
          if (childSessionIds.has(sessionId)) {
            return;
          }

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
          // Skip child sessions (not in sessionStates since we skipped session.created)
          if (!sessionStates.has(sessionId)) return;
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
          childSessionIds.delete(sessionId); // cleanup tracking
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
      if (input.command === "context") {
        const state = sessionStates.get(input.sessionID);
        if (!state) return;

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
          `    Spawn a full OpenCode child session with tool access.`,
          `    Tool calls and progress are streamed to stderr during execution.`,
          `    The final result is returned on stdout.`,
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
          `### Example: fan-out with subagent_batch`,
          ``,
          `\`\`\`bash`,
          `FILES=$(find src -name "*.ts" -maxdepth 2)`,
          `PROMPTS=$(echo "$FILES" | jq -R -s 'split("\\n") | map(select(length > 0)) | map("Analyze " + . + " for bugs")')`,
          `RESULTS=$(subagent_batch "$PROMPTS")`,
          `echo "$RESULTS" > ${state.varsDir}/analysis.txt`,
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
      // Proxy URL and directory for subagent bash functions
      output.env.OPENCODE_RLM_URL = proxyUrl;
      output.env.OPENCODE_RLM_DIR_PATH = directory;
      output.env.OPENCODE_AUTH_HEADER = authHeader;
    },

    "tool.execute.before": async (input, output) => {
      // Source bash functions into every bash command (snimu pattern)
      if (input.tool === "bash" && output.args?.command) {
        writeFileSync(sessionIdPath, input.sessionID);
        output.args.command = `source "${functionsPath}"\n` + output.args.command;
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
            `Additional bash helpers:`,
            `- subagent '<prompt>' — spawn a child session with tool access (streams progress)`,
            `- subagent_batch '<json array>' — run multiple child sessions in parallel`,
            `- llm-subcall "prompt" — single LLM call (fast, no tools)`,
            `- list_tools — list available tool IDs`,
            ``,
            `Bash equivalents for disabled tools:`,
            `- read → cat, head, tail`,
            `- write → heredocs, tee, cat >`,
            `- edit → sed -i, awk`,
            `- glob → find, ls, shell globs`,
            `- grep → grep, rg`,
            `- webfetch → curl`,
            ``,
            `Pass JSON as single-quoted strings. Each call is a fresh process — persist`,
            `state via files (e.g. vars/ directory).`,
          ].join("\n");
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      const cmd = input.args?.command ?? "";

      // Set descriptive title for subagent calls
      if (cmd.includes("subagent_batch")) {
        output.title = "subagent_batch";
      } else if (cmd.includes("subagent ") && !cmd.includes("subagent_batch")) {
        output.title = "subagent";
      }

      // Truncate long output
      if (maxOutput > 0 && output.output && output.output.length > maxOutput) {
        const half = Math.floor(maxOutput / 2);
        const trimmed = output.output.length - maxOutput;
        output.output =
          output.output.slice(0, half) +
          `\n\n... [${trimmed} characters truncated] ...\n\n` +
          output.output.slice(-half);
      }
    },
  };
};
