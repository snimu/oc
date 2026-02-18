import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildContextDisplay, type ContextDisplayOpts, type TokenUsage } from "./command";
import type { SessionState, TrajectoryDocument } from "../types";
import {
  createEmptyDocument,
  appendTurn,
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

function addTurns(doc: TrajectoryDocument, count: number) {
  for (let i = 0; i < count; i++) {
    const turn: import("../types").TrajectoryTurn = {
      turnIndex: doc.stats.totalTurns,
      role: "user",
      content: `turn ${doc.stats.totalTurns}`,
      estimatedTokens: 100,
      timestamp: new Date().toISOString(),
    };
    appendTurn(doc, turn);
  }
}

function usage(input: number, output = 500, opts?: Partial<TokenUsage>): TokenUsage {
  return {
    input,
    output,
    reasoning: opts?.reasoning ?? 0,
    cacheRead: opts?.cacheRead ?? 0,
    cacheWrite: opts?.cacheWrite ?? 0,
    cost: opts?.cost ?? 0.01,
  };
}

// ── Token display (uses OpenCode's actual counts) ────────────────

describe("/context token display", () => {
  test("shows total tokens (input+output+reasoning+cache) from last message", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(50000),
      messageCount: 10,
    });
    // total = 50000 input + 500 output + 0 reasoning + 0 cache = 50500
    expect(output).toContain("50.5k total tokens");
    expect(output).toContain("50.0k input");
    expect(output).toContain("10 messages in session");
  });

  test("shows context limit and percentage based on total", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(50000),
      contextLimit: 200000,
    });
    // total = 50500, pct = 50500/200000 = 25.3%
    expect(output).toContain("50.5k total tokens");
    expect(output).toContain("200k limit");
    expect(output).toContain("25.3%");
  });

  test("shows output and reasoning tokens", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(10000, 2000, { reasoning: 500 }),
    });
    // total = 10000 + 2000 + 500 = 12500
    expect(output).toContain("12.5k total tokens");
    expect(output).toContain("10.0k input, 2.0k output, 500 reasoning");
  });

  test("shows cache stats when present", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(10000, 1000, { cacheRead: 8000, cacheWrite: 2000 }),
    });
    expect(output).toContain("cache: 8.0k read, 2.0k write");
  });

  test("no cache line when cache is zero", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(10000, 1000, { cacheRead: 0, cacheWrite: 0 }),
    });
    expect(output).not.toContain("cache:");
  });

  test("shows session totals (cumulative output and cost)", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state, {
      lastUsage: usage(10000, 500),
      totalUsage: usage(10000, 5000, { reasoning: 1000, cost: 0.1234 }),
    });
    expect(output).toContain("Session Totals");
    expect(output).toContain("5.0k output tokens, 1.0k reasoning tokens");
    expect(output).toContain("$0.1234 total cost");
  });

  test("shows placeholder when no messages yet", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state);
    expect(output).toContain("no messages yet");
  });
});

// ── Compaction display ──────────────────────────────────────────

describe("/context compaction display", () => {
  test("shows compaction count when compactions exist", async () => {
    const state = makeState();
    addTurns(state.document, 3);
    recordCompaction(state.document, "Summary of first segment");
    addTurns(state.document, 2);

    const output = await buildContextDisplay(state, {
      lastUsage: usage(5000),
    });
    expect(output).toContain("Compactions");
    expect(output).toContain("1 compaction");
    expect(output).toContain("2 turns in current segment");
  });

  test("shows compaction summaries in history", async () => {
    const state = makeState();
    addTurns(state.document, 2);
    recordCompaction(state.document, "Fixed the login bug and added tests");
    addTurns(state.document, 1);

    const output = await buildContextDisplay(state);
    expect(output).toContain("Compaction History");
    expect(output).toContain("Fixed the login bug");
  });

  test("no compaction section when no compactions", async () => {
    const state = makeState();
    addTurns(state.document, 2);

    const output = await buildContextDisplay(state);
    expect(output).not.toContain("Compactions");
    expect(output).not.toContain("Compaction History");
  });

  test("multiple compactions", async () => {
    const state = makeState();
    addTurns(state.document, 2);
    recordCompaction(state.document, "First summary");
    addTurns(state.document, 2);
    recordCompaction(state.document, "Second summary");
    addTurns(state.document, 1);

    const output = await buildContextDisplay(state, {
      lastUsage: usage(8000),
    });
    expect(output).toContain("2 compactions");
    expect(output).toContain("First summary");
    expect(output).toContain("Second summary");
  });
});

// ── Vars display ────────────────────────────────────────────────

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

// ── Trajectory display ──────────────────────────────────────────

describe("/context trajectory display", () => {
  test("shows trajectory file path", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state);
    expect(output).toContain("Trajectory");
    expect(output).toContain(state.trajectoryPath);
  });

  test("shows first and last turns", async () => {
    const state = makeState();
    addTurns(state.document, 3);
    const output = await buildContextDisplay(state);
    expect(output).toContain("first: [user]");
    expect(output).toContain("last:  [user]");
  });

  test("shows (no turns yet) when empty", async () => {
    const state = makeState();
    const output = await buildContextDisplay(state);
    expect(output).toContain("(no turns yet)");
  });
});
