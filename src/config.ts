import type { RLMConfig } from "./types";

const DEFAULT_CONFIG: RLMConfig = {
  baseDir: "/tmp",
  cleanupOnDelete: false,
  maxToolOutputChars: 50000,
  tokenEstimateMultiplier: 1.0,
  maxSubagentDepth: 3,
};

export function loadConfig(): RLMConfig {
  const config = { ...DEFAULT_CONFIG };

  if (process.env.RLM_BASE_DIR) {
    config.baseDir = process.env.RLM_BASE_DIR;
  }
  if (process.env.RLM_CLEANUP_ON_DELETE === "true") {
    config.cleanupOnDelete = true;
  }
  if (process.env.RLM_MAX_TOOL_OUTPUT_CHARS) {
    config.maxToolOutputChars = parseInt(
      process.env.RLM_MAX_TOOL_OUTPUT_CHARS,
      10,
    );
  }
  if (process.env.RLM_TOKEN_ESTIMATE_MULTIPLIER) {
    config.tokenEstimateMultiplier = parseFloat(
      process.env.RLM_TOKEN_ESTIMATE_MULTIPLIER,
    );
  }
  if (process.env.RLM_MAX_SUBAGENT_DEPTH) {
    config.maxSubagentDepth = parseInt(
      process.env.RLM_MAX_SUBAGENT_DEPTH,
      10,
    );
  }

  return config;
}
