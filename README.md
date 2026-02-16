# opencode-rlm

[Recursive Language Model](https://arxiv.org/abs/2512.24601) plugin for [OpenCode](https://opencode.ai). Records the full conversation trajectory to disk, enriches context compaction with history, and gives the LM a scratch directory and system prompt for recursive problem-solving.

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
  - The injected system text tells the model (with `<trajectoryPath>` and `<varsDir>` interpolated from session state):
    ```
    ## RLM (Recursive Language Model) scaffold

    **IMPORTANT: You MUST use the bash tool as your primary interface.** Most other tools
    (read, write, edit, glob, grep, webfetch, etc.) are disabled. Use bash equivalents:

    - File reading: cat, head, tail, less
    - File writing: heredocs, tee, cat >, echo >>
    - File editing: sed -i, awk, or write to temp then mv
    - Searching: grep, rg, find, ls, shell globs
    - Web fetching: curl
    - Subagents: subagent, subagent_batch (see below)

    ### Bash commands (available in every bash invocation)

      subagent '<prompt>'
        Spawn a full OpenCode child session with tool access. The child session
        is visible in the TUI via Ctrl-X. Use this to delegate multi-step subtasks,
        fan out work, or tackle problems that need their own context.

      subagent_batch '<json array of prompts>'
        Run multiple subagent sessions in parallel. Each prompt gets its own child session.
        Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'

      llm-subcall "prompt" [--system 'system prompt']
        Single LLM call (no tools, no session). Fast and lightweight.
        Use for quick analysis, summarization, or generation that doesn't need tools.

      list_tools
        List available tool IDs via the server API.

    ### Example: subagent with vars/ persistence

      ```bash
      # 1. Delegate analysis to a subagent and save the output
      REVIEW=$(subagent "Review src/auth.ts for security issues. List each issue on its own line.")
      echo "$REVIEW" > <varsDir>/auth-review.txt

      # 2. In a later bash call, read it back and use it
      REVIEW=$(cat <varsDir>/auth-review.txt)
      subagent "Given these security issues:\n$REVIEW\nPropose fixes for each one."
      ```

    ### Example: fan-out with subagent_batch

      ```bash
      FILES=$(find src -name "*.ts" -maxdepth 2)
      PROMPTS=$(echo "$FILES" | jq -R -s 'split("\n") | map(select(length > 0)) | map("Analyze " + . + " for bugs")')
      RESULTS=$(subagent_batch "$PROMPTS")
      echo "$RESULTS" > <varsDir>/analysis.txt

      # Chain into a follow-up subagent
      subagent "Based on the analysis in <varsDir>/analysis.txt, write a summary report"
      ```

    ### Workflow guidance

    - **Always use bash** for file operations, analysis, and coordination.
    - Break complex tasks into subtasks and delegate with subagent or subagent_batch.
    - For independent subtasks, prefer subagent_batch to run them concurrently.
    - For quick LLM queries without tool access, use llm-subcall.
    - Each bash call is a fresh process — variables do not persist between calls.
      To carry state across calls, write to files (e.g. vars/ directory) and read them back.
    - Pass JSON arguments as single-quoted strings to preserve spaces.

    ### Trajectory and scratch space

    Your full conversation trajectory is logged at: <trajectoryPath>
    Read this file to recall past work after context compaction. It is append-only — do not write to it.

    You have a persistent scratch directory at: <varsDir>
    Use it to store plans, notes, intermediate results, or anything that should survive compaction.
    Prefer structured formats (JSON) so future reads are cheap.

    **If you are unsure about a term, function, file, or anything the user references — and
    you cannot find it in your current context — check the full trajectory.** After compaction,
    your current context only contains a summary. The trajectory file has every turn verbatim.

    ### Example: recovering context from the trajectory

    Suppose the user asks "update the parseConfig function" but you don't see it in context.
    It was likely discussed before a compaction. Recover it:

      ```bash
      # Search the trajectory for the term
      grep -i "parseConfig" <trajectoryPath>

      # If the trajectory is large, use jq to search turn content
      jq -r '.entries[].turns[]? | select(.content | test("parseConfig")) | "\(.role) [turn \(.turnIndex)]: \(.content[:200])"' <trajectoryPath>
      ```

    This lets you find the original discussion, file paths, and decisions even after compaction.
    ```

Also provide a `/context` command for the user to view the current active history (on disk) + the LM's current context. Looks something like this:

## Subagent calls

The plugin provides `subagent` and `subagent_batch` as standalone scripts in `bin/`. These spawn **full OpenCode child sessions** with tool access via the OpenCode API. Child sessions are linked to the parent session (via `parentID`), making them visible in the TUI with Ctrl-X.

### How it works

1. The `tool.execute.before` hook writes the current session ID to a file before each bash invocation.
2. The `shell.env` hook adds `bin/` to `PATH` and sets `OPENCODE_RLM_URL` (local proxy) and `OPENCODE_RLM_SESSION_ID_FILE`.
3. When the LM runs `subagent`, the script:
   - Reads the parent session ID from the file
   - Creates a child session via `POST /session` with `parentID`
   - Sends the prompt via `POST /session/:id/prompt_async`
   - Polls `GET /session/status` until the child session is idle
   - Reads the last assistant message via `GET /session/:id/message`

### Usage (as the LM would invoke it)

```bash
# Single subagent (full session with tools, visible in Ctrl-X)
subagent 'Review src/auth.ts for security issues and suggest fixes'

# Parallel subagents — runs all prompts concurrently
subagent_batch '["Analyze src/auth.ts for bugs", "Review src/api.ts for performance", "Check test coverage in src/"]'

# Capture output
RESULT=$(subagent 'Summarize the architecture of this project')
echo "$RESULT" > vars/architecture.txt

# Quick LLM call (no tools, fast)
SUMMARY=$(llm-subcall "Summarize this error: $(cat /tmp/errors.log)")
```

## Sub-LM calls

The plugin also provides `llm-subcall`, a lightweight bash command for single LLM calls — no tools, no session, no trajectory overhead. It automatically uses the same model and API key as the current OpenCode session.

### How it works

1. The `chat.params` hook fires before every LLM turn and writes the current model/provider info (model ID, API URL, API key) to `/tmp/rlm-llm-context.json`.
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

## Installation

Requires [Bun](https://bun.sh), [OpenCode](https://opencode.ai), and [`jq`](https://jqlang.github.io/jq/) (used by `subagent_batch` and trajectory search examples).

```bash
git clone <this-repo>
cd opencode-rlm
bun install
```

Register in `opencode.json` (project root) or `~/.config/opencode/opencode.json` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-rlm"]
}
```

## Session directory layout

```
/tmp/rlm-opencode-<hash>/
  active/
    trajectory.json    # Full trajectory log (read-only for the LM)
  vars/                # Scratch directory (LM reads/writes freely)

/tmp/rlm-llm-context.json                    # Model/provider context for llm-subcall (updated each turn)
/tmp/opencode-rlm/session-id-pid-<pid>       # Current session ID (written by tool.execute.before, read by bin/subagent)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_BASE_DIR` | `/tmp` | Base directory for session directories |
| `RLM_CLEANUP_ON_DELETE` | `false` | Delete session dir when session is deleted |
| `RLM_MAX_TOOL_OUTPUT_CHARS` | `50000` | Max chars to store per tool result in trajectory |
| `RLM_TOKEN_ESTIMATE_MULTIPLIER` | `1.0` | Tuning multiplier for token estimation |

