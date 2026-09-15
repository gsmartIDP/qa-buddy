import type { CoverageFileEntry, CoverageMetric, CoverageReport, CoverageSummary } from "./types.js";

function metric(covered: number, total: number): CoverageMetric {
  return {
    covered,
    total,
    percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10
  };
}

interface IstanbulMetric {
  covered?: unknown;
  total?: unknown;
}

function parseIstanbulMetric(value: unknown, name: string): CoverageMetric {
  if (!value || typeof value !== "object") {
    throw new Error(`Coverage summary is missing ${name}`);
  }

  const candidate = value as IstanbulMetric;
  if (
    typeof candidate.covered !== "number" ||
    typeof candidate.total !== "number" ||
    candidate.covered < 0 ||
    candidate.total < 0 ||
    candidate.covered > candidate.total
  ) {
    throw new Error(`Coverage summary has invalid ${name} counts`);
  }

  return metric(candidate.covered, candidate.total);
}


function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * Coverage reporters emit absolute container paths such as
 * `/workspaces/<runId>/repo/apps/web/src/x.ts`, which contain the run id and so
 * never match between runs. Everything is reduced to a repository-root-relative
 * POSIX path so snapshots stay comparable.
 */
export function normalizeCoverageFilePath(
  value: string,
  options: { rootDirectory?: string; workingDirectory?: string } = {}
): string {
  let candidate = toPosix(value.trim());
  if (candidate.startsWith("file://")) candidate = candidate.slice("file://".length);

  const root = options.rootDirectory ? toPosix(options.rootDirectory).replace(/\/+$/, "") : "";
  if (root && (candidate === root || candidate.startsWith(`${root}/`))) {
    return candidate.slice(root.length + 1);
  }
  if (candidate.startsWith("/")) {
    // Outside the checkout entirely; keep only the basename so nothing leaks a host path.
    return candidate.slice(candidate.lastIndexOf("/") + 1);
  }

  candidate = candidate.replace(/^\.\//, "");
  const workingDirectory = options.workingDirectory
    ? toPosix(options.workingDirectory).replace(/^\.\//, "").replace(/\/+$/, "")
    : "";
  if (workingDirectory && workingDirectory !== "." && !candidate.startsWith(`${workingDirectory}/`)) {
    return `${workingDirectory}/${candidate}`;
  }
  return candidate;
}

export interface CoverageParseOptions {
  rootDirectory?: string;
  workingDirectory?: string;
}

function optionalIstanbulMetric(value: unknown): CoverageMetric | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as IstanbulMetric;
  if (
    typeof candidate.covered !== "number" ||
    typeof candidate.total !== "number" ||
    candidate.covered < 0 ||
    candidate.total < 0 ||
    candidate.covered > candidate.total
  ) {
    return null;
  }
  return metric(candidate.covered, candidate.total);
}

function sortFiles(files: CoverageFileEntry[]): CoverageFileEntry[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseIstanbulReport(
  contents: string,
  options: CoverageParseOptions = {}
): CoverageReport {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error("Coverage summary is not valid JSON");
  }

  if (!document || typeof document !== "object" || !("total" in document)) {
    throw new Error("Coverage summary must contain a total object");
  }

  const entries = document as Record<string, unknown>;
  const total = (entries as { total: Record<string, unknown> }).total;
  const summary: CoverageSummary = {
    lines: parseIstanbulMetric(total.lines, "lines"),
    statements: parseIstanbulMetric(total.statements, "statements"),
    functions: parseIstanbulMetric(total.functions, "functions"),
    branches: parseIstanbulMetric(total.branches, "branches")
  };

  const files: CoverageFileEntry[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key === "total" || !value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const entry: CoverageFileEntry = {
      path: normalizeCoverageFilePath(key, options),
      lines: optionalIstanbulMetric(record.lines),
      statements: optionalIstanbulMetric(record.statements),
      functions: optionalIstanbulMetric(record.functions),
      branches: optionalIstanbulMetric(record.branches)
    };
    // A file entry with no usable metric tells us nothing; skipping keeps a
    // malformed record from failing a run that produced a valid total.
    if (entry.path && (entry.lines || entry.statements || entry.functions || entry.branches)) {
      files.push(entry);
    }
  }

  return { summary, files: sortFiles(files) };
}

export function parseIstanbulSummary(contents: string): CoverageSummary {
  return parseIstanbulReport(contents).summary;
}

export function parseLcovReport(contents: string, options: CoverageParseOptions = {}): CoverageReport {
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let records = 0;

  const files: CoverageFileEntry[] = [];
  let current: { path: string; lf: number; lh: number; fnf: number; fnh: number; brf: number; brh: number } | null = null;

  const closeRecord = (): void => {
    if (!current) return;
    if (current.path) {
      files.push({
        path: current.path,
        lines: metric(current.lh, current.lf),
        // LCOV has no separate statement metric, so it stays N/A per file too.
        statements: null,
        functions: metric(current.fnh, current.fnf),
        branches: metric(current.brh, current.brf)
      });
    }
    current = null;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      closeRecord();
      current = {
        path: normalizeCoverageFilePath(line.slice(3), options),
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
        brf: 0,
        brh: 0
      };
    } else if (line === "end_of_record") {
      records += 1;
      closeRecord();
    } else if (line.startsWith("DA:")) {
      linesFound += 1;
      const hits = Number(line.slice(3).split(",")[1]);
      const covered = Number.isFinite(hits) && hits > 0;
      if (covered) linesHit += 1;
      if (current) {
        current.lf += 1;
        if (covered) current.lh += 1;
      }
    } else if (line.startsWith("FNDA:")) {
      functionsFound += 1;
      const hits = Number(line.slice(5).split(",")[0]);
      const covered = Number.isFinite(hits) && hits > 0;
      if (covered) functionsHit += 1;
      if (current) {
        current.fnf += 1;
        if (covered) current.fnh += 1;
      }
    } else if (line.startsWith("BRDA:")) {
      branchesFound += 1;
      const hits = line.slice(5).split(",")[3];
      const covered = Boolean(hits && hits !== "-" && Number(hits) > 0);
      if (covered) branchesHit += 1;
      if (current) {
        current.brf += 1;
        if (covered) current.brh += 1;
      }
    }
  }
  // Tolerate a final record that never emitted end_of_record.
  closeRecord();

  if (records === 0 && linesFound === 0 && functionsFound === 0 && branchesFound === 0) {
    throw new Error("LCOV report does not contain any coverage records");
  }

  return {
    summary: {
      lines: metric(linesHit, linesFound),
      statements: null,
      functions: metric(functionsHit, functionsFound),
      branches: metric(branchesHit, branchesFound)
    },
    files: sortFiles(files)
  };
}

export function parseLcov(contents: string): CoverageSummary {
  return parseLcovReport(contents).summary;
}
