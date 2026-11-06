#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearPending, readActiveWork, readPending, recordChange, shouldRestart, writePending } from "./worker-restart.mjs";

const configurations = {
  server: {
    buildFilters: ["@qa-buddy/shared", "@qa-buddy/db", "@qa-buddy/web", "@qa-buddy/server"],
    startScript: "start:server",
    watchPaths: ["packages/shared/src", "packages/db/src", "apps/web/src", "apps/web/index.html", "apps/server/src"]
  },
  worker: {
    buildFilters: ["@qa-buddy/shared", "@qa-buddy/db", "@qa-buddy/worker"],
    startScript: "start:worker",
    watchPaths: ["packages/shared/src", "packages/db/src", "apps/worker/src"]
  }
};

const mode = process.argv[2];
const configuration = configurations[mode];

if (!configuration) {
  console.error("Usage: node docker/dev-watch.mjs <server|worker>");
  process.exit(1);
}

let appProcess;
let buildProcess;
let rebuilding = false;
let rebuildQueued = false;
let shuttingDown = false;
let debounceTimer;
let holdTimer;

// The worker holds restarts while a run or slice build is in progress; see worker-restart.mjs.
const holdsRestarts = mode === "worker";
const dataDirectory = process.env.QA_BUDDY_DATA_DIR ?? path.resolve("data");
const databasePath = process.env.QA_BUDDY_DATABASE_PATH ?? path.join(dataDirectory, "qa-buddy.sqlite");
const HOLD_POLL_MS = 2_000;

function describeWork(work) {
  return work.map((item) => `${item.kind} ${item.id.slice(0, 8)} (${item.repositoryName}, ${item.status})`).join(", ");
}

function releaseHeldRestart(reason) {
  clearInterval(holdTimer);
  holdTimer = undefined;
  clearPending(dataDirectory);
  console.log(`[dev-watch:${mode}] Restarting: ${reason}`);
  void rebuild();
}

function checkHeldRestart() {
  const pending = readPending(dataDirectory);
  const active = readActiveWork(databasePath);
  if (active === null) return releaseHeldRestart("could not read the database to check for active work");
  if (shouldRestart(pending, active)) {
    releaseHeldRestart(pending?.decision === "now" ? "restart requested from the dashboard" : "active work finished");
  }
}

/** Holds the restart when work is in progress. Returns true when held. */
function holdRestart(changedPath) {
  if (!holdsRestarts || !appProcess || appProcess.exitCode !== null) return false;
  const active = readActiveWork(databasePath);
  if (!active?.length) return false;
  const pending = recordChange(readPending(dataDirectory), changedPath);
  writePending(dataDirectory, pending);
  if (!holdTimer) {
    console.log(
      `[dev-watch:${mode}] Source changed while work is in progress: ${describeWork(active)}. ` +
        "Holding the restart until it finishes; restart now from the dashboard banner."
    );
    holdTimer = setInterval(checkHeldRestart, HOLD_POLL_MS);
  }
  return true;
}

function terminateProcessGroup(child, signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null) return;

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function stopApp() {
  const child = appProcess;
  if (!child || child.exitCode !== null) return;

  const exited = waitForExit(child);
  terminateProcessGroup(child);
  await exited;

  if (child.exitCode === null) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 1_000);
  }
}

function runBuild(packageName) {
  return new Promise((resolve) => {
    console.log(`[dev-watch:${mode}] Building ${packageName}`);
    const child = spawn("pnpm", ["--filter", packageName, "build"], {
      detached: true,
      env: process.env,
      stdio: "inherit"
    });
    buildProcess = child;
    child.once("exit", (code, signal) => {
      if (buildProcess === child) buildProcess = undefined;
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

function startApp() {
  if (shuttingDown) return;

  console.log(`[dev-watch:${mode}] Starting ${configuration.startScript}`);
  const child = spawn("pnpm", [configuration.startScript], {
    detached: true,
    env: process.env,
    stdio: "inherit"
  });
  appProcess = child;
  child.once("exit", (code, signal) => {
    if (appProcess === child) appProcess = undefined;
    if (!shuttingDown && !rebuilding && !rebuildQueued) {
      console.error(`[dev-watch:${mode}] Service stopped unexpectedly (${signal ?? `exit ${code ?? 1}`})`);
      process.exit(code ?? 1);
    }
  });
}

async function rebuild() {
  if (rebuilding) {
    rebuildQueued = true;
    return;
  }

  rebuilding = true;
  rebuildQueued = false;
  await stopApp();

  let succeeded = true;
  for (const packageName of configuration.buildFilters) {
    if (shuttingDown) return;
    const exitCode = await runBuild(packageName);
    if (exitCode !== 0) {
      succeeded = false;
      console.error(`[dev-watch:${mode}] Build failed for ${packageName}; waiting for another source change`);
      break;
    }
  }

  rebuilding = false;
  if (succeeded) startApp();

  if (rebuildQueued && !shuttingDown) {
    rebuildQueued = false;
    void rebuild();
  }
}

function scheduleRebuild(changedPath) {
  if (shuttingDown) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[dev-watch:${mode}] Source changed: ${changedPath}`);
    if (holdTimer) {
      writePending(dataDirectory, recordChange(readPending(dataDirectory), changedPath));
      return;
    }
    if (holdRestart(changedPath)) return;
    void rebuild();
  }, 250);
}

for (const watchPath of configuration.watchPaths) {
  const absolutePath = path.resolve(watchPath);
  const watcher = watch(absolutePath, { recursive: true }, (_eventType, filename) => {
    scheduleRebuild(filename ? path.join(watchPath, filename) : watchPath);
  });
  watcher.on("error", (error) => {
    console.error(`[dev-watch:${mode}] Watch error for ${watchPath}:`, error);
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(debounceTimer);
  clearInterval(holdTimer);
  terminateProcessGroup(buildProcess);
  await stopApp();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A restart held by an earlier watcher is moot now that the worker is starting fresh.
if (holdsRestarts) clearPending(dataDirectory);
console.log(`[dev-watch:${mode}] Watching ${configuration.watchPaths.join(", ")}`);
await rebuild();
