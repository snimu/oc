import { readdir, readFile, stat } from "fs/promises";
import type { SessionState } from "../types";
import { getActiveSegment, getRecentSummaries } from "../trajectory/manager";

// ── Box drawing ──────────────────────────────────────────────────────
const V = "│";
const H = "─";

// ── Layout constants ─────────────────────────────────────────────────
const BAR_WIDTH = 44;
const RULE_W = 72;

function hRule(left: string, label?: string): string {
  if (!label) return `  ${left}${H.repeat(RULE_W)}`;
  const tail = RULE_W - label.length - 1;
  return `  ${left} ${label} ${H.repeat(Math.max(0, tail))}`;
}

/**
 * Simple block bar: █ for filled, ░ for empty.
 */
function bar(ratio: number, fill = "█", width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(ratio, 1));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return fill.repeat(filled) + "░".repeat(empty);
}

/**
 * Stacked bar: two segments drawn with different fill characters.
 */
function stackedBar(
  ratioA: number,
  ratioB: number,
  width = BAR_WIDTH,
): string {
  const a = Math.max(0, Math.min(ratioA, 1));
  const b = Math.max(0, Math.min(ratioB, 1 - a));
  const cellsA = Math.round(a * width);
  const cellsB = Math.round(b * width);
  const cellsEmpty = width - cellsA - cellsB;
  return (
    "▓".repeat(cellsA) +
    "█".repeat(cellsB) +
    "░".repeat(Math.max(0, cellsEmpty))
  );
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

/**
 * Build the RLM context display for the /context command.
 */
export async function buildContextDisplay(
  state: SessionState,
): Promise<string> {
  const doc = state.document;
  const active = getActiveSegment(doc);
  const summaries = getRecentSummaries(doc, 3);

  const activeTurns = active?.turns.length ?? 0;
  const activeTokens = active?.totalEstimatedTokens ?? 0;
  const segIdx = active?.segmentIndex ?? 0;
  const compactedTokens = doc.stats.totalTokensProcessed - activeTokens;
  const totalProcessed = doc.stats.totalTokensProcessed || 1;
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
  const rootStats = `${fmt(activeTokens)} tokens · ${activeTurns} turns`;
  L.push(`  ${V}  ROOT MODEL CONTEXT                          ${rootStats}`);
  L.push(`  ${V}  What the language model currently sees`);
  L.push(`  ${V}`);

  const aRatio = totalProcessed > 0 ? activeTokens / totalProcessed : 1;
  const aBar = bar(aRatio);
  const started =
    active?.startedAt ? `started ${timeAgo(active.startedAt)}` : "";
  L.push(`  ${V}  ${aBar}  seg ${segIdx} · ${started}`);
  if (compactions > 0) {
    L.push(
      `  ${V}  ${" ".repeat(BAR_WIDTH)}  ${pct(activeTokens, totalProcessed)} of total trajectory`,
    );
  }
  L.push(`  ${V}`);

  // ── Total RLM Context ───────────────────────────────────────────────
  if (compactions > 0) {
    L.push(hRule("├", "Total RLM Context"));
    L.push(`  ${V}  Full trajectory including compacted history`);
    L.push(`  ${V}`);

    const totalLabel = `${fmt(totalProcessed)} tokens · ${doc.stats.totalTurns} turns · ${compactions} compaction${compactions === 1 ? "" : "s"}`;
    L.push(`  ${V}  ${totalLabel}`);
    L.push(`  ${V}`);

    const cRatio = compactedTokens / totalProcessed;
    const sBar = stackedBar(cRatio, aRatio);
    L.push(`  ${V}  ${sBar}`);
    L.push(
      `  ${V}  ${padR(`▓ compacted  ${fmt(compactedTokens)}  ${pct(compactedTokens, totalProcessed)}`, BAR_WIDTH)}  █ active  ${fmt(activeTokens)}  ${pct(activeTokens, totalProcessed)}`,
    );
    L.push(`  ${V}`);
  }

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
      L.push(`  ${V}  seg ${s.segmentIndex}  ${padR(age, 8)}  ${oneLine}`);
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
