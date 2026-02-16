/**
 * Formats subagent and subagent_batch tool output for clean TUI display.
 * Called from tool.execute.after hook.
 */

export interface FormatResult {
  title: string;
  summary: string;
}

/** Lines injected by the plugin's tool.execute.before hook — strip from display. */
function isNoiseLine(line: string): boolean {
  return (
    !line.trim() ||
    line.includes("export OPENCODE_RLM") ||
    line.includes("export BASH_ENV") ||
    line.includes("source ") ||
    line.includes("export PATH=")
  );
}

function cleanOutput(raw: string, maxLines: number): string {
  const lines = raw.split("\n").filter((l) => !isNoiseLine(l));
  if (lines.length === 0) return "";
  if (lines.length <= maxLines) return lines.join("\n");
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n… (${lines.length - maxLines} more lines)`
  );
}

/**
 * Format a single subagent call for display.
 * Extracts the prompt from the command, cleans the output.
 */
export function formatSubagent(cmd: string, rawOutput: string): FormatResult {
  const promptMatch = cmd.match(/subagent\s+['"](.+?)['"]/s);
  const prompt = promptMatch?.[1] ?? "";
  const preview = prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt;

  return {
    title: `subagent: ${preview}`,
    summary: cleanOutput(rawOutput, 30),
  };
}

/**
 * Format a subagent_batch call for display.
 * Lists each prompt as a numbered line, then shows clean output.
 */
export function formatSubagentBatch(
  cmd: string,
  rawOutput: string,
): FormatResult {
  const jsonMatch = cmd.match(/subagent_batch\s+'(\[.*?\])'/s);
  let prompts: string[] = [];
  try {
    if (jsonMatch) prompts = JSON.parse(jsonMatch[1]);
  } catch {
    /* best-effort */
  }
  const count = jsonMatch ? prompts.length : "?";

  const lines: string[] = [];
  if (prompts.length > 0) {
    for (let i = 0; i < prompts.length; i++) {
      const preview =
        prompts[i].length > 80
          ? prompts[i].slice(0, 80) + "…"
          : prompts[i];
      lines.push(`  ${i + 1}. ${preview}`);
    }
  }

  const cleaned = cleanOutput(rawOutput, 20);
  if (cleaned) {
    lines.push("");
    lines.push(cleaned);
  }

  return {
    title: `subagent_batch (${count} agents)`,
    summary: lines.join("\n"),
  };
}
