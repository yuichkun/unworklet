import { EventEmitter } from "node:events";
import type { Page, Request } from "playwright";
import { expect, test, vi } from "vite-plus/test";
import { createDevtoolsEvidence } from "./devtools-evidence.ts";

function fixture() {
  const page = Object.assign(new EventEmitter(), {
    isClosed: (): boolean => false,
    evaluate: vi.fn().mockResolvedValue({ connected: true, selector: true }),
  });
  const emit = vi.fn();
  const evidence = createDevtoolsEvidence(emit);
  evidence.watch("b", page as unknown as Page);
  return { page, emit, evidence };
}

test("retains only allowlisted metadata, including active request categories", async () => {
  const { page, emit, evidence } = fixture();
  const secret = "authToken=SECRET#connection";
  const request = { resourceType: () => "document", url: () => `http://localhost/?${secret}` };
  page.emit("request", request);
  page.emit("pageerror", new Error(secret));
  page.emit("console", { type: () => "error", text: () => secret });
  page.evaluate.mockResolvedValue({ connected: secret, selector: true, secret });
  evidence.stage("reload-disconnected");
  await evidence.report();
  const output = emit.mock.calls[0]![0];
  expect(output).not.toContain("SECRET");
  expect(JSON.parse(output)).toMatchObject({
    stage: "reload-disconnected",
    active: { b: { document: 1 } },
    readiness: [{ page: "b", closed: false, connected: false, selector: true }],
  });
  expect(output).toContain("pageerror");
  expect(output).toContain("console-error");
  evidence.dispose();
  expect(page.eventNames()).toEqual([]);
});

test("caps records and tracks completion without retaining request objects", async () => {
  const { page, emit, evidence } = fixture();
  const request = {
    url: () => "http://localhost/SECRET",
    resourceType: () => "unexpected secret",
  } as unknown as Request;
  page.emit("request", request);
  page.emit("requestfailed", request);
  for (let i = 0; i < 200; i++) page.emit("load");
  await evidence.report();
  const output = JSON.parse(emit.mock.calls[0]![0]);
  expect(output.records).toHaveLength(64);
  expect(output.dropped).toBeGreaterThan(0);
  expect(output.active.b.other).toBe(0);
  expect(JSON.stringify(output)).not.toContain("unexpected secret");
  evidence.dispose();
});

test("observer and output errors cannot replace the original failure", async () => {
  const { page, evidence, emit } = fixture();
  page.emit("request", {
    resourceType: () => {
      throw new Error("SECRET");
    },
  });
  page.evaluate.mockRejectedValue(new Error("SECRET"));
  emit.mockImplementation(() => {
    throw new Error("SECRET");
  });
  const original = new Error("original");
  const run = async () => {
    try {
      throw original;
    } catch (error) {
      await evidence.report();
      throw error;
    } finally {
      evidence.dispose();
    }
  };
  await expect(run()).rejects.toBe(original);
  expect(page.eventNames()).toEqual([]);
});

test("bounds stalled probes and cancels the deadline when probes finish", async () => {
  vi.useFakeTimers();
  try {
    const { page, evidence, emit } = fixture();
    page.evaluate.mockReturnValue(new Promise(() => {}));
    const report = evidence.report();
    await vi.advanceTimersByTimeAsync(200);
    await report;
    expect(JSON.parse(emit.mock.calls[0]![0]).readiness).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    evidence.dispose();
    const fast = fixture();
    await fast.evidence.report();
    expect(vi.getTimerCount()).toBe(0);
    fast.evidence.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("caps active tracking, categorizes only known routes, and discards query/hash values", async () => {
  const { page, emit, evidence } = fixture();
  for (let i = 0; i < 200; i++)
    page.emit("request", {
      resourceType: () => "script",
      url: () => "http://localhost/main.mjs?authToken=SECRET#SECRET",
    });
  await evidence.report();
  const output = JSON.parse(emit.mock.calls[0]![0]);
  expect(output.active.b.script).toBe(128);
  expect(output.untracked).toBe(72);
  expect(output.routes.b.app).toBe(128);
  expect(JSON.stringify(output)).not.toContain("SECRET");
  evidence.dispose();
});

test("does not emit on success and tolerates attachment and detachment errors", () => {
  const { page, emit, evidence } = fixture();
  evidence.watch("b", page as unknown as Page);
  page.off = () => {
    throw new Error("SECRET");
  };
  evidence.dispose();
  expect(emit).not.toHaveBeenCalled();
  const broken = Object.assign(new EventEmitter(), {
    on: () => {
      throw new Error("SECRET");
    },
  });
  const attachment = createDevtoolsEvidence(emit);
  expect(() => attachment.watch("a", broken as unknown as Page)).not.toThrow();
  attachment.dispose();
  expect(() => evidence.watch("a", broken as unknown as Page)).not.toThrow();
});

test("reports closed pages and probe errors without reading their messages", async () => {
  const { page, emit, evidence } = fixture();
  page.evaluate.mockRejectedValue(new Error("SECRET"));
  await evidence.report();
  expect(JSON.parse(emit.mock.calls[0]![0]).readiness).toEqual([
    { page: "b", closed: false, unavailable: true },
  ]);
  page.isClosed = () => true;
  await evidence.report();
  expect(JSON.parse(emit.mock.calls[1]![0]).readiness).toEqual([{ page: "b", closed: true }]);
  evidence.dispose();
});

test("browser disconnect and observer errors retain only generated labels", async () => {
  const { page, emit, evidence } = fixture();
  const browser = new EventEmitter();
  evidence.watchBrowser(browser as unknown as import("playwright").Browser);
  browser.emit("disconnected", new Error("SECRET"));
  page.emit("console", {
    type: () => {
      throw new Error("SECRET");
    },
  });
  await evidence.report();
  const output = JSON.parse(emit.mock.calls[0]![0]);
  expect(output.observerErrors).toBe(1);
  expect(
    output.records.some((record: { event: string }) => record.event === "browser-disconnected"),
  ).toBe(true);
  expect(JSON.stringify(output)).not.toContain("SECRET");
  evidence.dispose();
  expect(browser.eventNames()).toEqual([]);
});

test("the page probe returns booleans, never global or DOM values", async () => {
  const { page, emit, evidence } = fixture();
  vi.stubGlobal("devtoolsStatus", () => "SECRET");
  vi.stubGlobal("generation", "SECRET");
  vi.stubGlobal("document", { readyState: "SECRET", querySelector: () => ({ value: "SECRET" }) });
  try {
    page.evaluate.mockImplementation(async (fn: () => unknown) => fn());
    await evidence.report();
    const output = JSON.parse(emit.mock.calls[0]![0]);
    expect(output.readiness[0]).toMatchObject({
      connected: false,
      disconnected: false,
      connectionError: false,
      generationReady: false,
      documentReady: false,
      selector: true,
    });
    expect(JSON.stringify(output)).not.toContain("SECRET");
  } finally {
    vi.unstubAllGlobals();
    evidence.dispose();
  }
});

test("recognizes panel and Vite routes and tolerates untracked completions", async () => {
  const { page, emit, evidence } = fixture();
  for (const pathname of ["/__unworklet/assets/app.js", "/@vite/client", "/@id/client"])
    page.emit("request", {
      resourceType: () => "script",
      url: () => `http://localhost${pathname}?SECRET`,
    });
  page.emit("requestfinished", {});
  await evidence.report();
  expect(JSON.parse(emit.mock.calls[0]![0]).routes.b).toEqual({ panel: 1, vite: 2 });
  const listener = page.listeners("load")[0]!;
  evidence.dispose();
  listener();
  await evidence.report();
  expect(JSON.parse(emit.mock.calls[1]![0]).records).toEqual(
    JSON.parse(emit.mock.calls[0]![0]).records,
  );
});

test("a late probe cannot emit again or leak a payload after the deadline", async () => {
  vi.useFakeTimers();
  try {
    const { page, emit, evidence } = fixture();
    let resolve!: (value: unknown) => void;
    page.evaluate.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const report = evidence.report();
    await vi.advanceTimersByTimeAsync(200);
    await report;
    expect(JSON.parse(emit.mock.calls[0]![0]).probeTimedOut).toBe(true);
    evidence.dispose();
    resolve({ connected: "SECRET", selector: "SECRET" });
    await vi.runAllTimersAsync();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).not.toContain("SECRET");
  } finally {
    vi.useRealTimers();
  }
});
