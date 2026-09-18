import { describe, expect, it } from "vitest";
import { environmentPassThroughMessages } from "./worker.js";

describe("environment pass-through reporting", () => {
  it("says nothing when the repository allowlists nothing", () => {
    expect(environmentPassThroughMessages([], {})).toEqual([]);
  });

  it("names the variables that reached the runner", () => {
    const [summary, ...rest] = environmentPassThroughMessages(
      ["CYPRESS_username", "GITHUB_IDP_REGISTRY"],
      { CYPRESS_username: "someone", GITHUB_IDP_REGISTRY: "ghp_x" }
    );
    expect(summary).toContain("2 of 2");
    expect(summary).toContain("CYPRESS_username");
    expect(rest).toEqual([]);
  });

  it("calls out allowlisted variables the worker has no value for", () => {
    const messages = environmentPassThroughMessages(
      ["CYPRESS_username", "CYPRESS_idInspectBaseUrl"],
      { CYPRESS_username: "someone" }
    );
    expect(messages[0]).toContain("1 of 2");
    expect(messages[1]).toContain("CYPRESS_idInspectBaseUrl");
    expect(messages[1]).toContain("force-recreate");
  });

  it("never reports values, only names", () => {
    const messages = environmentPassThroughMessages(["SECRET_NAME"], { SECRET_NAME: "super-secret" });
    expect(messages.join(" ")).not.toContain("super-secret");
  });

  it("ignores the reserved clone token", () => {
    expect(environmentPassThroughMessages(["GITHUB_TOKEN"], {})).toEqual([]);
  });
});
