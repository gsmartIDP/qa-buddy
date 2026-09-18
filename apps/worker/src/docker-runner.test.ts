import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { DockerRunner } from "./docker-runner.js";
import { RunLogger } from "./logger.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function capturingDocker(): { docker: Docker; config: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (config: Record<string, unknown>) => {
      captured = config;
      return { start: async () => undefined, remove: async () => undefined, kill: async () => undefined };
    },
    modem: { demuxStream: () => undefined, followProgress: () => undefined }
  };
  return { docker: docker as unknown as Docker, config: () => captured };
}

describe("runner container configuration", () => {
  it("clears an image entrypoint so the keep-alive command is what actually runs", async () => {
    const { docker, config } = capturingDocker();
    const logger = new RunLogger(mkdtempSync(path.join(tmpdir(), "qa-buddy-runner-")), "run-1", []);
    const runner = new DockerRunner(docker, {
      runId: "run-1",
      // Cypress images declare ENTRYPOINT ["cypress","run"]; without clearing it
      // Docker prepends that to the keep-alive command and the container dies.
      image: "cypress/included:15.5.0",
      workspaceVolume: "qa-buddy-workspaces",
      workspaceContainerPath: "/workspaces/run-1/repo",
      environment: {},
      logger
    });

    await runner.start(30_000);

    expect(config().Entrypoint).toEqual([""]);
    expect(config().Cmd).toEqual(["/bin/sh", "-lc", "while :; do sleep 3600; done"]);
    expect(config().WorkingDir).toBe("/workspaces/run-1/repo");
  });
});
