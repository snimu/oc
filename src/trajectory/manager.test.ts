import { describe, test, expect } from "bun:test";
import {
  createEmptyDocument,
  getActiveSegment,
  appendTurn,
  createTurn,
  recordCompaction,
  getRecentSummaries,
  getSegment,
  getCompaction,
  getOverview,
  searchTrajectory,
} from "./manager";
import type { TrajectoryDocument } from "../types";

function addUserTurn(doc: TrajectoryDocument, content: string) {
  const turn = createTurn(doc.stats.totalTurns, "user", content);
  appendTurn(doc, turn);
}

function addAssistantTurn(doc: TrajectoryDocument, content: string) {
  const turn = createTurn(doc.stats.totalTurns, "assistant", content);
  appendTurn(doc, turn);
}

function addToolTurns(doc: TrajectoryDocument, name: string, output: string) {
  const call = createTurn(
    doc.stats.totalTurns,
    "tool_use",
    `Tool call: ${name}`,
    name,
    '{"path":"src/index.ts"}',
  );
  appendTurn(doc, call);
  const result = createTurn(
    doc.stats.totalTurns,
    "tool_result",
    output,
    name,
  );
  appendTurn(doc, result);
}

// ---------------------------------------------------------------------------
// Case 1: Fresh session — no compactions
// ---------------------------------------------------------------------------
describe("fresh session (no compactions)", () => {
  const doc = createEmptyDocument("sess-001");

  test("starts with one empty active segment", () => {
    expect(doc.entries.length).toBe(1);
    expect(doc.entries[0].type).toBe("segment");
    const seg = getActiveSegment(doc)!;
    expect(seg).not.toBeNull();
    expect(seg.segmentIndex).toBe(0);
    expect(seg.turns).toEqual([]);
    expect(seg.compactedAt).toBeNull();
  });

  test("accumulates turns in segment 0", () => {
    addUserTurn(doc, "Fix the login bug in auth.ts");
    addAssistantTurn(doc, "I'll look at auth.ts to understand the issue.");
    addToolTurns(doc, "read", 'export function login() { ... }');
    addAssistantTurn(
      doc,
      "Found the bug — the token comparison is using == instead of ===.",
    );

    const seg = getActiveSegment(doc)!;
    expect(seg.segmentIndex).toBe(0);
    expect(seg.turns.length).toBe(5); // user, assistant, tool_use, tool_result, assistant
    expect(seg.compactedAt).toBeNull();
    expect(doc.stats.totalTurns).toBe(5);
    expect(doc.stats.totalCompactions).toBe(0);
    expect(seg.totalEstimatedTokens).toBeGreaterThan(0);
    expect(doc.stats.totalTokensProcessed).toBe(seg.totalEstimatedTokens);
  });

  test("trajectory.json shape (no compaction yet)", () => {
    // This is what trajectory.json looks like on disk before any compaction.
    expect(doc.version).toBe(1);
    expect(doc.sessionId).toBe("sess-001");
    expect(doc.entries.length).toBe(1); // just segment 0
    expect(doc.entries[0].type).toBe("segment");

    const seg = doc.entries[0] as any;
    expect(seg.segmentIndex).toBe(0);
    expect(seg.turns[0].role).toBe("user");
    expect(seg.turns[0].content).toBe("Fix the login bug in auth.ts");
    expect(seg.turns[1].role).toBe("assistant");
    expect(seg.turns[2].role).toBe("tool_use");
    expect(seg.turns[2].toolName).toBe("read");
    expect(seg.turns[3].role).toBe("tool_result");
    expect(seg.turns[4].role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// Case 2: Single compaction
// ---------------------------------------------------------------------------
describe("single compaction", () => {
  const doc = createEmptyDocument("sess-002");

  // Simulate a full conversation cycle
  addUserTurn(doc, "Add a dark mode toggle to the settings page");
  addAssistantTurn(doc, "I'll start by reading the settings component.");
  addToolTurns(doc, "read", "<Settings component source>");
  addAssistantTurn(doc, "I see the settings page. I'll add a toggle.");
  addToolTurns(doc, "edit", "Applied edit to Settings.tsx");
  addAssistantTurn(doc, "Done! Added the dark mode toggle.");
  addUserTurn(doc, "Now make it persist to localStorage");
  addAssistantTurn(doc, "I'll update the toggle to save the preference.");
  addToolTurns(doc, "edit", "Applied edit to Settings.tsx");
  addAssistantTurn(doc, "Updated — the preference now persists.");

  test("before compaction: all turns in segment 0", () => {
    expect(doc.entries.length).toBe(1);
    const seg = getActiveSegment(doc)!;
    expect(seg.segmentIndex).toBe(0);
    // 4 user/assistant + 3 addToolTurns (2 each) + 2 assistant = 4 + 6 + 3 = 13
    // user, assistant, tool_use, tool_result, assistant, tool_use, tool_result,
    // assistant, user, assistant, tool_use, tool_result, assistant
    expect(seg.turns.length).toBe(13);
    expect(seg.compactedAt).toBeNull();
  });

  test("recordCompaction freezes segment 0, adds compaction entry, starts segment 1", () => {
    const tokensBeforeCompaction = doc.stats.totalTokensProcessed;

    recordCompaction(
      doc,
      "Added dark mode toggle to Settings.tsx with localStorage persistence. " +
        "Modified Settings component to include a toggle switch that saves " +
        "the user's theme preference to localStorage.",
    );

    // Document now has 3 entries: frozen segment 0 + compaction + active segment 1
    expect(doc.entries.length).toBe(3);
    expect(doc.entries[0].type).toBe("segment");
    expect(doc.entries[1].type).toBe("compaction");
    expect(doc.entries[2].type).toBe("segment");

    // Segment 0 is frozen
    const seg0 = getSegment(doc, 0)!;
    expect(seg0.compactedAt).not.toBeNull();
    expect(seg0.turns.length).toBe(13); // ALL turns preserved

    // Compaction entry references segment 0
    const comp = getCompaction(doc, 0)!;
    expect(comp.segmentIndex).toBe(0);
    expect(comp.summary).toContain("dark mode toggle");
    expect(comp.originalTokens).toBe(seg0.totalEstimatedTokens);
    expect(comp.summaryTokens).toBeGreaterThan(0);

    // New active segment 1
    const seg1 = getActiveSegment(doc)!;
    expect(seg1.segmentIndex).toBe(1);
    expect(seg1.turns).toEqual([]);
    expect(seg1.compactedAt).toBeNull();

    // Stats updated
    expect(doc.stats.totalCompactions).toBe(1);
    expect(doc.stats.currentActiveTokens).toBe(0);
    expect(doc.stats.totalTokensProcessed).toBe(tokensBeforeCompaction); // unchanged
  });

  test("new turns go into segment 1 after compaction", () => {
    addUserTurn(doc, "Also add a font size setting");
    addAssistantTurn(doc, "I'll add a font size slider.");

    const seg1 = getActiveSegment(doc)!;
    expect(seg1.segmentIndex).toBe(1);
    expect(seg1.turns.length).toBe(2);

    // Segment 0 still has all its original turns
    const seg0 = getSegment(doc, 0)!;
    expect(seg0.turns.length).toBe(13);

    expect(doc.stats.totalTurns).toBe(15); // 13 from seg0 + 2 from seg1
  });

  test("trajectory.json shape after one compaction", () => {
    // This is the full trajectory.json on disk.
    // ALL data is preserved — nothing deleted.
    expect(doc.entries.length).toBe(3);

    // Entry 0: frozen segment 0 with all 12 turns
    const e0 = doc.entries[0] as any;
    expect(e0.type).toBe("segment");
    expect(e0.segmentIndex).toBe(0);
    expect(e0.turns.length).toBe(13);
    expect(e0.compactedAt).not.toBeNull();

    // Entry 1: compaction summary for segment 0
    const e1 = doc.entries[1] as any;
    expect(e1.type).toBe("compaction");
    expect(e1.segmentIndex).toBe(0);
    expect(e1.summary).toContain("dark mode");

    // Entry 2: active segment 1 with new turns
    const e2 = doc.entries[2] as any;
    expect(e2.type).toBe("segment");
    expect(e2.segmentIndex).toBe(1);
    expect(e2.turns.length).toBe(2);
    expect(e2.compactedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 3: Multiple compactions — the full recursive lifecycle
// ---------------------------------------------------------------------------
describe("multiple compactions", () => {
  const doc = createEmptyDocument("sess-003");

  test("cycle 0: initial work", () => {
    addUserTurn(doc, "Create a REST API for user management");
    addAssistantTurn(doc, "Setting up Express routes for CRUD operations.");
    addToolTurns(doc, "write", "Created routes/users.ts");
    addAssistantTurn(doc, "Created GET/POST/PUT/DELETE routes.");

    expect(getActiveSegment(doc)!.segmentIndex).toBe(0);
    expect(doc.stats.totalTurns).toBe(5);
  });

  test("compaction 0: summarize initial work", () => {
    recordCompaction(
      doc,
      "Created REST API routes for user management with CRUD endpoints in routes/users.ts.",
    );

    expect(doc.stats.totalCompactions).toBe(1);
    expect(getActiveSegment(doc)!.segmentIndex).toBe(1);
    expect(doc.entries.length).toBe(3); // seg0, comp0, seg1
  });

  test("cycle 1: add auth", () => {
    addUserTurn(doc, "Add JWT authentication middleware");
    addAssistantTurn(doc, "Adding auth middleware.");
    addToolTurns(doc, "write", "Created middleware/auth.ts");
    addToolTurns(doc, "edit", "Applied edit to routes/users.ts");
    addAssistantTurn(doc, "Auth middleware added and applied to user routes.");

    const seg1 = getActiveSegment(doc)!;
    expect(seg1.segmentIndex).toBe(1);
    expect(seg1.turns.length).toBe(7);
  });

  test("compaction 1: summarize auth work", () => {
    recordCompaction(
      doc,
      "Added JWT auth middleware in middleware/auth.ts and applied it to " +
        "all user management routes. Previous: Created CRUD API in routes/users.ts.",
    );

    expect(doc.stats.totalCompactions).toBe(2);
    expect(getActiveSegment(doc)!.segmentIndex).toBe(2);
    expect(doc.entries.length).toBe(5); // seg0, comp0, seg1, comp1, seg2
  });

  test("cycle 2: add tests", () => {
    addUserTurn(doc, "Write integration tests for the API");
    addAssistantTurn(doc, "Writing tests with supertest.");
    addToolTurns(doc, "write", "Created tests/users.test.ts");
    addAssistantTurn(doc, "Tests pass — 8/8 green.");

    const seg2 = getActiveSegment(doc)!;
    expect(seg2.segmentIndex).toBe(2);
    expect(seg2.turns.length).toBe(5);
  });

  test("full document structure after 2 compactions", () => {
    // The trajectory.json now has 5 entries, preserving everything:
    //
    // entries[0]: segment 0 (frozen)  — 5 turns from initial CRUD work
    // entries[1]: compaction 0        — summary of segment 0
    // entries[2]: segment 1 (frozen)  — 7 turns from auth work
    // entries[3]: compaction 1        — summary of segment 1
    // entries[4]: segment 2 (active)  — 5 turns from test work (ongoing)

    expect(doc.entries.length).toBe(5);

    const seg0 = doc.entries[0] as any;
    expect(seg0.type).toBe("segment");
    expect(seg0.segmentIndex).toBe(0);
    expect(seg0.turns.length).toBe(5);
    expect(seg0.compactedAt).not.toBeNull();

    const comp0 = doc.entries[1] as any;
    expect(comp0.type).toBe("compaction");
    expect(comp0.segmentIndex).toBe(0);
    expect(comp0.summary).toContain("CRUD");

    const seg1 = doc.entries[2] as any;
    expect(seg1.type).toBe("segment");
    expect(seg1.segmentIndex).toBe(1);
    expect(seg1.turns.length).toBe(7);
    expect(seg1.compactedAt).not.toBeNull();

    const comp1 = doc.entries[3] as any;
    expect(comp1.type).toBe("compaction");
    expect(comp1.segmentIndex).toBe(1);
    expect(comp1.summary).toContain("JWT");

    const seg2 = doc.entries[4] as any;
    expect(seg2.type).toBe("segment");
    expect(seg2.segmentIndex).toBe(2);
    expect(seg2.turns.length).toBe(5);
    expect(seg2.compactedAt).toBeNull();

    // Aggregate stats
    expect(doc.stats.totalTurns).toBe(17); // 5 + 7 + 5
    expect(doc.stats.totalCompactions).toBe(2);
    expect(doc.stats.totalTokensProcessed).toBeGreaterThan(0);
  });

  test("getRecentSummaries returns most recent first", () => {
    const summaries = getRecentSummaries(doc, 3);
    expect(summaries.length).toBe(2);
    expect(summaries[0].segmentIndex).toBe(1); // most recent
    expect(summaries[1].segmentIndex).toBe(0); // older
    expect(summaries[0].summary).toContain("JWT");
    expect(summaries[1].summary).toContain("CRUD");
  });

  test("getOverview shows all segments with their compaction status", () => {
    const overview = getOverview(doc);
    expect(overview.segments.length).toBe(3);

    expect(overview.segments[0]).toMatchObject({
      segmentIndex: 0,
      turnCount: 5,
      compacted: true,
    });
    expect(overview.segments[0].summary).toContain("CRUD");

    expect(overview.segments[1]).toMatchObject({
      segmentIndex: 1,
      turnCount: 7,
      compacted: true,
    });
    expect(overview.segments[1].summary).toContain("JWT");

    expect(overview.segments[2]).toMatchObject({
      segmentIndex: 2,
      turnCount: 5,
      compacted: false,
    });
    expect(overview.segments[2].summary).toBeUndefined();
  });

  test("searchTrajectory finds content across all segments", () => {
    // Search hits turns first (segments come before compaction entries),
    // then compaction summaries
    const jwtResults = searchTrajectory(doc, "JWT", 10);
    expect(jwtResults.length).toBeGreaterThan(0);
    // "JWT" appears in both turn content and compaction summary
    const jwtSources = jwtResults.map((r) => r.source);
    expect(jwtSources).toContain("turn");
    expect(jwtSources).toContain("compaction");

    // Search in turn content only
    const testResults = searchTrajectory(doc, "integration tests", 10);
    expect(testResults.length).toBeGreaterThan(0);
    expect(testResults[0].source).toBe("turn");
    expect(testResults[0].segmentIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Case 4: Verify JSON output shape matches what's written to disk
// ---------------------------------------------------------------------------
describe("trajectory.json serialized format", () => {
  test("produces expected JSON structure", () => {
    const doc = createEmptyDocument("sess-json");

    addUserTurn(doc, "Hello");
    addAssistantTurn(doc, "Hi there!");

    recordCompaction(doc, "Greeted the user.");

    addUserTurn(doc, "What time is it?");
    addAssistantTurn(doc, "I don't have access to the current time.");

    const json = JSON.parse(JSON.stringify(doc, null, 2));

    // Top level
    expect(json.version).toBe(1);
    expect(json.sessionId).toBe("sess-json");
    expect(json.createdAt).toBeDefined();
    expect(json.lastUpdatedAt).toBeDefined();
    expect(json.stats.totalTurns).toBe(4);
    expect(json.stats.totalCompactions).toBe(1);

    // entries[0]: frozen segment 0
    expect(json.entries[0]).toMatchObject({
      type: "segment",
      segmentIndex: 0,
    });
    expect(json.entries[0].compactedAt).not.toBeNull();
    expect(json.entries[0].turns).toEqual([
      expect.objectContaining({
        turnIndex: 0,
        role: "user",
        content: "Hello",
      }),
      expect.objectContaining({
        turnIndex: 1,
        role: "assistant",
        content: "Hi there!",
      }),
    ]);

    // entries[1]: compaction for segment 0
    expect(json.entries[1]).toMatchObject({
      type: "compaction",
      segmentIndex: 0,
      summary: "Greeted the user.",
    });

    // entries[2]: active segment 1
    expect(json.entries[2]).toMatchObject({
      type: "segment",
      segmentIndex: 1,
    });
    expect(json.entries[2].compactedAt).toBeNull();
    expect(json.entries[2].turns).toEqual([
      expect.objectContaining({
        turnIndex: 2,
        role: "user",
        content: "What time is it?",
      }),
      expect.objectContaining({
        turnIndex: 3,
        role: "assistant",
        content: "I don't have access to the current time.",
      }),
    ]);
  });
});
