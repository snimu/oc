import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";

export interface SessionDirs {
  sessionDir: string;
  activeDir: string;
  trajectoryPath: string;
  varsDir: string;
}

export async function createSessionDirectory(
  baseDir: string,
): Promise<SessionDirs> {
  const hash = randomUUID().replace(/-/g, "").slice(0, 8);
  const sessionDir = `${baseDir}/rlm-opencode-${hash}`;
  const activeDir = `${sessionDir}/active`;
  const varsDir = `${sessionDir}/vars`;
  const trajectoryPath = `${activeDir}/trajectory.json`;

  await mkdir(activeDir, { recursive: true });
  await mkdir(varsDir, { recursive: true });

  return { sessionDir, activeDir, trajectoryPath, varsDir };
}

export async function removeSessionDirectory(sessionDir: string) {
  const { rm } = await import("fs/promises");
  await rm(sessionDir, { recursive: true, force: true });
}
