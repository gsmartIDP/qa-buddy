import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveLocalWorkingTree, auditCheckoutSecrets, resolveLocalRepositoryPath } from "./git.js";
import { RunLogger } from "./logger.js";

let root = "";
let dataDirectory = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "QA Buddy",
      GIT_AUTHOR_EMAIL: "qa@example.com",
      GIT_COMMITTER_NAME: "QA Buddy",
      GIT_COMMITTER_EMAIL: "qa@example.com"
    }
  });
}

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function makeRepository(name: string): string {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  write(path.join(directory, ".gitignore"), ".env\nnode_modules/\ncoverage/\n");
  write(path.join(directory, "src/index.js"), "export const value = 1;\n");
  write(path.join(directory, "keep.txt"), "committed\n");
  write(path.join(directory, ".env.example"), "TOKEN=replace-me\n");
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", "initial");
  return directory;
}

function archive(localPath: string) {
  const runDirectory = path.join(root, "run", localPath);
  const logger = new RunLogger(dataDirectory, `run-${localPath}`, []);
  return {
    logger,
    result: archiveLocalWorkingTree({
      localSourceDirectory: root,
      localPath,
      runDirectory,
      logger,
      timeoutMs: () => 30_000
    })
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "qa-buddy-local-"));
  dataDirectory = mkdtempSync(path.join(tmpdir(), "qa-buddy-logs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("local checkout path resolution", () => {
  it("accepts a path inside the mounted source directory", () => {
    expect(resolveLocalRepositoryPath("/local-source", "my-repo")).toBe("/local-source/my-repo");
    expect(resolveLocalRepositoryPath("/local-source", "group/my-repo")).toBe("/local-source/group/my-repo");
  });

  it.each(["../escape", "nested/../../escape", "/etc"])("rejects %s", (localPath) => {
    expect(() => resolveLocalRepositoryPath("/local-source", localPath)).toThrow(
      "escaped the mounted source directory"
    );
  });
});

describe("committed credential audit", () => {
  it("reports credential-shaped files without deleting any of them", () => {
    const directory = path.join(root, "checkout");
    write(path.join(directory, ".env"), "SECRET=1\n");
    write(path.join(directory, ".env.test"), "JWT_TOKEN=test-value\n");
    write(path.join(directory, ".env.example"), "SECRET=replace-me\n");
    write(path.join(directory, "fixtures/test.key"), "not-really-a-key\n");
    write(path.join(directory, "src/app.js"), "export const a = 1;\n");

    const logger = new RunLogger(dataDirectory, "audit", []);
    const warnings = auditCheckoutSecrets(directory, logger);

    // Tracked files are never removed; a local run must match a GitHub run.
    expect(existsSync(path.join(directory, ".env"))).toBe(true);
    expect(existsSync(path.join(directory, ".env.test"))).toBe(true);
    expect(existsSync(path.join(directory, ".env.example"))).toBe(true);
    expect(existsSync(path.join(directory, "fixtures/test.key"))).toBe(true);
    expect(existsSync(path.join(directory, "src/app.js"))).toBe(true);

    expect(warnings).toBe(3);
    const log = readFileSync(logger.filePath, "utf8");
    expect(log).toContain(".env.test");
    expect(log).toContain("committed to this repository");
    // Example files are not credentials.
    expect(log).not.toContain(".env.example");
  });
});

describe("archiving a local working tree", () => {
  it("reports a clean tree and copies the committed files", async () => {
    makeRepository("clean");
    const { result } = archive("clean");
    const { repositoryDirectory, resolvedSha, dirty } = await result;

    expect(dirty).toBe(false);
    expect(resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(path.join(repositoryDirectory, "keep.txt"), "utf8")).toBe("committed\n");
    expect(readFileSync(path.join(repositoryDirectory, "src/index.js"), "utf8")).toBe("export const value = 1;\n");
  });

  it("includes uncommitted edits, new files, and deletions", async () => {
    const source = makeRepository("dirty");
    write(path.join(source, "src/index.js"), "export const value = 2;\n");
    write(path.join(source, "src/added.spec.js"), "it('works', () => {});\n");
    rmSync(path.join(source, "keep.txt"));

    const { result } = archive("dirty");
    const { repositoryDirectory, dirty } = await result;

    expect(dirty).toBe(true);
    expect(readFileSync(path.join(repositoryDirectory, "src/index.js"), "utf8")).toBe("export const value = 2;\n");
    expect(existsSync(path.join(repositoryDirectory, "src/added.spec.js"))).toBe(true);
    expect(existsSync(path.join(repositoryDirectory, "keep.txt"))).toBe(false);
  });

  it("never copies gitignored files such as .env or node_modules", async () => {
    const source = makeRepository("ignored");
    write(path.join(source, ".env"), "DATABASE_URL=postgres://secret\n");
    write(path.join(source, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
    write(path.join(source, "coverage/coverage-summary.json"), "{}\n");

    const { result } = archive("ignored");
    const { repositoryDirectory } = await result;

    expect(existsSync(path.join(repositoryDirectory, ".env"))).toBe(false);
    expect(existsSync(path.join(repositoryDirectory, "node_modules"))).toBe(false);
    expect(existsSync(path.join(repositoryDirectory, "coverage"))).toBe(false);
    expect(existsSync(path.join(repositoryDirectory, ".env.example"))).toBe(true);
  });

  it("skips an uncommitted environment file that is not gitignored", async () => {
    const source = makeRepository("untracked-env");
    write(path.join(source, "apps/web/.env.local"), "SECRET=leaked\n");

    const { logger, result } = archive("untracked-env");
    const { repositoryDirectory } = await result;

    expect(existsSync(path.join(repositoryDirectory, "apps/web/.env.local"))).toBe(false);
    expect(readFileSync(logger.filePath, "utf8")).toContain("Skipped uncommitted environment file");
  });

  it("leaves the source checkout untouched", async () => {
    const source = makeRepository("readonly");
    write(path.join(source, "src/index.js"), "export const value = 3;\n");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });

    await archive("readonly").result;

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });
    expect(after).toBe(before);
    expect(existsSync(path.join(source, "source.tar"))).toBe(false);
  });

  it("fails with an actionable message when the path is not a checkout", async () => {
    mkdirSync(path.join(root, "not-a-repo"), { recursive: true });
    await expect(archive("not-a-repo").result).rejects.toThrow("No Git checkout found at not-a-repo");
  });

  it("keeps a committed .env.test so local runs match a run off main", async () => {
    const source = makeRepository("committed-env");
    write(path.join(source, ".env.test"), "JWT_TOKEN=test-value\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "add test env");

    const { result } = archive("committed-env");
    const { repositoryDirectory } = await result;

    expect(readFileSync(path.join(repositoryDirectory, ".env.test"), "utf8")).toBe("JWT_TOKEN=test-value\n");
  });
});
