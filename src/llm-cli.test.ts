import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const llmContextPath = "/tmp/rlm/llm-context.json";
const cliScript = join(import.meta.dir, "llm-cli.ts");
const binScript = ["bun", cliScript];

const hasContext = existsSync(llmContextPath);

describe.skipIf(!hasContext)("llm-subcall", () => {
  test(
    "returns a non-empty response for a simple prompt",
    async () => {
      const proc = Bun.spawn([...binScript, 'Reply with exactly "hello"'], {
        env: { ...process.env, RLM_LLM_CONTEXT: llmContextPath },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout.toLowerCase()).toContain("hello");
    },
    { timeout: 30_000 },
  );

  test(
    "supports --system flag",
    async () => {
      const proc = Bun.spawn(
        [
          ...binScript,
          "--system",
          "You only respond with a single number, nothing else.",
          "What is 2+2?",
        ],
        {
          env: { ...process.env, RLM_LLM_CONTEXT: llmContextPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("4");
    },
    { timeout: 30_000 },
  );

  test("fails with a clear error when no prompt is given", async () => {
    const proc = Bun.spawn([...binScript], {
      env: { ...process.env, RLM_LLM_CONTEXT: llmContextPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });
});

describe("llm-subcall without context", () => {
  test("fails with a clear error when RLM_LLM_CONTEXT is not set", async () => {
    const env = { ...process.env };
    delete env.RLM_LLM_CONTEXT;

    const proc = Bun.spawn([...binScript, "hello"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("RLM_LLM_CONTEXT");
  });
});
