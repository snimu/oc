import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface SubagentPaths {
  functionsPath: string;
}

/**
 * Writes the bash functions script to disk and returns paths.
 * The script provides subagent, subagent_batch, and list_tools helpers.
 * subagent/subagent_batch delegate to `opencode run` for full recursive sessions.
 * list_tools queries the OpenCode server API for available tool IDs.
 *
 * OPENCODE_RLM_DEPTH is injected by the plugin in tool.execute.before
 * and is the server-side source of truth. The subagent function passes
 * depth + 1 to child `opencode run` processes via env var prefix.
 * The LM cannot tamper with depth — attempts are blocked by the tool guard.
 */
export function setupSubagentFunctions(): SubagentPaths {
  const rlmDir = join(tmpdir(), "opencode-rlm");
  mkdirSync(rlmDir, { recursive: true });

  const functionsPath = join(rlmDir, "functions.sh");

  writeFileSync(functionsPath, buildBashFunctionsScript(), {
    mode: 0o755,
  });

  return { functionsPath };
}

function buildBashFunctionsScript(): string {
  return `#!/usr/bin/env bash
# OPENCODE_RLM_DEPTH is injected by the plugin before this file is sourced.
# Do not override it — the tool guard will block any attempt.

# Query the OpenCode server for available tool IDs (requires --port)
list_tools() {
  local auth_args=()
  if [[ -n "\$OPENCODE_AUTH_HEADER" ]]; then auth_args=(-H "\$OPENCODE_AUTH_HEADER"); fi
  curl -sS "\$OPENCODE_RLM_URL/experimental/tool/ids" \\
    "\${auth_args[@]}" \\
    -H "x-opencode-directory: \$OPENCODE_RLM_DIR_PATH"
}

# Build indent prefix based on nesting depth
_rlm_indent() {
  local d=\${OPENCODE_RLM_DEPTH:-0}
  local prefix=""
  for ((k=0; k<d; k++)); do prefix="  \${prefix}"; done
  printf '%s' "\$prefix"
}

subagent() {
  local prompt="\$1"
  if [[ -z "\$prompt" ]]; then echo "subagent <prompt>" >&2; return 2; fi

  local depth=\${OPENCODE_RLM_DEPTH:-0}
  local max_depth=\${RLM_MAX_SUBAGENT_DEPTH:-3}

  if (( depth >= max_depth )); then
    # At max depth, fall back to llm-subcall (single LLM call, no tools)
    llm-subcall "\$prompt"
  else
    # Spawn a full OpenCode session with incremented depth
    OPENCODE_RLM_DEPTH=\$((depth + 1)) opencode run "\$prompt"
  fi
}

subagent_batch() {
  local json="\$1"
  if [[ -z "\$json" ]]; then echo "subagent_batch <json array>" >&2; return 2; fi
  local batchdir
  batchdir=\$(mktemp -d)
  local pids=()
  local i=0
  local indent
  indent=\$(_rlm_indent)

  while IFS= read -r prompt; do
    ( subagent "\$prompt" > "\$batchdir/\$i.out" 2>"\$batchdir/\$i.err" ) &
    pids+=(\$!)
    i=\$((i + 1))
  done < <(printf '%s' "\$json" | jq -r '.[]')

  local total=\$i
  for pid in "\${pids[@]}"; do wait "\$pid"; done

  local succeeded=0
  local failed=0
  local out err
  for ((j=0; j<total; j++)); do
    printf '%s── Agent %d/%d ──\\n' "\$indent" "\$((j + 1))" "\$total" >&2
    out=\$(cat "\$batchdir/\$j.out")
    err=\$(cat "\$batchdir/\$j.err")
    if [[ -n "\$out" ]]; then
      printf '%s' "\$out" | while IFS= read -r line; do
        printf '%s  %s\\n' "\$indent" "\$line" >&2
      done
      printf '%s\\n' "\$out"
      succeeded=\$((succeeded + 1))
    elif [[ -n "\$err" ]]; then
      printf '%s  [error] %s\\n' "\$indent" "\$err" >&2
      printf '[error] %s\\n' "\$err"
      failed=\$((failed + 1))
    else
      printf '%s  [no output]\\n' "\$indent" >&2
      printf '[no output]\\n'
      failed=\$((failed + 1))
    fi
  done
  printf '%s── %d/%d agents completed ──\\n' "\$indent" "\$succeeded" "\$total" >&2
  rm -rf "\$batchdir"
}
`;
}
