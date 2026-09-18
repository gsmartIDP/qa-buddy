import type { AppRun, CoverageMetric } from "@qa-buddy/shared";
import { StatusBadge } from "./StatusBadge";

/** Elapsed milliseconds for a finished app run, or null while it is still going. */
export function appRunDurationMs(app: AppRun): number | null {
  if (!app.startedAt || !app.finishedAt) return null;
  const elapsed = new Date(app.finishedAt).getTime() - new Date(app.startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/** Whole seconds is plenty: nobody perceives a test suite to sub-second accuracy. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  // Past an hour, round to the nearest minute rather than truncating, so the
  // carry is handled (1h 59m 40s reads as 2h 00m, never 1h 60m).
  const roundedMinutes = Math.round(totalSeconds / 60);
  return `${Math.floor(roundedMinutes / 60)}h ${String(roundedMinutes % 60).padStart(2, "0")}m`;
}

function Metric({ value }: { value: CoverageMetric | null }) {
  if (!value) return <span className="metric-empty">N/A</span>;
  return (
    <span className="metric-value">
      <strong>{value.percent === null ? "—" : `${value.percent.toFixed(1)}%`}</strong>
      <small>
        {value.covered}/{value.total}
      </small>
      {value.percent !== null && <span className="coverage-track"><span style={{ width: `${value.percent}%` }} /></span>}
    </span>
  );
}

function TestSummary({ app }: { app: AppRun }) {
  if (!app.testResults) return <span className="metric-empty">N/A</span>;
  return (
    <span className="metric-value test-summary-value">
      <strong>{app.testResults.passed}/{app.testResults.total}</strong>
      <small>{app.testResults.failed ? `${app.testResults.failed} failed` : "passed"}</small>
    </span>
  );
}

export function CoverageTable({
  appRuns,
  compact = false,
  // End-to-end suites produce no coverage; showing four N/A columns implies a gap
  // that does not exist.
  showCoverage = true
}: {
  appRuns: AppRun[];
  compact?: boolean;
  showCoverage?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={compact ? "coverage-table compact" : "coverage-table"}>
        <thead>
          <tr>
            <th>App</th>
            <th>Status</th>
            {!compact && <th>Tests</th>}
            <th>Duration</th>
            {showCoverage && (
              <>
                <th>Lines</th>
                <th>Statements</th>
                <th>Functions</th>
                <th>Branches</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {appRuns.map((app) => (
            <tr key={app.id}>
              <td>
                <strong>{app.name}</strong>
                {!compact && <small className="cell-subtitle">{app.workingDirectory}</small>}
              </td>
              <td>
                <StatusBadge status={app.status} />
              </td>
              {!compact && <td><TestSummary app={app} /></td>}
              <td><span className="duration-value">{formatDuration(appRunDurationMs(app))}</span></td>
              {showCoverage && (
                <>
                  <td><Metric value={app.coverage?.lines ?? null} /></td>
                  <td><Metric value={app.coverage?.statements ?? null} /></td>
                  <td><Metric value={app.coverage?.functions ?? null} /></td>
                  <td><Metric value={app.coverage?.branches ?? null} /></td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
