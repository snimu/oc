import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { example1Bash, example2Bash, example3Bash } from "./system-prompt-examples";

/**
 * Tests for the 3 system prompt bash examples.
 *
 * Imports the exact same bash code the system prompt uses (from
 * src/system-prompt-examples.ts) and runs it with stubbed
 * subagent/subagent_batch/llm-subcall against realistic file fixtures.
 */

async function runBash(
  script: string,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

// ── Shared fixtures ─────────────────────────────────────────────────

let testRoot: string;
let varsDir: string;
let trajectoryPath: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "rlm-examples-test-"));
  const srcDir = join(testRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(testRoot, "active"), { recursive: true });

  // Source files for examples 1 and 2
  writeFileSync(
    join(srcDir, "auth.ts"),
    [
      'export function getUser(token: string) {',
      '  const session = validateToken(token);',
      '  return session.user;',
      '}',
      '',
      'export function validateToken(token: string) {',
      '  if (!token) return null;',
      '  return { user: { id: 1 }, expires: Date.now() + 3600000 };',
      '}',
    ].join("\n"),
  );

  writeFileSync(
    join(srcDir, "api.ts"),
    [
      'import { getUser } from "./auth";',
      '',
      'export async function handleRequest(req: Request) {',
      '  const token = req.headers.get("authorization");',
      '  const user = getUser(token);',
      '  return new Response(JSON.stringify({ user: user.name }));',
      '}',
    ].join("\n"),
  );

  writeFileSync(
    join(srcDir, "utils.ts"),
    'export function formatDate(d: Date) {\n  return d.toISOString().split("T")[0];\n}\n',
  );

  writeFileSync(
    join(srcDir, "auth.test.ts"),
    'import { test } from "bun:test";\ntest("placeholder", () => {});\n',
  );

  // Trajectory for example 3
  trajectoryPath = join(testRoot, "active", "trajectory.json");
  writeFileSync(
    trajectoryPath,
    JSON.stringify({
      version: 1,
      sessionId: "test-session",
      createdAt: "2026-02-17T10:00:00.000Z",
      lastUpdatedAt: "2026-02-17T11:00:00.000Z",
      entries: [
        {
          type: "segment",
          segmentIndex: 0,
          turns: [
            {
              turnIndex: 0, role: "user",
              content: "Can you look at the parseConfig function in src/config.ts?",
              estimatedTokens: 20, timestamp: "2026-02-17T10:00:00.000Z",
            },
            {
              turnIndex: 1, role: "assistant",
              content: 'The parseConfig function currently looks like:\n```typescript\nexport function parseConfig(raw: string): Config {\n  const json = JSON.parse(raw);\n  return { host: json.host ?? "localhost", port: json.port ?? 3000 };\n}\n```\nNo validation — invalid JSON throws unhandled.',
              estimatedTokens: 80, timestamp: "2026-02-17T10:01:00.000Z",
            },
            {
              turnIndex: 2, role: "user",
              content: "Add error handling and a maxRetries config option to parseConfig",
              estimatedTokens: 15, timestamp: "2026-02-17T10:02:00.000Z",
            },
            {
              turnIndex: 3, role: "assistant",
              content: 'Updated parseConfig with try/catch and maxRetries:\n```typescript\nexport function parseConfig(raw: string): Config {\n  try {\n    const json = JSON.parse(raw);\n    return { host: json.host ?? "localhost", port: json.port ?? 3000, maxRetries: json.maxRetries ?? 3 };\n  } catch (e) { throw new Error(`Invalid config`); }\n}\n```',
              estimatedTokens: 100, timestamp: "2026-02-17T10:03:00.000Z",
            },
          ],
          totalEstimatedTokens: 215,
          startedAt: "2026-02-17T10:00:00.000Z",
          compactedAt: "2026-02-17T10:30:00.000Z",
        },
        {
          type: "compaction", segmentIndex: 0,
          summary: "Added error handling and maxRetries to parseConfig",
          summaryTokens: 10, originalTokens: 215,
          compactedAt: "2026-02-17T10:30:00.000Z",
        },
        {
          type: "segment", segmentIndex: 1,
          turns: [{
            turnIndex: 4, role: "user",
            content: "Now add timeout support",
            estimatedTokens: 10, timestamp: "2026-02-17T10:31:00.000Z",
          }],
          totalEstimatedTokens: 10,
          startedAt: "2026-02-17T10:31:00.000Z",
          compactedAt: null,
        },
      ],
      stats: { totalTurns: 5, totalCompactions: 1, totalTokensProcessed: 225, currentActiveTokens: 10 },
    }, null, 2),
  );
});

beforeEach(() => {
  varsDir = mkdtempSync(join(testRoot, "vars-"));
});

// ── Stubs ───────────────────────────────────────────────────────────

/**
 * Bash preamble that stubs subagent, subagent_batch, llm-subcall, and bun.
 * Each stub writes its received prompt to a numbered file so tests can
 * inspect the exact arguments. Returns canned responses.
 */
function stubs(opts: {
  subagentResponse?: string;
  subagentBatchResponses?: string[];
  llmSubcallResponse?: string;
} = {}): string {
  const subagentResp = opts.subagentResponse ?? "STUB_SUBAGENT_RESULT";
  const llmResp = opts.llmSubcallResponse ?? "STUB_LLM_RESULT";
  const batchResps = opts.subagentBatchResponses ?? [];
  for (let i = 0; i < batchResps.length; i++) {
    writeFileSync(join(varsDir, `_batch_resp_${i}.txt`), batchResps[i]);
  }

  return `
set -euo pipefail
STUB_DIR="${varsDir}"

_LLM_IDX=0
llm-subcall() {
  local sys_prompt="" prompt=""
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --system) sys_prompt="\$2"; shift 2 ;;
      *) prompt="\$1"; shift ;;
    esac
  done
  if [[ -z "$prompt" && ! -t 0 ]]; then prompt=$(cat); fi
  printf '%s' "$sys_prompt" > "$STUB_DIR/_llm_sys_\${_LLM_IDX}.txt"
  printf '%s' "$prompt" > "$STUB_DIR/_llm_prompt_\${_LLM_IDX}.txt"
  _LLM_IDX=$((_LLM_IDX + 1))
  printf '%s' '${llmResp}'
}

_SUBAGENT_IDX=0
subagent() {
  local prompt="\${1:-}"
  if [[ -z "$prompt" && ! -t 0 ]]; then prompt=$(cat); fi
  printf '%s' "$prompt" > "$STUB_DIR/_subagent_\${_SUBAGENT_IDX}.txt"
  _SUBAGENT_IDX=$((_SUBAGENT_IDX + 1))
  printf '%s' '${subagentResp}'
}

_BATCH_IDX=0
subagent_batch() {
  local json="\${1:-}"
  if [[ -z "$json" && ! -t 0 ]]; then json=$(cat); fi
  printf '%s' "$json" > "$STUB_DIR/_batch_json_\${_BATCH_IDX}.txt"
  local resp_file="${varsDir}/_batch_resp_\${_BATCH_IDX}.txt"
  _BATCH_IDX=$((_BATCH_IDX + 1))
  if [[ -f "$resp_file" ]]; then
    cat "$resp_file"
  else
    printf '%s' "$json" | jq -r '.[]' | while IFS= read -r p; do
      echo "BATCH_RESULT:$p"
    done
  fi
}

bun() {
  if [[ "\$1" == "test" ]]; then echo "All 5 tests pass"; return 0; fi
  command bun "\$@"
}
`;
}

function readStub(type: string, idx = 0): string {
  try { return readFileSync(join(varsDir, `_${type}_${idx}.txt`), "utf-8"); }
  catch { return ""; }
}

function countStubs(type: string): number {
  let i = 0;
  try { while (readFileSync(join(varsDir, `_${type}_${i}.txt`))) i++; }
  catch { /* done */ }
  return i;
}

/** Run the exact example bash code with stubs prepended, cwd = testRoot. */
function run(script: string, env?: Record<string, string>) {
  return runBash(script, { cwd: testRoot, env });
}

// ── Example 1: parallel review with conditional follow-up ───────────

describe("Example 1: parallel review with conditional follow-up", () => {
  test("syntax check on the exact system prompt code", async () => {
    const scriptFile = join(testRoot, "example1.sh");
    writeFileSync(scriptFile, stubs() + "\n" + example1Bash(varsDir));
    const { exitCode, stderr } = await runBash(`bash -n "${scriptFile}"`);
    expect(stderr).not.toContain("syntax error");
    expect(exitCode).toBe(0);
  });

  test("no issues → skips fix phase", async () => {
    const script = stubs({ subagentBatchResponses: ["NONE\nNONE\nNONE"] })
      + "\n" + example1Bash(varsDir);
    const { exitCode, stdout } = await run(script);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 0 high-severity issues");
    expect(stdout).toContain("No high-severity issues found");
    expect(countStubs("batch_json")).toBe(1);
  });

  test("high issues → runs fix phase and tests", async () => {
    const reviews = [
      "ISSUE:high:auth.ts:3:Missing null check on session.user",
      "ISSUE:low:auth.ts:1:Consider using const",
      "ISSUE:high:api.ts:5:No null check on getUser return value",
    ].join("\n");
    const script = stubs({ subagentBatchResponses: [reviews, "Fixed."] })
      + "\n" + example1Bash(varsDir);
    const { exitCode, stdout } = await run(script);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 2 high-severity issues");
    expect(stdout).toContain("All tests pass after fixes");
    const highIssues = readFileSync(join(varsDir, "high-issues.txt"), "utf-8");
    expect(highIssues).toContain("ISSUE:high:");
    expect(highIssues).not.toContain("ISSUE:low:");
    expect(countStubs("batch_json")).toBe(2);
  });

  test("file discovery excludes test files", async () => {
    const script = stubs({ subagentBatchResponses: ["NONE"] })
      + "\n" + example1Bash(varsDir);
    await run(script);
    const files = readFileSync(join(varsDir, "files.txt"), "utf-8");
    expect(files).toContain("auth.ts");
    expect(files).toContain("api.ts");
    expect(files).toContain("utils.ts");
    expect(files).not.toContain("auth.test.ts");
  });

  test("jq builds valid JSON prompts array", async () => {
    const script = stubs({ subagentBatchResponses: ["NONE"] })
      + "\n" + example1Bash(varsDir);
    await run(script);
    const batchJson = readStub("batch_json", 0);
    const prompts = JSON.parse(batchJson);
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p).toContain("Review ");
      expect(p).toContain("ISSUE:");
    }
  });

  test("fix phase groups issues by file and builds fix prompts", async () => {
    const reviews = [
      "ISSUE:high:auth.ts:3:Null deref",
      "ISSUE:high:auth.ts:7:Unhandled error",
      "ISSUE:high:api.ts:5:No validation",
    ].join("\n");
    const script = stubs({ subagentBatchResponses: [reviews, "done"] })
      + "\n" + example1Bash(varsDir);
    await run(script);
    expect(countStubs("batch_json")).toBe(2);
    const fixJson = readStub("batch_json", 1);
    const fixPrompts = JSON.parse(fixJson);
    expect(fixPrompts.length).toBeGreaterThanOrEqual(1);
    const allText = fixPrompts.join(" ");
    expect(allText).toContain("auth.ts");
    expect(allText).toContain("api.ts");
  });
});

// ── Example 2: iterative investigation with accumulating context ────

describe("Example 2: iterative investigation with accumulating context", () => {
  test("syntax check on the exact system prompt code", async () => {
    const scriptFile = join(testRoot, "example2.sh");
    writeFileSync(scriptFile, stubs() + "\n" + example2Bash(varsDir));
    const { exitCode, stderr } = await runBash(`bash -n "${scriptFile}"`);
    expect(stderr).not.toContain("syntax error");
    expect(exitCode).toBe(0);
  });

  test("grep finds getUser references in source files", async () => {
    const script = stubs({
      llmSubcallResponse: "src/auth.ts:2\nsrc/api.ts:5",
      subagentBatchResponses: ["VERDICT:no\nVERDICT:no"],
    }) + "\n" + example2Bash(varsDir);
    await run(script);
    const refs = readFileSync(join(varsDir, "refs.txt"), "utf-8");
    expect(refs).toContain("getUser");
    expect(refs).toContain("auth.ts");
    expect(refs).toContain("api.ts");
    expect(refs).not.toContain("utils.ts");
  });

  test("llm-subcall receives --system flag", async () => {
    const script = stubs({
      llmSubcallResponse: "src/auth.ts:2",
      subagentBatchResponses: ["VERDICT:no"],
    }) + "\n" + example2Bash(varsDir);
    await run(script);
    expect(readStub("llm_sys", 0)).toContain("Output ONLY file:line pairs");
  });

  test("suspects written to file and counted", async () => {
    const script = stubs({
      llmSubcallResponse: "src/auth.ts:2\nsrc/api.ts:5",
      subagentBatchResponses: ["VERDICT:no\nVERDICT:no"],
    }) + "\n" + example2Bash(varsDir);
    const { stdout } = await run(script);
    expect(stdout).toContain("LLM identified 2 suspect locations");
    const suspects = readFileSync(join(varsDir, "suspects.txt"), "utf-8");
    expect(suspects).toContain("src/auth.ts:2");
    expect(suspects).toContain("src/api.ts:5");
  });

  test("VERDICT:yes → spawns fix agent with evidence", async () => {
    const investigation =
      "getUser at api.ts:5 can return null when token missing. VERDICT:yes";
    const script = stubs({
      llmSubcallResponse: "src/api.ts:5",
      subagentBatchResponses: [investigation],
      subagentResponse: "Applied null check fix",
    }) + "\n" + example2Bash(varsDir);
    const { exitCode, stdout } = await run(script);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Root cause found. Spawning fix agent...");
    const prompt = readStub("subagent", 0);
    expect(prompt).toContain("VERDICT:yes");
    expect(prompt).toContain("Apply a fix");
  });

  test("no VERDICT:yes → reports no root cause", async () => {
    const script = stubs({
      llmSubcallResponse: "src/auth.ts:2",
      subagentBatchResponses: ["Investigated. VERDICT:no"],
    }) + "\n" + example2Bash(varsDir);
    const { exitCode, stdout } = await run(script);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No conclusive root cause found");
    expect(countStubs("subagent")).toBe(0);
  });

  test("jq builds investigation prompts from suspects", async () => {
    const script = stubs({
      llmSubcallResponse: "src/auth.ts:2\nsrc/api.ts:5",
      subagentBatchResponses: ["VERDICT:no\nVERDICT:no"],
    }) + "\n" + example2Bash(varsDir);
    await run(script);
    const prompts = JSON.parse(readStub("batch_json", 0));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Investigate src/auth.ts:2");
    expect(prompts[1]).toContain("Investigate src/api.ts:5");
    expect(prompts[0]).toContain("VERDICT:");
  });
});

// ── Example 3: recovering lost context from trajectory ──────────────

describe("Example 3: recovering lost context from trajectory", () => {
  test("syntax check on the exact system prompt code", async () => {
    const scriptFile = join(testRoot, "example3.sh");
    writeFileSync(scriptFile, stubs() + "\n" + example3Bash(varsDir, trajectoryPath));
    const { exitCode, stderr } = await runBash(`bash -n "${scriptFile}"`);
    expect(stderr).not.toContain("syntax error");
    expect(exitCode).toBe(0);
  });

  test("subagent receives search prompt with trajectory path and jq command", async () => {
    const script = stubs({
      subagentResponse: "parseConfig: added error handling and maxRetries",
    }) + "\n" + example3Bash(varsDir, trajectoryPath);
    const { exitCode } = await run(script);
    expect(exitCode).toBe(0);
    const prompt = readStub("subagent", 0);
    expect(prompt).toContain("parseConfig");
    expect(prompt).toContain(trajectoryPath);
    expect(prompt).toContain("jq");
  });

  test("result saved to vars/ and echoed to stdout", async () => {
    const response = "parseConfig: originally no error handling. Added try/catch and maxRetries.";
    const script = stubs({ subagentResponse: response })
      + "\n" + example3Bash(varsDir, trajectoryPath);
    const { exitCode, stdout } = await run(script);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("parseConfig");
    expect(stdout).toContain("maxRetries");
    const saved = readFileSync(join(varsDir, "parseConfig-history.txt"), "utf-8");
    expect(saved).toContain("parseConfig");
  });

  test("heredoc expands $TRAJECTORY (not literal)", async () => {
    const script = stubs({ subagentResponse: "result" })
      + "\n" + example3Bash(varsDir, trajectoryPath);
    await run(script);
    const prompt = readStub("subagent", 0);
    expect(prompt).toContain(trajectoryPath);
    expect(prompt).not.toContain("$TRAJECTORY");
  });

  test("jq command from the example works against trajectory.json", async () => {
    const { exitCode, stdout } = await runBash(
      `jq -r '.entries[].turns[]? | select(.content | test("parseConfig"; "i")) | "\\(.role) [turn \\(.turnIndex)]:\\n\\(.content[:500])"' "${trajectoryPath}"`,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("user [turn 0]");
    expect(stdout).toContain("assistant [turn 1]");
    expect(stdout).toContain("user [turn 2]");
    expect(stdout).toContain("assistant [turn 3]");
    expect(stdout).toContain("parseConfig");
    expect(stdout).not.toContain("turn 4");
  });
});
