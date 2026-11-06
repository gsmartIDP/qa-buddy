import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyDatabase } from "@qa-buddy/db";
// The Docker dev watcher's side of the protocol, tested against the server's.
import {
  clearPending,
  readActiveWork,
  readPending,
  recordChange,
  shouldRestart,
  writePending
} from "../../../docker/worker-restart.mjs";
import { buildServer } from "./server.js";

const repositoryInput = {
  name: "Platform",
  githubUrl: "https://github.com/example/platform",
  defaultRef: "main",
  runnerImage: "node:22-bookworm",
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: true,
  apps: []
};

describe("held worker restarts", () => {
  let directory: string;
  let databasePath: string;
  let database: QaBuddyDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let repositoryId: string;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-restart-"));
    databasePath = path.join(directory, "qa-buddy.sqlite");
    database = new QaBuddyDatabase(databasePath);
    app = await buildServer({ database, dataDirectory: directory });
    repositoryId = (await app.inject({ method: "POST", url: "/api/repositories", payload: repositoryInput })).json().repository.id as string;
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("collects changed paths into one pending restart and keeps an earlier decision", () => {
    const first = recordChange(null, "apps/worker/src/a.ts", new Date("2026-11-06T10:00:00Z"));
    const second = recordChange({ ...first, decision: "after-run" }, "apps/worker/src/b.ts");
    expect(second).toEqual({
      requestedAt: "2026-11-06T10:00:00.000Z",
      changedPaths: ["apps/worker/src/a.ts", "apps/worker/src/b.ts"],
      decision: "after-run",
      decidedAt: null
    });
    expect(recordChange(second, "apps/worker/src/a.ts").changedPaths).toHaveLength(2);
  });

  it("restarts when asked to or once nothing is running", () => {
    const work = [{ kind: "run", id: "r", status: "testing", repositoryName: "Platform" }];
    expect(shouldRestart({ decision: null }, work)).toBe(false);
    expect(shouldRestart({ decision: "after-run" }, work)).toBe(false);
    expect(shouldRestart({ decision: "now" }, work)).toBe(true);
    expect(shouldRestart({ decision: null }, [])).toBe(true);
  });

  it("sees executing runs and slice builds in the database, but not queued ones", () => {
    database.createRun(repositoryId);
    expect(readActiveWork(databasePath)).toEqual([]);
    const run = database.claimNextRun()!;
    database.setSliceConfig(repositoryId, {
      backends: [{ directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: null, entryFile: null, baseUrlNames: [] }],
      frontendDirectories: []
    });
    database.createSliceBuild(repositoryId);
    const build = database.claimNextSliceBuild()!;
    expect(readActiveWork(databasePath)).toEqual([
      { kind: "run", id: run.id, status: "cloning", repositoryName: "Platform" },
      { kind: "slice-build", id: build.id, status: "running", repositoryName: "Platform" }
    ]);
    expect(readActiveWork(path.join(directory, "missing.sqlite"))).toEqual([]);
  });

  it("reports a held restart with the work in progress and records the decision for the watcher", async () => {
    expect((await app.inject({ method: "GET", url: "/api/worker-restart" })).json()).toEqual({ pending: null, activeWork: [] });
    expect((await app.inject({ method: "POST", url: "/api/worker-restart", payload: { decision: "now" } })).statusCode).toBe(404);

    database.createRun(repositoryId);
    const run = database.claimNextRun()!;
    writePending(directory, recordChange(null, "apps/worker/src/worker.ts", new Date("2026-11-06T10:00:00Z")));

    const held = (await app.inject({ method: "GET", url: "/api/worker-restart" })).json();
    expect(held).toEqual({
      pending: { requestedAt: "2026-11-06T10:00:00.000Z", changedPaths: ["apps/worker/src/worker.ts"], decision: null, decidedAt: null },
      activeWork: [{ kind: "run", id: run.id, repositoryId, repositoryName: "Platform", status: "cloning" }]
    });

    expect((await app.inject({ method: "POST", url: "/api/worker-restart", payload: { decision: "soon" } })).statusCode).toBe(400);
    const decided = await app.inject({ method: "POST", url: "/api/worker-restart", payload: { decision: "now" } });
    expect(decided.json().pending.decision).toBe("now");
    // The watcher reads the decision and restarts.
    const pending = readPending(directory);
    expect(shouldRestart(pending, readActiveWork(databasePath)!)).toBe(true);
    clearPending(directory);
    expect((await app.inject({ method: "GET", url: "/api/worker-restart" })).json().pending).toBeNull();
  });
});
