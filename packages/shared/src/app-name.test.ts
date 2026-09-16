import { describe, expect, it } from "vitest";
import { shortAppName } from "./types.js";

describe("short application names", () => {
  it("drops a package scope so the picker stays readable", () => {
    expect(shortAppName("@idplans-platform/infuse-rhf")).toBe("infuse-rhf");
    expect(shortAppName("@idplans-platform/scout-ui")).toBe("scout-ui");
  });

  it("leaves an unscoped name alone", () => {
    expect(shortAppName("idcloud")).toBe("idcloud");
  });

  it("keeps the last segment of a deeper path", () => {
    expect(shortAppName("@scope/group/name")).toBe("name");
  });

  it("falls back to the original when there is no trailing segment", () => {
    expect(shortAppName("@idplans-platform/")).toBe("@idplans-platform/");
    expect(shortAppName("  idcloud  ")).toBe("idcloud");
  });
});
