import { describe, test, expect } from "bun:test";
import { formatSubagent, formatSubagentBatch } from "./format";

// ── formatSubagent ──────────────────────────────────────────────────

describe("formatSubagent", () => {
  test("extracts prompt from single-quoted command", () => {
    const result = formatSubagent(
      `subagent 'Analyze src/auth.ts for bugs'`,
      "some output",
    );
    expect(result.title).toBe("subagent: Analyze src/auth.ts for bugs");
  });

  test("extracts prompt from double-quoted command", () => {
    const result = formatSubagent(
      `subagent "Review the API layer"`,
      "some output",
    );
    expect(result.title).toBe("subagent: Review the API layer");
  });

  test("truncates long prompts at 60 chars", () => {
    const longPrompt =
      "Analyze the entire authentication module including OAuth, JWT tokens, and session management";
    const result = formatSubagent(
      `subagent '${longPrompt}'`,
      "",
    );
    expect(result.title.length).toBeLessThan(75); // "subagent: " + 60 + "…"
    expect(result.title).toContain("…");
    expect(result.title).toStartWith("subagent: ");
  });

  test("handles missing prompt gracefully", () => {
    const result = formatSubagent("subagent", "output");
    expect(result.title).toBe("subagent: ");
  });

  test("strips noise lines from output", () => {
    const noisy = [
      'export OPENCODE_RLM_SESSION="abc"',
      "export OPENCODE_RLM_DEPTH=0",
      'export BASH_ENV="/tmp/functions.sh"',
      'source "/tmp/functions.sh"',
      "export PATH=/stubs:/usr/bin",
      "actual result line 1",
      "actual result line 2",
    ].join("\n");
    const result = formatSubagent(`subagent 'test'`, noisy);
    expect(result.summary).not.toContain("export OPENCODE_RLM");
    expect(result.summary).not.toContain("BASH_ENV");
    expect(result.summary).not.toContain("source ");
    expect(result.summary).not.toContain("export PATH=");
    expect(result.summary).toContain("actual result line 1");
    expect(result.summary).toContain("actual result line 2");
  });

  test("strips empty lines from output", () => {
    const result = formatSubagent(
      `subagent 'test'`,
      "\n\nactual output\n\n",
    );
    expect(result.summary).toBe("actual output");
  });

  test("preserves meaningful output lines", () => {
    const output = [
      "File analysis complete.",
      "Found 3 issues:",
      "  - Missing null check on line 42",
      "  - Unused import on line 5",
      "  - Type mismatch on line 88",
    ].join("\n");
    const result = formatSubagent(`subagent 'analyze'`, output);
    expect(result.summary).toContain("File analysis complete.");
    expect(result.summary).toContain("Found 3 issues:");
    expect(result.summary).toContain("Missing null check");
  });

  test("truncates output beyond 30 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const result = formatSubagent(`subagent 'test'`, lines.join("\n"));
    expect(result.summary).toContain("line 1");
    expect(result.summary).toContain("line 30");
    expect(result.summary).not.toContain("line 31");
    expect(result.summary).toContain("… (20 more lines)");
  });

  test("handles empty output", () => {
    const result = formatSubagent(`subagent 'test'`, "");
    expect(result.summary).toBe("");
  });

  test("handles output that is only noise", () => {
    const noisy = [
      'export OPENCODE_RLM_SESSION="abc"',
      'export BASH_ENV="/tmp/f.sh"',
      "",
      "",
    ].join("\n");
    const result = formatSubagent(`subagent 'test'`, noisy);
    expect(result.summary).toBe("");
  });
});

// ── formatSubagentBatch ─────────────────────────────────────────────

describe("formatSubagentBatch", () => {
  test("extracts prompts from JSON array and lists them", () => {
    const result = formatSubagentBatch(
      `subagent_batch '["Analyze auth","Review api","Check tests"]'`,
      "",
    );
    expect(result.title).toBe("subagent_batch (3 agents)");
    expect(result.summary).toContain("1. Analyze auth");
    expect(result.summary).toContain("2. Review api");
    expect(result.summary).toContain("3. Check tests");
  });

  test("shows correct agent count in title", () => {
    const result = formatSubagentBatch(
      `subagent_batch '["a","b","c","d","e"]'`,
      "",
    );
    expect(result.title).toBe("subagent_batch (5 agents)");
  });

  test("single-agent batch shows count 1", () => {
    const result = formatSubagentBatch(
      `subagent_batch '["only one"]'`,
      "",
    );
    expect(result.title).toBe("subagent_batch (1 agents)");
    expect(result.summary).toContain("1. only one");
  });

  test("truncates long prompts in the list at 80 chars", () => {
    const longPrompt = "A".repeat(100);
    const result = formatSubagentBatch(
      `subagent_batch '["${longPrompt}"]'`,
      "",
    );
    expect(result.summary).toContain("…");
    // 80 chars of A + "…" + prefix "  1. "
    const line = result.summary.split("\n")[0];
    expect(line.length).toBeLessThan(90);
  });

  test("includes cleaned output after prompt list", () => {
    const output = "Result from agent 1\nResult from agent 2";
    const result = formatSubagentBatch(
      `subagent_batch '["a","b"]'`,
      output,
    );
    expect(result.summary).toContain("1. a");
    expect(result.summary).toContain("2. b");
    expect(result.summary).toContain("Result from agent 1");
    expect(result.summary).toContain("Result from agent 2");
  });

  test("separates prompt list from output with blank line", () => {
    const result = formatSubagentBatch(
      `subagent_batch '["x"]'`,
      "output here",
    );
    const lines = result.summary.split("\n");
    // Should be: "  1. x", "", "output here"
    expect(lines[0]).toContain("1. x");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("output here");
  });

  test("strips noise from output", () => {
    const noisy = [
      'export OPENCODE_RLM_SESSION="abc"',
      "export OPENCODE_RLM_DEPTH=0",
      'export BASH_ENV="/tmp/f.sh"',
      'source "/tmp/f.sh"',
      "export PATH=/stubs:/bin",
      "actual result A",
      "actual result B",
    ].join("\n");
    const result = formatSubagentBatch(
      `subagent_batch '["test"]'`,
      noisy,
    );
    expect(result.summary).not.toContain("export OPENCODE_RLM");
    expect(result.summary).not.toContain("BASH_ENV");
    expect(result.summary).toContain("actual result A");
    expect(result.summary).toContain("actual result B");
  });

  test("truncates output beyond 20 lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `out ${i + 1}`);
    const result = formatSubagentBatch(
      `subagent_batch '["a"]'`,
      lines.join("\n"),
    );
    expect(result.summary).toContain("out 1");
    expect(result.summary).toContain("out 20");
    expect(result.summary).not.toContain("out 21");
    expect(result.summary).toContain("… (20 more lines)");
  });

  test("handles malformed JSON gracefully", () => {
    const result = formatSubagentBatch(
      `subagent_batch 'not valid json'`,
      "output",
    );
    expect(result.title).toBe("subagent_batch (? agents)");
    expect(result.summary).toContain("output");
  });

  test("handles empty JSON array", () => {
    const result = formatSubagentBatch(
      `subagent_batch '[]'`,
      "",
    );
    expect(result.title).toBe("subagent_batch (0 agents)");
    expect(result.summary).toBe("");
  });

  test("handles command without quotes around JSON", () => {
    // If the model doesn't quote properly, we should still handle it
    const result = formatSubagentBatch(
      `subagent_batch '["a","b"]'`,
      "some output",
    );
    expect(result.title).toBe("subagent_batch (2 agents)");
  });

  test("handles empty output with prompts", () => {
    const result = formatSubagentBatch(
      `subagent_batch '["task a","task b"]'`,
      "",
    );
    expect(result.summary).toContain("1. task a");
    expect(result.summary).toContain("2. task b");
    // No trailing blank line when no output
    expect(result.summary).not.toContain("\n\n");
  });

  test("real-world example with mixed noise and results", () => {
    const rawOutput = [
      'export OPENCODE_RLM_SESSION="sess-123"',
      "export OPENCODE_RLM_DEPTH=0",
      'export BASH_ENV="/tmp/rlm/functions.sh"',
      'source "/tmp/rlm/functions.sh"',
      "export PATH=/tmp/stubs:/usr/bin",
      "",
      "Analysis of src/auth.ts:",
      "  - Uses JWT tokens correctly",
      "  - Missing rate limiting",
      "",
      "Review of src/api.ts:",
      "  - REST endpoints follow conventions",
      "  - Missing input validation on POST /users",
    ].join("\n");

    const result = formatSubagentBatch(
      `subagent_batch '["Analyze src/auth.ts","Review src/api.ts"]'`,
      rawOutput,
    );

    expect(result.title).toBe("subagent_batch (2 agents)");
    expect(result.summary).toContain("1. Analyze src/auth.ts");
    expect(result.summary).toContain("2. Review src/api.ts");
    expect(result.summary).toContain("Analysis of src/auth.ts:");
    expect(result.summary).toContain("Uses JWT tokens correctly");
    expect(result.summary).toContain("Review of src/api.ts:");
    expect(result.summary).toContain("Missing input validation");
    expect(result.summary).not.toContain("export OPENCODE_RLM");
    expect(result.summary).not.toContain("BASH_ENV");
  });
});
