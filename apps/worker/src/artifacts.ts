import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { RunLogger } from "./logger.js";

/** Kept deliberately modest: artifacts are debugging aids, not a storage tier. */
export const maximumArtifactBytesPerSuite = 250 * 1024 * 1024;
export const maximumArtifactFilesPerSuite = 500;

export function artifactDirectory(dataDirectory: string, runId: string, appName?: string): string {
  const base = path.join(dataDirectory, "artifacts", runId);
  return appName === undefined ? base : path.join(base, encodeURIComponent(appName));
}

export interface CollectedArtifacts {
  files: string[];
  totalBytes: number;
  skipped: number;
}

/**
 * Copies a suite's artifacts out of the checkout into the data volume, which
 * outlives the run. Called while the workspace still exists: the checkout is
 * deleted as soon as the run finishes, taking screenshots and video with it.
 */
export async function collectRunArtifacts(options: {
  repositoryDirectory: string;
  dataDirectory: string;
  runId: string;
  appName: string;
  globs: string[];
  logger: RunLogger;
}): Promise<CollectedArtifacts> {
  const collected: CollectedArtifacts = { files: [], totalBytes: 0, skipped: 0 };
  const patterns = options.globs.map((value) => value.trim()).filter(Boolean);
  if (patterns.length === 0) return collected;

  const root = path.resolve(options.repositoryDirectory);
  const matches = await fg(patterns, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**"]
  });

  const destinationRoot = artifactDirectory(options.dataDirectory, options.runId, options.appName);

  for (const relative of matches.sort((left, right) => left.localeCompare(right))) {
    const source = path.resolve(root, relative);
    if (!source.startsWith(`${root}${path.sep}`)) {
      collected.skipped += 1;
      continue;
    }
    const destination = path.resolve(destinationRoot, relative);
    if (!destination.startsWith(`${path.resolve(destinationRoot)}${path.sep}`)) {
      collected.skipped += 1;
      continue;
    }

    let size = 0;
    try {
      const stats = statSync(source);
      if (!stats.isFile()) continue;
      size = stats.size;
    } catch {
      collected.skipped += 1;
      continue;
    }

    if (
      collected.files.length >= maximumArtifactFilesPerSuite ||
      collected.totalBytes + size > maximumArtifactBytesPerSuite
    ) {
      collected.skipped += 1;
      continue;
    }

    try {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      collected.files.push(relative.replaceAll("\\", "/"));
      collected.totalBytes += size;
    } catch {
      collected.skipped += 1;
    }
  }

  if (collected.files.length > 0) {
    options.logger.line(
      `Kept ${collected.files.length} artifact${collected.files.length === 1 ? "" : "s"} for ${options.appName} (${Math.round(collected.totalBytes / 1024)} KB)${collected.skipped ? `, skipped ${collected.skipped}` : ""}`
    );
  } else if (collected.skipped > 0 || patterns.length > 0) {
    options.logger.line(`No artifacts matched for ${options.appName}`);
  }

  return collected;
}
