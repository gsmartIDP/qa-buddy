import { describe, expect, it } from "vitest";
import {
  normalizeCoverageFilePath,
  parseIstanbulReport,
  parseIstanbulSummary,
  parseLcov,
  parseLcovReport
} from "./coverage.js";

describe("coverage parsers", () => {
  it("parses Istanbul coverage-summary JSON using counts", () => {
    const result = parseIstanbulSummary(
      JSON.stringify({
        total: {
          lines: { total: 10, covered: 8, pct: 1 },
          statements: { total: 12, covered: 9, pct: 1 },
          functions: { total: 4, covered: 2, pct: 1 },
          branches: { total: 8, covered: 3, pct: 1 }
        }
      })
    );
    expect(result.lines).toEqual({ covered: 8, total: 10, percent: 80 });
    expect(result.statements?.percent).toBe(75);
    expect(result.functions?.percent).toBe(50);
    expect(result.branches?.percent).toBe(37.5);
  });

  it("returns a null percentage for zero-sized Istanbul metrics", () => {
    const result = parseIstanbulSummary(
      JSON.stringify({
        total: {
          lines: { total: 0, covered: 0 },
          statements: { total: 0, covered: 0 },
          functions: { total: 0, covered: 0 },
          branches: { total: 0, covered: 0 }
        }
      })
    );
    expect(result.lines?.percent).toBeNull();
  });

  it("aggregates LCOV data without inventing statement coverage", () => {
    const result = parseLcov(`
TN:
SF:/workspace/src/a.ts
FN:1,one
FNDA:2,one
FN:5,two
FNDA:0,two
DA:1,3
DA:2,0
BRDA:2,0,0,1
BRDA:2,0,1,-
end_of_record
SF:/workspace/src/b.ts
DA:1,1
end_of_record
`);
    expect(result.lines).toEqual({ covered: 2, total: 3, percent: 66.7 });
    expect(result.functions).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(result.branches).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(result.statements).toBeNull();
  });

  it("reports malformed or empty coverage explicitly", () => {
    expect(() => parseIstanbulSummary("not json")).toThrow(/valid JSON/);
    expect(() => parseIstanbulSummary('{"total":{}}')).toThrow(/missing lines/);
    expect(() => parseLcov("TN:\n")).toThrow(/does not contain/);
  });
});

describe("coverage file path normalization", () => {
  const rootDirectory = "/workspaces/run-abc/repo";

  it("strips the run-specific checkout prefix", () => {
    expect(
      normalizeCoverageFilePath(`${rootDirectory}/apps/web/src/index.ts`, { rootDirectory })
    ).toBe("apps/web/src/index.ts");
  });

  it("anchors a relative path to the app working directory", () => {
    expect(
      normalizeCoverageFilePath("src/index.ts", { rootDirectory, workingDirectory: "apps/web" })
    ).toBe("apps/web/src/index.ts");
    expect(
      normalizeCoverageFilePath("./src/index.ts", { rootDirectory, workingDirectory: "apps/web" })
    ).toBe("apps/web/src/index.ts");
  });

  it("does not double-prefix a path that already includes the working directory", () => {
    expect(
      normalizeCoverageFilePath("apps/web/src/index.ts", { rootDirectory, workingDirectory: "apps/web" })
    ).toBe("apps/web/src/index.ts");
  });

  it("reduces a path outside the checkout to its basename", () => {
    expect(normalizeCoverageFilePath("/etc/passwd", { rootDirectory })).toBe("passwd");
  });

  it("handles a file:// URL and Windows separators", () => {
    expect(normalizeCoverageFilePath(`file://${rootDirectory}/src/a.ts`, { rootDirectory })).toBe("src/a.ts");
    expect(normalizeCoverageFilePath("src\\a.ts", { rootDirectory, workingDirectory: "." })).toBe("src/a.ts");
  });
});

describe("per-file Istanbul coverage", () => {
  const report = JSON.stringify({
    total: {
      lines: { covered: 8, total: 10 },
      statements: { covered: 8, total: 10 },
      functions: { covered: 2, total: 4 },
      branches: { covered: 1, total: 4 }
    },
    "/workspaces/run-abc/repo/src/good.ts": {
      lines: { covered: 8, total: 8 },
      statements: { covered: 8, total: 8 },
      functions: { covered: 2, total: 2 },
      branches: { covered: 1, total: 1 }
    },
    "/workspaces/run-abc/repo/src/gap.ts": {
      lines: { covered: 0, total: 2 },
      statements: { covered: 0, total: 2 },
      functions: { covered: 0, total: 2 },
      branches: { covered: 0, total: 3 }
    },
    "/workspaces/run-abc/repo/src/broken.ts": { lines: "nonsense" }
  });

  it("returns normalized per-file entries alongside the total", () => {
    const { summary, files } = parseIstanbulReport(report, { rootDirectory: "/workspaces/run-abc/repo" });

    expect(summary.lines).toEqual({ covered: 8, total: 10, percent: 80 });
    expect(files.map((file) => file.path)).toEqual(["src/gap.ts", "src/good.ts"]);
    expect(files[0]?.branches).toEqual({ covered: 0, total: 3, percent: 0 });
    expect(files[1]?.lines).toEqual({ covered: 8, total: 8, percent: 100 });
  });

  it("skips file entries with no usable metric instead of failing the run", () => {
    const { files } = parseIstanbulReport(report, { rootDirectory: "/workspaces/run-abc/repo" });
    expect(files.some((file) => file.path.endsWith("broken.ts"))).toBe(false);
  });

  it("keeps the original summary-only helper working", () => {
    expect(parseIstanbulSummary(report).functions).toEqual({ covered: 2, total: 4, percent: 50 });
  });
});

describe("per-file LCOV coverage", () => {
  const report = [
    "SF:/workspaces/run-abc/repo/src/a.ts",
    "DA:1,1",
    "DA:2,0",
    "FNDA:1,alpha",
    "BRDA:1,0,0,1",
    "BRDA:1,0,1,0",
    "end_of_record",
    "SF:/workspaces/run-abc/repo/src/b.ts",
    "DA:1,0",
    "FNDA:0,beta",
    "end_of_record"
  ].join("\n");

  it("splits records per source file and keeps statements N/A", () => {
    const { summary, files } = parseLcovReport(report, { rootDirectory: "/workspaces/run-abc/repo" });

    expect(summary.lines).toEqual({ covered: 1, total: 3, percent: 33.3 });
    expect(summary.statements).toBeNull();
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.lines).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(files[0]?.branches).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(files[0]?.statements).toBeNull();
    expect(files[1]?.lines).toEqual({ covered: 0, total: 1, percent: 0 });
  });

  it("tolerates a final record with no end_of_record", () => {
    const truncated = "SF:/repo/src/c.ts\nDA:1,1";
    const { files } = parseLcovReport(truncated, { rootDirectory: "/repo" });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/c.ts");
  });

  it("keeps the original summary-only helper working", () => {
    expect(parseLcov(report).lines).toEqual({ covered: 1, total: 3, percent: 33.3 });
  });
});
