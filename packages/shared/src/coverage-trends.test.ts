import { describe, expect, it } from "vitest";
import { buildCoverageTrend, resolveTrendValue, sliceTrend, trendMovers, trendReliability } from "./coverage-trends.js";
import type { CoverageHistoryEntry } from "./types.js";

function entry(runId: string, recordedAt: string, appName: string, covered: number | null, total = 10, tests = 5): CoverageHistoryEntry {
  const metric = covered === null ? null : { covered, total, percent: (covered / total) * 100 };
  return {
    runId,
    appName,
    requestedRef: "main",
    resolvedSha: null,
    useLocalWorkingTree: false,
    dirty: false,
    recordedAt,
    coverage: { lines: metric, statements: metric, functions: metric, branches: metric },
    tests: { total: tests, passed: tests, failed: 0 }
  };
}

describe("buildCoverageTrend", () => {
  const history = [
    entry("r1", "2026-10-01T00:00:00.000Z", "web", 5),
    entry("r1", "2026-10-01T00:00:00.000Z", "api", 2, 40),
    entry("r2", "2026-10-02T00:00:00.000Z", "web", 8),
    entry("r3", "2026-10-03T00:00:00.000Z", "API", 30, 40, 9)
  ];

  it("carries each app forward so partial runs keep a stable weighted total", () => {
    const trend = buildCoverageTrend(history, "branches");
    expect(trend.points.map((point) => point.total?.percent)).toEqual([14, 20, 76]);
    expect(trend.points.map((point) => point.testsTotal)).toEqual([10, 10, 14]);
    expect(trend.points[1]?.ranApps).toEqual(["web"]);
    expect(trend.apps).toMatchObject([
      { appName: "web", values: [50, 80, 80] },
      { appName: "api", values: [5, 5, 75] }
    ]);
  });

  it("scopes to a group case-insensitively and skips runs outside it", () => {
    const trend = buildCoverageTrend(history, "lines", ["Api"]);
    expect(trend.points.map((point) => point.runId)).toEqual(["r1", "r3"]);
    expect(trend.apps).toMatchObject([{ appName: "api", values: [5, 75] }]);
  });

  it("starts late-arriving apps with gaps and keeps coverage when a run reports only tests", () => {
    const trend = buildCoverageTrend(
      [entry("r1", "2026-10-01T00:00:00.000Z", "web", 5), entry("r2", "2026-10-02T00:00:00.000Z", "docs", 1), entry("r3", "2026-10-03T00:00:00.000Z", "web", null, 10, 7)],
      "lines"
    );
    expect(trend.apps).toMatchObject([
      { appName: "web", values: [50, 50, 50] },
      { appName: "docs", values: [null, 10, 10] }
    ]);
    expect(trend.points[2]?.testsTotal).toBe(12);
  });

  it("picks each app's best or worst metric and weights the total by line count", () => {
    const coverage = (lines: [number, number], functions: [number, number], branches: [number, number]) => ({
      lines: { covered: lines[0], total: lines[1], percent: (lines[0] / lines[1]) * 100 },
      statements: null,
      functions: { covered: functions[0], total: functions[1], percent: (functions[0] / functions[1]) * 100 },
      branches: { covered: branches[0], total: branches[1], percent: (branches[0] / branches[1]) * 100 }
    });
    const base = entry("r1", "2026-10-01T00:00:00.000Z", "web", 0);
    const history: CoverageHistoryEntry[] = [
      { ...base, appName: "web", coverage: coverage([50, 100], [9, 10], [1, 10]) },
      { ...base, appName: "api", coverage: coverage([300, 300], [1, 4], [3, 4]) }
    ];

    expect(resolveTrendValue(history[0]!.coverage, "max")).toEqual({ covered: 90, total: 100, percent: 90, source: "functions" });
    expect(resolveTrendValue(history[0]!.coverage, "min")?.source).toBe("branches");

    const max = buildCoverageTrend(history, "max");
    // web 90% x 100 lines + api 100% x 300 lines = 390 / 400
    expect(max.points[0]?.total?.percent).toBe(97.5);
    expect(max.apps.map((app) => app.sources[0])).toEqual(["functions", "lines"]);
    // web 10% x 100 + api 25% x 300 = 85 / 400
    expect(buildCoverageTrend(history, "min").points[0]?.total?.percent).toBe(21.3);
  });

  it("slices to a range while keeping values carried in from before it", () => {
    const sliced = sliceTrend(buildCoverageTrend(history, "branches"), "2026-10-02T00:00:00.000Z");
    expect(sliced.points.map((point) => point.runId)).toEqual(["r2", "r3"]);
    // api last ran in r1, before the range, yet still counts toward the total.
    expect(sliced.points[0]?.total?.percent).toBe(20);
    expect(sliced.apps).toMatchObject([{ appName: "web", values: [80, 80] }, { appName: "api", values: [5, 75] }]);
    expect(sliceTrend(buildCoverageTrend(history, "branches"), "2026-11-01T00:00:00.000Z")).toEqual({ points: [], apps: [] });
  });

  it("ranks the biggest movers and ignores apps without two points", () => {
    const movers = trendMovers(
      buildCoverageTrend(
        [
          ...history,
          entry("r3", "2026-10-03T00:00:00.000Z", "docs", 9),
          entry("r1", "2026-10-01T00:00:00.000Z", "legacy", 6),
          entry("r3", "2026-10-03T00:00:00.000Z", "legacy", 4)
        ],
        "branches"
      )
    );
    expect(movers.improved.map((mover) => [mover.appName, mover.delta])).toEqual([["api", 70], ["web", 30]]);
    expect(movers.declined).toEqual([{ appName: "legacy", from: 60, to: 40, delta: -20 }]);
  });

  it("counts pass rate only from apps that ran, never rounding a failure up to 100%", () => {
    const failing = { ...entry("r2", "2026-10-02T00:00:00.000Z", "web", 8), tests: { total: 2000, passed: 1999, failed: 1 } };
    const reliability = trendReliability(buildCoverageTrend([history[0]!, history[1]!, failing], "lines"));
    expect(reliability).toEqual({ passRate: 99.9, runsWithTests: 2, runsWithFailures: 1 });
  });
});
