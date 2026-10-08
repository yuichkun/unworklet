import { afterEach, expect, test, vi } from "vite-plus/test";
import { flushBoundaryTrace } from "./__tests__/browser/fixtures/boundary-trace-flush.ts";

afterEach(() => vi.useRealTimers());

function makePort() {
  let receive: (event: MessageEvent) => void = () => {};
  return {
    addEventListener: vi.fn((_kind: "message", listener: (event: MessageEvent) => void) => {
      receive = listener;
    }),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    reply(data: unknown) {
      receive({ data } as MessageEvent);
    },
  };
}

for (const method of ["addEventListener", "postMessage"] as const) {
  test(`trace flush ${method} failure cannot replace an assertion or skip original cleanup`, async () => {
    vi.useFakeTimers();
    const port = makePort();
    port[method].mockImplementation(() => {
      throw new Error("port unavailable");
    });
    const original = new Error("original zero-count assertion");
    const cleanup = vi.fn();
    let traceResult: unknown;
    const run = async () => {
      try {
        throw original;
      } finally {
        try {
          traceResult = await flushBoundaryTrace(port);
        } finally {
          cleanup();
        }
      }
    };
    await expect(run()).rejects.toBe(original);
    expect(traceResult).toEqual({ error: "trace flush failed" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(port.removeEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
}

test("trace flush timeout removes its listener and returns missing evidence", async () => {
  vi.useFakeTimers();
  const port = makePort();
  const pending = flushBoundaryTrace(port);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toEqual({ error: "trace flush timed out" });
  expect(port.removeEventListener).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("trace flush serializes only used rows and ignores unrelated replies", async () => {
  vi.useFakeTimers();
  const port = makePort();
  const pending = flushBoundaryTrace(port);
  port.reply({ kind: "restore-done" });
  port.reply({
    kind: "boundary-trace-result",
    rows: new Float64Array(18).fill(2),
    used: 1,
    dropped: 0,
  });
  await expect(pending).resolves.toEqual({
    kind: "boundary-trace-result",
    rows: Array(9).fill(2),
    used: 1,
    dropped: 0,
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("trace reply decode and listener cleanup exceptions become diagnostic failures", async () => {
  vi.useFakeTimers();
  const port = makePort();
  port.removeEventListener.mockImplementation(() => {
    throw new Error("remove failed");
  });
  const pending = flushBoundaryTrace(port);
  port.reply({ kind: "boundary-trace-result", rows: null, used: 1, dropped: 0 });
  await expect(pending).resolves.toEqual({
    error: "trace reply decode failed",
    cleanupError: "trace listener removal failed",
  });
  expect(vi.getTimerCount()).toBe(0);
});
