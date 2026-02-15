/** A single message turn captured in the trajectory */
export interface TrajectoryTurn {
  turnIndex: number;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  estimatedTokens: number;
  timestamp: string;
  toolName?: string;
  toolArgs?: string;
}

/** A contiguous sequence of turns between compactions */
export interface TrajectorySegment {
  type: "segment";
  segmentIndex: number;
  turns: TrajectoryTurn[];
  totalEstimatedTokens: number;
  startedAt: string;
  compactedAt: string | null;
}

/** A compaction record: the summary that replaced a segment */
export interface CompactionEntry {
  type: "compaction";
  segmentIndex: number;
  summary: string;
  summaryTokens: number;
  originalTokens: number;
  compactedAt: string;
}

/** Union type for entries in trajectory.json */
export type TrajectoryEntry = TrajectorySegment | CompactionEntry;

/** The top-level trajectory.json document */
export interface TrajectoryDocument {
  version: 1;
  sessionId: string;
  createdAt: string;
  lastUpdatedAt: string;
  entries: TrajectoryEntry[];
  stats: {
    totalTurns: number;
    totalCompactions: number;
    totalTokensProcessed: number;
    currentActiveTokens: number;
  };
}

/** Per-session runtime state */
export interface SessionState {
  sessionId: string;
  sessionDir: string;
  trajectoryPath: string;
  varsDir: string;
  document: TrajectoryDocument;
  lastKnownMessageCount: number;
  writeQueue: Promise<void>;
}

/** Plugin configuration */
export interface RLMConfig {
  /** Base directory for session directories. Default: "/tmp" */
  baseDir: string;
  /** Whether to delete session dir on session delete. Default: false */
  cleanupOnDelete: boolean;
  /** Max chars to store per tool result turn. Default: 50000 */
  maxToolOutputChars: number;
  /** Multiplier for token estimator tuning. Default: 1.0 */
  tokenEstimateMultiplier: number;
  /** Max subagent recursion depth before falling back to llm-subcall. Default: 3 */
  maxSubagentDepth: number;
}
