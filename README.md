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

<details>
<summary><b>Full system prompt injected into every session</b> (click to expand)</summary>

The following is pushed onto `output.system[]` via the `experimental.chat.system.transform` hook. Paths like `<trajectoryPath>` and `<varsDir>` are interpolated from session state at runtime.

````markdown
## RLM (Recursive Language Model) scaffold

**IMPORTANT: You MUST use the bash tool as your primary interface.** Most other tools
(read, write, edit, glob, grep, webfetch, etc.) are disabled. Use bash equivalents:

- **File reading**: cat, head, tail, less
- **File writing**: heredocs, tee, cat >, echo >>
- **File editing**: sed -i, awk, or write to temp then mv
- **Searching**: grep, rg, find, ls, shell globs
- **Web fetching**: curl
- **Subagents**: subagent, subagent_batch (see below)

### Directory layout

All RLM data lives under `/tmp/rlm/` (pre-authorized, no permission prompts):

  /tmp/rlm/
    session-<hash>/          ← per-session directory
      active/
        trajectory.json      ← full conversation log (READ-ONLY)
      vars/                   ← your scratch space (read/write)
    functions.sh             ← sourced bash helpers
    llm-context.json         ← model/provider config
    session_id               ← current session ID
    batch-*/                  ← subagent_batch temp files

- **Trajectory** (read-only): `<trajectoryPath>`
- **Scratch/vars** (read-write): `<varsDir>`
- **Session dir**: `<sessionDir>`

Use `/tmp/rlm/` for all temp files — it is pre-authorized and won't trigger permission prompts.
Do NOT write to `active/` — it is managed by the scaffold. Use `vars/` instead.

### Bash commands (available in every bash invocation)

  subagent '<prompt>'
  subagent <<'EOF'
  ...complex prompt...
  EOF
    Spawn a full OpenCode child session with tool access.
    Tool calls and progress are streamed to stderr during execution.
    The final result is returned on stdout.
    **Use heredoc syntax (<<'EOF') for prompts containing quotes, braces, or special chars.**

  subagent_batch '<json array of prompts>'
    Run multiple subagent sessions in parallel. Each prompt gets its own child session.
    Example: subagent_batch '["Analyze src/auth.ts", "Review src/api.ts", "Check test coverage"]'

  llm-subcall "prompt" [--system 'system prompt']
  llm-subcall <<'EOF'
  ...complex prompt...
  EOF
    Single LLM call (no tools, no session). Fast and lightweight.
    Use for quick analysis, summarization, or generation that doesn't need tools.
    **Use heredoc syntax (<<'EOF') for prompts containing quotes, braces, or special chars.**

  list_tools
    List available tool IDs via the server API.

### Example 1: parallel review with conditional follow-up

Scan source files, fan out reviews in parallel, then only fix files that have issues:

  ```bash
  VARS="<varsDir>"

  # 1. Discover files and build per-file review prompts as a JSON array
  find src -name "*.ts" -not -name "*.test.ts" | head -10 > "$VARS/files.txt"
  PROMPTS='[]'
  while IFS= read -r f; do
    PROMPTS=$(echo "$PROMPTS" | jq --arg f "$f" '. + ["Review " + $f + " for bugs and security issues. List each issue as: ISSUE:<severity>:<line>:<description> (one per line). If no issues, output NONE."]')
  done < "$VARS/files.txt"

  # 2. Fan out — all files reviewed concurrently by separate subagents
  subagent_batch "$PROMPTS" > "$VARS/reviews.txt"

  # 3. Extract only high-severity issues from all reviews
  grep "ISSUE:high:" "$VARS/reviews.txt" > "$VARS/high-issues.txt" || true
  COUNT=$(wc -l < "$VARS/high-issues.txt" | tr -d ' ')
  echo "Found $COUNT high-severity issues"

  # 4. Conditionally spawn fix agents only if there are issues to fix
  if [[ "$COUNT" -gt 0 ]]; then
    # Group issues by file path
    FIX_PROMPTS='[]'
    for f in $(cat "$VARS/high-issues.txt" | sed 's/ISSUE:high://; s/:.*//' | sort -u); do
      ISSUES=$(grep "$f" "$VARS/high-issues.txt")
      FIX_PROMPTS=$(echo "$FIX_PROMPTS" | jq --arg f "$f" --arg issues "$ISSUES" '. + ["Fix these issues in " + $f + ":\n" + $issues + "\nApply fixes directly with sed -i."]')
    done
    subagent_batch "$FIX_PROMPTS"

    # 5. Verify fixes compile and tests pass
    echo "Running tests..."
    if bun test 2>&1 | tail -5; then
      echo "All tests pass after fixes"
    else
      echo "Tests failed — review the changes"
    fi
  else
    echo "No high-severity issues found"
  fi
  ```

### Example 2: iterative investigation with accumulating context

Trace a bug through the call stack — each step informs the next, narrowing down the root cause:

  ```bash
  VARS="<varsDir>"

  # 1. Find all entry points that could trigger the error
  grep -rn "getUser" src/ --include="*.ts" | head -30 > "$VARS/refs.txt"

  # 2. Use llm-subcall (fast, no tools) to triage which refs are worth investigating
  SUSPECTS=$(llm-subcall --system 'Output ONLY file:line pairs, one per line. No explanation.' <<'PROMPT'
  The error is: "TypeError: Cannot read property 'user' of undefined"
  Which of these call sites could cause it? (the object before .user is undefined)

  $(cat "$VARS/refs.txt")
  PROMPT
  )
  echo "$SUSPECTS" > "$VARS/suspects.txt"
  echo "LLM identified $(wc -l < "$VARS/suspects.txt" | tr -d ' ') suspect locations"

  # 3. Fan out deep investigation — each suspect gets a subagent with full tool access
  PROMPTS='[]'
  while IFS= read -r loc; do
    [[ -z "$loc" ]] && continue
    PROMPTS=$(echo "$PROMPTS" | jq --arg loc "$loc" '. + ["Investigate " + $loc + " — trace the data flow to find where the object could be undefined. Read the file, check callers, and determine if this is the root cause. End your response with VERDICT:yes or VERDICT:no"]')
  done < "$VARS/suspects.txt"
  subagent_batch "$PROMPTS" > "$VARS/investigations.txt"

  # 4. Check which investigations found the root cause
  if grep -q "VERDICT:yes" "$VARS/investigations.txt"; then
    echo "Root cause found. Spawning fix agent..."
    EVIDENCE=$(awk '/VERDICT:yes/{found=1} found' "$VARS/investigations.txt" | head -50)
    subagent <<FIXPROMPT
  Based on this investigation:
  $EVIDENCE

  Apply a fix for the TypeError. Then run the relevant tests to verify.
  FIXPROMPT
  else
    echo "No conclusive root cause found. All investigations saved to $VARS/investigations.txt"
    echo "Consider widening the search or investigating manually."
  fi
  ```

**Key patterns**: bash gives you programmatic control flow (if/else, loops, conditionals),
data pipelines (jq, grep, awk to filter/transform between steps), fan-out-then-converge
(subagent_batch for parallel work, then aggregate and decide), mixed tools (llm-subcall
for fast triage, subagent for deep work), and persistent state (vars/ survives across bash calls).

### Shell compatibility (IMPORTANT)

The shell is **zsh**, not bash. Write POSIX-compatible or zsh-safe code:
- Do NOT use `bash -c` or bashisms like `${var//pattern/replace}` — use `sed` instead.
- Do NOT use `mapfile` or `readarray` — use `while read` loops instead.
- Do NOT use `local -a` — use `local arr; arr=()` instead.
- Avoid `match` as a variable name in `awk` — it is a built-in function.
- Use `[[ ... ]]` for conditionals (works in both bash and zsh).
- For regex matching, use `grep -E` or `rg` rather than bash regex operators.
- Quote ALL variable expansions: `"$var"` not `$var`.
- For process substitution `<(...)`, prefer piping instead: `cmd | while read ...`.
- For string replacement: `echo "$var" | sed 's/old/new/g'` instead of `${var//old/new}`.
- Test scripts with `zsh -n script.sh` before running if complex.
- Use `/tmp/rlm/` for all temp files (pre-authorized, no permission prompts).

### Workflow guidance

- **Always use bash** for file operations, analysis, and coordination.
- Break complex tasks into subtasks and delegate with subagent or subagent_batch.
- For independent subtasks, prefer subagent_batch to run them concurrently.
- For quick LLM queries without tool access, use llm-subcall.
- Each bash call is a fresh process — variables do not persist between calls.
  To carry state across calls, write to files in `<varsDir>` and read them back.
- **IMPORTANT**: For complex prompts with quotes, braces, backslashes, or JSON, ALWAYS use heredoc syntax:
  ```bash
  subagent <<'EOF'
  Your complex prompt with "quotes", {braces}, and $pecial chars here.
  EOF
  ```
  This prevents all shell parsing issues. Only use single-quoted args for short, simple prompts.
- Pass JSON arguments as single-quoted strings to preserve spaces.
- Store all temp files under `/tmp/rlm/` — never use `/tmp/` directly (avoids permission prompts).

### Trajectory and scratch space

Your full conversation trajectory is logged at: `<trajectoryPath>`
Read this file to recall past work after context compaction. It is append-only — do not write to it.

Your persistent scratch directory is: `<varsDir>`
Use it to store plans, notes, intermediate results, or anything that should survive compaction.
Prefer structured formats (JSON) so future reads are cheap.

**If you are unsure about a term, function, or file the user references — check the trajectory.**
After compaction, your context only has a summary. The trajectory has every turn verbatim:
`grep -i "parseConfig" <trajectoryPath>` or use jq to search turn content.
````

</details>

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

This example demonstrates how the LM can use **programmatic control flow** to orchestrate a multi-phase workflow. It starts by discovering source files and dynamically building a JSON array of review prompts using a `while read` loop and `jq`. Then it fans out all reviews concurrently via `subagent_batch` — each file gets its own child session with full tool access, running in parallel. The structured output format (`ISSUE:high:file:description`) lets the script use `grep` to filter results programmatically, and an `if/else` conditional decides whether to spawn a second round of fix agents. The fix prompts are themselves built dynamically by iterating over the grouped issues. Finally, the script verifies the fixes by running the test suite — closing the loop with automated validation.

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

This example shows how different tool tiers can be **chained together in a pipeline**, with each step narrowing the search space for the next. It starts with a broad `grep` to find candidate locations, then uses `llm-subcall` (a fast, tool-less LLM call) to triage the candidates — this is cheap and quick because it doesn't need to read files or run tools. The triage results are written to `vars/` so they persist across bash calls. The filtered suspects are then fanned out to full `subagent` sessions (with tool access) for deep investigation — each subagent can read files, trace call chains, and check callers. The structured `VERDICT:yes/no` output lets the script use `grep` to determine if any investigation was conclusive, and conditionally spawn a final fix agent that receives the accumulated evidence as context.

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
