// Holding a worker restart while work is in progress, for docker/dev-watch.mjs.
//
// When worker code changes during a run, the watcher writes a pending restart
// to `<data dir>/worker-restart.json`. The server shows it on the dashboard
// (GET/POST /api/worker-restart), and the person decides:
//   decision null        - not decided yet; restart when the work finishes
//   decision "after-run" - restart when the work finishes (banner dismissed)
//   decision "now"       - restart immediately; in-progress runs end as interrupted
// The server reads the same file format in apps/server/src/worker-restart.ts.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PENDING_FILE = "worker-restart.json";
/** Statuses of runs whose work a worker restart would cut short. Queued runs wait safely. */
export const EXECUTING_RUN_STATUSES = ["cloning", "setup", "building", "testing"];
const MAX_CHANGED_PATHS = 20;

export function pendingPath(dataDirectory) {
  return path.join(dataDirectory, PENDING_FILE);
}

export function readPending(dataDirectory) {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(dataDirectory), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes atomically, so the server never reads half a file. */
export function writePending(dataDirectory, pending) {
  const target = pendingPath(dataDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

export function clearPending(dataDirectory) {
  rmSync(pendingPath(dataDirectory), { force: true });
}

/** Adds a changed path to the pending restart, creating it if needed. Keeps an earlier decision. */
export function recordChange(existing, changedPath, now = new Date()) {
  const changedPaths = existing?.changedPaths ?? [];
  const merged = changedPaths.includes(changedPath) ? changedPaths : [...changedPaths, changedPath].slice(-MAX_CHANGED_PATHS);
  return {
    requestedAt: existing?.requestedAt ?? now.toISOString(),
    changedPaths: merged,
    decision: existing?.decision ?? null,
    decidedAt: existing?.decidedAt ?? null
  };
}

/** Whether a held restart should go ahead now. */
export function shouldRestart(pending, activeWork) {
  return pending?.decision === "now" || activeWork.length === 0;
}

/**
 * Runs and slice builds a restart would cut short, read straight from SQLite
 * so it works while the server is itself restarting. Returns null when the
 * database cannot be read, so the caller can fall back to restarting.
 */
export function readActiveWork(databasePath, requireFrom = path.resolve("packages/db/package.json")) {
  if (!existsSync(databasePath)) return [];
  let database;
  try {
    const Database = createRequire(requireFrom)("better-sqlite3");
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const placeholders = EXECUTING_RUN_STATUSES.map(() => "?").join(", ");
    const runs = database
      .prepare(
        `SELECT runs.id AS id, runs.status AS status, repositories.name AS repositoryName
         FROM runs JOIN repositories ON repositories.id = runs.repository_id
         WHERE runs.status IN (${placeholders})`
      )
      .all(...EXECUTING_RUN_STATUSES)
      .map((row) => ({ kind: "run", ...row }));
    const builds = database
      .prepare(
        `SELECT slice_builds.id AS id, slice_builds.status AS status, repositories.name AS repositoryName
         FROM slice_builds JOIN repositories ON repositories.id = slice_builds.repository_id
         WHERE slice_builds.status = 'running'`
      )
      .all()
      .map((row) => ({ kind: "slice-build", ...row }));
    return [...runs, ...builds];
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
