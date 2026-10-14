import type { CoverageHistoryEntry, CoverageMetric, CoverageMetricName } from "./types.js";
import { coverageMetricNames } from "./types.js";

/**
 * A real coverage metric, or the best/worst of the four per app. Max and Min
 * are deliberately optimistic/pessimistic views, not measurements.
 */
export type CoverageTrendMetric = CoverageMetricName | "max" | "min";

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
  /** Test outcomes from only the apps that ran in this run; never carried forward. */
  ranTests: { passed: number; failed: number } | null;
}

export interface CoverageTrendSeries {
  appName: string;
  /** One value per point; null until the app's first measured result. */
  values: Array<number | null>;
  /** Which metric each value came from; differs per point only for max/min. */
  sources: Array<CoverageMetricName | null>;
}

interface ResolvedValue {
  covered: number;
  total: number;
  percent: number | null;
  source: CoverageMetricName;
}

/**
 * Max/min pick a percentage per app, but the four metrics count different
 * things, so the weighted total uses line count as a consistent app size.
 */
export function resolveTrendValue(
  coverage: CoverageHistoryEntry["coverage"],
  metric: CoverageTrendMetric
): ResolvedValue | null {
  if (metric !== "max" && metric !== "min") {
    const value = coverage[metric];
    return value ? { ...value, source: metric } : null;
  }
  let chosen: { name: CoverageMetricName; value: CoverageMetric & { percent: number } } | null = null;
  for (const name of coverageMetricNames) {
    const value = coverage[name];
    if (!value || value.percent === null) continue;
    if (!chosen || (metric === "max" ? value.percent > chosen.value.percent : value.percent < chosen.value.percent)) {
      chosen = { name, value: value as CoverageMetric & { percent: number } };
    }
  }
  if (!chosen) return null;
  const weight = coverage.lines?.total || coverage.statements?.total || chosen.value.total;
  return { covered: (chosen.value.percent / 100) * weight, total: weight, percent: chosen.value.percent, source: chosen.name };
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
  metric: CoverageTrendMetric,
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
  const latest = new Map<string, { entry: CoverageHistoryEntry; value: ResolvedValue | null }>();
  const appOrder: string[] = [];
  const valuesByApp = new Map<string, Array<number | null>>();
  const sourcesByApp = new Map<string, Array<CoverageMetricName | null>>();
  const points: CoverageTrendPoint[] = [];

  ordered.forEach((runEntries, index) => {
    for (const entry of runEntries) {
      const key = entry.appName.toLowerCase();
      if (!valuesByApp.has(key)) {
        appOrder.push(entry.appName);
        valuesByApp.set(key, Array<number | null>(index).fill(null));
        sourcesByApp.set(key, Array<CoverageMetricName | null>(index).fill(null));
      }
      // A run that produced tests but no coverage keeps the last coverage value.
      const value = resolveTrendValue(entry.coverage, metric) ?? latest.get(key)?.value ?? null;
      latest.set(key, { entry, value });
    }

    let covered = 0;
    let total = 0;
    let measured = 0;
    let testsTotal: number | null = null;
    for (const { entry, value } of latest.values()) {
      if (value) {
        covered += value.covered;
        total += value.total;
        measured += 1;
      }
      if (entry.tests) testsTotal = (testsTotal ?? 0) + entry.tests.total;
    }
    for (const [key, values] of valuesByApp) {
      const value = latest.get(key)?.value ?? null;
      values.push(value?.percent ?? null);
      sourcesByApp.get(key)!.push(value?.source ?? null);
    }

    const reported = runEntries.flatMap((entry) => (entry.tests ? [entry.tests] : []));
    const ranTests = reported.length
      ? {
          passed: reported.reduce((sum, tests) => sum + tests.passed, 0),
          failed: reported.reduce((sum, tests) => sum + tests.failed, 0)
        }
      : null;

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
      testsTotal,
      ranTests
    });
  });

  return {
    points,
    apps: appOrder.map((appName) => ({
      appName,
      values: valuesByApp.get(appName.toLowerCase())!,
      sources: sourcesByApp.get(appName.toLowerCase())!
    }))
  };
}

/**
 * Keeps only points recorded at or after `since`. Slicing a trend built from
 * the full history keeps the carried-forward values at the range start correct.
 */
export function sliceTrend(trend: CoverageTrend, since: string | null): CoverageTrend {
  if (!since) return trend;
  const cutoff = Date.parse(since);
  const start = trend.points.findIndex((point) => Date.parse(point.recordedAt) >= cutoff);
  if (start === -1) return { points: [], apps: [] };
  return {
    points: trend.points.slice(start),
    apps: trend.apps
      .map((app) => ({ ...app, values: app.values.slice(start), sources: app.sources.slice(start) }))
      .filter((app) => app.values.some((value) => value !== null))
  };
}

export interface CoverageTrendMover {
  appName: string;
  from: number;
  to: number;
  delta: number;
}

/** Apps whose value moved most between their first and last point in the trend. */
export function trendMovers(trend: CoverageTrend, limit = 3): { improved: CoverageTrendMover[]; declined: CoverageTrendMover[] } {
  const movers: CoverageTrendMover[] = [];
  for (const app of trend.apps) {
    const firstIndex = app.values.findIndex((value) => value !== null);
    const to = app.values[app.values.length - 1];
    if (firstIndex === -1 || firstIndex === app.values.length - 1 || to == null) continue;
    const from = app.values[firstIndex]!;
    const delta = Math.round((to - from) * 10) / 10;
    if (delta !== 0) movers.push({ appName: app.appName, from, to, delta });
  }
  return {
    improved: movers.filter((mover) => mover.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit),
    declined: movers.filter((mover) => mover.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit)
  };
}

/** Pass rate over the tests that actually ran in each run, excluding skipped. */
export function trendReliability(trend: CoverageTrend): { passRate: number | null; runsWithTests: number; runsWithFailures: number } {
  let passed = 0;
  let failed = 0;
  let runsWithTests = 0;
  let runsWithFailures = 0;
  for (const point of trend.points) {
    if (!point.ranTests) continue;
    runsWithTests += 1;
    passed += point.ranTests.passed;
    failed += point.ranTests.failed;
    if (point.ranTests.failed > 0) runsWithFailures += 1;
  }
  const counted = passed + failed;
  return { passRate: counted ? Math.floor((passed / counted) * 1_000) / 10 : null, runsWithTests, runsWithFailures };
}
