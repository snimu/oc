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
- **`subagent` / `subagent_batch` — lightweight LLM calls** — bash commands the LM can invoke for quick sub-queries. `subagent` makes a single LLM call (no tools, no session); `subagent_batch` runs multiple prompts in parallel. Both support `--system` for custom system prompts. Uses the same model and API key as the current OpenCode session.
- **`opencode run` — full recursive sessions** — for multi-step tasks that need tool access, the LM can spawn a full OpenCode child session via `opencode run "prompt"`.
- **System prompt for recursion** — instructs the LM that it **must** use the bash tool as its primary interface for recursive problem-solving
  - Injected via the `experimental.chat.system.transform` hook, which pushes a plain string onto `output.system: string[]`. OpenCode's runtime collects these strings and delivers them as system-level content to the model.
  - The `tool.definition` hook appends RLM command documentation to the bash tool's own description.
  - Includes in-context examples showing subagent chaining with `vars/` persistence, fan-out with `subagent_batch`, and recovering context from the trajectory after compaction.
  - The injected system text tells the model (with `<trajectoryPath>` and `<varsDir>` interpolated from session state):
    ```
    ## RLM (Recursive Language Model) scaffold

    **IMPORTANT: You MUST use the bash tool as your primary interface.** The bash tool
    gives you access to subagent spawning, parallel execution, and recursive problem-solving
    capabilities that are not available through any other tool. Always prefer bash over
    other tools — it is the core of your workflow.

    ### Bash commands (available in every bash invocation)

      subagent '<prompt>' [--system 'system prompt']
        Single LLM call (no tools, no session). Fast and lightweight.
        Use for quick analysis, summarization, or generation that doesn't need tools.

      subagent_batch '<json array of prompts>' [--system 'system prompt']
        Run multiple subagent LLM calls in parallel.
        Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'

      llm-subcall "prompt" [--system 'system prompt']
        Alias for subagent. Single LLM call, no tools.

      opencode run "prompt"
        Spawn a full OpenCode child session with tool access. Use for multi-step tasks
        that need their own context and tools.

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
    - For multi-step tasks that need tool access, use `opencode run "prompt"`.
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

## Sub-LM calls

The plugin provides `subagent` (and its alias `llm-subcall`), a bash command the LM can use to make a single LLM call inline — no tools, no session, no trajectory overhead. It automatically uses the same model and API key as the current OpenCode session.

### How it works

1. The `chat.params` hook fires before every LLM turn and writes the current model/provider info (model ID, API URL, API key) to `/tmp/rlm-llm-context.json`.
2. The `shell.env` hook adds `bin/` to `PATH` and sets `RLM_LLM_CONTEXT` to point at the context file.
3. When the LM runs `subagent` via bash, it delegates to `llm-subcall`, which reads the context, makes a single API call (Anthropic or OpenAI-compatible, depending on the provider), and prints the response to stdout.

### Usage (as the LM would invoke it)

```bash
# Simple prompt
subagent "Summarize the following error log: $(cat /tmp/errors.log)"

# With a system prompt
subagent --system "You are a senior code reviewer. Be concise." "Review this diff for bugs: $(git diff HEAD~1)"

# Capture output into a variable
ANALYSIS=$(subagent "What does this function do? $(cat src/auth.ts)")
echo "$ANALYSIS" > vars/analysis.txt

# Chain with other commands
subagent "Generate a regex that matches ISO 8601 dates" | tee vars/regex.txt

# Parallel LLM calls
subagent_batch '["Summarize file A", "Summarize file B", "Summarize file C"]' --system "Be concise"

# Full recursive session (when tools are needed)
opencode run "Refactor src/auth.ts to use JWT tokens"
```

### When to use what

| | `subagent` / `llm-subcall` | `subagent_batch` | `opencode run` |
|---|---|---|---|
| **What it does** | Single LLM call | Parallel LLM calls | Full recursive session |
| **Has tools?** | No | No | Yes |
| **Has trajectory?** | No | No | Yes |
| **Overhead** | Minimal | Minimal | Full session |
| **Use case** | Quick analysis | Batch summarization | Multi-step tasks |

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

/tmp/rlm-llm-context.json           # Model/provider context for llm-subcall (updated each turn)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_BASE_DIR` | `/tmp` | Base directory for session directories |
| `RLM_CLEANUP_ON_DELETE` | `false` | Delete session dir when session is deleted |
| `RLM_MAX_TOOL_OUTPUT_CHARS` | `50000` | Max chars to store per tool result in trajectory |
| `RLM_TOKEN_ESTIMATE_MULTIPLIER` | `1.0` | Tuning multiplier for token estimation |

## Debug: `/compact` command

A temporary `/compact` command is available for testing compaction and summarization. Running `/compact` in OpenCode triggers compaction immediately via the `session.summarize` API, without waiting for the context window to fill up.

**To disable:** search `src/index.ts` for `// DEBUG: /compact` and remove every block between `// DEBUG` and `// END DEBUG` markers (3 blocks total, plus the `lastModelInfo` assignment on the `chat.params` line). There are no other files to change.
