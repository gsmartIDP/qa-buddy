import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { QaBuddyDatabase } from "@qa-buddy/db";

/**
 * A worker restart held by the Docker dev watcher because worker code changed
 * while a run or slice build was in progress. The watcher writes it to
 * `<data dir>/worker-restart.json`, in the format docker/worker-restart.mjs
 * defines, and restarts once the work finishes or the decision is "now".
 */
export interface PendingWorkerRestart {
  requestedAt: string;
  changedPaths: string[];
  decision: "now" | "after-run" | null;
  decidedAt: string | null;
}

export interface ActiveWork {
  kind: "run" | "slice-build";
  id: string;
  repositoryId: string;
  repositoryName: string;
  status: string;
}

const PENDING_FILE = "worker-restart.json";
/** Run statuses a restart would cut short; queued runs wait safely. Mirrors docker/worker-restart.mjs. */
const EXECUTING_RUN_STATUSES = new Set(["cloning", "setup", "building", "testing"]);

export function readPendingWorkerRestart(dataDirectory: string): PendingWorkerRestart | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDirectory, PENDING_FILE), "utf8")) as Partial<PendingWorkerRestart>;
    if (!parsed || typeof parsed.requestedAt !== "string") return null;
    return {
      requestedAt: parsed.requestedAt,
      changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths.filter((item) => typeof item === "string") : [],
      decision: parsed.decision === "now" || parsed.decision === "after-run" ? parsed.decision : null,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : null
    };
  } catch {
    return null;
  }
}

export function decideWorkerRestart(
  dataDirectory: string,
  decision: "now" | "after-run",
  now = new Date()
): PendingWorkerRestart | null {
  const pending = readPendingWorkerRestart(dataDirectory);
  if (!pending) return null;
  const updated: PendingWorkerRestart = { ...pending, decision, decidedAt: now.toISOString() };
  const target = path.join(dataDirectory, PENDING_FILE);
  const temporary = `${target}.server.tmp`;
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return updated;
}

/** Runs and slice builds a worker restart would end. */
export function listActiveWork(database: QaBuddyDatabase): ActiveWork[] {
  const work: ActiveWork[] = [];
  for (const repository of database.listRepositories()) {
    for (const run of database.listRuns(repository.id, 5)) {
      if (EXECUTING_RUN_STATUSES.has(run.status)) {
        work.push({ kind: "run", id: run.id, repositoryId: repository.id, repositoryName: repository.name, status: run.status });
      }
    }
    for (const build of database.listSliceBuilds(repository.id, 5)) {
      if (build.status === "running") {
        work.push({ kind: "slice-build", id: build.id, repositoryId: repository.id, repositoryName: repository.name, status: build.status });
      }
    }
  }
  return work;
}
