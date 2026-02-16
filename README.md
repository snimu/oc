# opencode-rlm

[Recursive Language Model](https://arxiv.org/abs/2512.24601) plugin for [OpenCode](https://opencode.ai). Records the full conversation trajectory to disk, enriches context compaction with history, and gives the LM a scratch directory and system prompt for recursive problem-solving.

## Setup

Requires [Bun](https://bun.sh), [OpenCode](https://opencode.ai), and [`jq`](https://jqlang.github.io/jq/) (used by `subagent_batch` and trajectory search examples).

```bash
git clone <this-repo>
cd opencode-rlm
bun install
```

### Local setup (single project)

Add the plugin to `opencode.json` in your project root. This enables the RLM plugin only for that project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-rlm"]
}
```

### Global setup (all projects)

Add the plugin to `~/.config/opencode/opencode.json`. This enables the RLM plugin for every OpenCode session:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-rlm"]
}
```

> **Note:** The plugin pre-authorizes bash access to `/tmp/rlm/` on load. All RLM data (sessions, trajectories, scratch space, subagent state) lives under this directory.

## What it does

- **Tracks full RLM history without discarding information** — appends every turn to `active/trajectory.json` so nothing is lost on compaction
  - The trajectory is stored as a single JSON document with segments and compaction summaries interleaved in order. After two compaction cycles the file looks like:
    ```json
    {
      "version": 1,
      "sessionId": "abc-123",
      "createdAt": "2026-02-13T10:00:00.000Z",
      "lastUpdatedAt": "2026-02-13T10:45:00.000Z",
      "entries": [
        {
          "type": "segment",
          "segmentIndex": 0,
          "turns": [
            { "turnIndex": 0, "role": "user", "content": "Fix the login bug", "estimatedTokens": 8, "timestamp": "2026-02-13T10:00:01.000Z" },
            { "turnIndex": 1, "role": "assistant", "content": "I'll investigate the auth module...", "estimatedTokens": 120, "timestamp": "2026-02-13T10:00:05.000Z" },
            { "turnIndex": 2, "role": "tool_use", "content": "Tool call: read", "estimatedTokens": 6, "timestamp": "2026-02-13T10:00:06.000Z", "toolName": "read", "toolArgs": "{\"file_path\":\"/src/auth.ts\"}" },
            { "turnIndex": 3, "role": "tool_result", "content": "export function login() { ... }", "estimatedTokens": 85, "timestamp": "2026-02-13T10:00:07.000Z", "toolName": "read" }
          ],
          "totalEstimatedTokens": 219,
          "startedAt": "2026-02-13T10:00:00.000Z",
          "compactedAt": "2026-02-13T10:15:00.000Z"
        },
        {
          "type": "compaction",
          "segmentIndex": 0,
          "summary": "Investigated login bug in /src/auth.ts. Found missing null check on token refresh. Applied fix and verified tests pass.",
          "summaryTokens": 30,
          "originalTokens": 219,
          "compactedAt": "2026-02-13T10:15:00.000Z"
        },
        {
          "type": "segment",
          "segmentIndex": 1,
          "turns": [
            { "turnIndex": 4, "role": "user", "content": "Now add rate limiting to the API", "estimatedTokens": 12, "timestamp": "2026-02-13T10:15:30.000Z" },
            { "turnIndex": 5, "role": "assistant", "content": "I'll add a rate limiter middleware...", "estimatedTokens": 200, "timestamp": "2026-02-13T10:16:00.000Z" }
          ],
          "totalEstimatedTokens": 212,
          "startedAt": "2026-02-13T10:15:00.000Z",
          "compactedAt": "2026-02-13T10:30:00.000Z"
        },
        {
          "type": "compaction",
          "segmentIndex": 1,
          "summary": "Added token-bucket rate limiter middleware in /src/middleware/rate-limit.ts. Configured at 100 req/min per IP. Integrated into Express app and added tests.",
          "summaryTokens": 42,
          "originalTokens": 212,
          "compactedAt": "2026-02-13T10:30:00.000Z"
        },
        {
          "type": "segment",
          "segmentIndex": 2,
          "turns": [
            { "turnIndex": 6, "role": "user", "content": "Looks good, now update the README", "estimatedTokens": 10, "timestamp": "2026-02-13T10:30:30.000Z" }
          ],
          "totalEstimatedTokens": 10,
          "startedAt": "2026-02-13T10:30:00.000Z",
          "compactedAt": null
        }
      ],
      "stats": {
        "totalTurns": 7,
        "totalCompactions": 2,
        "totalTokensProcessed": 441,
        "currentActiveTokens": 10
      }
    }
    ```
- **Summarizes when root LM is full, but history still available in JSON** — injects past trajectory summaries into the compaction prompt so the continuation summary is RLM-aware
- **Scratch directory** — provides `vars/` for the LM to persist plans, notes, and intermediates across compaction boundaries
- **`subagent` / `subagent_batch` — full recursive sessions via the OpenCode API** — bash commands that spawn child OpenCode sessions with full tool access. `subagent` runs a single prompt; `subagent_batch` runs multiple prompts in parallel. Child sessions are visible in the TUI via Ctrl-X. See [Subagent calls](#subagent-calls) below.
- **`llm-subcall` — lightweight single LLM call** — a bash command the LM can invoke for quick sub-queries without spawning a full session. Uses the same model and API key as the current OpenCode session. See [Sub-LM calls](#sub-lm-calls) below.
- **Disables tools with bash equivalents** — the `config` hook disables `read`, `write`, `edit`, `glob`, `grep`, `webfetch`, `codesearch`, `apply_patch`, and `task`, forcing the LM to use bash for all operations. This keeps the workflow consistent and ensures all file operations go through the bash tool permission system.
- **System prompt for recursion** — instructs the LM that it **must** use the bash tool as its primary interface for recursive problem-solving
  - Injected via the `experimental.chat.system.transform` hook, which pushes a plain string onto `output.system: string[]`. OpenCode's runtime collects these strings and delivers them as system-level content to the model.
  - The `tool.definition` hook appends RLM command documentation to the bash tool's own description.
  - Includes in-context examples showing subagent chaining with `vars/` persistence, fan-out with `subagent_batch`, and recovering context from the trajectory after compaction.

Also provides a `/context` command for the user to view the current active history (on disk) + the LM's current context.

## Subagent calls

The plugin provides `subagent` and `subagent_batch` as sourced bash functions (via `functions.sh`). These spawn **full OpenCode child sessions** with tool access via a local proxy server. Child sessions are linked to the parent session (via `parentID`), making them visible in the TUI with Ctrl-X.

### How it works

1. The `tool.execute.before` hook writes the current session ID to `/tmp/rlm/session_id` and sources `functions.sh` before each bash invocation.
2. The `shell.env` hook sets `OPENCODE_RLM_URL` (local proxy) and `OPENCODE_RLM_DIR_PATH`.
3. When the LM runs `subagent`, the function:
   - Reads the parent session ID from the file
   - Calls the streaming `POST /session/run` endpoint on the local proxy
   - The proxy creates a child session, sends the prompt, polls for completion, and streams tool call progress as NDJSON events
   - Progress (tool calls) is displayed on stderr with box-drawing; the final result goes to stdout
4. `subagent_batch` calls `POST /session/run-batch` which runs all sessions in parallel, streams interleaved progress, then wipes and reprints grouped by agent.

### Usage (as the LM would invoke it)

```bash
# Single subagent (full session with tools, visible in Ctrl-X)
subagent 'Review src/auth.ts for security issues and suggest fixes'

# Heredoc for complex prompts (prevents shell parsing issues)
subagent <<'EOF'
Analyze the codebase for {security issues} and "performance problems".
Focus on: auth, API layer, and database queries.
EOF

# Parallel subagents — runs all prompts concurrently
subagent_batch '["Analyze src/auth.ts for bugs", "Review src/api.ts for performance", "Check test coverage in src/"]'

# Capture output
RESULT=$(subagent 'Summarize the architecture of this project')
echo "$RESULT" > vars/architecture.txt

# Quick LLM call (no tools, fast)
SUMMARY=$(llm-subcall "Summarize this error: $(cat /tmp/rlm/errors.log)")
```

## Sub-LM calls

The plugin also provides `llm-subcall`, a lightweight bash command for single LLM calls — no tools, no session, no trajectory overhead. It automatically uses the same model and API key as the current OpenCode session.

### How it works

1. The `chat.params` hook fires before every LLM turn and writes the current model/provider info (model ID, API URL, API key) to `/tmp/rlm/llm-context.json`.
2. The `shell.env` hook sets `RLM_LLM_CONTEXT` to point at the context file.
3. `llm-subcall` reads the context, makes a single API call (Anthropic or OpenAI-compatible), and prints the response to stdout.

### When to use what

| | `subagent` | `subagent_batch` | `llm-subcall` |
|---|---|---|---|
| **What it does** | Full child session | Parallel child sessions | Single LLM call |
| **Has tools?** | Yes | Yes | No |
| **Visible in Ctrl-X?** | Yes | Yes | No |
| **Overhead** | Full session | Full session per prompt | Minimal |
| **Use case** | Multi-step tasks | Fan-out work | Quick analysis |

## Session directory layout

```
/tmp/rlm/
  session-<hash>/            # Per-session directory
    active/
      trajectory.json        # Full trajectory log (read-only for the LM)
    vars/                    # Scratch directory (LM reads/writes freely)
  functions.sh               # Sourced bash helpers (subagent, llm-subcall, etc.)
  llm-context.json           # Model/provider context for llm-subcall (updated each turn)
  session_id                 # Current session ID (written before each bash invocation)
  batch-*/                   # Temp files for subagent_batch (cleaned up after)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_BASE_DIR` | `/tmp/rlm` | Base directory for session directories |
| `RLM_CLEANUP_ON_DELETE` | `false` | Delete session dir when session is deleted |
| `RLM_MAX_TOOL_OUTPUT_CHARS` | `50000` | Max chars to store per tool result in trajectory |
