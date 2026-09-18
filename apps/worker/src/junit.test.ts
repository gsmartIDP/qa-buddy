import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseJUnitXml, readJUnitResults } from "./junit.js";

// Shape that mocha-junit-reporter produces for a Cypress spec.
const cypressReport = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="3" failures="1" time="12.5">
  <testsuite name="Root Suite" timestamp="2026-09-18T00:00:00" tests="0" file="cypress/e2e/smoke/app.load.cy.js" time="0">
  </testsuite>
  <testsuite name="App Load" tests="3" failures="1" time="12.5">
    <testcase name="App Load should load app" classname="should load app" time="4.2"/>
    <testcase name="App Load should sign in" classname="should sign in" time="8.3">
      <failure message="Timed out retrying" type="AssertionError">Expected to find element</failure>
    </testcase>
    <testcase name="App Load pending check" classname="pending check" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

// Playwright's built-in JUnit reporter nests suites per file.
const playwrightReport = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites id="" name="" tests="2" failures="1" time="3">
  <testsuite name="login.spec.ts" timestamp="..." hostname="chromium" tests="2" failures="1">
    <testcase name="signs in" classname="login.spec.ts" time="1.5"/>
    <testcase name="rejects bad password" classname="login.spec.ts" time="1.5">
      <failure message="expect(received).toBe(expected)"/>
    </testcase>
  </testsuite>
</testsuites>`;

describe("JUnit parsing", () => {
  it("reads Cypress output including failures and skips", () => {
    const cases = parseJUnitXml(cypressReport);

    expect(cases).toHaveLength(3);
    expect(cases.map((entry) => entry.status)).toEqual(["passed", "failed", "skipped"]);
    expect(cases[0]?.durationMs).toBe(4200);
    expect(cases[1]?.failureMessage).toContain("Timed out retrying");
    expect(cases[1]?.failureMessage).toContain("Expected to find element");
    expect(cases[1]?.ancestorTitles).toContain("App Load");
  });

  it("reads Playwright output", () => {
    const cases = parseJUnitXml(playwrightReport);

    expect(cases).toHaveLength(2);
    expect(cases[0]?.name).toBe("signs in");
    expect(cases[0]?.filePath).toBe("login.spec.ts");
    expect(cases[1]?.status).toBe("failed");
    expect(cases[1]?.failureMessage).toContain("expect(received)");
  });

  it("rejects XML with no test suite", () => {
    expect(() => parseJUnitXml("<nothing/>")).toThrow("does not contain a testsuite");
  });

  it("rejects malformed XML", () => {
    expect(() => parseJUnitXml("<testsuite><unclosed>")).toThrow();
  });
});

describe("merging report files", () => {
  let directory = "";

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-junit-"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("merges every file a glob matches, as Cypress writes one per spec", async () => {
    mkdirSync(path.join(directory, "apps/web/results"), { recursive: true });
    writeFileSync(path.join(directory, "apps/web/results/a.xml"), cypressReport, "utf8");
    writeFileSync(path.join(directory, "apps/web/results/b.xml"), playwrightReport, "utf8");

    const { results, files } = await readJUnitResults(directory, "apps/web/results/*.xml");

    expect(files).toEqual(["apps/web/results/a.xml", "apps/web/results/b.xml"]);
    expect(results.total).toBe(5);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(2);
    expect(results.skipped).toBe(1);
  });

  it("fails with an actionable message when nothing matches", async () => {
    await expect(readJUnitResults(directory, "results/*.xml")).rejects.toThrow(
      "No JUnit report matched results/*.xml"
    );
  });
});
