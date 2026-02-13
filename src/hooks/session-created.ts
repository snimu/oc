import type { RLMConfig, SessionState } from "../types";
import { createSessionDirectory } from "../session/directory";
import { createEmptyDocument, writeTrajectory } from "../trajectory/manager";

export async function handleSessionCreated(
  sessionId: string,
  config: RLMConfig,
  sessionStates: Map<string, SessionState>,
): Promise<void> {
  const dirs = await createSessionDirectory(config.baseDir);

  const document = createEmptyDocument(sessionId);
  await writeTrajectory(dirs.trajectoryPath, document);

  const state: SessionState = {
    sessionId,
    sessionDir: dirs.sessionDir,
    trajectoryPath: dirs.trajectoryPath,
    varsDir: dirs.varsDir,
    document,
    lastKnownMessageCount: 0,
    writeQueue: Promise.resolve(),
  };

  sessionStates.set(sessionId, state);
}
