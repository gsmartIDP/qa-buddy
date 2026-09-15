import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { RunLogger } from "./logger.js";
import { ProcessError, runProcess } from "./process.js";

function tokenPreview(token: string): string {
  return token.length > 10 ? `${token.slice(0, 10)}********` : "[REDACTED]";
}

export function githubAuthenticationMessage(token?: string): string {
  if (!token) {
    return "GitHub authentication: not configured; clone access is limited to public repositories";
  }
  return `GitHub authentication: GITHUB_TOKEN is configured (${tokenPreview(token)})`;
}

export function githubRegistryAuthenticationMessage(token?: string): string {
  return token
    ? `Package registry authentication: GITHUB_IDP_REGISTRY is configured (${tokenPreview(token)})`
    : "Package registry authentication: GITHUB_IDP_REGISTRY is not configured";
}

export function githubFetchFailureMessage(tokenConfigured: boolean): string {
  return tokenConfigured
    ? "GitHub fetch failed. Verify that GITHUB_TOKEN can read this repository and that the requested ref exists"
    : "GitHub fetch failed. This repository may be private; set GITHUB_TOKEN in .env and recreate the worker";
}

export async function cloneRepository(options: {
  githubUrl: string;
  ref: string;
  runDirectory: string;
  githubToken?: string;
  logger: RunLogger;
  timeoutMs: () => number;
}): Promise<{ repositoryDirectory: string; resolvedSha: string }> {
  mkdirSync(options.runDirectory, { recursive: true });
  const repositoryDirectory = path.join(options.runDirectory, "repo");
  mkdirSync(repositoryDirectory, { recursive: true });
  const gitEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0"
  };
  if (options.githubToken) {
    gitEnvironment.GITHUB_TOKEN = options.githubToken;
    gitEnvironment.GIT_ASKPASS = process.env.QA_BUDDY_GIT_ASKPASS ?? "/app/docker/git-askpass.sh";
  }

  await runProcess({
    command: "git",
    args: ["init", "--quiet"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  await runProcess({
    command: "git",
    args: ["remote", "add", "origin", options.githubUrl],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs(),
    display: `git remote add origin ${options.githubUrl}`
  });
  try {
    await runProcess({
      command: "git",
      args: ["fetch", "--depth=1", "origin", options.ref],
      cwd: repositoryDirectory,
      env: gitEnvironment,
      logger: options.logger,
      timeoutMs: options.timeoutMs(),
      display: `git fetch --depth=1 origin ${options.ref}`
    });
  } catch (error) {
    if (error instanceof ProcessError) {
      throw new ProcessError(githubFetchFailureMessage(Boolean(options.githubToken)), error.exitCode);
    }
    throw error;
  }
  await runProcess({
    command: "git",
    args: ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  const revision = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });

  return { repositoryDirectory, resolvedSha: revision.stdout.trim() };
}

/**
 * Basenames that must never reach a runner container. `.env` style files are
 * removed outright; the broader credential patterns only warn, so a legitimate
 * fixture (for example `fixtures/test.key`) is never silently deleted.
 */
const secretFilePatterns: Array<{ pattern: RegExp; action: "remove" | "warn"; label: string }> = [
  { pattern: /^\.env$/i, action: "remove", label: "environment file" },
  { pattern: /^\.env\.(?!example$|sample$|template$|defaults$|dist$)[^.]*$/i, action: "remove", label: "environment file" },
  { pattern: /^\.netrc$/i, action: "remove", label: "netrc credentials" },
  { pattern: /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i, action: "remove", label: "private SSH key" },
  { pattern: /\.(pem|p12|pfx|keystore)$/i, action: "warn", label: "possible certificate or key material" },
  { pattern: /\.key$/i, action: "warn", label: "possible key material" }
];

function classifySecretFile(basename: string): { action: "remove" | "warn"; label: string } | null {
  for (const entry of secretFilePatterns) {
    if (entry.pattern.test(basename)) return { action: entry.action, label: entry.label };
  }
  return null;
}

/**
 * Belt-and-braces sweep over an extracted checkout. `git archive` and
 * `git ls-files --exclude-standard` already exclude ignored files, so this
 * should never remove anything; when it does, the run log says so loudly.
 */
export function sweepSecretFiles(root: string, logger: RunLogger): number {
  let removed = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(absolute);
        continue;
      }
      const match = classifySecretFile(entry.name);
      if (!match) continue;
      const relative = path.relative(root, absolute);
      if (match.action === "remove") {
        rmSync(absolute, { force: true });
        removed += 1;
        logger.line(`Removed ${match.label} from the checkout before running tests: ${relative}`);
      } else {
        logger.line(`Warning: ${match.label} is tracked in this repository and was passed to the runner: ${relative}`);
      }
    }
  };
  walk(root);
  return removed;
}

export function resolveLocalRepositoryPath(localSourceDirectory: string, localPath: string): string {
  const root = path.resolve(localSourceDirectory);
  const resolved = path.resolve(root, localPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Local checkout path escaped the mounted source directory");
  }
  return resolved;
}

/**
 * Materializes the host checkout into the run workspace without writing to it.
 *
 * `git archive HEAD` provides the committed tree, then modified and untracked
 * files are overlaid and deleted files removed, so uncommitted work is included
 * while gitignored files (`.env`, `node_modules`, build output) never are.
 */
export async function archiveLocalWorkingTree(options: {
  localSourceDirectory: string;
  localPath: string;
  runDirectory: string;
  logger: RunLogger;
  timeoutMs: () => number;
}): Promise<{ repositoryDirectory: string; resolvedSha: string; dirty: boolean }> {
  const sourceDirectory = resolveLocalRepositoryPath(options.localSourceDirectory, options.localPath);
  if (!existsSync(path.join(sourceDirectory, ".git"))) {
    throw new Error(
      `No Git checkout found at ${options.localPath} inside the mounted source directory. Check QA_BUDDY_LOCAL_SOURCE_ROOT and the repository's local checkout path.`
    );
  }

  mkdirSync(options.runDirectory, { recursive: true });
  const repositoryDirectory = path.join(options.runDirectory, "repo");
  mkdirSync(repositoryDirectory, { recursive: true });
  const archivePath = path.join(options.runDirectory, "source.tar");

  options.logger.line(`Archiving local working tree from ${options.localPath}`);

  const revision = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: sourceDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  const resolvedSha = revision.stdout.trim();

  // Writes the tar to the run workspace; the source mount stays read-only.
  await runProcess({
    command: "git",
    args: ["archive", "--format=tar", "-o", archivePath, "HEAD"],
    cwd: sourceDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  await runProcess({
    command: "tar",
    args: ["-x", "-f", archivePath, "-C", repositoryDirectory],
    cwd: options.runDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  rmSync(archivePath, { force: true });

  const deleted = await listFiles(sourceDirectory, ["ls-files", "-z", "--deleted"], options);
  const deletedSet = new Set(deleted);
  // --modified covers tracked edits, --others plus --exclude-standard covers new
  // files while still honouring .gitignore.
  const changed = await listFiles(
    sourceDirectory,
    ["ls-files", "-z", "--modified", "--others", "--exclude-standard"],
    options
  );

  let copied = 0;
  let skipped = 0;
  for (const relative of changed) {
    if (deletedSet.has(relative)) continue;
    const destination = safeJoin(repositoryDirectory, relative);
    if (!destination) {
      options.logger.line(`Skipped a working-tree path that escaped the checkout: ${relative}`);
      continue;
    }
    const match = classifySecretFile(path.basename(relative));
    if (match?.action === "remove") {
      skipped += 1;
      options.logger.line(`Skipped uncommitted ${match.label}: ${relative}`);
      continue;
    }
    const source = path.join(sourceDirectory, relative);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied += 1;
  }

  let removed = 0;
  for (const relative of deletedSet) {
    const destination = safeJoin(repositoryDirectory, relative);
    if (!destination || !existsSync(destination)) continue;
    rmSync(destination, { force: true });
    removed += 1;
  }

  const dirty = copied > 0 || removed > 0;
  options.logger.line(
    dirty
      ? `Applied uncommitted changes: ${copied} added or modified, ${removed} deleted${skipped ? `, ${skipped} skipped as sensitive` : ""}`
      : "Local working tree is clean; the checkout matches HEAD"
  );

  const sweptCount = sweepSecretFiles(repositoryDirectory, options.logger);
  if (sweptCount > 0) {
    options.logger.line(`Removed ${sweptCount} tracked sensitive file(s) before starting the runner`);
  }

  return { repositoryDirectory, resolvedSha, dirty };
}

function safeJoin(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

async function listFiles(
  cwd: string,
  args: string[],
  options: { logger: RunLogger; timeoutMs: () => number }
): Promise<string[]> {
  // NUL-separated output must not reach the run log, which is streamed as text.
  const result = await runProcess({
    command: "git",
    args,
    cwd,
    logger: options.logger,
    timeoutMs: options.timeoutMs(),
    quiet: true
  });
  return result.stdout.split("\0").filter((value) => value.length > 0);
}
