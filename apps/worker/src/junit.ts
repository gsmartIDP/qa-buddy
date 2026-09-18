import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { TestCaseResult, TestCaseStatus, TestResults } from "@qa-buddy/shared";

const maximumReportBytes = 50 * 1024 * 1024;
const maximumTestCases = 25_000;
const maximumFailureMessageLength = 8_000;

/**
 * Cypress and Playwright both emit JUnit XML, so one reader covers the
 * end-to-end runners without a per-tool parser.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // A <testsuite> with one child must still parse as an array.
  isArray: (name) => name === "testsuite" || name === "testcase"
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string | null {
  if (typeof node === "string") return node.trim() || null;
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  const message = typeof record["@message"] === "string" ? record["@message"].trim() : "";
  const body = typeof record["#text"] === "string" ? record["#text"].trim() : "";
  const combined = [message, body].filter(Boolean).join("\n");
  return combined || null;
}

function limited(value: string | null): string | null {
  if (!value) return null;
  return value.length > maximumFailureMessageLength
    ? `${value.slice(0, maximumFailureMessageLength)}\n[Failure message truncated by QA Buddy]`
    : value;
}

function durationMs(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

interface RawTestCase {
  "@name"?: unknown;
  "@classname"?: unknown;
  "@file"?: unknown;
  "@time"?: unknown;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}

interface RawTestSuite {
  "@name"?: unknown;
  "@file"?: unknown;
  testcase?: RawTestCase | RawTestCase[];
  testsuite?: RawTestSuite | RawTestSuite[];
}

function collectSuites(node: RawTestSuite): RawTestSuite[] {
  // JUnit allows nested suites; Playwright uses them for projects and files.
  return [node, ...asArray(node.testsuite).flatMap((child) => collectSuites(child))];
}

function suiteFilePath(suite: RawTestSuite, testCase: RawTestCase): string | null {
  for (const candidate of [testCase["@file"], suite["@file"], suite["@name"]]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().replaceAll("\\", "/");
  }
  return null;
}

/** Parses one JUnit XML document into QA Buddy's shared test-result shape. */
export function parseJUnitXml(contents: string): TestCaseResult[] {
  // The parser is lenient by default; a truncated report from an interrupted run
  // would otherwise parse as silently fewer tests.
  if (XMLValidator.validate(contents) !== true) {
    throw new Error("JUnit report is not valid XML");
  }

  let document: Record<string, unknown>;
  try {
    document = parser.parse(contents) as Record<string, unknown>;
  } catch {
    throw new Error("JUnit report is not valid XML");
  }

  const roots = [
    ...asArray(document.testsuites as RawTestSuite | RawTestSuite[] | undefined).flatMap((node) =>
      asArray((node as { testsuite?: RawTestSuite | RawTestSuite[] }).testsuite)
    ),
    ...asArray(document.testsuite as RawTestSuite | RawTestSuite[] | undefined)
  ];
  if (roots.length === 0) {
    throw new Error("JUnit report does not contain a testsuite element");
  }

  const cases: TestCaseResult[] = [];
  for (const suite of roots.flatMap((root) => collectSuites(root))) {
    const suiteName = typeof suite["@name"] === "string" ? suite["@name"].trim() : "";
    for (const testCase of asArray(suite.testcase)) {
      if (cases.length >= maximumTestCases) return cases;

      const failure = limited(textOf(testCase.failure) ?? textOf(testCase.error));
      const status: TestCaseStatus = failure
        ? "failed"
        : testCase.skipped !== undefined
          ? "skipped"
          : "passed";

      const name = typeof testCase["@name"] === "string" ? testCase["@name"].trim() : "Unnamed test";
      const className = typeof testCase["@classname"] === "string" ? testCase["@classname"].trim() : "";
      // Cypress puts the describe chain in classname; Playwright puts the suite there.
      const ancestorTitles = [suiteName, className].filter(
        (value, index, all) => value && all.indexOf(value) === index && value !== name
      );

      cases.push({
        name,
        fullName: [...ancestorTitles, name].join(" ") || name,
        ancestorTitles,
        filePath: suiteFilePath(suite, testCase),
        status,
        durationMs: durationMs(testCase["@time"]),
        failureMessage: failure
      });
    }
  }
  return cases;
}

function summarize(cases: TestCaseResult[]): TestResults {
  const count = (status: TestCaseStatus): number => cases.filter((entry) => entry.status === status).length;
  return {
    total: cases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    todo: count("todo"),
    testCases: cases
  };
}

/**
 * Reads every JUnit file matching a glob and merges them. Cypress writes one
 * file per spec, so a suite's results are normally spread across many.
 */
export async function readJUnitResults(
  repositoryDirectory: string,
  reportGlob: string
): Promise<{ results: TestResults; files: string[] }> {
  const root = path.resolve(repositoryDirectory);
  const matches = await fg(reportGlob, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"]
  });

  const files = matches
    .map((relative) => relative.replace(/^\.\//, ""))
    .filter((relative) => {
      const resolved = path.resolve(root, relative);
      return resolved.startsWith(`${root}${path.sep}`);
    })
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error(`No JUnit report matched ${reportGlob}`);
  }

  const cases: TestCaseResult[] = [];
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    if (statSync(absolute).size > maximumReportBytes) {
      throw new Error(`JUnit report ${relative} exceeded the 50 MB safety limit`);
    }
    cases.push(...parseJUnitXml(readFileSync(absolute, "utf8")));
  }

  return { results: summarize(cases), files };
}
