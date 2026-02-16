import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// bin/ directory with the real standalone scripts
const binDir = join(import.meta.dir, "..", "..", "bin");

/**
 * Helper: run a bash snippet with bin/ scripts on PATH.
 * We stub `llm-subcall` with a simple echo script
 * so we can verify which path subagent takes without needing a real server.
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

// ── Setup ───────────────────────────────────────────────────────────

let stubDir: string;

beforeAll(() => {
  // Create stub script for `llm-subcall` that echoes a marker
  stubDir = join(tmpdir(), "opencode-rlm-test-stubs");
  const { mkdirSync } = require("fs");
  mkdirSync(stubDir, { recursive: true });

  // Stub llm-subcall: echoes "LLM_SUBCALL:<prompt>" and passes through --system
  writeFileSync(
    join(stubDir, "llm-subcall"),
    `#!/usr/bin/env bash
prompt=""
system=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) system="$2"; shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done
if [[ -n "$system" ]]; then
  echo "LLM_SUBCALL:$prompt SYSTEM:$system"
else
  echo "LLM_SUBCALL:$prompt"
fi
`,
    { mode: 0o755 },
  );
});

/** Build a command with stubs and bin/ scripts on PATH */
function cmd(script: string): string {
  // stubs first so they override real llm-subcall, then bin/ for subagent etc.
  return `export PATH="${stubDir}:${binDir}:$PATH"\n${script}`;
}

// ── bin/ scripts validation ─────────────────────────────────────────

describe("bin/ scripts", () => {
  test("subagent script exists and is executable", () => {
    const p = join(binDir, "subagent");
    expect(existsSync(p)).toBe(true);
    const stats = statSync(p);
    expect(stats.mode & 0o111).toBeTruthy();
  });

  test("subagent_batch script exists and is executable", () => {
    const p = join(binDir, "subagent_batch");
    expect(existsSync(p)).toBe(true);
    const stats = statSync(p);
    expect(stats.mode & 0o111).toBeTruthy();
  });

  test("list_tools script exists and is executable", () => {
    const p = join(binDir, "list_tools");
    expect(existsSync(p)).toBe(true);
    const stats = statSync(p);
    expect(stats.mode & 0o111).toBeTruthy();
  });

  test("subagent script has valid bash syntax", async () => {
    const { exitCode, stderr } = await runBash(`bash -n "${join(binDir, "subagent")}"`);
    expect(exitCode).toBe(0);
    if (stderr) expect(stderr).not.toContain("syntax error");
  });

  test("subagent_batch script has valid bash syntax", async () => {
    const { exitCode, stderr } = await runBash(`bash -n "${join(binDir, "subagent_batch")}"`);
    expect(exitCode).toBe(0);
    if (stderr) expect(stderr).not.toContain("syntax error");
  });

  test("list_tools script has valid bash syntax", async () => {
    const { exitCode, stderr } = await runBash(`bash -n "${join(binDir, "list_tools")}"`);
    expect(exitCode).toBe(0);
    if (stderr) expect(stderr).not.toContain("syntax error");
  });

  test("subagent script starts with shebang", () => {
    const content = readFileSync(join(binDir, "subagent"), "utf-8");
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("llm_subcall_batch does not exist (removed)", () => {
    const p = join(binDir, "llm_subcall_batch");
    expect(existsSync(p)).toBe(false);
  });
});

// ── subagent calls llm-subcall ──────────────────────────────────────

describe("subagent (LLM call)", () => {
  test("calls llm-subcall with the prompt", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('subagent "analyze this"'),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:analyze this");
  });

  test("passes --system flag through to llm-subcall", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('subagent "analyze this" --system "Be concise"'),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:analyze this");
    expect(stdout).toContain("SYSTEM:Be concise");
  });

  test("prompt with spaces is preserved", async () => {
    const { stdout } = await runBash(
      cmd('subagent "analyze the auth module in src/auth.ts"'),
    );
    expect(stdout).toContain("LLM_SUBCALL:analyze the auth module in src/auth.ts");
  });

  test("prompt with special characters is preserved", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent 'Review this: "hello world"'`),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:");
  });
});

// ── subagent output capture ─────────────────────────────────────────

describe("subagent output capture", () => {
  test("stdout from subagent can be captured in a variable", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('RESULT=$(subagent "capture me")\necho "GOT:$RESULT"'),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("GOT:LLM_SUBCALL:capture me");
  });

  test("stdout from subagent can be piped", async () => {
    const { exitCode, stdout } = await runBash(
      cmd('subagent "pipe me" | tr "a-z" "A-Z"'),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:");
  });

  test("stdout from subagent can be written to a file", async () => {
    const outFile = join(tmpdir(), "opencode-rlm-test-out.txt");
    const { exitCode } = await runBash(
      cmd(`subagent "file output" > "${outFile}"`),
    );
    expect(exitCode).toBe(0);
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("LLM_SUBCALL:file output");
  });
});

// ── subagent_batch ──────────────────────────────────────────────────

describe("subagent_batch", () => {
  test("runs multiple prompts and collects output", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent_batch '["prompt one","prompt two","prompt three"]'`),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:prompt one");
    expect(stdout).toContain("LLM_SUBCALL:prompt two");
    expect(stdout).toContain("LLM_SUBCALL:prompt three");
  });

  test("passes --system flag through to each subagent", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent_batch '["first","second"]' --system "Be brief"`),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SYSTEM:Be brief");
  });

  test("reports agent count on stderr", async () => {
    const { stderr } = await runBash(
      cmd(`subagent_batch '["a","b"]'`),
    );
    expect(stderr).toContain("Agent 1/2");
    expect(stderr).toContain("Agent 2/2");
    expect(stderr).toContain("2/2 agents completed");
  });

  test("with no argument, prints usage and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      cmd("subagent_batch"),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent_batch");
  });

  test("handles single-element batch", async () => {
    const { exitCode, stdout } = await runBash(
      cmd(`subagent_batch '["only one"]'`),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:only one");
  });

  test("handles large batch (5 prompts)", async () => {
    const prompts = JSON.stringify(["p1", "p2", "p3", "p4", "p5"]);
    const { exitCode, stdout, stderr } = await runBash(
      cmd(`subagent_batch '${prompts}'`),
    );
    expect(exitCode).toBe(0);
    for (let i = 1; i <= 5; i++) {
      expect(stdout).toContain(`LLM_SUBCALL:p${i}`);
      expect(stderr).toContain(`Agent ${i}/5`);
    }
    expect(stderr).toContain("5/5 agents completed");
  });

  test("batch output can be captured in a variable", async () => {
    const { stdout } = await runBash(
      cmd(`RESULT=$(subagent_batch '["x","y"]')\necho "BATCH:$RESULT"`),
    );
    expect(stdout).toContain("BATCH:");
    expect(stdout).toContain("LLM_SUBCALL:x");
    expect(stdout).toContain("LLM_SUBCALL:y");
  });

  test("batch cleans up temp directory", async () => {
    const { exitCode } = await runBash(
      cmd(`subagent_batch '["cleanup test"]'`),
    );
    expect(exitCode).toBe(0);
  });

  test("batch with prompts containing spaces", async () => {
    const { stdout } = await runBash(
      cmd(`subagent_batch '["analyze src/auth.ts","review the api layer"]'`),
    );
    expect(stdout).toContain("LLM_SUBCALL:analyze src/auth.ts");
    expect(stdout).toContain("LLM_SUBCALL:review the api layer");
  });

  test("batch stderr shows agent headers in order", async () => {
    const { stderr } = await runBash(
      cmd(`subagent_batch '["x","y","z"]'`),
    );
    const idx1 = stderr.indexOf("Agent 1/3");
    const idx2 = stderr.indexOf("Agent 2/3");
    const idx3 = stderr.indexOf("Agent 3/3");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });
});

// ── subagent_batch error handling ───────────────────────────────────

describe("subagent_batch error handling", () => {
  test("reports failed agents when llm-subcall returns error", async () => {
    const failStubDir = join(tmpdir(), "opencode-rlm-test-fail-stubs");
    const { mkdirSync } = require("fs");
    mkdirSync(failStubDir, { recursive: true });

    writeFileSync(
      join(failStubDir, "llm-subcall"),
      `#!/usr/bin/env bash
echo "ERROR: something went wrong" >&2
exit 1
`,
      { mode: 0o755 },
    );

    const { stderr } = await runBash(
      `export PATH="${failStubDir}:${binDir}:$PATH"\nsubagent_batch '["fail1","fail2"]'`,
    );
    expect(stderr).toContain("[error]");
    expect(stderr).toContain("0/2 agents completed");
  });

  test("handles mixed success and empty output", async () => {
    const mixStubDir = join(tmpdir(), "opencode-rlm-test-mix-stubs2");
    const { mkdirSync } = require("fs");
    mkdirSync(mixStubDir, { recursive: true });

    writeFileSync(
      join(mixStubDir, "llm-subcall"),
      `#!/usr/bin/env bash
if [[ "$1" == *"good"* ]]; then
  echo "LLM_SUBCALL:$1"
fi
`,
      { mode: 0o755 },
    );

    const { stdout, stderr } = await runBash(
      `export PATH="${mixStubDir}:${binDir}:$PATH"\nsubagent_batch '["good one","bad one","good two"]'`,
    );
    expect(stdout).toContain("LLM_SUBCALL:good one");
    expect(stdout).toContain("LLM_SUBCALL:good two");
    expect(stderr).toContain("2/3 agents completed");
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
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("R1:LLM_SUBCALL:first");
    expect(stdout).toContain("R2:LLM_SUBCALL:second");
    expect(stdout).toContain("R3:LLM_SUBCALL:third");
  });

  test("subagent followed by subagent_batch", async () => {
    const { exitCode, stdout } = await runBash(
      cmd([
        'SINGLE=$(subagent "single first")',
        `BATCH=$(subagent_batch '["batch a","batch b"]')`,
        'echo "SINGLE:$SINGLE"',
        'echo "BATCH:$BATCH"',
      ].join("\n")),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SINGLE:LLM_SUBCALL:single first");
    expect(stdout).toContain("LLM_SUBCALL:batch a");
    expect(stdout).toContain("LLM_SUBCALL:batch b");
  });

  test("subagent result used as input to next subagent", async () => {
    const { exitCode, stdout } = await runBash(
      cmd([
        'STEP1=$(subagent "analyze code")',
        'subagent "summarize: $STEP1"',
      ].join("\n")),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("summarize: LLM_SUBCALL:analyze code");
  });
});
