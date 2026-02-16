import type { RLMConfig } from "./types";

const DEFAULT_CONFIG: RLMConfig = {
  baseDir: "/tmp/rlm",
  cleanupOnDelete: false,
  maxToolOutputChars: 50000,
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

  return config;
}
