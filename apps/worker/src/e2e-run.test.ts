import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import type { RepositoryInput } from "@qa-buddy/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyWorker } from "./worker.js";

let directory = "";
let sourceRoot = "";
let database: QaBuddyDatabase;
let worker: QaBuddyWorker;

const junitReport = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="2" failures="1">
  <testsuite name="App Load" tests="2" failures="1">
    <testcase name="App Load loads" classname="loads" time="4.0"/>
    <testcase name="App Load signs in" classname="signs in" time="2.0">
      <failure message="Timed out">Expected element</failure>
    </testcase>
  </testsuite>
</testsuites>`;

/** Records the image it was asked for and runs every exec successfully. */
function fakeDocker(onExec: () => void): { docker: Docker; image: () => string } {
  let requestedImage = "";
  const container = {
    start: async () => undefined,
    exec: async () => ({
      start: async () => {
        onExec();
        const stream = new PassThrough();
        stream.resume();
        stream.end();
        return stream;
      },
      inspect: async () => ({ ExitCode: 0 })
    }),
    kill: async () => undefined,
    remove: async () => undefined
  };
  const docker = {
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (config: { Image: string }) => {
      requestedImage = config.Image;
      return container;
    },
    getContainer: () => container,
    modem: { demuxStream: () => undefined, followProgress: () => undefined }
  };
  return { docker: docker as unknown as Docker, image: () => requestedImage };
}

function makeLocalRepository(): void {
  const repository = path.join(sourceRoot, "platform");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "src/index.js"), "export const value = 1;\n", "utf8");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "QA Buddy",
    GIT_AUTHOR_EMAIL: "qa@example.com",
    GIT_COMMITTER_NAME: "QA Buddy",
    GIT_COMMITTER_EMAIL: "qa@example.com"
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository, env });
  execFileSync("git", ["add", "-A"], { cwd: repository, env });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository, env });
}

const repositoryInput: RepositoryInput = {
  name: "Platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  localPath: "platform",
  additionalWorkspaces: [],
  runnerImage: "node:22-bookworm",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: false,
  apps: [
    {
      name: "Unit",
      workingDirectory: ".",
      testCommand: "pnpm test",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json"
    }
  ],
  e2e: {
    enabled: true,
    runnerImage: "cypress/included:15.8.2",
    timeoutMinutes: 90,
    environmentAllowlist: [],
    apps: [
      {
        name: "idinspect smoke",
        workingDirectory: ".",
        testCommand: "pnpm cy:smoke",
        reportGlob: "results/*.xml",
        artifactGlobs: []
      }
    ]
  }
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-e2e-"));
  sourceRoot = mkdtempSync(path.join(tmpdir(), "qa-buddy-e2e-src-"));
  database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  makeLocalRepository();
});

afterEach(async () => {
  await worker?.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("an end-to-end run", () => {
  it("uses the e2e image and reports JUnit results without needing coverage", async () => {
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true, "e2e");

    const { docker, image } = fakeDocker(() => {
      const results = path.join(directory, "workspaces", run.id, "repo", "results");
      mkdirSync(results, { recursive: true });
      writeFileSync(path.join(results, "app.load.xml"), junitReport, "utf8");
    });

    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      runType: "e2e"
    });
    void worker.run();

    await waitFor(
      () => ["passed", "failed"].includes(database.getRun(run.id)?.status ?? ""),
      "the run to finish"
    );

    // The browser image, not the unit one.
    expect(image()).toBe("cypress/included:15.8.2");

    const finished = database.getRun(run.id);
    const appRun = finished?.appRuns[0];
    expect(appRun?.status).toBe("passed");
    expect(appRun?.coverage).toBeNull();
    expect(appRun?.coverageError).toBeNull();
    expect(appRun?.testResults?.total).toBe(2);
    expect(appRun?.testResults?.passed).toBe(1);
    expect(appRun?.testResults?.failed).toBe(1);
    // Coverage snapshots belong to unit runs only.
    expect(database.listCoverageSnapshots(repository.id)).toEqual([]);
  });

  it("fails the suite when no JUnit report is produced", async () => {
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true, "e2e");

    const { docker } = fakeDocker(() => undefined);
    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      runType: "e2e"
    });
    void worker.run();

    await waitFor(() => database.getRun(run.id)?.status === "failed", "the run to fail");
    // The command succeeded here, so the missing report is the whole story.
    expect(database.getRun(run.id)?.appRuns[0]?.coverageError).toContain("No JUnit report matched");
  });

  it("ignores a queued unit run", async () => {
    const repository = database.createRepository(repositoryInput);
    const unit = database.createRun(repository.id, "main");

    const { docker } = fakeDocker(() => undefined);
    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      runType: "e2e"
    });
    void worker.run();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(database.getRun(unit.id)?.status).toBe("queued");
  });

  it("keeps configured artifacts after the checkout is deleted", async () => {
    const withArtifacts: RepositoryInput = {
      ...repositoryInput,
      e2e: {
        ...repositoryInput.e2e,
        apps: [{ ...repositoryInput.e2e.apps[0]!, artifactGlobs: ["cypress/screenshots/**"] }]
      }
    };
    const repository = database.createRepository(withArtifacts);
    const run = database.createRun(repository.id, "main", undefined, true, "e2e");

    const { docker } = fakeDocker(() => {
      const checkout = path.join(directory, "workspaces", run.id, "repo");
      mkdirSync(path.join(checkout, "results"), { recursive: true });
      writeFileSync(path.join(checkout, "results/app.load.xml"), junitReport, "utf8");
      mkdirSync(path.join(checkout, "cypress/screenshots/app.load.cy.js"), { recursive: true });
      writeFileSync(
        path.join(checkout, "cypress/screenshots/app.load.cy.js/failed.png"),
        "screenshot-bytes",
        "utf8"
      );
    });

    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      runType: "e2e"
    });
    void worker.run();

    await waitFor(
      () => ["passed", "failed"].includes(database.getRun(run.id)?.status ?? ""),
      "the run to finish"
    );

    // The checkout is gone, which is exactly why artifacts had to be copied out.
    expect(existsSync(path.join(directory, "workspaces", run.id))).toBe(false);

    const kept = path.join(
      directory,
      "artifacts",
      run.id,
      encodeURIComponent("idinspect smoke"),
      "cypress/screenshots/app.load.cy.js/failed.png"
    );
    expect(readFileSync(kept, "utf8")).toBe("screenshot-bytes");
  });

  it("removes artifacts when the run is pruned from history", async () => {
    const withArtifacts: RepositoryInput = {
      ...repositoryInput,
      e2e: {
        ...repositoryInput.e2e,
        apps: [{ ...repositoryInput.e2e.apps[0]!, artifactGlobs: ["cypress/screenshots/**"] }]
      }
    };
    const repository = database.createRepository(withArtifacts);
    const run = database.createRun(repository.id, "main", undefined, true, "e2e");

    const { docker } = fakeDocker(() => {
      const checkout = path.join(directory, "workspaces", run.id, "repo");
      mkdirSync(path.join(checkout, "results"), { recursive: true });
      writeFileSync(path.join(checkout, "results/app.load.xml"), junitReport, "utf8");
      mkdirSync(path.join(checkout, "cypress/screenshots"), { recursive: true });
      writeFileSync(path.join(checkout, "cypress/screenshots/failed.png"), "bytes", "utf8");
    });

    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      // Retain nothing, so this run is pruned as soon as it finishes.
      historyLimit: 0,
      pollIntervalMs: 10,
      runType: "e2e"
    });
    void worker.run();

    await waitFor(() => database.getRun(run.id) === null, "the run to be pruned");
    expect(existsSync(path.join(directory, "artifacts", run.id))).toBe(false);
  });
});
