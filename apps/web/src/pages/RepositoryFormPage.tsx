import { type FormEvent, useEffect, useState } from "react";
import type { AppInput, Repository, RepositoryInput } from "@qa-buddy/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Loading } from "../components/Loading";

const emptyApp = (): AppInput => ({
  name: "",
  workingDirectory: ".",
  testCommand: "npm test -- --coverage",
  coverageFormat: "istanbul-summary-json",
  coveragePath: "coverage/coverage-summary.json"
});

const initialValue: RepositoryInput = {
  name: "",
  githubUrl: "",
  defaultRef: "main",
  localPath: undefined,
  additionalWorkspaces: [],
  runnerImage: "node:22-bookworm",
  setupCommand: "npm ci",
  buildCommand: undefined,
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: false,
  apps: [emptyApp()],
  e2e: { enabled: false, runnerImage: "", timeoutMinutes: 60, environmentAllowlist: [], apps: [] }
};

export function RepositoryFormPage() {
  const { repositoryId } = useParams();
  const navigate = useNavigate();
  const [value, setValue] = useState<RepositoryInput>(initialValue);
  const [environmentNames, setEnvironmentNames] = useState("");
  const [workspaceNames, setWorkspaceNames] = useState("");
  const [e2eEnvironmentNames, setE2eEnvironmentNames] = useState("");
  const [loading, setLoading] = useState(Boolean(repositoryId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!repositoryId) return;
    api<{ repository: Repository }>(`/api/repositories/${repositoryId}`)
      .then(({ repository }) => {
        setValue({
          name: repository.name,
          githubUrl: repository.githubUrl,
          defaultRef: repository.defaultRef,
          localPath: repository.localPath,
          additionalWorkspaces: repository.additionalWorkspaces ?? [],
          runnerImage: repository.runnerImage,
          setupCommand: repository.setupCommand,
          buildCommand: repository.buildCommand,
          testWorkerLimit: repository.testWorkerLimit,
          timeoutMinutes: repository.timeoutMinutes,
          environmentAllowlist: repository.environmentAllowlist,
          autoDetect: repository.autoDetect,
          e2e: repository.e2e,
          apps: repository.apps.map(({ id: _id, repositoryId: _repositoryId, position: _position, ...app }) => app)
        });
        setEnvironmentNames(repository.environmentAllowlist.join(", "));
        setWorkspaceNames((repository.additionalWorkspaces ?? []).join(", "));
        setE2eEnvironmentNames((repository.e2e?.environmentAllowlist ?? []).join(", "));
      })
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setLoading(false));
  }, [repositoryId]);

  const updateApp = (index: number, patch: Partial<AppInput>) => {
    setValue((current) => ({
      ...current,
      apps: current.apps.map((app, appIndex) => (appIndex === index ? { ...app, ...patch } : app))
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    const input: RepositoryInput = {
      ...value,
      apps: value.autoDetect ? [] : value.apps,
      environmentAllowlist: environmentNames
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      e2e: {
        ...value.e2e,
        environmentAllowlist: e2eEnvironmentNames
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      },
      additionalWorkspaces: value.autoDetect
        ? workspaceNames
            .split(",")
            .map((name) => name.trim().replace(/\/+$/, ""))
            .filter(Boolean)
        : []
    };
    try {
      const response = await api<{ repository: Repository }>(
        repositoryId ? `/api/repositories/${repositoryId}` : "/api/repositories",
        {
          method: repositoryId ? "PATCH" : "POST",
          body: JSON.stringify(input)
        }
      );
      navigate(`/repositories/${response.repository.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save repository");
    } finally {
      setSaving(false);
    }
  };


  const e2e = value.e2e;
  const setE2e = (changes: Partial<RepositoryInput["e2e"]>) =>
    setValue((current) => ({ ...current, e2e: { ...current.e2e, ...changes } }));
  const updateE2eApp = (index: number, changes: Partial<RepositoryInput["e2e"]["apps"][number]>) =>
    setE2e({ apps: e2e.apps.map((app, position) => (position === index ? { ...app, ...changes } : app)) });

  if (loading) return <Loading label="Loading repository configuration…" />;

  return (
    <div className="page page-form">
      <div className="breadcrumbs">
        <Link to="/repositories">Repositories</Link>
        <span>/</span>
        <span>{repositoryId ? "Edit" : "New repository"}</span>
      </div>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>{repositoryId ? "Edit repository" : "Add a repository"}</h1>
          <p>Commands execute inside the runner image you choose. Only configure repositories you trust.</p>
        </div>
      </section>

      <form onSubmit={submit} className="form-stack">
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <section className="panel form-section">
          <div className="section-heading">
            <span className="section-number">01</span>
            <div>
              <h2>Repository</h2>
              <p>GitHub location and the default revision to test.</p>
            </div>
          </div>
          <div className="field-grid two-column">
            <label>
              <span>Name</span>
              <input
                required
                value={value.name}
                onChange={(event) => setValue({ ...value, name: event.target.value })}
                placeholder="Platform web"
              />
            </label>
            <label>
              <span>Default test branch or ref</span>
              <input
                required
                value={value.defaultRef}
                onChange={(event) => setValue({ ...value, defaultRef: event.target.value })}
                placeholder="main"
              />
              <small>Used for new runs unless you choose a different branch, tag, or commit on the repository page.</small>
            </label>
            <label className="field-span">
              <span>GitHub HTTPS URL</span>
              <input
                required
                type="url"
                value={value.githubUrl}
                onChange={(event) => setValue({ ...value, githubUrl: event.target.value })}
                placeholder="https://github.com/owner/repository"
              />
              <small>
                Private repository? Put a read-only fine-grained token in <code>.env</code> as{" "}
                <code>GITHUB_TOKEN</code>, then recreate the worker. Tokens are never entered or stored here.
              </small>
            </label>
            <label className="field-span">
              <span>Local checkout path (optional)</span>
              <input
                value={value.localPath ?? ""}
                onChange={(event) => setValue({ ...value, localPath: event.target.value || undefined })}
                placeholder="my-monorepo"
                autoComplete="off"
              />
              <small>
                Relative to <code>QA_BUDDY_LOCAL_SOURCE_ROOT</code> in <code>.env</code>. Set both to run this
                repository against your own working tree, including uncommitted changes. Gitignored files such as{" "}
                <code>.env</code> and <code>node_modules</code> are never copied into the runner.
              </small>
            </label>
          </div>
        </section>

        <section className="panel form-section">
          <div className="section-heading">
            <span className="section-number">02</span>
            <div>
              <h2>Runner</h2>
              <p>Choose the image, setup and build commands, timeout, and named environment pass-throughs.</p>
            </div>
          </div>
          <div className="field-grid two-column">
            <label>
              <span>Docker image</span>
              <input
                required
                value={value.runnerImage}
                onChange={(event) => setValue({ ...value, runnerImage: event.target.value })}
                placeholder="node:22-bookworm"
              />
            </label>
            <label>
              <span>Timeout in minutes</span>
              <input
                required
                type="number"
                min="1"
                max="120"
                value={value.timeoutMinutes}
                onChange={(event) => setValue({ ...value, timeoutMinutes: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>Test workers per app</span>
              <input
                required
                type="number"
                min="1"
                max="16"
                value={value.testWorkerLimit}
                onChange={(event) => setValue({ ...value, testWorkerLimit: Number(event.target.value) })}
              />
              <small>
                Limits auto-detected Jest and Vitest parallelism. Jest workers are also recycled after 1 GiB to
                prevent long test runs from exhausting Node's heap. Use 1 for the lowest memory usage.
              </small>
            </label>
            <label className="field-span">
              <span>Setup command</span>
              <input
                value={value.setupCommand ?? ""}
                onChange={(event) => setValue({ ...value, setupCommand: event.target.value })}
                placeholder="npm ci"
              />
              <small>Runs once from the repository root before any app tests. Leave blank to skip.</small>
            </label>
            <label className="field-span">
              <span>Build command override</span>
              <input
                value={value.buildCommand ?? ""}
                onChange={(event) => setValue({ ...value, buildCommand: event.target.value })}
                placeholder="pnpm build"
              />
              <small>
                Runs once after setup and before the selected app tests. Override the repository default here, or
                leave blank to skip the build phase.
              </small>
            </label>
            <label className="field-span">
              <span>Allowed environment variable names</span>
              <input
                value={environmentNames}
                onChange={(event) => setEnvironmentNames(event.target.value)}
                placeholder="NPM_TOKEN, API_BASE_URL"
              />
              <small>Comma-separated names only. Values come from the worker environment and are never stored.</small>
            </label>
          </div>
        </section>

        <section className="panel form-section">
          <div className="section-heading section-heading-actions">
            <div className="section-heading-group">
              <span className="section-number">03</span>
              <div>
                <h2>Applications</h2>
                <p>Discover pnpm workspaces automatically or define each app explicitly.</p>
              </div>
            </div>
            {!value.autoDetect && (
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => setValue({ ...value, apps: [...value.apps, emptyApp()] })}
              >
                ＋ Add app
              </button>
            )}
          </div>
          <label className="auto-detect-toggle">
            <input
              type="checkbox"
              checked={value.autoDetect}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  autoDetect: event.target.checked,
                  setupCommand:
                    event.target.checked && current.setupCommand === "npm ci"
                      ? "corepack enable && pnpm install --frozen-lockfile"
                      : current.setupCommand,
                  buildCommand:
                    event.target.checked && !current.buildCommand
                      ? "pnpm build"
                      : current.buildCommand,
                  apps:
                    !event.target.checked && current.apps.length === 0 ? [emptyApp()] : current.apps
                }))
              }
            />
            <span>
              <strong>Auto-detect pnpm/Turborepo apps</strong>
              <small>
                Reads <code>pnpm-workspace.yaml</code>, prioritizes workspaces under <code>apps/</code>,
                and uses each package&apos;s test:coverage, coverage, or test script.
              </small>
            </span>
          </label>
          {value.autoDetect ? (
            <>
              <div className="auto-detect-note">
                <span aria-hidden="true">⌁</span>
                <div>
                  <strong>Apps and coverage reports will be discovered after each fresh clone.</strong>
                  <p>
                    QA Buddy looks for Istanbul <code>coverage-summary.json</code> or <code>lcov.info</code>
                    beneath each detected app. Edit the setup command above if your workspace needs extra preparation.
                  </p>
                </div>
              </div>
              <label className="field-span additional-workspaces">
                <span>Additional workspaces</span>
                <input
                  value={workspaceNames}
                  onChange={(event) => setWorkspaceNames(event.target.value)}
                  placeholder="libs/scout-ui, libs/infuse-ui"
                  autoComplete="off"
                />
                <small>
                  Comma-separated workspace directories to test alongside <code>apps/</code>, for shared libraries
                  that are not applications. Each must be a pnpm workspace with a <code>package.json</code>, and a
                  directory that cannot be found fails the run. Workspaces with no test script, or whose suite
                  reports no tests, are skipped without failing the run.
                </small>
              </label>
            </>
          ) : (
            <div className="app-form-list">
              {value.apps.map((app, index) => (
              <fieldset className="app-form" key={index}>
                <legend>App {index + 1}</legend>
                {value.apps.length > 1 && (
                  <button
                    type="button"
                    className="text-button danger app-remove"
                    onClick={() => setValue({ ...value, apps: value.apps.filter((_, item) => item !== index) })}
                  >
                    Remove
                  </button>
                )}
                <div className="field-grid two-column">
                  <label>
                    <span>App name</span>
                    <input
                      required
                      value={app.name}
                      onChange={(event) => updateApp(index, { name: event.target.value })}
                      placeholder="Web app"
                    />
                  </label>
                  <label>
                    <span>Working directory</span>
                    <input
                      required
                      value={app.workingDirectory}
                      onChange={(event) => updateApp(index, { workingDirectory: event.target.value })}
                      placeholder="apps/web"
                    />
                  </label>
                  <label className="field-span">
                    <span>Test command</span>
                    <input
                      required
                      value={app.testCommand}
                      onChange={(event) => updateApp(index, { testCommand: event.target.value })}
                      placeholder="npm test -- --coverage"
                    />
                  </label>
                  <label>
                    <span>Coverage format</span>
                    <select
                      value={app.coverageFormat}
                      onChange={(event) =>
                        updateApp(index, {
                          coverageFormat: event.target.value as AppInput["coverageFormat"]
                        })
                      }
                    >
                      <option value="istanbul-summary-json">Istanbul summary JSON</option>
                      <option value="lcov">LCOV</option>
                    </select>
                  </label>
                  <label>
                    <span>Coverage path from repository root</span>
                    <input
                      required
                      value={app.coveragePath}
                      onChange={(event) => updateApp(index, { coveragePath: event.target.value })}
                      placeholder="apps/web/coverage/coverage-summary.json"
                    />
                  </label>
                </div>
              </fieldset>
              ))}
            </div>
          )}
        </section>

        <section className="panel form-section">
          <div className="section-heading">
            <span className="section-number">04</span>
            <div>
              <h2>End-to-end suites</h2>
              <p>
                Browser suites run in their own image, on their own queue, and report through JUnit XML instead
                of coverage. They never block a unit run.
              </p>
            </div>
          </div>

          <label className="auto-detect-toggle">
            <input
              type="checkbox"
              checked={e2e.enabled}
              onChange={(event) =>
                setE2e({
                  enabled: event.target.checked,
                  runnerImage:
                    event.target.checked && !e2e.runnerImage ? "cypress/included:15.8.2" : e2e.runnerImage,
                  // Browser images ship Node but not pnpm, and corepack needs the
                  // prompt disabled because the runner has no TTY.
                  setupCommand:
                    event.target.checked && !e2e.setupCommand
                      ? "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile"
                      : e2e.setupCommand
                })
              }
            />
            <span>
              <strong>Enable end-to-end runs</strong>
              <small>
                Adds a separate run button on the repository page. Suites are always configured explicitly;
                there is no auto-detection.
              </small>
            </span>
          </label>

          {e2e.enabled && (
            <>
              <div className="field-grid two-column">
                <label>
                  <span>Runner image</span>
                  <input
                    value={e2e.runnerImage}
                    onChange={(event) => setE2e({ runnerImage: event.target.value })}
                    placeholder="cypress/included:15.8.2"
                  />
                  <small>
                    Must include a browser. The tag has to match the Cypress version your lockfile resolves, or
                    the binary will be missing.
                  </small>
                </label>
                <label>
                  <span>Timeout (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={240}
                    value={e2e.timeoutMinutes}
                    onChange={(event) => setE2e({ timeoutMinutes: Number(event.target.value) })}
                  />
                  <small>Browser suites are slow; up to 240 minutes is allowed.</small>
                </label>
                <label className="field-span">
                  <span>Setup command</span>
                  <input
                    value={e2e.setupCommand ?? ""}
                    onChange={(event) => setE2e({ setupCommand: event.target.value })}
                    placeholder="COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile"
                  />
                  <small>Browser images ship Node but not pnpm, so corepack has to enable it first.</small>
                </label>
                <label className="field-span">
                  <span>Build command</span>
                  <input
                    value={e2e.buildCommand ?? ""}
                    onChange={(event) => setE2e({ buildCommand: event.target.value })}
                    placeholder="pnpm build"
                  />
                </label>
                <label className="field-span">
                  <span>Allowed environment variable names</span>
                  <input
                    value={e2eEnvironmentNames}
                    onChange={(event) => setE2eEnvironmentNames(event.target.value)}
                    placeholder="CYPRESS_CLERK_SECRET_KEY, CYPRESS_adminEmail"
                  />
                  <small>
                    Separate from the unit allowlist, since end-to-end suites need credentials a unit run never
                    sees. Values live in <code>.env</code>; only names go here.
                  </small>
                </label>
              </div>

              <div className="app-form-list">
                {e2e.apps.map((app, index) => (
                  <fieldset className="app-form" key={index}>
                    <legend>Suite {index + 1}</legend>
                    {e2e.apps.length > 0 && (
                      <button
                        type="button"
                        className="text-button danger app-remove"
                        onClick={() => setE2e({ apps: e2e.apps.filter((_, position) => position !== index) })}
                      >
                        Remove
                      </button>
                    )}
                    <div className="field-grid two-column">
                      <label>
                        <span>Suite name</span>
                        <input
                          value={app.name}
                          onChange={(event) => updateE2eApp(index, { name: event.target.value })}
                          placeholder="idinspect smoke"
                        />
                      </label>
                      <label>
                        <span>Working directory</span>
                        <input
                          value={app.workingDirectory}
                          onChange={(event) => updateE2eApp(index, { workingDirectory: event.target.value })}
                          placeholder="."
                        />
                        <small>Use <code>.</code> to run from the repository root.</small>
                      </label>
                      <label className="field-span">
                        <span>Test command</span>
                        <input
                          value={app.testCommand}
                          onChange={(event) => updateE2eApp(index, { testCommand: event.target.value })}
                          placeholder="pnpm --filter app exec cypress run --reporter junit ..."
                        />
                        <small>
                          Start any servers the suite needs in this command; it runs through a shell.
                        </small>
                      </label>
                      <label className="field-span">
                        <span>Artifacts to keep (optional)</span>
                        <input
                          value={(app.artifactGlobs ?? []).join(", ")}
                          onChange={(event) =>
                            updateE2eApp(index, {
                              artifactGlobs: event.target.value
                                .split(",")
                                .map((entry) => entry.trim())
                                .filter(Boolean)
                            })
                          }
                          placeholder="apps/idinspect/cypress/screenshots/**, apps/idinspect/cypress/videos/**"
                        />
                        <small>
                          Comma-separated globs from the repository root. These are copied out before the
                          checkout is deleted, and are kept for as long as the run itself.
                        </small>
                      </label>
                      <label className="field-span">
                        <span>JUnit report path</span>
                        <input
                          value={app.reportGlob}
                          onChange={(event) => updateE2eApp(index, { reportGlob: event.target.value })}
                          placeholder="apps/idinspect/results/*.xml"
                        />
                        <small>
                          A glob relative to the repository root. Cypress writes one file per spec; every match
                          is merged.
                        </small>
                      </label>
                    </div>
                  </fieldset>
                ))}
              </div>

              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  setE2e({
                    apps: [
                      ...e2e.apps,
                      {
                        name: "",
                        workingDirectory: ".",
                        testCommand: "",
                        reportGlob: "results/*.xml",
                        artifactGlobs: []
                      }
                    ]
                  })
                }
              >
                + Add a suite
              </button>
            </>
          )}
        </section>

        <div className="form-actions">
          <Link to={repositoryId ? `/repositories/${repositoryId}` : "/"} className="button button-ghost">
            Cancel
          </Link>
          <button className="button button-primary" disabled={saving}>
            {saving ? "Saving…" : repositoryId ? "Save configuration" : "Add repository"}
          </button>
        </div>
      </form>
    </div>
  );
}
