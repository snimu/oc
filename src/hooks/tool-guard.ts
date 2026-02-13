import type { SessionState } from "../types";

/**
 * Check if a file path targets the active/ directory of any RLM session.
 * Used in tool.execute.before to enforce read-only on active/.
 */
export function isInActiveDirectory(
  targetPath: string,
  sessionStates: Map<string, SessionState>,
): boolean {
  for (const [, state] of sessionStates) {
    const activeDir = `${state.sessionDir}/active/`;
    if (targetPath.startsWith(activeDir) || targetPath === activeDir) {
      return true;
    }
  }
  return false;
}
