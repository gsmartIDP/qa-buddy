// @vitest-environment jsdom

import type { AppRun } from "@qa-buddy/shared";
import { describe, expect, it } from "vitest";
import { appRunDurationMs, formatDuration } from "./CoverageTable";

function appRun(startedAt: string | null, finishedAt: string | null): AppRun {
  return {
    id: "app-1",
    runId: "run-1",
    name: "Web",
    workingDirectory: "apps/web",
    testCommand: "pnpm test",
    coverageFormat: "istanbul-summary-json",
    coveragePath: "apps/web/coverage/coverage-summary.json",
    position: 0,
    status: "passed",
    exitCode: 0,
    coverage: null,
    coverageError: null,
    testResults: null,
    testResultsError: null,
    startedAt,
    finishedAt
  };
}

describe("app run duration", () => {
  it("measures the elapsed time between start and finish", () => {
    const app = appRun("2026-09-16T12:00:00.000Z", "2026-09-16T12:03:45.000Z");
    expect(appRunDurationMs(app)).toBe(225_000);
  });

  it("has no duration while the app is still running", () => {
    expect(appRunDurationMs(appRun("2026-09-16T12:00:00.000Z", null))).toBeNull();
    expect(appRunDurationMs(appRun(null, null))).toBeNull();
  });
});

describe("duration formatting", () => {
  it.each([
    [0, "0s"],
    [400, "0s"],
    [5_000, "5s"],
    [5_400, "5s"],
    [5_600, "6s"],
    [59_000, "59s"],
    [60_000, "1m 00s"],
    [225_000, "3m 45s"],
    [630_000, "10m 30s"],
    [3_600_000, "1h 00m"],
    [3_930_000, "1h 06m"],
    // Rounding must carry into the hour rather than producing "1h 60m".
    [7_180_000, "2h 00m"]
  ])("renders %ims as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  it("renders an unknown duration as a dash", () => {
    expect(formatDuration(null)).toBe("—");
  });
});
