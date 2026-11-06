// Types for worker-restart.mjs, so TypeScript tests can import it.
export interface PendingRestart {
  requestedAt: string;
  changedPaths: string[];
  decision: "now" | "after-run" | null;
  decidedAt: string | null;
}
export interface ActiveWorkItem {
  kind: "run" | "slice-build";
  id: string;
  status: string;
  repositoryName: string;
}
export const PENDING_FILE: string;
export const EXECUTING_RUN_STATUSES: string[];
export function pendingPath(dataDirectory: string): string;
export function readPending(dataDirectory: string): PendingRestart | null;
export function writePending(dataDirectory: string, pending: PendingRestart): void;
export function clearPending(dataDirectory: string): void;
export function recordChange(existing: Partial<PendingRestart> | null, changedPath: string, now?: Date): PendingRestart;
export function shouldRestart(pending: Partial<PendingRestart> | null, activeWork: unknown[]): boolean;
export function readActiveWork(databasePath: string, requireFrom?: string): ActiveWorkItem[] | null;
