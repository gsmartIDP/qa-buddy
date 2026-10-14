// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildCoverageTrend, type CoverageHistoryEntry } from "@qa-buddy/shared";
import { buildTrendExportSvg, escapeXml, exportFileName } from "./trend-export";
import { summarizeTrend } from "./trend-model";

function entry(runId: string, day: number, appName: string, branches: number): CoverageHistoryEntry {
  const metric = { covered: branches, total: 100, percent: branches };
  return {
    runId,
    appName,
    requestedRef: "main",
    resolvedSha: null,
    useLocalWorkingTree: false,
    dirty: false,
    recordedAt: `2026-10-0${day}T12:00:00.000Z`,
    coverage: { lines: metric, statements: metric, functions: metric, branches: metric },
    tests: { total: 10, passed: 10, failed: 0 }
  };
}

function render(entries: CoverageHistoryEntry[], focusedApp: string | null = null) {
  const trend = buildCoverageTrend(entries, "branches");
  const svg = buildTrendExportSvg({
    repositoryName: "Platform <core> & co",
    subtitle: "Branches · All apps · Last 30 days",
    trend,
    summary: summarizeTrend(trend, "branches", "All apps", 70),
    goal: 70,
    focusedApp,
    generatedAt: new Date("2026-10-13T12:00:00.000Z")
  });
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  return { svg, document, texts: Array.from(document.querySelectorAll("text")).map((node) => node.textContent) };
}

describe("trend export", () => {
  it("produces well-formed, escaped SVG with the stats, movers, goal and legend", () => {
    const { document, texts } = render([
      entry("r1", 1, "@acme/web", 40),
      entry("r1", 1, "@acme/api", 60),
      entry("r2", 2, "@acme/web", 46)
    ]);
    expect(document.querySelector("parsererror")).toBeNull();
    expect(texts).toContain("Platform <core> & co · Coverage trend");
    expect(texts).toContain("Branches · All apps · Last 30 days");
    expect(texts).toContain("53.0%");
    expect(texts).toContain("17 pts to 70% goal");
    // Long details stack as separate lines in the narrow export columns.
    expect(texts).toContain("−6 since Oct 1");
    expect(texts).toContain("codebase unchanged");
    expect(texts).toContain("+6 pts");
    expect(texts).toContain("No app declined in this range");
    expect(texts.filter((value) => value === "Goal 70%")).toHaveLength(2);
    expect(texts).toEqual(expect.arrayContaining(["Weighted total", "web", "api"]));
    expect(texts.some((value) => value?.startsWith("Generated "))).toBe(true);
  });

  it("summarises the legend instead of listing every app past eight", () => {
    const many = Array.from({ length: 9 }, (_, index) => entry("r1", 1, `@acme/app-${index}`, 50));
    expect(render(many).texts).toContain("Individual apps (9)");
    const focused = render(many, "@acme/app-3").texts;
    expect(focused).toEqual(expect.arrayContaining(["app-3", "Other apps (8)"]));
  });

  it("escapes markup and builds a readable file name", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
    expect(exportFileName("idplans-platform", "Branches · Frontend · Last 30 days", new Date("2026-10-13T12:00:00.000Z"), "png"))
      .toBe("idplans-platform-branches-frontend-last-30-days-2026-10-13.png");
  });
});
