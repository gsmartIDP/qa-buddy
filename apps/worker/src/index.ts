import { existsSync } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { QaBuddyWorker } from "./worker.js";
import { githubAuthenticationMessage, githubRegistryAuthenticationMessage } from "./git.js";

const dataDirectory = process.env.QA_BUDDY_DATA_DIR ?? path.resolve("data");
const workspaceDirectory = process.env.QA_BUDDY_WORKSPACE_DIR ?? path.resolve("workspaces");
const databasePath = process.env.QA_BUDDY_DATABASE_PATH ?? path.join(dataDirectory, "qa-buddy.sqlite");
const historyLimit = Math.max(1, Number(process.env.RUN_HISTORY_LIMIT ?? 20));
const localSourceMount = process.env.QA_BUDDY_LOCAL_SOURCE_DIR ?? "/local-source";
// One worker per lane: the default serves unit runs, a second serves e2e.
const runType = process.env.QA_BUDDY_RUN_TYPE === "e2e" ? "e2e" : "unit";
const githubToken = process.env.GITHUB_TOKEN || undefined;
// Compose always mounts something at /local-source, so the opt-in is the
// QA_BUDDY_LOCAL_SOURCE_ROOT value in .env rather than the mount's existence.
const localSourceDirectory =
  process.env.QA_BUDDY_LOCAL_SOURCE_ROOT && existsSync(localSourceMount) ? localSourceMount : undefined;

const database = new QaBuddyDatabase(databasePath);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const worker = new QaBuddyWorker({
  database,
  docker,
  dataDirectory,
  workspaceDirectory,
  workspaceVolume: process.env.QA_BUDDY_WORKSPACE_VOLUME ?? "qa-buddy-workspaces",
  localSourceDirectory,
  githubToken,
  historyLimit,
  runType
});

const shutdown = async (): Promise<void> => {
  await worker.stop();
  database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  console.info(`Worker lane: ${runType} runs`);
  console.info(githubAuthenticationMessage(githubToken));
  console.info(githubRegistryAuthenticationMessage(process.env.GITHUB_IDP_REGISTRY));
  console.info(
    localSourceDirectory
      ? `Local working tree runs: enabled from ${localSourceDirectory}`
      : "Local working tree runs: disabled; set QA_BUDDY_LOCAL_SOURCE_ROOT in .env and recreate the worker"
  );
  await worker.run();
} catch (error) {
  console.error(error);
  database.close();
  process.exit(1);
}
