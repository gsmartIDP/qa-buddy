import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryInput } from "@qa-buddy/shared";
import { QaBuddyDatabase } from "./database.js";

const input: RepositoryInput = {
  name: "Example platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  additionalWorkspaces: [],
  runnerImage: "node:22-bookworm",
  setupCommand: "npm ci",
  buildCommand: "npm run build",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: ["NPM_TOKEN"],
  autoDetect: false,
  apps: [
    {
      name: "Web",
      workingDirectory: "apps/web",
      testCommand: "npm test -- --coverage",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "apps/web/coverage/coverage-summary.json"
    },
    {
      name: "API",
      workingDirectory: "apps/api",
      testCommand: "npm test -- --coverage",
      coverageFormat: "lcov",
      coveragePath: "apps/api/coverage/lcov.info"
    }
  ]
};

describe("QaBuddyDatabase", () => {
  let directory: string;
  let database: QaBuddyDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-db-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists repositories and immutable run snapshots", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "feature/test");
    database.updateRepository(repository.id, { ...input, name: "Renamed platform", apps: [input.apps[0]!] });

    expect(database.getRepository(repository.id)?.name).toBe("Renamed platform");
    expect(database.getRun(run.id)?.configurationSnapshot.name).toBe("Example platform");
    expect(database.getRun(run.id)?.configurationSnapshot.buildCommand).toBe("npm run build");
    expect(database.getRun(run.id)?.configurationSnapshot.testWorkerLimit).toBe(2);
    expect(database.getRun(run.id)?.appRuns).toHaveLength(2);
  });

  it("creates a run for only the selected configured apps", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, undefined, ["API"]);

    expect(run.selectedApps).toEqual(["API"]);
    expect(run.configurationSnapshot.apps).toHaveLength(2);
    expect(run.configurationSnapshot.selectedApps).toEqual(["API"]);
    expect(run.appRuns.map((app) => app.name)).toEqual(["API"]);
  });

  it("stores run-specific apps discovered from a pnpm workspace", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id);
    expect(run.appRuns).toHaveLength(0);

    const detected = database.setDetectedApps(run.id, [input.apps[0]!]);
    expect(detected.appRuns).toHaveLength(1);
    expect(detected.configurationSnapshot.apps[0]?.name).toBe("Web");
    expect(database.getRepository(repository.id)?.apps).toHaveLength(0);
  });

  it("filters detected apps to the immutable run selection", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["API"]);
    const detected = database.setDetectedApps(run.id, input.apps);

    expect(detected.configurationSnapshot.apps).toEqual(input.apps);
    expect(detected.selectedApps).toEqual(["API"]);
    expect(detected.appRuns.map((app) => app.name)).toEqual(["API"]);
    expect(database.getRepositoryDetail(repository.id)?.selectableApps).toEqual(input.apps);
  });

  it("rejects selected apps that are absent from the requested ref", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["Missing"]);

    expect(() => database.setDetectedApps(run.id, input.apps)).toThrow(/not detected.*Missing/);
  });

  it("claims runs sequentially and prevents duplicate active runs per repository", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    expect(() => database.createRun(repository.id)).toThrow(/already has/);
    expect(database.claimNextRun()?.id).toBe(run.id);
    expect(database.claimNextRun()).toBeNull();
  });

  it("records app coverage and run outcomes", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    database.claimNextRun();
    const app = run.appRuns[0]!;
    database.startAppRun(app.id);
    database.finishAppRun(app.id, {
      status: "passed",
      exitCode: 0,
      coverage: {
        lines: { covered: 9, total: 10, percent: 90 },
        statements: { covered: 9, total: 10, percent: 90 },
        functions: { covered: 3, total: 4, percent: 75 },
        branches: { covered: 2, total: 4, percent: 50 }
      },
      testResults: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        todo: 0,
        testCases: [
          {
            name: "works",
            fullName: "suite works",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "passed",
            durationMs: 4,
            failureMessage: null
          },
          {
            name: "fails",
            fullName: "suite fails",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "failed",
            durationMs: 2,
            failureMessage: "Expected true"
          }
        ]
      }
    });
    database.updateRun(run.id, { status: "passed", finished: true });

    const result = database.getRun(run.id)!;
    expect(result.status).toBe("passed");
    expect(result.appRuns[0]?.coverage?.lines?.percent).toBe(90);
    expect(result.appRuns[0]?.testResults?.failed).toBe(1);
    expect(result.appRuns[0]?.testResults?.testCases[1]?.failureMessage).toBe("Expected true");
    expect(result.finishedAt).not.toBeNull();
  });

  it("interrupts active work but leaves queued jobs available", () => {
    const first = database.createRepository(input);
    const second = database.createRepository({
      ...input,
      name: "Second",
      githubUrl: "https://github.com/example/second.git"
    });
    const active = database.createRun(first.id);
    database.claimNextRun();
    const queued = database.createRun(second.id);

    expect(database.markActiveRunsInterrupted()).toEqual([active.id]);
    expect(database.getRun(active.id)?.status).toBe("interrupted");
    expect(database.getRun(queued.id)?.status).toBe("queued");
  });

  it("prunes older history and blocks deletion during active work", () => {
    const repository = database.createRepository(input);
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = database.createRun(repository.id);
      runIds.push(run.id);
      database.claimNextRun();
      database.updateRun(run.id, { status: "passed", finished: true });
    }
    expect(database.pruneRuns(repository.id, 2)).toEqual([runIds[0]]);
    expect(database.listRuns(repository.id, 20)).toHaveLength(2);

    database.createRun(repository.id);
    expect(database.deleteRepository(repository.id)).toMatchObject({ deleted: false, active: true });
  });

  it("records local working tree runs and refuses them without a configured checkout path", () => {
    const remoteOnly = database.createRepository(input);
    expect(() => database.createRun(remoteOnly.id, "main", undefined, true)).toThrow(
      "no local checkout path configured"
    );
    expect(database.createRun(remoteOnly.id, "main").useLocalWorkingTree).toBe(false);

    const local = database.createRepository({
      ...input,
      name: "Local platform",
      githubUrl: "https://github.com/example/local.git",
      localPath: "platform"
    });
    expect(database.getRepository(local.id)?.localPath).toBe("platform");

    const run = database.createRun(local.id, "main", undefined, true);
    expect(run.useLocalWorkingTree).toBe(true);
    expect(run.dirty).toBe(false);
    expect(run.configurationSnapshot.localPath).toBe("platform");

    database.updateRun(run.id, { resolvedSha: "abc123", dirty: true });
    expect(database.getRun(run.id)?.dirty).toBe(true);
    expect(database.getRun(run.id)?.resolvedSha).toBe("abc123");
  });

  const coverageFile = (
    path: string,
    lines: [number, number],
    branches: [number, number]
  ) => ({
    path,
    lines: { covered: lines[0], total: lines[1], percent: null },
    statements: null,
    functions: { covered: 1, total: 2, percent: null },
    branches: { covered: branches[0], total: branches[1], percent: null }
  });

  const summary = {
    lines: { covered: 5, total: 10, percent: 50 },
    statements: null,
    functions: { covered: 1, total: 2, percent: 50 },
    branches: { covered: 1, total: 4, percent: 25 }
  };

  function seedSnapshot(repositoryId: string, appName = "Web") {
    database.replaceCoverageSnapshot(repositoryId, appName, {
      runId: "run-1",
      resolvedSha: "abc123",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json",
      summary,
      files: [
        coverageFile("src/well-tested.ts", [10, 10], [8, 8]),
        coverageFile("src/partial.ts", [5, 10], [2, 8]),
        coverageFile("src/untested.ts", [0, 20], [0, 12]),
        coverageFile("src/types.ts", [0, 0], [0, 0])
      ]
    });
  }

  it("stores a per-app coverage snapshot and replaces it in place", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);
    seedSnapshot(repository.id, "API");

    const snapshots = database.listCoverageSnapshots(repository.id);
    expect(snapshots.map((snapshot) => snapshot.appName)).toEqual(["API", "Web"]);
    expect(snapshots[0]?.fileCount).toBe(4);
    expect(snapshots[0]?.resolvedSha).toBe("abc123");
    expect(snapshots[0]?.summary.branches).toEqual({ covered: 1, total: 4, percent: 25 });

    database.replaceCoverageSnapshot(repository.id, "Web", {
      runId: "run-2",
      resolvedSha: "def456",
      coverageFormat: "lcov",
      coveragePath: "coverage/lcov.info",
      summary,
      files: [coverageFile("src/only.ts", [1, 2], [1, 2])]
    });

    const replaced = database.listCoverageSnapshots(repository.id);
    expect(replaced).toHaveLength(2);
    const web = replaced.find((snapshot) => snapshot.appName === "Web");
    expect(web?.fileCount).toBe(1);
    expect(web?.resolvedSha).toBe("def456");
    expect(database.queryCoverageFiles(repository.id, { appName: "Web" }).total).toBe(1);
  });

  it("ranks the weakest files first and treats zero-denominator files as unmeasured", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);

    const branches = database.queryCoverageFiles(repository.id, { metric: "branches" });
    expect(branches.files.map((file) => file.path)).toEqual([
      "src/untested.ts",
      "src/partial.ts",
      "src/well-tested.ts",
      "src/types.ts"
    ]);
    expect(branches.files[0]?.branches?.percent).toBe(0);
    // A file with a zero denominator has no measurable coverage and sorts last.
    expect(branches.files[3]?.branches?.percent).toBeNull();

    const belowHalf = database.queryCoverageFiles(repository.id, { metric: "branches", maxPercent: 50 });
    expect(belowHalf.files.map((file) => file.path)).toEqual(["src/untested.ts", "src/partial.ts"]);
    expect(belowHalf.total).toBe(2);

    const zeroOnly = database.queryCoverageFiles(repository.id, { metric: "branches", maxPercent: 0 });
    expect(zeroOnly.files.map((file) => file.path)).toEqual(["src/untested.ts"]);
  });

  it("filters by path and pages through results", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);

    expect(database.queryCoverageFiles(repository.id, { search: "untested" }).files).toHaveLength(1);
    expect(database.queryCoverageFiles(repository.id, { search: "src/" }).total).toBe(4);
    expect(database.queryCoverageFiles(repository.id, { search: "%" }).total).toBe(0);

    const firstPage = database.queryCoverageFiles(repository.id, { metric: "branches", limit: 2 });
    expect(firstPage.files).toHaveLength(2);
    expect(firstPage.total).toBe(4);

    const secondPage = database.queryCoverageFiles(repository.id, { metric: "branches", limit: 2, offset: 2 });
    expect(secondPage.files.map((file) => file.path)).toEqual(["src/well-tested.ts", "src/types.ts"]);
  });

  it("keeps the snapshot when the run that produced it is pruned from history", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.updateRun(run.id, { status: "passed", finished: true });
    database.replaceCoverageSnapshot(repository.id, "Web", {
      runId: run.id,
      resolvedSha: "abc123",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json",
      summary,
      files: [coverageFile("src/only.ts", [1, 2], [1, 2])]
    });

    expect(database.pruneRuns(repository.id, 0)).toContain(run.id);
    expect(database.getRun(run.id)).toBeNull();

    const snapshots = database.listCoverageSnapshots(repository.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.runId).toBe(run.id);
    expect(database.queryCoverageFiles(repository.id).total).toBe(1);
  });

  it("removes snapshots when the repository is deleted", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);
    database.deleteRepository(repository.id);
    expect(database.listCoverageSnapshots(repository.id)).toHaveLength(0);
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM coverage_files").get()
    ).toEqual({ count: 0 });
  });

  it("stops a queued run outright without marking it failed", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");

    expect(database.requestRunCancellation(run.id)).toBe("stopped");

    const stopped = database.getRun(run.id);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.cancelRequested).toBe(true);
    expect(stopped?.finishedAt).not.toBeNull();
    expect(stopped?.appRuns.every((app) => app.status === "skipped")).toBe(true);
    // The repository is free again immediately.
    expect(() => database.createRun(repository.id, "main")).not.toThrow();
  });

  it("flags a claimed run for the worker rather than ending it directly", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.claimNextRun();

    expect(database.isCancellationRequested(run.id)).toBe(false);
    expect(database.requestRunCancellation(run.id)).toBe("requested");
    expect(database.isCancellationRequested(run.id)).toBe(true);

    // Still active: only the worker may move a claimed run to a terminal state.
    const claimed = database.getRun(run.id);
    expect(claimed?.status).toBe("cloning");
    expect(claimed?.finishedAt).toBeNull();
  });

  it("reports runs that cannot be stopped", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.updateRun(run.id, { status: "passed", finished: true });

    expect(database.requestRunCancellation(run.id)).toBe("already_finished");
    expect(database.requestRunCancellation("missing-run")).toBe("not_found");
    expect(database.getRun(run.id)?.status).toBe("passed");
  });
});
