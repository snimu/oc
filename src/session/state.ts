import type { SessionState } from "../types";

/** Global per-session state, keyed by OpenCode session ID */
export const sessionStates = new Map<string, SessionState>();

/** Subagent recursion depth per session. Root sessions = 0, child sessions = parent + 1. */
export const sessionDepths = new Map<string, number>();
