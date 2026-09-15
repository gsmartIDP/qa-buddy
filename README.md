# QA Buddy

QA Buddy is a local dashboard for running trusted GitHub repository test suites in disposable Docker containers and tracking coverage for every configured app. Single-app repositories and monorepos use the same model: a repository contains one or more explicit app configurations.

## Start QA Buddy

Requirements:

- Docker Desktop or Docker Engine with Compose.
- Port `3003` available on the host.

```bash
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3003](http://localhost:3003). Configuration, run summaries, and logs persist in the `qa-buddy-data` Docker volume. Fresh checkouts use `qa-buddy-workspaces` and are removed after every run.

Compose bind-mounts the QA Buddy source and watches it inside each service. Changes under the server, worker, web, database, or shared source directories are rebuilt automatically and the affected service is restarted; refresh the browser to load an updated dashboard bundle. You only need `docker compose up --build -d --force-recreate` after changing dependencies, package manifests, the Dockerfile, Compose configuration, or the development watcher itself.

The `.env` file is optional for public repositories. For a private repository, create a fine-grained GitHub personal access token scoped only to the required repository, with **Contents: read-only**, and add it locally:

```dotenv
GITHUB_TOKEN=github_pat_your_token_here
```

Then apply it to the worker:

```bash
docker compose up -d --force-recreate worker
```

The Docker worker reads `GITHUB_TOKEN` from `.env`; a token exported in the shell running Compose does not override it. After changing or removing the token in `.env`, recreate the worker with the command above. Restarting an existing container does not reload its environment. Startup and run logs show the first 10 token characters followed by `********` so you can identify the configured token; tokens of 10 characters or fewer are fully redacted. QA Buddy passes the token to Git through a non-interactive askpass helper; the full token is not stored in SQLite, embedded in repository URLs, sent to runner containers, or written to logs. If the organization requires approval or SSO authorization for tokens, complete that in GitHub before running the repository.

## Configure a repository

Repository configuration includes:

- A GitHub HTTPS URL and default branch, tag, or commit SHA.
- An optional local checkout path for running against your own working tree.
- A runner image that provides `/bin/sh` and the required language tools.
- An optional setup command that runs once at the repository root.
- An optional build-command override that runs once after setup and before any selected app tests.
- A per-app test-worker limit, defaulting to `2`, for auto-detected Jest and Vitest commands. Parallel Jest workers are recycled after 1 GiB so long suites cannot grow a worker until Node exhausts its heap; scripts already using `--runInBand` keep their intentional serial execution.
- A timeout from 1 to 120 minutes.
- Optional environment variable names to pass from the worker to the runner.
- Automatic pnpm/Turborepo app detection, or one or more manually configured apps.

### Automatic pnpm/Turborepo detection

Enable **Auto-detect pnpm/Turborepo apps** when the repository has a root `pnpm-workspace.yaml`. On every fresh clone, QA Buddy:

1. Expands the workspace package globs without following symlinks outside the checkout.
2. Prioritizes workspaces under `apps/`; if there is no `apps/` group, it considers all workspaces.
3. Reads each workspace `package.json` and selects `test:coverage`, then `test:cov`, `coverage`, and finally `test` in that order.
4. Runs the selected script from that app's workspace directory.
5. Adds Jest or Vitest's JSON test reporter, requires an Istanbul-compatible JSON coverage summary for both runners, and records exact passed, failed, skipped, and todo test cases.
6. Limits parallel Jest and Vitest workers to the configured per-app value, preserves serial Jest scripts, uses version-compatible Vitest worker flags, and ignores compiled `dist` output during Jest coverage collection.
7. Clears that app's old structured-test and coverage files before execution, then discovers newly generated `coverage/coverage-summary.json` or `coverage/lcov.info`, including repository-root `coverage/apps/...` layouts and both JSON/LCOV files in safe shared Jest `coverageDirectory` values from package.json. This prevents a failed app from inheriting another app's shared or stale report.

The presence of `turbo.json` is reported in the run log, but pnpm workspace configuration remains the source of truth for app directories. Workspaces without a supported test script are ignored. Detection fails with an actionable error when no testable apps are found.

The form suggests `corepack enable && pnpm install --frozen-lockfile` as the setup command and `pnpm build` as the build command when auto-detection is enabled. A build failure skips all app tests so tests never run against missing workspace artifacts. Adjust either command when the repository uses a different bootstrap or build entry point.

Example for a single Node app:

```text
Runner image:      node:22-bookworm
Setup command:     npm ci
App directory:     .
Test command:      npm test -- --coverage
Coverage format:   Istanbul summary JSON
Coverage path:     coverage/coverage-summary.json
```

For a pnpm monorepo that does not follow these conventions, leave auto-detection off and add one app entry per workspace with an explicit command and report path.

Supported coverage inputs:

- `coverage-summary.json` generated by Istanbul-compatible tools. Lines, statements, functions, and branches are shown.
- LCOV. Lines, functions, and branches are shown; statements are `N/A` because LCOV does not define a separate statement metric.

A run passes only when every app test exits successfully and every configured coverage report is present and valid. Coverage is still parsed after a failing test command when the report exists. Apps later in a monorepo continue after an earlier app fails.

From the repository detail page, a multi-app run can target any subset of the configured or most recently detected apps. Use **Select failed** to quickly rerun only applications that failed the latest run. The selected app names are retained with the run, and auto-detected selections are checked again after cloning the requested ref. Run all apps once before using per-app selection on a newly configured auto-detected repository.

The run detail page provides an expandable test-case readout for auto-detected Jest and Vitest apps. It records test names, source test files, durations, statuses, and bounded failure messages. For a manually configured command, QA Buddy will also consume a Jest-compatible JSON report written to `.qa-buddy-test-results.json` in the app working directory. Other test runners continue to use the full redacted log as their detailed readout.

## Run against a local working tree

By default every run fetches a fresh shallow clone from GitHub, so only pushed commits are visible. To test uncommitted work, point QA Buddy at your own checkout.

Set the directory that holds your repositories in `.env`:

```dotenv
QA_BUDDY_LOCAL_SOURCE_ROOT=/Users/you/Repositories
```

Then recreate the worker so it picks up the new mount:

```bash
docker compose up -d --force-recreate worker
```

You will need to edit/add the local name of this repo into the `Section 01` of the Configuration for the repo. You will not see the local run checkbox without this in the Config, and it will fail completely if you dont had the `QA_BUDDY_LOCAL_SOURCE_ROOT` in your env file

Compose bind-mounts that directory read-only at `/local-source`. Add the repository's subdirectory name to its **Local checkout path** field (for example `platform` for `/Users/you/Repositories/platform`), and a **Run against my local working tree** checkbox appears on the repository page. The saved default ref is still used for every ordinary run; the checkbox is a per-run choice and does not change it.

QA Buddy builds the checkout with `git archive HEAD`, then overlays modified and untracked files and removes deleted ones, so uncommitted work is included while the source checkout is never written to. Because the file set comes from Git:

- Gitignored files never reach the runner. That includes `.env`, `node_modules`, and build output. Host `node_modules` would be the wrong platform for a Linux runner anyway, so setup still installs dependencies inside the container.
- A file you have created but not yet `git add`ed is included, because untracked files that are not ignored are copied. Files excluded by `.gitignore` are not.
- As a second line of defence, `.env` style files and private SSH keys are removed from the checkout even if they are committed, and certificate or key material is reported in the run log. `.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, and `.env.dist` are kept.

Runs against a local working tree record the `HEAD` commit and are marked dirty when uncommitted changes were applied, so they are never mistaken for a reproducible run. The run history shows `local working tree` in place of the ref and appends `+dirty` to the commit.

Local runs are for iterating before you push. Anything you intend to keep should still be pushed and run against its branch.

## Environment pass-through

Values belong in `.env`, not in the dashboard. Add only their names to a repository's environment allowlist. The worker reads those values and passes only the selected variables into that repository's runner. Values are redacted from logs.

`GITHUB_TOKEN` is reserved for cloning and is rejected from runner allowlists. Use a separate, narrowly scoped package token such as `NPM_TOKEN` when tests need private packages.

If a repository's `.npmrc` references a named variable, put that variable in `.env` and add only its name to the repository's environment allowlist. For example, ID Plans uses `GITHUB_IDP_REGISTRY`. The Docker worker reads this token from `.env`, ignoring shell overrides, and displays its first 10 characters followed by `********` in startup and run logs (short tokens are fully redacted). Recreate the worker after changing it. Run logs also indicate when the token is not allowlisted for that repository. GitHub's npm package registry currently requires a personal access token (classic) with at least `read:packages`; keep this package token separate from the repository clone token.

If `GITHUB_IDP_REGISTRY` is used, you will need to include it in the `Allowed environment variable names` field of #2 Runner section.

The Build command override may be required for some apps where the default cannot be completed. As an example, with sub-applications pdf/renderer that cannot build correctly, you can use this override: `pnpm exec turbo run build --concurrency=2 --filter=!pdf --filter=!renderer` to ommit them and have the tool build correctly.

## Coverage gaps

Every run that uses a GitHub ref records a per-file coverage snapshot for each app that produced a report. Open **Coverage gaps** from the repository page to rank files by their weakest metric.

Snapshots are deliberately not part of run history:

- One snapshot per app, replaced in place. Storing per-file coverage for every retained run would keep twenty near-identical copies of the same data.
- They survive run history pruning. The run that produced a snapshot can age out of the latest 20 without taking the snapshot with it; the recorded commit still says where it came from.
- **Local working tree runs never overwrite a snapshot.** An uncommitted checkout is not reproducible, so it cannot replace a baseline captured from a commit that exists on the remote. The run log says when a snapshot was skipped for this reason.

The view ranks by branch coverage by default, because branches are where untested edge cases hide. Filter by app, metric, threshold, or path fragment. Files with a zero denominator, such as a types-only module with no executable branches, have no measurable coverage and sort last rather than appearing as 0%.

Istanbul summary reports provide lines, statements, functions, and branches per file. LCOV provides lines, functions, and branches; statements are `N/A` because LCOV does not define a separate statement metric.

Coverage percentage identifies lines that never executed, not behaviour that was never considered. A file at 100% line coverage with weak assertions still looks complete here. Treat zero-coverage files and low branch coverage as leads to investigate rather than a finished verdict.

## Architecture and security

Compose runs two services from one image:

- `server` owns the Fastify API, React dashboard, SQLite configuration, history, logs, and port `3003`.
- `worker` claims one queued run at a time, clones the requested ref, starts a disposable runner container, streams its output, parses coverage, and cleans up.

The worker also bind-mounts `QA_BUDDY_LOCAL_SOURCE_ROOT` read-only at `/local-source` when that variable is set. Runner containers never receive that mount; the worker copies the archived checkout into the disposable workspace volume instead.

The worker mounts `/var/run/docker.sock`. Access to that socket is effectively host-level Docker control. QA Buddy is intentionally a trusted, local, single-user tool: do not expose it publicly and do not configure repositories you do not trust. Runner containers do not receive the Docker socket, the persistent data volume, or the GitHub clone token, but repository commands can access the network and the temporary checkout.

## Local development

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm dev` starts the API on `3003`, the worker, and Vite on `5173`. Local worker execution still requires Docker and a workspace volume matching `QA_BUDDY_WORKSPACE_VOLUME`; the Compose flow is the supported end-to-end environment.

The default Compose services run `docker/dev-watch.mjs`, which keeps the port-3003 environment synchronized with ordinary source edits without rebuilding the Docker image manually.

Useful endpoints:

- `GET /api/health`
- `GET|POST /api/repositories`
- `GET|PATCH|DELETE /api/repositories/:repositoryId`
- `POST /api/repositories/:repositoryId/runs`
- `GET /api/repositories/:repositoryId/runs`
- `GET /api/repositories/:repositoryId/coverage` (per-app snapshot metadata)
- `GET /api/repositories/:repositoryId/coverage/files` (ranked per-file coverage; `app`, `metric`, `maxPercent`, `search`, `limit`, `offset`)
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/log` (full redacted log download)
- `GET /api/runs/:runId/events` (server-sent events)

The latest 20 runs per repository are retained by default. Override this with `RUN_HISTORY_LIMIT`.
