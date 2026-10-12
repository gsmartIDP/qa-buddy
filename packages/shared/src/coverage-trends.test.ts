import { describe, expect, it } from "vitest";
import { buildCoverageTrend } from "./coverage-trends.js";
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
    expect(trend.apps).toEqual([
      { appName: "web", values: [50, 80, 80] },
      { appName: "api", values: [5, 5, 75] }
    ]);
  });

  it("scopes to a group case-insensitively and skips runs outside it", () => {
    const trend = buildCoverageTrend(history, "lines", ["Api"]);
    expect(trend.points.map((point) => point.runId)).toEqual(["r1", "r3"]);
    expect(trend.apps).toEqual([{ appName: "api", values: [5, 75] }]);
  });

  it("starts late-arriving apps with gaps and keeps coverage when a run reports only tests", () => {
    const trend = buildCoverageTrend(
      [entry("r1", "2026-10-01T00:00:00.000Z", "web", 5), entry("r2", "2026-10-02T00:00:00.000Z", "docs", 1), entry("r3", "2026-10-03T00:00:00.000Z", "web", null, 10, 7)],
      "lines"
    );
    expect(trend.apps).toEqual([
      { appName: "web", values: [50, 50, 50] },
      { appName: "docs", values: [null, 10, 10] }
    ]);
    expect(trend.points[2]?.testsTotal).toBe(12);
  });
});
