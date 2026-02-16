import { readdir, readFile, stat } from "fs/promises";
import type { SessionState } from "../types";
import { getActiveSegment, getRecentSummaries } from "../trajectory/manager";

function fmt(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function peekVar(path: string): Promise<string> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    const val =
      typeof parsed.value === "string"
        ? parsed.value
        : JSON.stringify(parsed.value);
    return val.length > 50 ? val.slice(0, 50) + "..." : val;
  } catch {
    try {
      const raw = await readFile(path, "utf-8");
      return raw.length > 50 ? raw.slice(0, 50) + "..." : raw;
    } catch {
      return "(unreadable)";
    }
  }
}

const INDENT = "  ";

/** Indent every line of text, including lines created by embedded newlines. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => INDENT + line)
    .join("\n");
}

/** Token usage from OpenCode's actual model response. */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ContextDisplayOpts {
  /** Token usage from the last assistant message (actual model-reported values). */
  lastUsage?: TokenUsage;
  /** Cumulative totals across all assistant messages in this session. */
  totalUsage?: TokenUsage;
  /** Context window limit from model config. */
  contextLimit?: number;
  /** Number of messages in the session. */
  messageCount?: number;
}

export async function buildContextDisplay(
  state: SessionState,
  opts: ContextDisplayOpts = {},
): Promise<string> {
  const doc = state.document;
  const active = getActiveSegment(doc);
  const summaries = getRecentSummaries(doc, 3);
  const compactions = doc.stats.totalCompactions;

  const varsEntries: Array<{ name: string; size: number; path: string }> = [];
  try {
    const files = await readdir(state.varsDir);
    for (const file of files) {
      const fp = `${state.varsDir}/${file}`;
      const s = await stat(fp);
      if (s.isFile()) varsEntries.push({ name: file, size: s.size, path: fp });
    }
  } catch {
    /* empty */
  }

  const L: string[] = [];

  L.push("RLM Context");
  L.push("----------------------------------------");
  L.push("");

  // ── Current context (from OpenCode's actual token counts) ──
  L.push("Current Context");
  if (opts.lastUsage) {
    const u = opts.lastUsage;
    let line = `${fmt(u.input)} input tokens`;
    if (opts.contextLimit) {
      line += ` / ${fmt(opts.contextLimit)} limit (${pct(u.input, opts.contextLimit)})`;
    }
    L.push(indent(line));
    L.push(indent(`${fmt(u.output)} output, ${fmt(u.reasoning)} reasoning`));
    if (u.cacheRead > 0 || u.cacheWrite > 0) {
      L.push(indent(`cache: ${fmt(u.cacheRead)} read, ${fmt(u.cacheWrite)} write`));
    }
  } else {
    L.push(indent("(no messages yet — send a message to see actual token counts)"));
  }
  if (opts.messageCount != null) {
    L.push(indent(`${opts.messageCount} messages in session`));
  }
  L.push("");

  // ── Session totals (cumulative output/cost, NOT input — input is already full context) ──
  if (opts.totalUsage) {
    const t = opts.totalUsage;
    L.push("Session Totals");
    L.push(indent(`${fmt(t.output)} output tokens, ${fmt(t.reasoning)} reasoning tokens`));
    if (t.cost > 0) {
      L.push(indent(`$${t.cost.toFixed(4)} total cost`));
    }
    L.push("");
  }

  // ── Compaction info ──
  if (compactions > 0) {
    L.push("Compactions");
    L.push(indent(`${compactions} compaction${compactions === 1 ? "" : "s"}`));
    if (active?.turns.length) {
      let turnsLine = `${active.turns.length} turns in current segment`;
      if (active.startedAt) {
        turnsLine += `, started ${timeAgo(active.startedAt)}`;
      }
      L.push(indent(turnsLine));
    }
    L.push("");
  }

  if (summaries.length > 0) {
    L.push("Compaction History");
    for (const s of summaries) {
      const preview =
        s.summary.length > 60
          ? s.summary.slice(0, 60).trimEnd() + "..."
          : s.summary;
      L.push(indent(`#${s.segmentIndex} ${timeAgo(s.compactedAt)} - ${preview}`));
    }
    L.push("");
  }

  // ── Trajectory ──
  L.push("Trajectory");
  L.push(indent(`file: ${state.trajectoryPath}`));
  L.push(indent(`${doc.entries.length} entries, ${doc.stats.totalTurns} turns, ${doc.stats.totalCompactions} compactions`));
  const allTurns: Array<{ role: string; content: string; timestamp: string }> = [];
  for (const entry of doc.entries) {
    if (entry.type === "segment") {
      for (const t of entry.turns) allTurns.push(t);
    }
  }
  if (allTurns.length > 0) {
    const first = allTurns[0];
    const last = allTurns[allTurns.length - 1];
    const clip = (s: string, n: number) =>
      s.length > n ? s.slice(0, n).trimEnd() + "..." : s;
    L.push(indent(`first: [${first.role}] ${clip(first.content, 60)}`));
    if (allTurns.length > 1) {
      L.push(indent(`last:  [${last.role}] ${clip(last.content, 60)}`));
    }
  } else {
    L.push(indent("(no turns yet)"));
  }
  L.push("");

  // ── Vars ──
  L.push("REPL Variables");
  if (varsEntries.length === 0) {
    L.push(indent("(empty)"));
  } else {
    for (const v of varsEntries.slice(0, 6)) {
      const preview = await peekVar(v.path);
      L.push(indent(`${v.name}: ${preview}`));
    }
    if (varsEntries.length > 6) {
      L.push(indent(`... and ${varsEntries.length - 6} more`));
    }
  }
  L.push("");

  L.push("Bash Commands");
  L.push(indent(`subagent '<prompt>'          — child session (streams tool calls)`));
  L.push(indent(`subagent_batch '<json>'      — parallel child sessions (streaming)`));
  L.push(indent(`llm-subcall "prompt"         — single LLM call (no tools, fast)`));
  L.push(indent(`list_tools                   — list available tool IDs`));
  L.push("");

  L.push("Paths");
  L.push(indent(`session: ${state.sessionDir}`));
  L.push(indent(`trajectory: ${state.trajectoryPath}`));
  L.push(indent(`vars: ${state.varsDir}`));

  return L.join("\n");
}
