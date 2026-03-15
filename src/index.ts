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
import {
  recordCompaction,
  enqueueWrite,
  writeTrajectory,
} from "./trajectory/manager";
import {
  example1Bash,
  example2Bash,
  example3Bash,
} from "./system-prompt-examples";
import { runSubAgent } from "./sub-agent";

const llmContextPath = "/tmp/rlm/llm-context.json";

/**
 * Generate the bash functions script that gets sourced into every bash invocation.
 * This is the same pattern snimu/opencode-rlm uses — functions are defined at source
 * time so they're available immediately in the bash process.
 */
function buildBashFunctionsScript(sessionIdPath: string, llmCliPath: string): string {
  return `#!/usr/bin/env bash
# Enable bash emulation mode in zsh for this file and all functions defined in it
[[ -n "$ZSH_VERSION" ]] && emulate -L bash 2>/dev/null
export OPENCODE_RLM_SESSION="\$(cat "${sessionIdPath}")"
export OPENCODE_RLM_DEPTH="\${OPENCODE_RLM_DEPTH:-0}"

# llm-subcall: single LLM call (no tools, no session)
# Usage:
#   llm-subcall "prompt"
#   llm-subcall --system "sys" "prompt"
#   llm-subcall <<'EOF'            — prompt via heredoc
#   ...complex prompt...
#   EOF
#   llm-subcall --system "sys" <<'EOF'
#   ...complex prompt...
#   EOF
llm-subcall() {
  # If stdin is not a terminal (heredoc/pipe), read prompt from stdin
  # and append it as the last argument (works with or without --system)
  if [[ ! -t 0 ]]; then
    local stdin_prompt
    stdin_prompt=\$(cat)
    bun "${llmCliPath}" "$@" "$stdin_prompt"
  else
    bun "${llmCliPath}" "$@"
  fi
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
  local max_depth=\${RLM_MAX_DEPTH:-3}
  if [[ \${OPENCODE_RLM_DEPTH:-0} -ge $max_depth ]]; then
    echo "Maximum recursion depth ($max_depth) reached. Use llm-subcall instead." >&2
    return 1
  fi
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
  local etype=""
  local etext=""
  while IFS= read -r _rlm_line; do
    [[ -z "$_rlm_line" ]] && continue
    etype="$(printf '%s' "$_rlm_line" | jq -r '.type // empty' 2>/dev/null)" || etype=""
    etext="$(printf '%s' "$_rlm_line" | jq -r '.text // empty' 2>/dev/null)" || etext=""

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
      heartbeat)
        # keep-alive, ignore
        ;;
    esac
  done < <(curl -sS -N --max-time 300 -X POST "$OPENCODE_RLM_URL/session/run" \\
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

# subagent_batch: calls the streaming /session/run-batch endpoint.
# All sessions run in parallel on the server. Progress is streamed live
# with agent labels. Once all agents finish, the interleaved output is
# wiped and replaced with a clean grouped-by-agent view.
subagent_batch() {
  local json="\${1:-}"
  if [[ -z "$json" && ! -t 0 ]]; then
    json=\$(cat)
  fi
  if [[ -z "$json" ]]; then echo "Usage: subagent_batch '<json array>' or subagent_batch <<'EOF'" >&2; return 2; fi

  local H="content-type: application/json"
  local auth_args=()
  if [[ -n "$OPENCODE_AUTH_HEADER" ]]; then auth_args=(-H "$OPENCODE_AUTH_HEADER"); fi
  local indent
  indent=$(_rlm_indent)

  local count
  count=$(printf '%s' "$json" | jq 'length' 2>/dev/null) || count="?"

  # Build JSON body safely with jq
  local body
  body=$(jq -n --arg pid "$OPENCODE_RLM_SESSION" --argjson prompts "$json" \\
    '{parentID: $pid, prompts: $prompts}')

  # Header (2 lines — counted for ANSI wipe later)
  printf '%s┌─ subagent_batch (%s agents) ──\\n' "$indent" "$count" >&2
  printf '%s├───────────────────────────────\\n' "$indent" >&2
  local line_count=2

  # Temp dir for per-agent progress logs and results
  local batch_dir="/tmp/rlm/batch-$$-$RANDOM"
  mkdir -p "$batch_dir"

  local succeeded=0
  local total_done=0
  local had_error=0
  local etype=""
  local etext=""
  local eagent=""

  while IFS= read -r _rlm_line; do
    [[ -z "$_rlm_line" ]] && continue
    etype="$(printf '%s' "$_rlm_line" | jq -r '.type // empty' 2>/dev/null)" || etype=""
    etext="$(printf '%s' "$_rlm_line" | jq -r '.text // empty' 2>/dev/null)" || etext=""
    eagent="$(printf '%s' "$_rlm_line" | jq -r '.agent // empty' 2>/dev/null)" || eagent=""

    case "$etype" in
      progress)
        if [[ "$eagent" == "-1" ]]; then
          printf '%s│ %s\\n' "$indent" "$etext" >&2
          line_count=\$((line_count + 1))
        else
          local anum=\$((eagent + 1))
          local line_text="[Sub-agent \${anum}] \${etext}"
          printf '%s│ %s\\n' "$indent" "$line_text" >&2
          line_count=\$((line_count + 1))
          # Buffer per-agent progress for grouped replay
          printf '%s\\n' "$etext" >> "$batch_dir/progress_$eagent"
        fi
        ;;
      result)
        local anum=\$((eagent + 1))
        # Store result for ordered output
        printf '%s' "$etext" > "$batch_dir/result_$eagent"
        local rpreview
        rpreview=$(printf '%s' "$etext" | head -c 80 | tr '\\n' ' ')
        [[ \${#etext} -gt 80 ]] && rpreview="\${rpreview}..."
        printf '%s│ [Sub-agent %s] ✓ done: %s\\n' "$indent" "$anum" "$rpreview" >&2
        line_count=\$((line_count + 1))
        ;;
      error)
        if [[ "$eagent" == "-1" ]]; then
          printf '%s│ [error] %s\\n' "$indent" "$etext" >&2
          line_count=\$((line_count + 1))
        else
          local anum=\$((eagent + 1))
          printf '%s│ [Sub-agent %s] ✗ %s\\n' "$indent" "$anum" "$etext" >&2
          line_count=\$((line_count + 1))
          printf '✗ %s\\n' "$etext" >> "$batch_dir/progress_$eagent"
        fi
        had_error=1
        ;;
      done)
        succeeded="$(printf '%s' "$_rlm_line" | jq -r '.succeeded // 0' 2>/dev/null)" || succeeded=0
        total_done="$(printf '%s' "$_rlm_line" | jq -r '.total // 0' 2>/dev/null)" || total_done=0
        ;;
      heartbeat)
        ;;
    esac
  done < <(curl -sS -N --max-time 600 -X POST "$OPENCODE_RLM_URL/session/run-batch" \\
    -H "$H" "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH" \\
    -d "$body")

  # ── Wipe interleaved output and reprint grouped by agent ──
  # Move cursor up by line_count lines, then clear to end of screen
  printf '\\033[%dA\\033[J' "$line_count" >&2

  # Reprint header
  printf '%s┌─ subagent_batch (%s/%s succeeded) ──\\n' "$indent" "$succeeded" "$total_done" >&2
  printf '%s├───────────────────────────────\\n' "$indent" >&2

  # Print each agent's progress grouped together
  local i=0
  while [[ $i -lt \${count:-0} ]]; do
    local anum=\$((i + 1))
    printf '%s│\\n' "$indent" >&2
    printf '%s│ ┌ Sub-agent %s\\n' "$indent" "$anum" >&2
    # Show buffered progress lines indented under this agent
    if [[ -f "$batch_dir/progress_$i" ]]; then
      while IFS= read -r pline; do
        printf '%s│ │ %s\\n' "$indent" "$pline" >&2
      done < "$batch_dir/progress_$i"
    fi
    # Show result preview
    if [[ -f "$batch_dir/result_$i" ]]; then
      local res
      res=$(cat "$batch_dir/result_$i")
      local rpreview
      rpreview=$(printf '%s' "$res" | head -c 100 | tr '\\n' ' ')
      [[ \${#res} -gt 100 ]] && rpreview="\${rpreview}..."
      printf '%s│ └ ✓ %s\\n' "$indent" "$rpreview" >&2
    else
      printf '%s│ └ ✗ (no output)\\n' "$indent" >&2
    fi
    i=\$((i + 1))
  done

  # Footer + results on stdout
  printf '%s├─ output ──────────────────────\\n' "$indent" >&2
  i=0
  while [[ $i -lt \${count:-0} ]]; do
    if [[ -f "$batch_dir/result_$i" ]]; then
      local res
      res=$(cat "$batch_dir/result_$i")
      if [[ -n "$res" ]]; then
        printf '%s\\n' "$res"
      fi
    fi
    i=\$((i + 1))
  done

  printf '%s└───────────────────────────────\\n' "$indent" >&2
  rm -rf "$batch_dir"

  if [[ $had_error -eq 1 && $succeeded -eq 0 ]]; then
    return 1
  fi
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
    } else if (toolName === "bash" && (!input || !input.command)) {
      // Bash tool call still being assembled (streaming) — skip for now
      return null;
    } else if (input) {
      const s = JSON.stringify(input);
      if (s === "{}" || s === "null") {
        return null; // Input not populated yet
      }
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
    idleTimeout: 255, // seconds; subagent calls can take minutes
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

          // --- Verifiers mode: custom tool-calling loop ---
          if (process.env.RLM_SUBAGENT_VIA_TOOL_LOOP) {
            const rlmDir = process.env.RLM_BASE_DIR || "/tmp/rlm";
            const fPath = join(rlmDir, "functions.sh");
            const mOutput = parseInt(process.env.OPENCODE_RLM_MAX_OUTPUT ?? "8192", 10);
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              async start(controller) {
                const send = (obj: any) => {
                  try {
                    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
                  } catch { /* stream closed */ }
                };
                try {
                  const result = await runSubAgent({
                    prompt,
                    model: process.env.RLM_SUB_MODEL_ID || "sub",
                    baseUrl: process.env.OPENAI_BASE_URL!,
                    apiKey: process.env.OPENAI_API_KEY || "intercepted",
                    maxTurns: parseInt(process.env.RLM_SUB_MAX_TURNS || "10", 10),
                    timeoutMs: parseInt(process.env.RLM_SUB_TIMEOUT || "120000", 10),
                    functionsPath: fPath,
                    depth: parseInt(process.env.OPENCODE_RLM_DEPTH || "0", 10),
                    maxOutputChars: mOutput,
                    onProgress: (text) => send({ type: "progress", text }),
                  });
                  send({ type: "result", text: result.content });
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
          // --- End verifiers mode ---

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
                //
                // Key race conditions handled:
                // a) After promptAsync, the session may still be "idle" briefly before
                //    becoming "busy". We wait up to MAX_IDLE_RETRIES before giving up.
                // b) Between consecutive tool calls, the session may go briefly "idle"
                //    before the next tool call starts. We require IDLE_COOLDOWN
                //    consecutive idle polls after having seen "busy" before declaring done.
                let seenParts = new Set<string>();
                let seenBusy = false;
                let initialIdleRetries = 0;
                let consecutiveIdle = 0;
                const MAX_IDLE_RETRIES = 30; // up to 15s waiting for session to start
                const IDLE_COOLDOWN = 6;     // 3s of idle after busy = truly done
                const POLL_INTERVAL = 500;
                let heartbeatCounter = 0;

                while (true) {
                  // Send periodic heartbeats to keep the HTTP stream alive
                  heartbeatCounter++;
                  if (heartbeatCounter % 4 === 0) {
                    send({ type: "heartbeat" });
                  }

                  // Check status
                  let status = "idle";
                  try {
                    const { data: statuses } = await client.session.status();
                    status = statuses ? (statuses as any)[sid]?.type ?? "idle" : "idle";
                  } catch {
                    // If status check fails, assume still running
                    if (seenBusy) status = "busy";
                  }

                  if (status === "busy") {
                    seenBusy = true;
                    consecutiveIdle = 0;
                  } else if (!seenBusy) {
                    // Haven't seen busy yet — session might not have started processing
                    initialIdleRetries++;
                    if (initialIdleRetries >= MAX_IDLE_RETRIES) {
                      send({ type: "error", text: "Timed out waiting for session to start" });
                      break;
                    }
                    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
                    continue;
                  } else {
                    // Was busy, now idle — but might go busy again between tool calls.
                    // Wait for several consecutive idle polls before declaring done.
                    consecutiveIdle++;
                    if (consecutiveIdle >= IDLE_COOLDOWN) {
                      break; // truly done
                    }
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

                  await new Promise((r) => setTimeout(r, POLL_INTERVAL));
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

        // POST /session/run-batch — create N sessions, prompt all, stream interleaved progress
        // Body: { parentID, prompts: string[] }
        // Response: newline-delimited JSON events:
        //   {"type":"progress","agent":0,"text":"..."} — tool call progress
        //   {"type":"result","agent":0,"text":"..."}   — final result for agent N
        //   {"type":"done","succeeded":N,"total":M}    — all agents finished
        //   {"type":"error","agent":0,"text":"..."}    — error for agent N
        //   {"type":"heartbeat"}                       — keep-alive
        if (req.method === "POST" && path === "/session/run-batch") {
          const body = await req.json();
          const { parentID, prompts } = body as { parentID: string; prompts: string[] };

          if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
            return Response.json({ error: "prompts must be a non-empty array" }, { status: 400 });
          }

          // --- Verifiers mode: parallel custom tool-calling loops ---
          if (process.env.RLM_SUBAGENT_VIA_TOOL_LOOP) {
            const rlmDir = process.env.RLM_BASE_DIR || "/tmp/rlm";
            const fPath = join(rlmDir, "functions.sh");
            const mOutput = parseInt(process.env.OPENCODE_RLM_MAX_OUTPUT ?? "8192", 10);
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              async start(controller) {
                const send = (obj: any) => {
                  try {
                    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
                  } catch { /* stream closed */ }
                };

                const total = prompts.length;
                send({ type: "progress", agent: -1, text: `Started ${total} sub-agents` });

                const results = await Promise.all(
                  prompts.map(async (p: string, i: number) => {
                    try {
                      const result = await runSubAgent({
                        prompt: p,
                        model: process.env.RLM_SUB_MODEL_ID || "sub",
                        baseUrl: process.env.OPENAI_BASE_URL!,
                        apiKey: process.env.OPENAI_API_KEY || "intercepted",
                        maxTurns: parseInt(process.env.RLM_SUB_MAX_TURNS || "10", 10),
                        timeoutMs: parseInt(process.env.RLM_SUB_TIMEOUT || "120000", 10),
                        functionsPath: fPath,
                        depth: parseInt(process.env.OPENCODE_RLM_DEPTH || "0", 10),
                        maxOutputChars: mOutput,
                        onProgress: (text) => send({ type: "progress", agent: i, text }),
                      });
                      send({ type: "result", agent: i, text: result.content });
                      return result.content;
                    } catch (e: any) {
                      send({ type: "error", agent: i, text: e.message ?? String(e) });
                      return "";
                    }
                  }),
                );

                const succeeded = results.filter((r) => r).length;
                send({ type: "done", succeeded, total });
                controller.close();
              },
            });
            return new Response(stream, {
              headers: { "content-type": "application/x-ndjson" },
            });
          }
          // --- End verifiers mode ---

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              const send = (obj: any) => {
                try {
                  controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
                } catch { /* stream closed */ }
              };

              try {
                const total = prompts.length;

                // 1. Create all child sessions
                const sessions: Array<{ id: string; prompt: string; agentIdx: number }> = [];
                for (let i = 0; i < total; i++) {
                  const { data: sess, error: createErr } = await client.session.create({
                    body: { parentID },
                  });
                  if (createErr || !sess) {
                    send({ type: "error", agent: i, text: `Failed to create session: ${JSON.stringify(createErr)}` });
                    continue;
                  }
                  const sid = (sess as any).id;
                  childSessionIds.add(sid);
                  sessions.push({ id: sid, prompt: prompts[i], agentIdx: i });
                }

                // 2. Send prompts to all sessions (don't await sequentially — fire them off)
                await Promise.all(sessions.map(async (s) => {
                  const { error: promptErr } = await client.session.promptAsync({
                    path: { id: s.id },
                    body: {
                      parts: [{ type: "text", text: s.prompt }],
                      agent: "general",
                    },
                  });
                  if (promptErr) {
                    send({ type: "error", agent: s.agentIdx, text: `Failed to send prompt: ${JSON.stringify(promptErr)}` });
                  }
                }));

                send({ type: "progress", agent: -1, text: `Started ${sessions.length}/${total} agents` });

                // 3. Poll all sessions, streaming interleaved progress
                const seenPartsPerAgent = new Map<string, Set<string>>();
                const completedAgents = new Set<number>();
                const results = new Map<number, string>();
                const seenBusyPerAgent = new Map<string, boolean>();
                const idleCountPerAgent = new Map<string, number>();
                const IDLE_COOLDOWN = 6;
                const POLL_INTERVAL = 500;
                let heartbeatCounter = 0;

                for (const s of sessions) {
                  seenPartsPerAgent.set(s.id, new Set());
                  seenBusyPerAgent.set(s.id, false);
                  idleCountPerAgent.set(s.id, 0);
                }

                while (completedAgents.size < sessions.length) {
                  // Heartbeat
                  heartbeatCounter++;
                  if (heartbeatCounter % 4 === 0) {
                    send({ type: "heartbeat" });
                  }

                  // Check status of all sessions at once
                  let allStatuses: any = {};
                  try {
                    const { data: statuses } = await client.session.status();
                    allStatuses = statuses ?? {};
                  } catch { /* continue */ }

                  for (const s of sessions) {
                    if (completedAgents.has(s.agentIdx)) continue;

                    const status = allStatuses[s.id]?.type ?? "idle";
                    const seenBusy = seenBusyPerAgent.get(s.id)!;

                    if (status === "busy") {
                      seenBusyPerAgent.set(s.id, true);
                      idleCountPerAgent.set(s.id, 0);
                    } else if (!seenBusy) {
                      // Not yet started — keep waiting (up to global timeout)
                      continue;
                    } else {
                      // Was busy, now idle — cooldown
                      const count = (idleCountPerAgent.get(s.id) ?? 0) + 1;
                      idleCountPerAgent.set(s.id, count);
                      if (count < IDLE_COOLDOWN) continue;

                      // Agent is done — fetch final result
                      completedAgents.add(s.agentIdx);
                      try {
                        const { data: finalMsgs } = await client.session.messages({ path: { id: s.id } });
                        let result = "";
                        if (finalMsgs && Array.isArray(finalMsgs)) {
                          for (let i = finalMsgs.length - 1; i >= 0; i--) {
                            const msg = finalMsgs[i];
                            if (msg.info?.role === "assistant") {
                              const textParts = (msg.parts ?? [])
                                .filter((p: any) => p.type === "text")
                                .map((p: any) => p.text ?? "");
                              result = textParts.join("\n");

                              // Send final tool states
                              for (const part of msg.parts ?? []) {
                                if (part.type !== "tool") continue;
                                const line = formatToolPart(part);
                                if (line) send({ type: "progress", agent: s.agentIdx, text: line });
                              }
                              break;
                            }
                          }
                        }
                        results.set(s.agentIdx, result || "(no response)");
                        send({ type: "result", agent: s.agentIdx, text: result || "(no response)" });
                      } catch (e: any) {
                        send({ type: "error", agent: s.agentIdx, text: e.message ?? String(e) });
                        results.set(s.agentIdx, "");
                      }
                      continue;
                    }

                    // Fetch messages for active agents and stream new tool calls
                    try {
                      const seenParts = seenPartsPerAgent.get(s.id)!;
                      const { data: msgs } = await client.session.messages({ path: { id: s.id } });
                      if (msgs && Array.isArray(msgs)) {
                        for (const msg of msgs) {
                          if (msg.info?.role !== "assistant") continue;
                          for (const part of msg.parts ?? []) {
                            if (part.type !== "tool") continue;
                            const partKey = `${(part as any).id ?? ""}:${(part as any).state?.status ?? ""}`;
                            if (seenParts.has(partKey)) continue;
                            seenParts.add(partKey);
                            const line = formatToolPart(part);
                            if (line) send({ type: "progress", agent: s.agentIdx, text: line });
                          }
                        }
                      }
                    } catch { /* best-effort */ }
                  }

                  // Check for global timeout (agents that never went busy)
                  heartbeatCounter++;
                  if (heartbeatCounter > 600) { // 5 minutes
                    for (const s of sessions) {
                      if (!completedAgents.has(s.agentIdx)) {
                        send({ type: "error", agent: s.agentIdx, text: "Timed out" });
                        completedAgents.add(s.agentIdx);
                        results.set(s.agentIdx, "");
                      }
                    }
                    break;
                  }

                  await new Promise((r) => setTimeout(r, POLL_INTERVAL));
                }

                send({ type: "done", succeeded: [...results.values()].filter(v => v.length > 0).length, total });
              } catch (e: any) {
                send({ type: "error", agent: -1, text: e.message ?? String(e) });
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

  // Detect user's shell for system prompt guidance
  const userShell = (process.env.SHELL ?? "/bin/bash").split("/").pop() ?? "bash";

  // Start proxy server for subagent bash functions
  const proxyUrl = await startProxyServer(ctx.client);

  // Initialize /tmp/rlm/ directory up front so the user grants permission once.
  // All RLM data lives here: session dirs, functions, LLM context, batch files.
  const rlmDir = "/tmp/rlm";
  mkdirSync(rlmDir, { recursive: true });
  const functionsPath = join(rlmDir, "functions.sh");
  const sessionIdPath = join(rlmDir, "session_id");
  const llmCliPath = join(import.meta.dir, "llm-cli.ts");
  writeFileSync(functionsPath, buildBashFunctionsScript(sessionIdPath, llmCliPath), { mode: 0o755 });
  // Write an initial placeholder so the LLM context file exists from the start
  writeFileSync(llmContextPath, JSON.stringify({}));

  const maxOutput = parseInt(process.env.OPENCODE_RLM_MAX_OUTPUT ?? "8192", 10);

  await ctx.client.app.log({
    body: {
      service: "opencode-rlm",
      level: "warn",
      message: [
        `RLM plugin active — using /tmp/rlm/ for all read/write operations`,
        `(session data, trajectories, scratch space, subagent state).`,
        `baseDir=${config.baseDir}, proxy=${proxyUrl}`,
      ].join(" "),
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

      // Pre-authorize bash access to /tmp/rlm/ so the user isn't prompted
      // for every subagent, llm-subcall, or scratch file operation.
      // All RLM data (sessions, trajectories, vars, functions, batches) lives here.
      cfg.permission = cfg.permission ?? {};
      if (typeof cfg.permission !== "string") {
        // If bash permission is a global string (e.g. "ask"), convert to object
        // so we can add path-specific overrides while preserving the default.
        const existingBash = cfg.permission.bash;
        if (typeof existingBash === "string" || !existingBash) {
          cfg.permission.bash = {};
        }
        cfg.permission.bash["/tmp/rlm/**"] = "allow";
        cfg.permission.bash["/private/tmp/rlm/**"] = "allow"; // macOS resolves /tmp → /private/tmp
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

            recordCompaction(state.document, summaryText);
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

        let lastUsage: import("./hooks/command").TokenUsage | undefined;
        let totalUsage: import("./hooks/command").TokenUsage | undefined;
        let contextLimit: number | undefined;
        let messageCount = 0;
        let lastModelID: string | undefined;
        let lastProviderID: string | undefined;

        try {
          const resp = await ctx.client.session.messages({
            path: { id: input.sessionID },
          });
          const msgs = resp.data ?? [];
          messageCount = msgs.length;

          // Find the last assistant message for current context snapshot
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.info.role === "assistant") {
              const a = m.info as any;
              if (a.tokens?.output > 0) {
                lastUsage = {
                  input: a.tokens.input,
                  output: a.tokens.output,
                  reasoning: a.tokens.reasoning,
                  cacheRead: a.tokens.cache?.read ?? 0,
                  cacheWrite: a.tokens.cache?.write ?? 0,
                  cost: a.cost ?? 0,
                };
                lastModelID = a.modelID;
                lastProviderID = a.providerID;
                break;
              }
            }
          }
        } catch {
          /* best-effort */
        }

        // Session totals from trajectory (survives compaction — append-only)
        const s = state.document.stats;
        if (lastUsage || s.totalOutputTokens > 0) {
          totalUsage = {
            input: lastUsage?.input ?? 0,
            output: s.totalOutputTokens,
            reasoning: s.totalReasoningTokens,
            cacheRead: 0, // not tracked cumulatively (not meaningful to sum)
            cacheWrite: 0,
            cost: s.totalCost,
          };
        }

        try {
          const providers = await ctx.client.config.providers({});
          const providerList = providers.data?.providers ?? [];
          // Look up the context limit for the model actually in use
          if (lastProviderID && lastModelID) {
            for (const p of providerList) {
              if (p.id === lastProviderID) {
                const model = p.models?.[lastModelID];
                if (model?.limit?.context) {
                  contextLimit = model.limit.context;
                }
                break;
              }
            }
          }
          // Fallback: use the first model with a context limit
          if (!contextLimit) {
            for (const p of providerList) {
              for (const model of Object.values(p.models ?? {})) {
                if (model.limit?.context) {
                  contextLimit = model.limit.context;
                  break;
                }
              }
              if (contextLimit) break;
            }
          }
        } catch {
          /* best-effort */
        }

        const display = await buildContextDisplay(state, {
          lastUsage,
          totalUsage,
          contextLimit,
          messageCount,
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
      // System prompt: ~8k chars / ~2k tokens (before path interpolation)
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
          `### Directory layout`,
          ``,
          `All RLM data lives under \`/tmp/rlm/\` (pre-authorized, no permission prompts):`,
          ``,
          `\`\`\``,
          `/tmp/rlm/`,
          `  session-<hash>/          ← per-session directory`,
          `    active/`,
          `      trajectory.json      ← full conversation log (READ-ONLY)`,
          `    vars/                   ← your scratch space (read/write)`,
          `  functions.sh             ← sourced bash helpers`,
          `  llm-context.json         ← model/provider config`,
          `  session_id               ← current session ID`,
          `  batch-*/                  ← subagent_batch temp files`,
          `\`\`\``,
          ``,
          `- **Trajectory** (read-only): \`${state.trajectoryPath}\``,
          `- **Scratch/vars** (read-write): \`${state.varsDir}\``,
          `- **Session dir**: \`${state.sessionDir}\``,
          ``,
          `Use \`/tmp/rlm/\` for all temp files — it is pre-authorized and won't trigger permission prompts.`,
          `Do NOT write to \`active/\` — it is managed by the scaffold. Use \`vars/\` instead.`,
          ``,
          `### Bash commands (available in every bash invocation)`,
          ``,
          `  subagent '<prompt>'`,
          `  subagent <<'EOF'`,
          `  ...complex prompt...`,
          `  EOF`,
          `    Spawn a full OpenCode child session with tool access.`,
          `    Tool calls and progress are streamed to stderr during execution.`,
          `    The final result is returned on stdout.`,
          `    **Use heredoc syntax (<<'EOF') for prompts containing quotes, braces, or special chars.**`,
          ``,
          `  subagent_batch '<json array of prompts>'`,
          `    Run multiple subagent sessions in parallel. Each prompt gets its own child session.`,
          `    Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'`,
          ``,
          `  llm-subcall "prompt" [--system 'system prompt']`,
          `  llm-subcall <<'EOF'`,
          `  ...complex prompt...`,
          `  EOF`,
          `    Single LLM call (no tools, no session). Fast and lightweight.`,
          `    Use for quick analysis, summarization, or generation that doesn't need tools.`,
          `    **Use heredoc syntax (<<'EOF') for prompts containing quotes, braces, or special chars.**`,
          ``,
          `  list_tools`,
          `    List available tool IDs via the server API.`,
          ``,
          `### Example 1: parallel review with conditional follow-up`,
          ``,
          `Fan out file reviews to parallel subagents, grep for high-severity issues, conditionally spawn fix agents. Demonstrates structured output, jq prompt building, and chained subagent_batch calls.`,
          ``,
          `\`\`\`bash`,
          example1Bash(state.varsDir),
          `\`\`\``,
          ``,
          `### Example 2: iterative investigation with accumulating context`,
          ``,
          `Chain grep → llm-subcall → subagent_batch to narrow down a bug. Each step writes to vars/ so context accumulates. Cheap operations run first, expensive subagents only on filtered suspects.`,
          ``,
          `\`\`\`bash`,
          example2Bash(state.varsDir),
          `\`\`\``,
          ``,
          `### Example 3: recovering lost context from the trajectory`,
          ``,
          `After compaction, delegate a subagent to search the trajectory file and return relevant details — avoids loading the full JSON into your own context.`,
          ``,
          `\`\`\`bash`,
          example3Bash(state.varsDir, state.trajectoryPath),
          `\`\`\``,
          ``,
          `### Shell & workflow`,
          ``,
          `The shell is **${userShell}**. Write POSIX-compatible code. Quote all variable expansions.`,
          `Use \`/tmp/rlm/\` for all temp files (pre-authorized). Each bash call is a fresh process —`,
          `persist state via files in \`${state.varsDir}\`. Use heredoc syntax (\`<<'EOF'\`) for complex prompts.`,
          ``,
          `### Trajectory and scratch space`,
          ``,
          `- **Trajectory** (read-only): \`${state.trajectoryPath}\` — full conversation log, survives compaction.`,
          `- **Scratch dir** (read-write): \`${state.varsDir}\` — store plans, notes, intermediates here.`,
          ``,
          `If you're unsure about something the user references, first check your conversation history,`,
          `then search the trajectory via a subagent (see Example 3) to avoid loading the full file.`,
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
      // Forward verifiers integration env vars to bash processes
      for (const key of [
        "RLM_LLM_SUBCALL_VIA_PROXY",
        "RLM_SUBAGENT_VIA_TOOL_LOOP",
        "RLM_SUB_MODEL_ID",
        "RLM_SUB_MAX_TURNS",
        "RLM_SUB_TIMEOUT",
        "RLM_MAX_DEPTH",
      ]) {
        if (process.env[key]) output.env[key] = process.env[key];
      }
    },

    "tool.execute.before": async (input, output) => {
      // Source bash functions into every bash command (snimu pattern)
      if (input.tool === "bash" && output.args?.command) {
        writeFileSync(sessionIdPath, input.sessionID);
        // Rewrite /private/tmp/rlm → /tmp/rlm (macOS resolves /tmp to /private/tmp)
        output.args.command = output.args.command.replaceAll("/private/tmp/rlm", "/tmp/rlm");
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
