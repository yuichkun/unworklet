// Verify the Lifecycle state machine + transition rules from
// docs/05-client §4 / draft_spec §11. Terminal states (disposed, errored)
// don't transition further; listeners fire on every state change.
import { describe, expect, test } from "vite-plus/test";
import { Lifecycle } from "@unworklet/client";

describe("Lifecycle state machine", () => {
  test("creating → ready → running → disposed", () => {
    const lc = new Lifecycle();
    const seen: string[] = [];
    lc.on((s) => seen.push(s));
    expect(lc.state).toBe("creating");
    lc.transition("ready");
    lc.transition("running");
    lc.transition("disposed");
    expect(lc.state).toBe("disposed");
    expect(seen).toEqual(["ready", "running", "disposed"]);
  });

  test("disposed is terminal — no further transitions", () => {
    const lc = new Lifecycle();
    lc.transition("ready");
    lc.transition("disposed");
    lc.transition("running");
    expect(lc.state).toBe("disposed");
  });

  test("errored is terminal — no further transitions", () => {
    const lc = new Lifecycle();
    lc.transition("errored");
    lc.transition("ready");
    lc.transition("running");
    expect(lc.state).toBe("errored");
  });

  test("identity transitions don't notify listeners", () => {
    const lc = new Lifecycle();
    lc.transition("ready");
    let n = 0;
    lc.on(() => n++);
    lc.transition("ready"); // no change
    expect(n).toBe(0);
  });

  test("listener errors don't break the chain", () => {
    const lc = new Lifecycle();
    const seen: string[] = [];
    lc.on(() => {
      throw new Error("first listener boom");
    });
    lc.on((s) => seen.push(s));
    lc.transition("ready");
    expect(seen).toEqual(["ready"]);
  });
});
