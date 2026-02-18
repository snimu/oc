import { rename, writeFile } from "fs/promises";
import type {
  TrajectoryDocument,
  TrajectoryTurn,
  TrajectorySegment,
  CompactionEntry,
  SessionState,
} from "../types";
import { estimateTokens } from "./token-estimator";

export function createEmptyDocument(sessionId: string): TrajectoryDocument {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    createdAt: now,
    lastUpdatedAt: now,
    entries: [
      {
        type: "segment",
        segmentIndex: 0,
        turns: [],
        totalEstimatedTokens: 0,
        startedAt: now,
        compactedAt: null,
      },
    ],
    stats: {
      totalTurns: 0,
      totalCompactions: 0,
      totalTokensProcessed: 0,
      currentActiveTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalCost: 0,
      lastInputTokens: 0,
      pendingCompactionInputTokens: 0,
      totalCompactedTokens: 0,
    },
  };
}

/** Get the current active (last, non-compacted) segment */
export function getActiveSegment(
  doc: TrajectoryDocument,
): TrajectorySegment | null {
  for (let i = doc.entries.length - 1; i >= 0; i--) {
    const entry = doc.entries[i];
    if (entry.type === "segment" && entry.compactedAt === null) {
      return entry;
    }
  }
  return null;
}

/** Append a turn to the active segment */
export function appendTurn(
  doc: TrajectoryDocument,
  turn: TrajectoryTurn,
): void {
  const active = getActiveSegment(doc);
  if (!active) return;

  active.turns.push(turn);
  active.totalEstimatedTokens += turn.estimatedTokens;
  doc.stats.totalTurns++;
  doc.stats.totalTokensProcessed += turn.estimatedTokens;
  doc.stats.currentActiveTokens = active.totalEstimatedTokens;
  // Accumulate actual API usage from assistant turns
  if (turn.tokens) {
    doc.stats.totalOutputTokens += turn.tokens.output;
    doc.stats.totalReasoningTokens += turn.tokens.reasoning;

    // Resolve pending compaction delta:
    // If a compaction happened since the last assistant turn, the input tokens
    // dropped. The difference = tokens compacted away from context but still
    // in the trajectory.
    if (doc.stats.pendingCompactionInputTokens > 0 && turn.tokens.input > 0) {
      const delta = doc.stats.pendingCompactionInputTokens - turn.tokens.input;
      if (delta > 0) {
        doc.stats.totalCompactedTokens += delta;
      }
      doc.stats.pendingCompactionInputTokens = 0;
    }

    doc.stats.lastInputTokens = turn.tokens.input;
  }
  if (turn.cost) {
    doc.stats.totalCost += turn.cost;
  }
  doc.lastUpdatedAt = new Date().toISOString();
}

/** Create a TrajectoryTurn from message content */
export function createTurn(
  turnIndex: number,
  role: TrajectoryTurn["role"],
  content: string,
  toolName?: string,
  toolArgs?: string,
): TrajectoryTurn {
  return {
    turnIndex,
    role,
    content,
    estimatedTokens: estimateTokens(content),
    timestamp: new Date().toISOString(),
    toolName,
    toolArgs,
  };
}

/** Freeze the active segment and record a compaction summary, then start a new segment */
export function recordCompaction(
  doc: TrajectoryDocument,
  summary: string,
): void {
  const active = getActiveSegment(doc);
  if (!active) return;

  const now = new Date().toISOString();

  // Freeze the active segment
  active.compactedAt = now;

  // Add compaction entry
  const compaction: CompactionEntry = {
    type: "compaction",
    segmentIndex: active.segmentIndex,
    summary,
    summaryTokens: estimateTokens(summary),
    originalTokens: active.totalEstimatedTokens,
    compactedAt: now,
  };
  doc.entries.push(compaction);

  // Start a fresh active segment
  const newSegment: TrajectorySegment = {
    type: "segment",
    segmentIndex: active.segmentIndex + 1,
    turns: [],
    totalEstimatedTokens: 0,
    startedAt: now,
    compactedAt: null,
  };
  doc.entries.push(newSegment);

  doc.stats.totalCompactions++;
  doc.stats.currentActiveTokens = 0;
  // Snapshot pre-compaction context size so we can compute the delta
  // when the next assistant turn arrives with a smaller input
  doc.stats.pendingCompactionInputTokens = doc.stats.lastInputTokens;
  doc.lastUpdatedAt = now;
}

/** Get recent compaction summaries (most recent first) */
export function getRecentSummaries(
  doc: TrajectoryDocument,
  count: number,
): CompactionEntry[] {
  const compactions = doc.entries.filter(
    (e): e is CompactionEntry => e.type === "compaction",
  );
  return compactions.slice(-count).reverse();
}

/** Get a segment by index */
export function getSegment(
  doc: TrajectoryDocument,
  segmentIndex: number,
): TrajectorySegment | null {
  const entry = doc.entries.find(
    (e): e is TrajectorySegment =>
      e.type === "segment" && e.segmentIndex === segmentIndex,
  );
  return entry ?? null;
}

/** Get the compaction entry for a given segment index */
export function getCompaction(
  doc: TrajectoryDocument,
  segmentIndex: number,
): CompactionEntry | null {
  const entry = doc.entries.find(
    (e): e is CompactionEntry =>
      e.type === "compaction" && e.segmentIndex === segmentIndex,
  );
  return entry ?? null;
}

/** Get an overview of all segments and their summaries */
export function getOverview(doc: TrajectoryDocument) {
  const segments: Array<{
    segmentIndex: number;
    turnCount: number;
    tokens: number;
    compacted: boolean;
    summary?: string;
  }> = [];

  for (const entry of doc.entries) {
    if (entry.type === "segment") {
      segments.push({
        segmentIndex: entry.segmentIndex,
        turnCount: entry.turns.length,
        tokens: entry.totalEstimatedTokens,
        compacted: entry.compactedAt !== null,
      });
    } else if (entry.type === "compaction") {
      const seg = segments.find(
        (s) => s.segmentIndex === entry.segmentIndex,
      );
      if (seg) {
        seg.summary = entry.summary;
      }
    }
  }

  return { segments, stats: doc.stats };
}

/** Search across all turns and summaries */
export function searchTrajectory(
  doc: TrajectoryDocument,
  query: string,
  maxResults: number,
): Array<{
  source: "turn" | "compaction";
  segmentIndex: number;
  turnIndex?: number;
  snippet: string;
}> {
  const results: Array<{
    source: "turn" | "compaction";
    segmentIndex: number;
    turnIndex?: number;
    snippet: string;
  }> = [];
  const lowerQuery = query.toLowerCase();

  for (const entry of doc.entries) {
    if (results.length >= maxResults) break;

    if (entry.type === "segment") {
      for (const turn of entry.turns) {
        if (results.length >= maxResults) break;
        if (turn.content.toLowerCase().includes(lowerQuery)) {
          const idx = turn.content.toLowerCase().indexOf(lowerQuery);
          const start = Math.max(0, idx - 100);
          const end = Math.min(turn.content.length, idx + query.length + 100);
          results.push({
            source: "turn",
            segmentIndex: entry.segmentIndex,
            turnIndex: turn.turnIndex,
            snippet: turn.content.slice(start, end),
          });
        }
      }
    } else if (entry.type === "compaction") {
      if (entry.summary.toLowerCase().includes(lowerQuery)) {
        results.push({
          source: "compaction",
          segmentIndex: entry.segmentIndex,
          snippet: entry.summary,
        });
      }
    }
  }

  return results;
}

/** Atomic write: write to .tmp then rename */
export async function writeTrajectory(
  path: string,
  doc: TrajectoryDocument,
): Promise<void> {
  const tmpPath = `${path}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(doc, null, 2));
  await rename(tmpPath, path);
}

/** Enqueue a write to prevent concurrent writes on a session */
export function enqueueWrite(
  state: SessionState,
  fn: () => Promise<void>,
): Promise<void> {
  state.writeQueue = state.writeQueue.then(fn).catch(() => {});
  return state.writeQueue;
}
