import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { setupSubagentFunctions } from "./functions";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Helper: run a bash snippet with the functions sourced.
 * We stub `opencode` and `llm-subcall` with simple echo scripts
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

let functionsPath: string;
let stubDir: string;

beforeAll(() => {
  const result = setupSubagentFunctions();
  functionsPath = result.functionsPath;

  // Create stub scripts for `opencode` and `llm-subcall` that just echo
  // a marker so tests can verify which codepath was taken.
  stubDir = join(tmpdir(), "opencode-rlm-test-stubs");
  const { mkdirSync } = require("fs");
  mkdirSync(stubDir, { recursive: true });

  // Stub opencode: `opencode run <prompt>` → echoes "OPENCODE_RUN:<prompt> DEPTH:<depth>"
  writeFileSync(
    join(stubDir, "opencode"),
    `#!/usr/bin/env bash
if [[ "$1" == "run" ]]; then
  echo "OPENCODE_RUN:$2 DEPTH:$OPENCODE_RLM_DEPTH"
else
  echo "opencode called with: $@"
fi
`,
    { mode: 0o755 },
  );

  // Stub llm-subcall: echoes "LLM_SUBCALL:<prompt>"
  writeFileSync(
    join(stubDir, "llm-subcall"),
    `#!/usr/bin/env bash
echo "LLM_SUBCALL:$1"
`,
    { mode: 0o755 },
  );
});

/** Build a command that sources functions.sh with stubs on PATH */
function src(cmd: string): string {
  return `export PATH="${stubDir}:$PATH"\nsource "${functionsPath}"\n${cmd}`;
}

// ── setupSubagentFunctions ──────────────────────────────────────────

describe("setupSubagentFunctions", () => {
  test("creates functions.sh at the expected path", () => {
    expect(existsSync(functionsPath)).toBe(true);
    expect(functionsPath).toContain("opencode-rlm");
    expect(functionsPath).toEndWith("functions.sh");
  });

  test("file is executable", () => {
    const stats = statSync(functionsPath);
    // Check owner-execute bit
    expect(stats.mode & 0o100).toBeTruthy();
  });

  test("script defines subagent, subagent_batch, and list_tools functions", () => {
    const content = readFileSync(functionsPath, "utf-8");
    expect(content).toContain("subagent()");
    expect(content).toContain("subagent_batch()");
    expect(content).toContain("list_tools()");
    expect(content).toContain("_rlm_indent()");
  });
});

// ── subagent depth gating ───────────────────────────────────────────

describe("subagent depth gating", () => {
  test("at depth 0 with max 3, calls opencode run", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "analyze this"'),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:");
    expect(stdout).toContain("analyze this");
  });

  test("at depth 2 with max 3, still calls opencode run", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "still deep enough"'),
      { OPENCODE_RLM_DEPTH: "2", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:");
  });

  test("at depth 3 with max 3, falls back to llm-subcall", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "too deep"'),
      { OPENCODE_RLM_DEPTH: "3", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:");
    expect(stdout).toContain("too deep");
  });

  test("at depth 5 with max 3, falls back to llm-subcall", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "way too deep"'),
      { OPENCODE_RLM_DEPTH: "5", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:");
  });

  test("passes incremented depth to opencode run", async () => {
    const { stdout } = await runBash(
      src('subagent "check depth"'),
      { OPENCODE_RLM_DEPTH: "1", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(stdout).toContain("DEPTH:2");
  });

  test("with no depth set, defaults to 0 and calls opencode run", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "no depth"'),
      { RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:");
  });

  test("with max depth 0, always falls back to llm-subcall", async () => {
    const { exitCode, stdout } = await runBash(
      src('subagent "immediate fallback"'),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "0" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:");
  });

  test("with no prompt, prints usage to stderr and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      src("subagent"),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent <prompt>");
  });
});

// ── subagent_batch ──────────────────────────────────────────────────

describe("subagent_batch", () => {
  test("runs multiple prompts and collects output", async () => {
    const { exitCode, stdout } = await runBash(
      src(`subagent_batch '["prompt one","prompt two","prompt three"]'`),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:prompt one");
    expect(stdout).toContain("OPENCODE_RUN:prompt two");
    expect(stdout).toContain("OPENCODE_RUN:prompt three");
  });

  test("at max depth, batch falls back to llm-subcall for each prompt", async () => {
    const { exitCode, stdout } = await runBash(
      src(`subagent_batch '["first","second"]'`),
      { OPENCODE_RLM_DEPTH: "3", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:first");
    expect(stdout).toContain("LLM_SUBCALL:second");
    // Should NOT contain OPENCODE_RUN
    expect(stdout).not.toContain("OPENCODE_RUN:");
  });

  test("reports agent count on stderr", async () => {
    const { stderr } = await runBash(
      src(`subagent_batch '["a","b"]'`),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(stderr).toContain("Agent 1/2");
    expect(stderr).toContain("Agent 2/2");
    expect(stderr).toContain("2/2 agents completed");
  });

  test("with no argument, prints usage and returns 2", async () => {
    const { exitCode, stderr } = await runBash(
      src("subagent_batch"),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("subagent_batch <json array>");
  });

  test("handles single-element batch", async () => {
    const { exitCode, stdout } = await runBash(
      src(`subagent_batch '["only one"]'`),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:only one");
  });
});

// ── BASH_ENV propagation ────────────────────────────────────────────

describe("BASH_ENV propagation", () => {
  test("helpers are available inside a child bash script", async () => {
    // Write a temporary script that calls subagent
    const scriptPath = join(tmpdir(), "opencode-rlm-test-script.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nsubagent "from script"\n`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await runBash(
      src(`export BASH_ENV="${functionsPath}"\nbash "${scriptPath}"`),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:from script");
  });

  test("depth is inherited by child bash scripts", async () => {
    const scriptPath = join(tmpdir(), "opencode-rlm-test-depth.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nsubagent "depth check"\n`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await runBash(
      src(`export BASH_ENV="${functionsPath}"\nbash "${scriptPath}"`),
      { OPENCODE_RLM_DEPTH: "2", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    // Child script inherits depth 2, subagent increments to 3
    expect(stdout).toContain("DEPTH:3");
  });

  test("child script at max depth falls back to llm-subcall", async () => {
    const scriptPath = join(tmpdir(), "opencode-rlm-test-maxdepth.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nsubagent "max depth in script"\n`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await runBash(
      src(`export BASH_ENV="${functionsPath}"\nbash "${scriptPath}"`),
      { OPENCODE_RLM_DEPTH: "3", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LLM_SUBCALL:max depth in script");
  });

  test("subagent_batch works inside a child bash script", async () => {
    const scriptPath = join(tmpdir(), "opencode-rlm-test-batch-script.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nsubagent_batch '["from script A","from script B"]'\n`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await runBash(
      src(`export BASH_ENV="${functionsPath}"\nbash "${scriptPath}"`),
      { OPENCODE_RLM_DEPTH: "0", RLM_MAX_SUBAGENT_DEPTH: "3" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPENCODE_RUN:from script A");
    expect(stdout).toContain("OPENCODE_RUN:from script B");
  });
});

// ── tool.execute.before tamper guard ────────────────────────────────

describe("tamper guard regex", () => {
  // The plugin uses this regex to block depth tampering:
  //   /OPENCODE_RLM_DEPTH\s*=/
  // We test the regex directly since the hook isn't callable in isolation.
  const tamperRegex = /OPENCODE_RLM_DEPTH\s*=/;

  test("matches direct assignment", () => {
    expect(tamperRegex.test("OPENCODE_RLM_DEPTH=0")).toBe(true);
  });

  test("matches export assignment", () => {
    expect(tamperRegex.test("export OPENCODE_RLM_DEPTH=0")).toBe(true);
  });

  test("matches with spaces around =", () => {
    expect(tamperRegex.test("OPENCODE_RLM_DEPTH =0")).toBe(true);
  });

  test("does not match reading the variable", () => {
    expect(tamperRegex.test("echo $OPENCODE_RLM_DEPTH")).toBe(false);
  });

  test("does not match a substring", () => {
    expect(tamperRegex.test("echo OPENCODE_RLM_DEPTH_INFO")).toBe(false);
  });

  test("does not match unrelated commands", () => {
    expect(tamperRegex.test('subagent "hello"')).toBe(false);
  });
});

// ── _rlm_indent ─────────────────────────────────────────────────────

describe("_rlm_indent", () => {
  // _rlm_indent outputs spaces via printf with no newline, so we
  // measure the raw length instead of comparing trimmed strings.
  test("returns empty string at depth 0", async () => {
    const { stdout } = await runBash(
      src('_rlm_indent; echo "END"'),
      { OPENCODE_RLM_DEPTH: "0" },
    );
    // Should be just "END" with no leading spaces
    expect(stdout).toBe("END");
  });

  test("returns 2 spaces at depth 1", async () => {
    const { stdout } = await runBash(
      src('_rlm_indent; echo "END"'),
      { OPENCODE_RLM_DEPTH: "1" },
    );
    expect(stdout).toBe("  END");
  });

  test("returns 6 spaces at depth 3", async () => {
    const { stdout } = await runBash(
      src('_rlm_indent; echo "END"'),
      { OPENCODE_RLM_DEPTH: "3" },
    );
    expect(stdout).toBe("      END");
  });
});
