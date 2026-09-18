import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactDirectory, collectRunArtifacts, maximumArtifactFilesPerSuite } from "./artifacts.js";
import { RunLogger } from "./logger.js";

let checkout = "";
let dataDirectory = "";

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function collect(globs: string[], appName = "IDI Smoke") {
  const logger = new RunLogger(dataDirectory, `run-${Math.random()}`, []);
  return collectRunArtifacts({
    repositoryDirectory: checkout,
    dataDirectory,
    runId: "run-1",
    appName,
    globs,
    logger
  });
}

beforeEach(() => {
  checkout = mkdtempSync(path.join(tmpdir(), "qa-buddy-checkout-"));
  dataDirectory = mkdtempSync(path.join(tmpdir(), "qa-buddy-data-"));
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("keeping run artifacts", () => {
  it("copies matching files out of the checkout, preserving their paths", async () => {
    write(path.join(checkout, "apps/idinspect/cypress/screenshots/app.load.cy.js/failed.png"), "image");
    write(path.join(checkout, "apps/idinspect/cypress/videos/app.load.cy.js.mp4"), "video");
    write(path.join(checkout, "apps/idinspect/src/index.ts"), "code");

    const result = await collect([
      "apps/idinspect/cypress/screenshots/**",
      "apps/idinspect/cypress/videos/**"
    ]);

    expect(result.files).toHaveLength(2);
    const destination = artifactDirectory(dataDirectory, "run-1", "IDI Smoke");
    expect(
      readFileSync(
        path.join(destination, "apps/idinspect/cypress/screenshots/app.load.cy.js/failed.png"),
        "utf8"
      )
    ).toBe("image");
    // Source files are never swept up by a screenshots glob.
    expect(existsSync(path.join(destination, "apps/idinspect/src/index.ts"))).toBe(false);
  });

  it("survives the checkout being deleted, which is the whole point", async () => {
    write(path.join(checkout, "results/shot.png"), "image");
    await collect(["results/**"]);

    rmSync(checkout, { recursive: true, force: true });

    const destination = artifactDirectory(dataDirectory, "run-1", "IDI Smoke");
    expect(readFileSync(path.join(destination, "results/shot.png"), "utf8")).toBe("image");
  });

  it("keeps each suite's artifacts apart", async () => {
    write(path.join(checkout, "results/shot.png"), "image");
    await collect(["results/**"], "Smoke");
    await collect(["results/**"], "Regression");

    expect(existsSync(path.join(artifactDirectory(dataDirectory, "run-1", "Smoke"), "results/shot.png"))).toBe(true);
    expect(
      existsSync(path.join(artifactDirectory(dataDirectory, "run-1", "Regression"), "results/shot.png"))
    ).toBe(true);
  });

  it("handles a suite name that is not path-safe", async () => {
    write(path.join(checkout, "results/shot.png"), "image");
    const result = await collect(["results/**"], "../escape");

    expect(result.files).toHaveLength(1);
    // Everything stays under the run's own directory.
    const runRoot = artifactDirectory(dataDirectory, "run-1");
    expect(existsSync(path.join(runRoot, encodeURIComponent("../escape"), "results/shot.png"))).toBe(true);
  });

  it("does nothing when no globs are configured", async () => {
    write(path.join(checkout, "results/shot.png"), "image");
    const result = await collect([]);
    expect(result.files).toEqual([]);
    expect(existsSync(artifactDirectory(dataDirectory, "run-1", "IDI Smoke"))).toBe(false);
  });

  it("reports when a glob matches nothing rather than failing", async () => {
    const result = await collect(["cypress/screenshots/**"]);
    expect(result.files).toEqual([]);
  });

  it("stops at the per-suite file cap", async () => {
    for (let index = 0; index < maximumArtifactFilesPerSuite + 10; index += 1) {
      write(path.join(checkout, `results/shot-${index}.png`), "image");
    }
    const result = await collect(["results/**"]);

    expect(result.files).toHaveLength(maximumArtifactFilesPerSuite);
    expect(result.skipped).toBe(10);
  });
});
