// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoverageFileRow, CoverageSnapshot } from "@qa-buddy/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CoverageGapsPage } from "./CoverageGapsPage";

const repositoryId = "repository-1";

const metric = (covered: number, total: number) => ({
  covered,
  total,
  percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10
});

function snapshot(appName: string): CoverageSnapshot {
  return {
    repositoryId,
    appName,
    runId: "run-1",
    resolvedSha: "0123456789abcdef",
    coverageFormat: "istanbul-summary-json",
    coveragePath: "coverage/coverage-summary.json",
    fileCount: 2,
    capturedAt: "2026-09-09T12:00:00.000Z",
    summary: {
      lines: metric(5, 10),
      statements: null,
      functions: null,
      branches: metric(1, 4)
    }
  };
}

const files: CoverageFileRow[] = [
  { appName: "Web", path: "src/gap.ts", lines: metric(0, 10), statements: null, functions: null, branches: metric(0, 6) },
  { appName: "Web", path: "src/partial.ts", lines: metric(5, 10), statements: null, functions: null, branches: metric(2, 6) }
];

function renderPage(snapshots: CoverageSnapshot[] = [snapshot("Web"), snapshot("API")]) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const body = url.includes("/coverage/files")
      ? { files, total: files.length, limit: 100, offset: 0 }
      : url.endsWith("/coverage")
        ? { snapshots }
        : { repository: { id: repositoryId, name: "Platform", runs: [], selectableApps: [] } };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={[`/repositories/${repositoryId}/coverage`]}>
      <Routes>
        <Route path="/repositories/:repositoryId/coverage" element={<CoverageGapsPage />} />
      </Routes>
    </MemoryRouter>
  );
  return { requests, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("coverage gaps page", () => {
  it("lists each app snapshot and ranks files by branch coverage by default", async () => {
    const { requests } = renderPage();

    await screen.findByText("src/gap.ts");
    expect(screen.getByText("src/partial.ts")).toBeTruthy();
    expect(screen.getAllByText("Web").length).toBeGreaterThan(0);
    expect(screen.getAllByText("API").length).toBeGreaterThan(0);

    await waitFor(() =>
      expect(requests.some((url) => url.includes("metric=branches"))).toBe(true)
    );
  });

  it("explains how to populate the view when no snapshot exists", async () => {
    renderPage([]);
    await screen.findByText("No coverage snapshots yet");
    expect(screen.queryByText("src/gap.ts")).toBeNull();
  });

  it("requests a new ranking when the threshold filter changes", async () => {
    const { requests, user } = renderPage();
    await screen.findByText("src/gap.ts");

    await user.selectOptions(screen.getByLabelText("Threshold"), "50");

    await waitFor(() => expect(requests.some((url) => url.includes("maxPercent=50"))).toBe(true));
  });

  it("scopes the ranking to one app", async () => {
    const { requests, user } = renderPage();
    await screen.findByText("src/gap.ts");

    await user.selectOptions(screen.getByLabelText("App"), "API");

    await waitFor(() => expect(requests.some((url) => url.includes("app=API"))).toBe(true));
  });
});
