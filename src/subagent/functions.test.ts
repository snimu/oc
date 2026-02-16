import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "bun";

// bin/ directory with the real standalone scripts
const binDir = join(import.meta.dir, "..", "..", "bin");

/**
 * Helper: run a bash snippet with bin/ scripts on PATH.
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

// Track created sessions and their prompts
const sessions = new Map<string, { parentID: string; prompts: string[] }>();
let nextSessionId = 1;

beforeAll(() => {
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
        sessions.set(id, { parentID: body.parentID ?? "", prompts: [] });
        return Response.json({ id });
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
});

afterAll(() => {
  mockServer.stop();
});

/** Build env vars for running bin/ scripts against the mock server */
function testEnv(): Record<string, string> {
  return {
    OPENCODE_RLM_URL: mockServerUrl,
    OPENCODE_RLM_DIR_PATH: "/test/project",
    OPENCODE_AUTH_HEADER: "",
    OPENCODE_RLM_SESSION_ID_FILE: sessionIdFile,
  };
}

/** Build a command with bin/ scripts on PATH */
function cmd(script: string): string {
  return `export PATH="${binDir}:$PATH"\n${script}`;
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

  test("fails gracefully without session ID file", async () => {
    const env = { ...testEnv(), OPENCODE_RLM_SESSION_ID_FILE: "/nonexistent/file" };
    const { exitCode, stderr } = await runBash(
      cmd('subagent "no session"'),
      env,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("session ID");
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

  test("handles large batch (5 prompts)", async () => {
    const prompts = JSON.stringify(["p1", "p2", "p3", "p4", "p5"]);
    const { exitCode, stdout, stderr } = await runBash(
      cmd(`subagent_batch '${prompts}'`),
      testEnv(),
    );
    expect(exitCode).toBe(0);
    for (let i = 1; i <= 5; i++) {
      expect(stdout).toContain(`SUBAGENT_RESULT:p${i}`);
      expect(stderr).toContain(`Agent ${i}/5`);
    }
    expect(stderr).toContain("5/5 agents completed");
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

  test("batch cleans up temp directory", async () => {
    const { exitCode } = await runBash(
      cmd(`subagent_batch '["cleanup test"]'`),
      testEnv(),
    );
    expect(exitCode).toBe(0);
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
