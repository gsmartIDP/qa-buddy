// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerRestartBanner } from "./WorkerRestartBanner";

const run = { kind: "run", id: "0095cfc5-aaaa", repositoryId: "repo-1", repositoryName: "idplans-platform", status: "testing" };
const pending = (decision: "now" | "after-run" | null) => ({
  requestedAt: "2026-11-06T10:00:00.000Z",
  changedPaths: ["apps/worker/src/worker.ts"],
  decision,
  decidedAt: decision ? "2026-11-06T10:01:00.000Z" : null
});

function serve(state: () => unknown, posts: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(state()), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
}

const renderBanner = () =>
  render(
    <MemoryRouter>
      <WorkerRestartBanner pollMs={60_000} />
    </MemoryRouter>
  );

describe("worker restart banner", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("stays hidden when no restart is held", async () => {
    serve(() => ({ pending: null, activeWork: [] }));
    const { container } = renderBanner();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("asks whether to restart now, naming the run it would end", async () => {
    let decision: "now" | "after-run" | null = null;
    const posts: unknown[] = [];
    serve(() => ({ pending: pending(decision), activeWork: [run] }), posts);
    renderBanner();

    expect(await screen.findByText("QA Buddy's worker code changed while work is in progress.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Run 0095cfc5" }).getAttribute("href")).toBe("/runs/0095cfc5-aaaa");

    decision = "after-run";
    await userEvent.click(screen.getByRole("button", { name: "Restart when it finishes" }));
    expect(await screen.findByText(/will restart with new code when the current work finishes/)).toBeTruthy();

    decision = "now";
    await userEvent.click(screen.getByRole("button", { name: "Restart now instead" }));
    expect(await screen.findByText("Restarting the worker…")).toBeTruthy();
    expect(posts).toEqual([{ decision: "after-run" }, { decision: "now" }]);
  });
});
