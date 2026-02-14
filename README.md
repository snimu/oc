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
- **`llm-subcall` — lightweight single LLM call** — a bash command the LM can invoke for quick sub-queries without spawning a full recursive session. Uses the same model and API key as the current OpenCode session. See [Sub-LM calls](#sub-lm-calls) below.
- **System prompt for recursion** — tells the LM about its trajectory file, vars directory, `opencode run` for subtasks, and `llm-subcall` for single calls
  - Injected via the `experimental.chat.system.transform` hook, which pushes a plain string onto `output.system: string[]`. OpenCode's runtime collects these strings and delivers them as system-level content to the model. The plugin does **not** construct `{"role": "system", "content": "..."}` messages directly — it pushes to the array and OpenCode handles the rest. The injected text:
    ```
    ## RLM (Recursive Language Model) scaffold

    Your full conversation trajectory is logged at: <trajectoryPath>
    Read this file to recall past work after context compaction. It is append-only and managed by the scaffold — do not write to it.

    You have a persistent scratch directory at: <varsDir>
    Use it to store plans, notes, intermediate results, or anything that should survive compaction. Prefer structured formats (JSON) so future reads are cheap.

    To spawn a recursive subtask, use: opencode run "{prompt}"
    The subtask runs in the same working directory and can read your vars.

    For a single LLM call (no tools, no session), run: llm-subcall "prompt"
    It calls the same model and returns the response directly. Supports --system "system prompt" as an optional flag.
    ```

Also provide a `/context` command for the user to view the current active history (on disk) + the LM's current context. Looks something like this:

## Sub-LM calls

The plugin provides `llm-subcall`, a bash command the LM can use to make a single LLM call inline — no tools, no session, no trajectory overhead. It automatically uses the same model and API key as the current OpenCode session.

### How it works

1. The `chat.params` hook fires before every LLM turn and writes the current model/provider info (model ID, API URL, API key) to `/tmp/rlm-llm-context.json`.
2. The `shell.env` hook adds `bin/` to `PATH` and sets `RLM_LLM_CONTEXT` to point at the context file.
3. When the LM runs `llm-subcall` via bash, the script reads the context, makes a single API call (Anthropic or OpenAI-compatible, depending on the provider), and prints the response to stdout.

### Usage (as the LM would invoke it)

```bash
# Simple prompt
llm-subcall "Summarize the following error log: $(cat /tmp/errors.log)"

# With a system prompt
llm-subcall --system "You are a senior code reviewer. Be concise." "Review this diff for bugs: $(git diff HEAD~1)"

# Capture output into a variable
ANALYSIS=$(llm-subcall "What does this function do? $(cat src/auth.ts)")
echo "$ANALYSIS" > vars/analysis.txt

# Chain with other commands
llm-subcall "Generate a regex that matches ISO 8601 dates" | tee vars/regex.txt
```

### When to use `llm-subcall` vs `opencode run`

| | `llm-subcall` | `opencode run` |
|---|---|---|
| **What it does** | Single LLM call, returns text | Full recursive session with tools |
| **Has tools?** | No | Yes (read, write, bash, etc.) |
| **Has trajectory?** | No | Yes (own trajectory + vars) |
| **Overhead** | Minimal — one HTTP request | Full session lifecycle |
| **Use case** | Quick analysis, generation, summarization | Multi-step tasks that need tool access |

## Installation

Requires [Bun](https://bun.sh) and [OpenCode](https://opencode.ai).

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

/tmp/rlm-llm-context.json           # Model/provider context for llm-subcall (updated each turn)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_BASE_DIR` | `/tmp` | Base directory for session directories |
| `RLM_CLEANUP_ON_DELETE` | `false` | Delete session dir when session is deleted |
| `RLM_MAX_TOOL_OUTPUT_CHARS` | `50000` | Max chars to store per tool result in trajectory |
| `RLM_TOKEN_ESTIMATE_MULTIPLIER` | `1.0` | Tuning multiplier for token estimation |
