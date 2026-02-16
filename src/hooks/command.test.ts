import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildContextDisplay, type ContextDisplayOpts } from "./command";
import type { SessionState, TrajectoryDocument } from "../types";
import {
  createEmptyDocument,
  appendTurn,
  createTurn,
  recordCompaction,
} from "../trajectory/manager";

function makeState(doc?: TrajectoryDocument): SessionState {
  const dir = mkdtempSync(join(tmpdir(), "rlm-cmd-test-"));
  const varsDir = join(dir, "vars");
  mkdirSync(varsDir, { recursive: true });
  return {
    sessionId: "test-session",
    sessionDir: dir,
    trajectoryPath: join(dir, "active", "trajectory.json"),
    varsDir,
    document: doc ?? createEmptyDocument("test-session"),
    lastKnownMessageCount: 0,
    writeQueue: Promise.resolve(),
  };
}

function addTurns(doc: TrajectoryDocument, count: number, tokensEach: number) {
  for (let i = 0; i < count; i++) {
    const content = "x".repeat(tokensEach * 4); // rough: 4 chars per token
    const turn = createTurn(doc.stats.totalTurns, "user", content, 1.0);
    // Override estimated tokens for deterministic tests
    turn.estimatedTokens = tokensEach;
    appendTurn(doc, turn);
    // Fix stats since we overrode estimatedTokens after createTurn computed it
    const active = doc.entries[doc.entries.length - 1];
    if (active.type === "segment") {
      active.totalEstimatedTokens =
        active.totalEstimatedTokens - turn.estimatedTokens + tokensEach;
    }
  }
  // Recompute stats from scratch for correctness
  let totalTokens = 0;
  for (const entry of doc.entries) {
    if (entry.type === "segment") {
      totalTokens += entry.totalEstimatedTokens;
    }
  }
  doc.stats.totalTokensProcessed = totalTokens;
  doc.stats.currentActiveTokens =
    (doc.entries[doc.entries.length - 1] as any).totalEstimatedTokens ?? 0;
}

/** Helper to add turns with exact estimated token counts */
function addExactTurns(
  doc: TrajectoryDocument,
  count: number,
  tokensEach: number,
) {
  for (let i = 0; i < count; i++) {
    const turn: import("../types").TrajectoryTurn = {
      turnIndex: doc.stats.totalTurns,
      role: "user",
      content: `turn ${doc.stats.totalTurns}`,
      estimatedTokens: tokensEach,
      timestamp: new Date().toISOString(),
    };
    appendTurn(doc, turn);
  }
}

// ── Token display invariants ────────────────────────────────────────

describe("/context token display", () => {
  test("total >= root when modelInputTokens provided (no compactions)", async () => {
    const state = makeState();
    addExactTurns(state.document, 5, 100); // 500 estimated active tokens

    // Model reports 2000 actual tokens (includes system prompt, tool defs, etc.)
    const output = await buildContextDisplay(state, {
      modelInputTokens: 2000,
    });

    // Root should show 2000 (actual)
    expect(output).toContain("2.0k input tokens");
    // Total should show ~2000 (root) + 0 (no compacted) = 2000
    expect(output).toContain("~2.0k tokens total");
  });

  test("total >= root when modelInputTokens provided (with compactions)", async () => {
    const state = makeState();

    // Segment 0: 3 turns at 200 tokens each = 600 estimated
    addExactTurns(state.document, 3, 200);
    recordCompaction(state.document, "Summary of segment 0", 1.0);

    // Segment 1 (active): 2 turns at 150 tokens each = 300 estimated
    addExactTurns(state.document, 2, 150);

    // Model reports 5000 actual tokens for root context
    const output = await buildContextDisplay(state, {
      modelInputTokens: 5000,
    });

    // Root should show 5000
    expect(output).toContain("5.0k input tokens");
    // Total should be 5000 (root) + 600 (compacted estimate) = 5600
    expect(output).toContain("~5.6k tokens total");
    // Compacted line should show ~600
    expect(output).toContain("~600 compacted");
  });

  test("total >= root even when estimate << actual model tokens", async () => {
    const state = makeState();
    // Tiny estimated tokens — model tokens much larger due to system prompt etc.
    addExactTurns(state.document, 2, 50); // 100 estimated

    const output = await buildContextDisplay(state, {
      modelInputTokens: 10000,
    });

    // Root = 10000, Total = 10000 + 0 compacted = 10000
    // Total (10k) >= Root (10k) ✓
    expect(output).toContain("10.0k input tokens");
    expect(output).toContain("~10.0k tokens total");
  });

  test("total >= root after multiple compactions", async () => {
    const state = makeState();

    // Segment 0: 500 estimated tokens, compacted
    addExactTurns(state.document, 5, 100);
    recordCompaction(state.document, "First summary", 1.0);

    // Segment 1: 800 estimated tokens, compacted
    addExactTurns(state.document, 4, 200);
    recordCompaction(state.document, "Second summary", 1.0);

    // Segment 2 (active): 300 estimated tokens
    addExactTurns(state.document, 3, 100);

    // Model reports 8000 actual
    const output = await buildContextDisplay(state, {
      modelInputTokens: 8000,
    });

    // Root = 8000
    // Compacted = 500 + 800 = 1300
    // Total = 8000 + 1300 = 9300
    expect(output).toContain("8.0k input tokens");
    expect(output).toContain("~9.3k tokens total");
    expect(output).toContain("~1.3k compacted");
    expect(output).toContain("2 compactions");
  });

  test("without modelInputTokens, falls back to estimates with ~ prefix", async () => {
    const state = makeState();
    addExactTurns(state.document, 4, 250); // 1000 estimated

    const output = await buildContextDisplay(state);

    // Root should show estimate with ~ prefix
    expect(output).toContain("~1.0k tokens (estimated");
    // Total should also use estimate
    expect(output).toContain("~1.0k tokens total");
  });

  test("without modelInputTokens after compaction, total >= root (both estimates)", async () => {
    const state = makeState();

    // Segment 0: 600 estimated, compacted
    addExactTurns(state.document, 3, 200);
    recordCompaction(state.document, "Summary", 1.0);

    // Segment 1 (active): 400 estimated
    addExactTurns(state.document, 2, 200);

    const output = await buildContextDisplay(state);

    // Root = ~400 (active estimate)
    // Total = 400 + 600 = 1000
    expect(output).toContain("~400 tokens (estimated");
    expect(output).toContain("~1.0k tokens total");
  });

  test("shows context limit and percentage when provided", async () => {
    const state = makeState();
    addExactTurns(state.document, 2, 100);

    const output = await buildContextDisplay(state, {
      modelInputTokens: 50000,
      contextLimit: 200000,
    });

    expect(output).toContain("50.0k input tokens");
    expect(output).toContain("200k limit");
    expect(output).toContain("25.0%");
  });

  test("active line shows actual count (no ~) when modelInputTokens present", async () => {
    const state = makeState();
    addExactTurns(state.document, 2, 100);
    recordCompaction(state.document, "Summary", 1.0);
    addExactTurns(state.document, 1, 50);

    const output = await buildContextDisplay(state, {
      modelInputTokens: 3000,
    });

    // Active line should NOT have ~ when we have actual tokens
    expect(output).toContain("3.0k active (current segment)");
    expect(output).not.toContain("~3.0k active");
  });

  test("active line shows ~ when using estimates", async () => {
    const state = makeState();
    addExactTurns(state.document, 2, 100);
    recordCompaction(state.document, "Summary", 1.0);
    addExactTurns(state.document, 1, 50);

    const output = await buildContextDisplay(state);

    // Active line should have ~ when using estimates
    expect(output).toContain("~50 active (current segment)");
  });

  test("zero compactions: no compacted/active breakdown shown", async () => {
    const state = makeState();
    addExactTurns(state.document, 3, 100);

    const output = await buildContextDisplay(state, {
      modelInputTokens: 1000,
    });

    expect(output).not.toContain("compacted");
    expect(output).not.toContain("active (current segment)");
  });
});

// ── Vars display ────────────────────────────────────────────────────

describe("/context vars display", () => {
  test("shows (empty) when no vars", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state);
    expect(output).toContain("(empty)");
  });

  test("shows var files", async () => {
    const state = makeState();
    writeFileSync(join(state.varsDir, "plan.txt"), "my plan here");
    const output = await buildContextDisplay(state);
    expect(output).toContain("plan.txt");
  });
});

// ── Compaction history ──────────────────────────────────────────────

describe("/context compaction history", () => {
  test("shows compaction summaries", async () => {
    const state = makeState();
    addExactTurns(state.document, 2, 100);
    recordCompaction(state.document, "Fixed the login bug and added tests", 1.0);
    addExactTurns(state.document, 1, 50);

    const output = await buildContextDisplay(state);
    expect(output).toContain("Compaction History");
    expect(output).toContain("Fixed the login bug");
  });

  test("no compaction history section when no compactions", async () => {
    const state = makeState();
    addExactTurns(state.document, 2, 100);

    const output = await buildContextDisplay(state);
    expect(output).not.toContain("Compaction History");
  });
});
