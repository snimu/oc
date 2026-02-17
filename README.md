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

- **Tracks full RLM history without discarding information** — appends every turn to `active/trajectory.json` so nothing is lost on compaction. The trajectory is a single JSON document with segments and compaction summaries interleaved:
  ```json
  {
    "entries": [
      { "type": "segment", "segmentIndex": 0, "turns": [
        { "role": "user", "content": "Fix the login bug", ... },
        { "role": "assistant", "content": "I'll investigate...", ... },
        { "role": "tool_use", "content": "Tool call: read", "toolName": "read", ... },
        { "role": "tool_result", "content": "export function login() { ... }", ... }
      ], "compactedAt": "2026-02-13T10:15:00.000Z" },
      { "type": "compaction", "segmentIndex": 0, "summary": "Fixed login bug: missing null check on token refresh." },
      { "type": "segment", "segmentIndex": 1, "turns": [...], "compactedAt": null }
    ],
    "stats": { "totalTurns": 7, "totalCompactions": 1, "totalTokensProcessed": 441 }
  }
  ```
- **Summarizes when root LM is full, but history still available in JSON** — injects past trajectory summaries into the compaction prompt so the continuation summary is RLM-aware
- **Scratch directory** — provides `vars/` for the LM to persist plans, notes, and intermediates across compaction boundaries
- **`subagent` / `subagent_batch`** — bash commands that spawn child OpenCode sessions with full tool access. `subagent` runs a single prompt; `subagent_batch` runs multiple prompts in parallel. Child sessions are visible in the TUI via Ctrl-X.
- **`llm-subcall`** — lightweight single LLM call (no tools, no session). Uses the same model and API key as the current session.
- **Disables tools with bash equivalents** — forces the LM through bash for all operations (`read` → `cat`, `write` → heredocs, `edit` → `sed`, `grep` → `grep`/`rg`, etc.)
- **System prompt for recursion** — instructs the LM to use bash as its primary interface, with in-context examples showing programmatic subagent patterns

Also provides a `/context` command for the user to view token usage, compaction history, and trajectory status.

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

### Basic usage

```bash
# Single subagent
subagent 'Review src/auth.ts for security issues'

# Heredoc for complex prompts
subagent <<'EOF'
Analyze the codebase for {security issues} and "performance problems".
EOF

# Parallel subagents
subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'

# Quick LLM call (no tools, fast)
SUMMARY=$(llm-subcall "Summarize this error: $(cat /tmp/rlm/errors.log)")
```

### Example: parallel review with conditional follow-up

Scan source files, fan out reviews in parallel, then only fix files that have issues:

```bash
VARS="/tmp/rlm/session-xxx/vars"

# 1. Discover files and build per-file review prompts as a JSON array
find src -name "*.ts" -not -name "*.test.ts" | head -10 > "$VARS/files.txt"
PROMPTS='[]'
while IFS= read -r f; do
  PROMPTS=$(echo "$PROMPTS" | jq --arg f "$f" \
    '. + ["Review " + $f + " for bugs. List issues as ISSUE:<severity>:<line>:<description>. If none, output NONE."]')
done < "$VARS/files.txt"

# 2. Fan out — all files reviewed concurrently
subagent_batch "$PROMPTS" > "$VARS/reviews.txt"

# 3. Extract high-severity issues
grep "ISSUE:high:" "$VARS/reviews.txt" > "$VARS/high-issues.txt" || true
COUNT=$(wc -l < "$VARS/high-issues.txt" | tr -d ' ')

# 4. Conditionally spawn fix agents
if [[ "$COUNT" -gt 0 ]]; then
  FIX_PROMPTS='[]'
  for f in $(sed 's/ISSUE:high://; s/:.*//' "$VARS/high-issues.txt" | sort -u); do
    ISSUES=$(grep "$f" "$VARS/high-issues.txt")
    FIX_PROMPTS=$(echo "$FIX_PROMPTS" | jq --arg f "$f" --arg i "$ISSUES" \
      '. + ["Fix these issues in " + $f + ":\n" + $i]')
  done
  subagent_batch "$FIX_PROMPTS"

  # 5. Verify
  if bun test 2>&1 | tail -5; then
    echo "All tests pass"
  else
    echo "Tests failed — review changes"
  fi
else
  echo "No high-severity issues"
fi
```

### Example: iterative investigation with accumulating context

Trace a bug through the call stack — each step informs the next:

```bash
VARS="/tmp/rlm/session-xxx/vars"

# 1. Find potential error sites
grep -rn "getUser" src/ --include="*.ts" | head -30 > "$VARS/refs.txt"

# 2. Use llm-subcall (fast, no tools) to triage
SUSPECTS=$(llm-subcall --system 'Output ONLY file:line pairs, one per line.' <<'PROMPT'
The error is: "TypeError: Cannot read property 'user' of undefined"
Which of these could cause it?

$(cat "$VARS/refs.txt")
PROMPT
)
echo "$SUSPECTS" > "$VARS/suspects.txt"

# 3. Fan out deep investigation — each suspect gets a subagent with tool access
PROMPTS='[]'
while IFS= read -r loc; do
  [[ -z "$loc" ]] && continue
  PROMPTS=$(echo "$PROMPTS" | jq --arg loc "$loc" \
    '. + ["Investigate " + $loc + " — trace the data flow, read the file, check callers. End with VERDICT:yes or VERDICT:no"]')
done < "$VARS/suspects.txt"
subagent_batch "$PROMPTS" > "$VARS/investigations.txt"

# 4. If a root cause was found, spawn a fix agent with the evidence
if grep -q "VERDICT:yes" "$VARS/investigations.txt"; then
  EVIDENCE=$(awk '/VERDICT:yes/{found=1} found' "$VARS/investigations.txt" | head -50)
  subagent <<FIXPROMPT
Based on this investigation:
$EVIDENCE

Apply a fix for the TypeError. Then run the relevant tests to verify.
FIXPROMPT
else
  echo "No root cause found. Results in $VARS/investigations.txt"
fi
```

**Key patterns**: programmatic control flow (if/else, loops), data pipelines (jq, grep, awk), fan-out-then-converge (subagent_batch + aggregate), mixed tools (llm-subcall for fast triage, subagent for deep work), persistent state (vars/ across bash calls).

## Sub-LM calls

`llm-subcall` is a lightweight bash command for single LLM calls — no tools, no session, no trajectory overhead. It automatically uses the same model and API key as the current OpenCode session.

1. The `chat.params` hook writes model/provider info to `/tmp/rlm/llm-context.json`.
2. `llm-subcall` reads it, makes a single API call (Anthropic or OpenAI-compatible), and prints to stdout.

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
