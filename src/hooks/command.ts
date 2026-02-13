import { readdir, readFile, stat } from "fs/promises";
import type { SessionState } from "../types";
import { getActiveSegment, getRecentSummaries } from "../trajectory/manager";

// ── Box drawing ──────────────────────────────────────────────────────
const V = "│";
const H = "─";
const RULE_W = 72;

function hRule(left: string, label?: string): string {
  if (!label) return `  ${left}${H.repeat(RULE_W)}`;
  const tail = RULE_W - label.length - 1;
  return `  ${left} ${label} ${H.repeat(Math.max(0, tail))}`;
}

function fmt(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function padR(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
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
    return val.length > 56 ? val.slice(0, 56) + "…" : val;
  } catch {
    try {
      const raw = await readFile(path, "utf-8");
      return raw.length > 56 ? raw.slice(0, 56) + "…" : raw;
    } catch {
      return "(unreadable)";
    }
  }
}

export interface ContextDisplayOpts {
  modelInputTokens?: number;
  contextLimit?: number;
}

/**
 * Build the RLM context display for the /context command.
 */
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

  // Gather vars/ info
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

  // ── Header ──────────────────────────────────────────────────────────
  L.push(hRule("┌", "RLM Context"));
  L.push(`  ${V}`);

  // ── Root Model Context ──────────────────────────────────────────────
  L.push(`  ${V}  ROOT MODEL CONTEXT`);
  L.push(`  ${V}  What the language model currently sees`);
  L.push(`  ${V}`);

  if (opts.modelInputTokens != null) {
    let line = `  ${V}    ${fmt(opts.modelInputTokens)} input tokens`;
    if (opts.contextLimit) {
      line += `  /  ${fmt(opts.contextLimit)} limit  (${pct(opts.modelInputTokens, opts.contextLimit)})`;
    }
    L.push(line);
  } else {
    L.push(`  ${V}    ~${fmt(activeTokens)} tokens (estimated)`);
  }
  L.push(`  ${V}    ${activeTurns} turns`);
  if (active?.startedAt) {
    L.push(`  ${V}    started ${timeAgo(active.startedAt)}`);
  }
  L.push(`  ${V}`);

  // ── Total RLM Context ───────────────────────────────────────────────
  L.push(hRule("├", "Total RLM Context"));
  L.push(`  ${V}  Full trajectory including compacted history`);
  L.push(`  ${V}`);
  L.push(`  ${V}    ${fmt(totalProcessed)} tokens total  ·  ${doc.stats.totalTurns} turns`);
  if (compactions > 0) {
    L.push(`  ${V}    ${fmt(compactedTokens)} compacted  (${pct(compactedTokens, totalProcessed || 1)})  ·  ${compactions} compaction${compactions === 1 ? "" : "s"}`);
    L.push(`  ${V}    ${fmt(activeTokens)} active  (${pct(activeTokens, totalProcessed || 1)})`);
  }
  L.push(`  ${V}`);

  // ── Compaction summaries ────────────────────────────────────────────
  if (summaries.length > 0) {
    L.push(hRule("├", "Compaction History"));
    L.push(`  ${V}`);
    for (const s of summaries) {
      const preview =
        s.summary.length > 68
          ? s.summary.slice(0, 68).trimEnd() + "…"
          : s.summary;
      const oneLine = preview.replace(/\n/g, " ");
      const age = timeAgo(s.compactedAt);
      L.push(`  ${V}  #${s.segmentIndex}  ${padR(age, 8)}  ${oneLine}`);
    }
    L.push(`  ${V}`);
  }

  // ── Variables ───────────────────────────────────────────────────────
  L.push(hRule("├", "REPL Variables"));
  L.push(`  ${V}`);
  if (varsEntries.length === 0) {
    L.push(`  ${V}  (empty)`);
  } else {
    for (const v of varsEntries.slice(0, 6)) {
      const preview = await peekVar(v.path);
      L.push(`  ${V}  ${padR(v.name, 18)} ${preview}`);
    }
    if (varsEntries.length > 6) {
      L.push(`  ${V}  … and ${varsEntries.length - 6} more`);
    }
  }
  L.push(`  ${V}`);

  // ── Paths ───────────────────────────────────────────────────────────
  L.push(hRule("├", "Paths"));
  L.push(`  ${V}`);
  L.push(`  ${V}  session      ${state.sessionDir}`);
  L.push(`  ${V}  rlm context  ${state.trajectoryPath}`);
  L.push(`  ${V}  repl vars    ${state.varsDir}`);
  L.push(`  ${V}`);
  L.push(hRule("└"));

  return L.join("\n");
}
