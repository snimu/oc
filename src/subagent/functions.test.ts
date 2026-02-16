import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "bun";

/**
 * Helper: run a bash snippet with env vars set.
 */
async function runBash(
  script: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

// ── Mock OpenCode API server ────────────────────────────────────────

let mockServer: Server;
let mockServerUrl: string;
let sessionIdFile: string;
let functionsPath: string;

// Track created sessions and their prompts
const sessions = new Map<string, { parentID: string; prompts: string[]; title: string }>();
let nextSessionId = 1;

beforeAll(async () => {
  // Write a session ID file (simulates what tool.execute.before does)
  sessionIdFile = join(tmpdir(), "opencode-rlm-test-session-id");
  writeFileSync(sessionIdFile, "parent-session-123");

  // Start a mock OpenCode API server
  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // POST /session — create child session
      if (req.method === "POST" && path === "/session") {
        const body = await req.json();
        const id = `child-session-${nextSessionId++}`;
        const parentID = body.parentID ?? "";
        const title = `Child session - ${new Date().toISOString()}`;
        sessions.set(id, { parentID, prompts: [], title });
        return Response.json({ id, parentID, title, slug: `test-${id}`, version: "1.0.0" });
      }

      // GET /session/:id/children — return child sessions
      const childrenMatch = path.match(/^\/session\/([^/]+)\/children$/);
      if (req.method === "GET" && childrenMatch) {
        const parentId = childrenMatch[1];
        const children: Array<{ id: string; parentID: string; title: string }> = [];
        for (const [id, sess] of sessions) {
          if (sess.parentID === parentId) {
            children.push({ id, parentID: sess.parentID, title: sess.title });
          }
        }
        return Response.json(children);
      }

      // POST /session/:id/prompt_async — send prompt
      const promptMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === "POST" && promptMatch) {
        const id = promptMatch[1];
        const body = await req.json();
        const promptText = body.parts?.[0]?.text ?? "";
        const sess = sessions.get(id);
        if (sess) sess.prompts.push(promptText);
        return new Response(null, { status: 204 });
      }

      // GET /session/status — always return idle
      if (req.method === "GET" && path === "/session/status") {
        const status: Record<string, { type: string }> = {};
        for (const [id] of sessions) {
          status[id] = { type: "idle" };
        }
        return Response.json(status);
      }

      // GET /session/:id/message — return mock assistant message
      const msgMatch = path.match(/^\/session\/([^/]+)\/message$/);
      if (req.method === "GET" && msgMatch) {
        const id = msgMatch[1];
        const sess = sessions.get(id);
        const prompt = sess?.prompts[sess.prompts.length - 1] ?? "unknown";
        return Response.json([
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: `SUBAGENT_RESULT:${prompt} PARENT:${sess?.parentID}` }],
          },
        ]);
      }

      // GET /experimental/tool/ids
      if (req.method === "GET" && path === "/experimental/tool/ids") {
        return Response.json(["bash", "read", "write", "edit", "glob", "grep"]);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  mockServerUrl = `http://127.0.0.1:${mockServer.port}`;

  // Generate functions.sh the same way src/index.ts does at load time
  // Import the function builder dynamically to avoid circular deps
  const { default: indexModule } = await import("../index");
  // We can't easily call buildBashFunctionsScript since it's not exported,
  // so we'll generate the script manually matching what index.ts produces.
  functionsPath = join(tmpdir(), "opencode-rlm-test-functions.sh");
  // Write a functions script that sources subagent/subagent_batch/list_tools
  // matching the exact pattern from buildBashFunctionsScript
  const functionsScript = `#!/usr/bin/env bash
export OPENCODE_RLM_SESSION="$(cat "${sessionIdFile}")"
export OPENCODE_RLM_DEPTH="\${OPENCODE_RLM_DEPTH:-0}"

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

subagent() {
  local prompt="$1"
  if [[ -z "$prompt" ]]; then echo "subagent <prompt>" >&2; return 2; fi
  local H="content-type: application/json"
  local auth_args=()
  if [[ -n "$OPENCODE_AUTH_HEADER" ]]; then auth_args=(-H "$OPENCODE_AUTH_HEADER"); fi

  local sess
  sess=$(curl -sS -X POST "$OPENCODE_RLM_URL/session" \\
    -H "$H" "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH" \\
    -d "{\\"parentID\\":\\"$OPENCODE_RLM_SESSION\\"}")
  local sid
  sid=$(printf '%s' "$sess" | jq -r '.id')
  if [[ -z "$sid" || "$sid" == "null" ]]; then
    echo "subagent: failed to create session: $sess" >&2; return 1
  fi

  curl -sS -X POST "$OPENCODE_RLM_URL/session/$sid/prompt_async" \\
    -H "$H" "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH" \\
    -d "{\\"parts\\":[{\\"type\\":\\"text\\",\\"text\\":$(printf '%s' "$prompt" | jq -Rs .)}],\\"agent\\":\\"general\\"}" \\
    >/dev/null

  local _rlm_status
  while true; do
    _rlm_status=$(curl -sS "$OPENCODE_RLM_URL/session/status" \\
      "\${auth_args[@]}" \\
      -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH" \\
      | jq -r ".[\\"$sid\\"].type // \\"idle\\"")
    if [[ "$_rlm_status" != "busy" ]]; then break; fi
    sleep 0.5
  done

  local msgs
  msgs=$(curl -sS "$OPENCODE_RLM_URL/session/$sid/message" \\
    "\${auth_args[@]}" \\
    -H "x-opencode-directory: $OPENCODE_RLM_DIR_PATH")
  printf '%s' "$msgs" | jq -r '[.[] | select(.info.role=="assistant")] | last | .parts[] | select(.type=="text") | .text'
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

  export OPENCODE_RLM_DEPTH=$((depth + 1))

  while IFS= read -r prompt; do
    ( subagent "$prompt" > "$tmpdir/$i.out" 2>"$tmpdir/$i.err" ) &
    pids+=($!)
    i=$((i + 1))
  done < <(printf '%s' "$json" | jq -r '.[]')

  local total=$i
  for pid in "\${pids[@]}"; do wait "$pid"; done

  export OPENCODE_RLM_DEPTH=$depth

  local succeeded=0
  local failed=0
  local out err
  for ((j=0; j<total; j++)); do
    printf '%s── Agent %d/%d ──\\n' "$indent" "$((j + 1))" "$total" >&2
    out=$(cat "$tmpdir/$j.out")
    err=$(cat "$tmpdir/$j.err")
    if [[ -n "$out" ]]; then
      printf '%s' "$out" | while IFS= read -r line; do
        printf '%s  %s\\n' "$indent" "$line" >&2
      done
      printf '%s\\n' "$out"
      succeeded=$((succeeded + 1))
    elif [[ -n "$err" ]]; then
      printf '%s  [error] %s\\n' "$indent" "$err" >&2
      printf '[error] %s\\n' "$err"
      failed=$((failed + 1))
    else
      printf '%s  [no output]\\n' "$indent" >&2
      printf '[no output]\\n'
      failed=$((failed + 1))
    fi
  done
  printf '%s── %d/%d agents completed ──\\n' "$indent" "$succeeded" "$total" >&2
  rm -rf "$tmpdir"
}
`;
  writeFileSync(functionsPath, functionsScript, { mode: 0o755 });
});

afterAll(() => {
  mockServer.stop();
});

/** Build env vars for running sourced functions against the mock server */
function testEnv(): Record<string, string> {
  return {
    OPENCODE_RLM_URL: mockServerUrl,
    OPENCODE_RLM_DIR_PATH: "/test/project",
    OPENCODE_AUTH_HEADER: "",
  };
}

/** Prepend source of functions.sh to a command (mimics tool.execute.before) */
function cmd(script: string): string {
  return `source "${functionsPath}"\n${script}`;
}

// ── functions.sh validation ─────────────────────────────────────────

describe("functions.sh", () => {
  test("functions file exists", () => {
    expect(existsSync(functionsPath)).toBe(true);
  });

  test("functions file has valid bash syntax", async () => {
    const { exitCode, stderr } = await runBash(`bash -n "${functionsPath}"`);
    expect(exitCode).toBe(0);
    if (stderr) expect(stderr).not.toContain("syntax error");
  });

  test("functions file starts with shebang", () => {
    const content = readFileSync(functionsPath, "utf-8");
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("sourcing defines subagent function", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('type -t subagent'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("function");
  });

  test("sourcing defines subagent_batch function", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('type -t subagent_batch'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("function");
  });

  test("sourcing defines list_tools function", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('type -t list_tools'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("function");
  });

  test("sourcing reads session ID from file", async () => {
    const { stdout } = await runBash(
      cmd('echo "$OPENCODE_RLM_SESSION"'),
      testEnv(),
    );
    expect(stdout).toBe("parent-session-123");
  });
});

// ── subagent creates child session ──────────────────────────────────

describe("subagent (child session)", () => {
  test("creates a child session and returns result", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('subagent "analyze this"'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUBAGENT_RESULT:analyze this");
  });

  test("passes parent session ID to child session", async () => {
    const { stdout } = await runBash(
      cmd('subagent "check parent"'),
      testEnv(),
    );
    expect(stdout).toContain("PARENT:parent-session-123");
  });

  test("with no prompt, prints usage and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      cmd("subagent"),
      testEnv(),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent");
  });

  test("with empty prompt, prints usage and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      cmd('subagent ""'),
      testEnv(),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent");
  });

  test("prompt with spaces is preserved", async () => {
    const { stdout } = await runBash(
      cmd('subagent "analyze the auth module in src/auth.ts"'),
      testEnv(),
    );
    expect(stdout).toContain("SUBAGENT_RESULT:analyze the auth module in src/auth.ts");
  });
});

// ── subagent output capture ─────────────────────────────────────────

describe("subagent output capture", () => {
  test("stdout from subagent can be captured in a variable", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('RESULT=$(subagent "capture me")\necho "GOT:$RESULT"'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("GOT:SUBAGENT_RESULT:capture me");
  });

  test("stdout from subagent can be piped", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('subagent "pipe me" | tr "a-z" "A-Z"'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUBAGENT_RESULT:");
  });

  test("stdout from subagent can be written to a file", async () => {
    const outFile = join(tmpdir(), "opencode-rlm-test-out.txt");
    const { exitCode } = await runBash(
      cmd(`subagent "file output" > "${outFile}"`),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("SUBAGENT_RESULT:file output");
  });
});

// ── subagent_batch ──────────────────────────────────────────────────

describe("subagent_batch", () => {
  test("runs multiple prompts and collects output", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent_batch '["prompt one","prompt two","prompt three"]'`),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUBAGENT_RESULT:prompt one");
    expect(stdout).toContain("SUBAGENT_RESULT:prompt two");
    expect(stdout).toContain("SUBAGENT_RESULT:prompt three");
  });

  test("reports agent count on stderr", async () => {
    const { stderr } = await runBash(
      cmd(`subagent_batch '["a","b"]'`),
      testEnv(),
    );
    expect(stderr).toContain("Agent 1/2");
    expect(stderr).toContain("Agent 2/2");
    expect(stderr).toContain("2/2 agents completed");
  });

  test("with no argument, prints usage and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      cmd("subagent_batch"),
      testEnv(),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent_batch");
  });

  test("handles single-element batch", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent_batch '["only one"]'`),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUBAGENT_RESULT:only one");
  });

  test("batch output can be captured in a variable", async () => {
    const { stdout } = await runBash(
      cmd(`RESULT=$(subagent_batch '["x","y"]')\necho "BATCH:$RESULT"`),
      testEnv(),
    );
    expect(stdout).toContain("BATCH:");
    expect(stdout).toContain("SUBAGENT_RESULT:x");
    expect(stdout).toContain("SUBAGENT_RESULT:y");
  });

  test("batch with prompts containing spaces", async () => {
    const { stdout } = await runBash(
      cmd(`subagent_batch '["analyze src/auth.ts","review the api layer"]'`),
      testEnv(),
    );
    expect(stdout).toContain("SUBAGENT_RESULT:analyze src/auth.ts");
    expect(stdout).toContain("SUBAGENT_RESULT:review the api layer");
  });

  test("batch stderr shows agent headers in order", async () => {
    const { stderr } = await runBash(
      cmd(`subagent_batch '["x","y","z"]'`),
      testEnv(),
    );
    const idx1 = stderr.indexOf("Agent 1/3");
    const idx2 = stderr.indexOf("Agent 2/3");
    const idx3 = stderr.indexOf("Agent 3/3");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });
});

// ── end-to-end: chained subagent calls ──────────────────────────────

describe("chained subagent calls", () => {
  test("multiple sequential subagent calls work", async () => {
    const { exitCode, stdout } = await runBash(
      cmd([
        'R1=$(subagent "first")',
        'R2=$(subagent "second")',
        'R3=$(subagent "third")',
        'echo "R1:$R1 R2:$R2 R3:$R3"',
      ].join("\n")),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("R1:SUBAGENT_RESULT:first");
    expect(stdout).toContain("R2:SUBAGENT_RESULT:second");
    expect(stdout).toContain("R3:SUBAGENT_RESULT:third");
  });

  test("subagent followed by subagent_batch", async () => {
    const { exitCode, stdout } = await runBash(
      cmd([
        'SINGLE=$(subagent "single first")',
        `BATCH=$(subagent_batch '["batch a","batch b"]')`,
        'echo "SINGLE:$SINGLE"',
        'echo "BATCH:$BATCH"',
      ].join("\n")),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SINGLE:SUBAGENT_RESULT:single first");
    expect(stdout).toContain("SUBAGENT_RESULT:batch a");
    expect(stdout).toContain("SUBAGENT_RESULT:batch b");
  });

  test("subagent result used as input to next subagent", async () => {
    const { exitCode, stdout } = await runBash(
      cmd([
        'STEP1=$(subagent "analyze code")',
        'subagent "summarize: $STEP1"',
      ].join("\n")),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("summarize: SUBAGENT_RESULT:analyze code");
  });
});

// ── list_tools ──────────────────────────────────────────────────────

describe("list_tools", () => {
  test("returns tool IDs from mock server", async () => {
    const { exitCode, stdout } = await runBash(
      cmd("list_tools"),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("bash");
    expect(stdout).toContain("read");
  });
});

// ── parent-child session linkage (Ctrl-X visibility) ────────────────

describe("parent-child session linkage", () => {
  test("child session is created with correct parentID", async () => {
    // Call subagent and verify the mock server received the right parentID
    const { exitCode, stdout } = await runBash(
      cmd('subagent "verify parent link"'),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    // Mock server echoes back PARENT:<parentID> in the response
    expect(stdout).toContain("PARENT:parent-session-123");
  });

  test("session creation response includes parentID field", async () => {
    // Directly call the mock server to verify the response shape
    const { stdout } = await runBash(
      `curl -sS -X POST "${mockServerUrl}/session" ` +
        '-H "content-type: application/json" ' +
        '-d \'{"parentID":"test-parent-id"}\'',
    );
    const resp = JSON.parse(stdout);
    expect(resp.id).toBeTruthy();
    expect(resp.parentID).toBe("test-parent-id");
  });

  test("children endpoint returns child sessions for a parent", async () => {
    // Create two child sessions with the same parentID
    const parentId = "shared-parent-for-children-test";
    await runBash(
      `curl -sS -X POST "${mockServerUrl}/session" ` +
        '-H "content-type: application/json" ' +
        `-d '{"parentID":"${parentId}"}'`,
    );
    await runBash(
      `curl -sS -X POST "${mockServerUrl}/session" ` +
        '-H "content-type: application/json" ' +
        `-d '{"parentID":"${parentId}"}'`,
    );

    // Query children endpoint
    const { stdout } = await runBash(
      `curl -sS "${mockServerUrl}/session/${parentId}/children"`,
    );
    const children = JSON.parse(stdout);
    expect(Array.isArray(children)).toBe(true);
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const child of children) {
      expect(child.parentID).toBe(parentId);
    }
  });

  test("subagent reads session ID from file at source time", async () => {
    // Verify OPENCODE_RLM_SESSION is set from the session ID file
    const { stdout } = await runBash(
      cmd('echo "SESSION_VAR:$OPENCODE_RLM_SESSION"'),
      testEnv(),
    );
    expect(stdout).toBe("SESSION_VAR:parent-session-123");
  });

  test("subagent sends parentID matching the session ID file", async () => {
    // Write a different session ID and verify it's used as parentID
    const altSessionFile = join(tmpdir(), "opencode-rlm-test-alt-session-id");
    writeFileSync(altSessionFile, "alt-parent-999");

    // Generate a new functions.sh with the alt session ID file
    const altFunctionsPath = join(tmpdir(), "opencode-rlm-test-alt-functions.sh");
    const content = readFileSync(functionsPath, "utf-8")
      .replace(sessionIdFile, altSessionFile);
    writeFileSync(altFunctionsPath, content, { mode: 0o755 });

    const { stdout } = await runBash(
      `source "${altFunctionsPath}"\nsubagent "check alt parent"`,
      testEnv(),
    );
    expect(stdout).toContain("PARENT:alt-parent-999");
  });

  test("batch creates multiple child sessions all with same parentID", async () => {
    const { stdout } = await runBash(
      cmd(`subagent_batch '["child-a","child-b","child-c"]'`),
      testEnv(),
    );
    // All three should have the same parent
    const parentMatches = stdout.match(/PARENT:parent-session-123/g);
    expect(parentMatches).toBeTruthy();
    expect(parentMatches!.length).toBe(3);
  });
});
