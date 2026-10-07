import { describe, expect, it } from "vitest";
import { RetryPolicy } from "./retry-policy";

describe("RetryPolicy", () => {
  it("replays only failures proven to happen before dispatch", () => {
    const policy = new RetryPolicy();
    expect(policy.canReplay({ kind: "PRE_DISPATCH" })).toBe(true);
    expect(policy.canReplay({ kind: "ACK_UNKNOWN" })).toBe(false);
    expect(policy.canReplay({ kind: "UPSTREAM_ERROR" })).toBe(false);
    expect(policy.canReplay({ kind: "POST_DISPATCH" })).toBe(false);
  });

  it("defaults unknown failure classifications to no replay", () => {
    const policy = new RetryPolicy();
    expect(policy.canReplay({ kind: "SOMETHING_NEW" } as never)).toBe(false);
  });
});
