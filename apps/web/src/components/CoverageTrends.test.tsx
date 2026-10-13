// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppGroup, CoverageHistoryEntry } from "@qa-buddy/shared";
import { CoverageTrends, formatSpan } from "./CoverageTrends";

function entry(runId: string, day: number, appName: string, lines: number, branches: number): CoverageHistoryEntry {
  return {
    runId,
    appName,
    requestedRef: "main",
    resolvedSha: "abcdef1234",
    useLocalWorkingTree: false,
    dirty: false,
    recordedAt: `2026-10-0${day}T12:00:00.000Z`,
    coverage: {
      lines: { covered: lines, total: 100, percent: lines },
      statements: null,
      functions: null,
      branches: { covered: branches, total: 100, percent: branches }
    },
    tests: { total: 10, passed: 10, failed: 0 }
  };
}

const groups: AppGroup[] = [
  { id: "g-fe", repositoryId: "repo-1", name: "Frontend", appNames: ["@acme/web"], createdAt: "", updatedAt: "" }
];

function renderTrends(entries: CoverageHistoryEntry[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ entries }) }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  render(<CoverageTrends repositoryId="repo-1" groups={groups} refreshKey="run-2" />);
  return { fetchMock, user: userEvent.setup() };
}

const headline = () => document.querySelector(".trend-summary strong")?.textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CoverageTrends", () => {
  const history = [
    entry("run-1", 1, "@acme/web", 50, 40),
    entry("run-1", 1, "@acme/api", 70, 60),
    entry("run-2", 2, "@acme/web", 60, 46)
  ];

  it("defaults to the weighted branch total across all apps", async () => {
    const { fetchMock } = renderTrends(history);
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-1/coverage/history", expect.anything());
    await waitFor(() => expect(headline()).toBe("53.0%"));
    expect(screen.getByText("+3 pts since Oct 1")).toBeTruthy();
    expect(screen.getByText("No change since Oct 1")).toBeTruthy();
    expect(screen.getByText("1 day")).toBeTruthy();
    expect(screen.getByText(/Oct 1 – Oct 2.* · 2 runs/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Branches" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches metric and scopes to a saved group", async () => {
    const { user } = renderTrends(history);
    await waitFor(() => expect(headline()).toBe("53.0%"));

    await user.click(screen.getByRole("button", { name: "Lines" }));
    expect(headline()).toBe("65.0%");

    await user.click(screen.getByRole("tab", { name: "Frontend" }));
    expect(screen.getByText("Lines · Frontend")).toBeTruthy();
    expect(headline()).toBe("60.0%");
    const legend = screen.getByLabelText("Chart legend");
    expect(within(legend).queryByRole("button", { name: "api" })).toBeNull();
    expect(within(legend).getByRole("button", { name: "web" })).toBeTruthy();
  });

  it("falls back to gray lines with a focusable legend past eight apps", async () => {
    const many = Array.from({ length: 9 }, (_, index) => entry("run-1", 1, `@acme/app-${index}`, 50, 50));
    const { user } = renderTrends(many);
    await waitFor(() => expect(headline()).toBe("50.0%"));

    const lines = document.querySelectorAll(".trend-line-muted");
    expect(lines).toHaveLength(9);
    await user.click(screen.getByRole("button", { name: "app-3" }));
    expect(screen.getByRole("button", { name: "app-3" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.querySelector(".trend-line-focused")).not.toBeNull());
  });

  it("explains an empty group", async () => {
    const { user } = renderTrends([entry("run-1", 1, "@acme/api", 70, 60)]);
    await waitFor(() => expect(headline()).toBe("60.0%"));
    await user.click(screen.getByRole("tab", { name: "Frontend" }));
    expect(screen.getByText("No completed runs have reported coverage for Frontend yet.")).toBeTruthy();
  });

  it("rounds the time span to the unit a reader would use", () => {
    const from = "2026-01-01T00:00:00.000Z";
    const after = (days: number) => new Date(Date.parse(from) + days * 86_400_000).toISOString();
    expect(formatSpan(from, after(0.5))).toBe("Under a day");
    expect(formatSpan(from, after(1))).toBe("1 day");
    expect(formatSpan(from, after(21))).toBe("3 weeks");
    expect(formatSpan(from, after(75))).toBe("2 months");
    expect(formatSpan(from, after(365))).toBe("12 months");
    expect(formatSpan(from, after(600))).toBe("1.6 years");
  });
});
