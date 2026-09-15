import { describe, expect, it } from "vitest";
import { coverageSnapshotSkipReason } from "./worker.js";

describe("coverage snapshot eligibility", () => {
  const base = { useLocalWorkingTree: false, hasCoverage: true, fileCount: 12 };

  it("records a snapshot for a GitHub run with per-file coverage", () => {
    expect(coverageSnapshotSkipReason(base)).toBeNull();
  });

  it("never overwrites the snapshot from a local working tree run", () => {
    expect(coverageSnapshotSkipReason({ ...base, useLocalWorkingTree: true })).toBe("local-working-tree");
  });

  it("leaves the snapshot alone when the app produced no coverage", () => {
    expect(coverageSnapshotSkipReason({ ...base, hasCoverage: false })).toBe("no-coverage");
    // A failed local run is still reported as missing coverage first.
    expect(
      coverageSnapshotSkipReason({ useLocalWorkingTree: true, hasCoverage: false, fileCount: 0 })
    ).toBe("no-coverage");
  });

  it("leaves the snapshot alone when the report has no per-file entries", () => {
    expect(coverageSnapshotSkipReason({ ...base, fileCount: 0 })).toBe("no-files");
  });
});
