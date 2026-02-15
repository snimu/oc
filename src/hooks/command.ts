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

export interface ContextDisplayOpts {
  modelInputTokens?: number;
  contextLimit?: number;
}

export async function buildContextDisplay(
  state: SessionState,
  opts: ContextDisplayOpts = {},
): Promise<string> {
  const doc = state.document;
  const active = getActiveSegment(doc);
  const summaries = getRecentSummaries(doc, 3);

  const activeTurns = active?.turns.length ?? 0;
  const activeTokens = active?.totalEstimatedTokens ?? 0;
  const compactedTokens = doc.stats.totalTokensProcessed - activeTokens;
  const totalProcessed = doc.stats.totalTokensProcessed;
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

  L.push("Root Model Context");
  if (opts.modelInputTokens != null) {
    let line = `${fmt(opts.modelInputTokens)} input tokens`;
    if (opts.contextLimit) {
      line += ` / ${fmt(opts.contextLimit)} limit (${pct(opts.modelInputTokens, opts.contextLimit)})`;
    }
    L.push(indent(line));
  } else {
    L.push(indent(`~${fmt(activeTokens)} tokens (estimated)`));
  }
  let turnsLine = `${fmt(activeTurns)} turns`;
  if (active?.startedAt) {
    turnsLine += `, started ${timeAgo(active.startedAt)}`;
  }
  L.push(indent(turnsLine));
  L.push("");

  L.push("Total RLM Context");
  L.push(indent(`${fmt(totalProcessed)} tokens total, ${doc.stats.totalTurns} turns`));
  if (compactions > 0) {
    L.push(indent(`${fmt(compactedTokens)} compacted (${pct(compactedTokens, totalProcessed || 1)}), ${compactions} compaction${compactions === 1 ? "" : "s"}`));
    L.push(indent(`${fmt(activeTokens)} active (${pct(activeTokens, totalProcessed || 1)})`));
  }
  L.push("");

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

  L.push("Bash Helpers");
  L.push(indent(`subagent '<prompt>'          — spawn child OpenCode session`));
  L.push(indent(`subagent_batch '<json>'      — parallel subagents`));
  L.push(indent(`llm-subcall "prompt"         — single LLM call (no tools)`));
  L.push(indent(`list_tools                   — list available tool IDs`));
  L.push("");

  L.push("Paths");
  L.push(indent(`session: ${state.sessionDir}`));
  L.push(indent(`full context: ${state.trajectoryPath}`));
  L.push(indent(`repl vars: ${state.varsDir}`));

  return L.join("\n");
}
