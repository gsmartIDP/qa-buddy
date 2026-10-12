import type { CoverageHistoryEntry, CoverageMetricName } from "./types.js";

export interface CoverageTrendPoint {
  runId: string;
  recordedAt: string;
  requestedRef: string;
  resolvedSha: string | null;
  useLocalWorkingTree: boolean;
  dirty: boolean;
  /** Apps whose results came from this run rather than being carried forward. */
  ranApps: string[];
  /** Weighted across every app in scope, using each app's latest known value. */
  total: { covered: number; total: number; percent: number | null } | null;
  /** Carried-forward test count across every app in scope. */
  testsTotal: number | null;
}

export interface CoverageTrendSeries {
  appName: string;
  /** One value per point; null until the app's first measured result. */
  values: Array<number | null>;
}

export interface CoverageTrend {
  points: CoverageTrendPoint[];
  apps: CoverageTrendSeries[];
}

/**
 * Builds one chart's worth of trend data. Runs often cover only some apps
 * (groups, selections), so each point carries every app's most recent value
 * forward; otherwise the weighted total would swing with whichever apps ran.
 * Runs that touched none of the scoped apps add no point.
 */
export function buildCoverageTrend(
  entries: CoverageHistoryEntry[],
  metric: CoverageMetricName,
  appNames: string[] | null = null
): CoverageTrend {
  const scope = appNames ? new Set(appNames.map((name) => name.toLowerCase())) : null;
  const runs = new Map<string, CoverageHistoryEntry[]>();
  for (const entry of entries) {
    if (scope && !scope.has(entry.appName.toLowerCase())) continue;
    const run = runs.get(entry.runId);
    if (run) run.push(entry);
    else runs.set(entry.runId, [entry]);
  }

  const ordered = [...runs.values()].sort(
    (a, b) => Date.parse(a[0]!.recordedAt) - Date.parse(b[0]!.recordedAt)
  );
  const latest = new Map<string, CoverageHistoryEntry>();
  const appOrder: string[] = [];
  const valuesByApp = new Map<string, Array<number | null>>();
  const points: CoverageTrendPoint[] = [];

  ordered.forEach((runEntries, index) => {
    for (const entry of runEntries) {
      const key = entry.appName.toLowerCase();
      if (!valuesByApp.has(key)) {
        appOrder.push(entry.appName);
        valuesByApp.set(key, Array<number | null>(index).fill(null));
      }
      const previous = latest.get(key);
      // A run that produced tests but no coverage keeps the last coverage value.
      latest.set(key, entry.coverage[metric] || !previous ? entry : { ...entry, coverage: previous.coverage });
    }

    let covered = 0;
    let total = 0;
    let measured = 0;
    let testsTotal: number | null = null;
    for (const entry of latest.values()) {
      const value = entry.coverage[metric];
      if (value) {
        covered += value.covered;
        total += value.total;
        measured += 1;
      }
      if (entry.tests) testsTotal = (testsTotal ?? 0) + entry.tests.total;
    }
    for (const [key, values] of valuesByApp) values.push(latest.get(key)?.coverage[metric]?.percent ?? null);

    const first = runEntries[0]!;
    points.push({
      runId: first.runId,
      recordedAt: first.recordedAt,
      requestedRef: first.requestedRef,
      resolvedSha: first.resolvedSha,
      useLocalWorkingTree: first.useLocalWorkingTree,
      dirty: first.dirty,
      ranApps: runEntries.map((entry) => entry.appName),
      total: measured ? { covered, total, percent: total ? Math.round((covered / total) * 1_000) / 10 : null } : null,
      testsTotal
    });
  });

  return {
    points,
    apps: appOrder.map((appName) => ({ appName, values: valuesByApp.get(appName.toLowerCase())! }))
  };
}
