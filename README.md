# opencode-rlm

Recursive Language Model plugin for [OpenCode](https://opencode.ai). Tracks the full conversation trajectory to disk, enriches context compaction with trajectory history, and gives the LM a scratch directory for persisting intermediates across compaction boundaries.

## What it does

- On every turn, appends the conversation to `/tmp/rlm-opencode-<hash>/active/trajectory.json`
- When OpenCode compacts context, injects past trajectory summaries into the compaction prompt so the summary is RLM-aware
- After compaction, records the summary in `trajectory.json` as a boundary marker (trajectory -> summary -> trajectory -> summary -> ...)
- Exposes a `vars/` scratch directory via system prompt so the LM can read/write intermediates using standard file tools
- Blocks the LM from writing to `active/` (scaffold-managed, read-only)
- Provides `rlm_read_trajectory` and `rlm_search_trajectory` tools for the LM to inspect past segments

## Prerequisites

- [Bun](https://bun.sh) (OpenCode plugins run on Bun)
- [OpenCode](https://opencode.ai)

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://opencode.ai/install | bash
```

## Local installation

Clone and install dependencies:

```bash
git clone <this-repo>
cd opencode-rlm
bun install
```

Then register it in `opencode.json` (project root) or `~/.config/opencode/opencode.json` (global):

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-rlm"]
}
```

Alternatively, place the plugin directory in `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global).

## Verify it works

1. Run `opencode` in a project directory
2. Check logs for `RLM plugin loaded`
3. After a message exchange, look for a `/tmp/rlm-opencode-*` directory containing `active/trajectory.json`
4. Run `/context` — you'll see the standard OpenCode context info plus an appended **RLM Context** section:

```
 Context Usage
 ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   claude-opus-4-6 · 52k/200k tokens (26%)
 ...

RLM Context
  ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶  active segment 0 · 12.3k tokens (24 turns)

  Trajectory
    ⛁ Active:    12.3k tokens, 24 turns (100%)
    Total: 12.3k tokens, 24 turns

  Vars
    (empty)

  Session:    /tmp/rlm-opencode-8e13a
  Trajectory: /tmp/rlm-opencode-8e13a/active/trajectory.json
  Vars:       /tmp/rlm-opencode-8e13a/vars
```

## Configuration

Set via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_BASE_DIR` | `/tmp` | Base directory for session directories |
| `RLM_CLEANUP_ON_DELETE` | `false` | Delete session dir when session is deleted |
| `RLM_MAX_TOOL_OUTPUT_CHARS` | `50000` | Max chars to store per tool result in trajectory |
| `RLM_TOKEN_ESTIMATE_MULTIPLIER` | `1.0` | Tuning multiplier for token estimation |

## Session directory layout

```
/tmp/rlm-opencode-<hash>/
  active/
    trajectory.json    # Full trajectory log (read-only for the LM)
  vars/                # Scratch directory (LM reads/writes freely)
```
