import type { SessionState } from "../types";

/** Global per-session state, keyed by OpenCode session ID */
export const sessionStates = new Map<string, SessionState>();
