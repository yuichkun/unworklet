import { expect, test } from "vite-plus/test";
import { BoundaryTrace } from "./restoreBoundaryTrace.ts";

test("boundary recorder retains exact numeric rows and explicitly reports truncation", () => {
  const trace = new BoundaryTrace(2);
  const storage = trace.rows;
  trace.record(1, 7, 57728, 3, 0, 0, 1, 0, 1);
  trace.record(2, 7, 57728, 3, 128, 0, 1, 0, 0);
  trace.record(2, 7, 57856, 3, 128, 1, 1, 1, 1);
  expect(trace.rows).toBe(storage);
  expect(trace.used).toBe(2);
  expect(trace.dropped).toBe(1);
  expect(Array.from(trace.rows)).toEqual([
    1, 7, 57728, 3, 0, 0, 1, 0, 1, 2, 7, 57728, 3, 128, 0, 1, 0, 0,
  ]);
});

test("boundary recorder keeps unavailable native observations distinct from zero", () => {
  const trace = new BoundaryTrace(1);
  trace.record(3, 8, 57728, 1, 0, NaN, 0, NaN, 1);
  expect(Number.isNaN(trace.rows[5])).toBe(true);
  expect(Number.isNaN(trace.rows[7])).toBe(true);
  expect(trace.rows[4]).toBe(0);
});

// This models input arrays, not Chromium's native AudioParam implementation.
for (const transport of ["sab", "postMessage"] as const) {
  test(`boundary recorder (${transport}) separates ordered commit from a stale input quantum`, async () => {
    const { compile } = await import("./compile/index.ts");
    const { restoreFrozenCounter } =
      await import("./__tests__/browser/fixtures/restore-frozen-counter.processor.ts");
    const { wasm } = await compile(restoreFrozenCounter);
    const replies: Array<Record<string, unknown>> = [];
    let receive: (event: MessageEvent) => void = () => {};
    const self = {
      port: {
        postMessage(message: Record<string, unknown>) {
          replies.push(message);
        },
        addEventListener(_kind: string, listener: (event: MessageEvent) => void) {
          receive = listener;
        },
        start() {},
      },
    };
    const send = (data: unknown): void => receive({ data } as MessageEvent);
    restoreFrozenCounter.worklet.initialize(self as never, {
      processorOptions: { wasm, transport, boundaryTrace: true },
    });
    expect(replies.at(-1)?.kind).toBe("ready");
    const outputs = [[new Float32Array(128)]];
    const frozen = { freeze: new Float32Array([1]) };
    const stale = { freeze: new Float32Array([0]) };
    restoreFrozenCounter.worklet.process(self as never, [], outputs, frozen);
    send({ kind: "snapshot-request", requestId: 1 });
    const slots = replies.at(-1)!.slots;
    expect(slots).toBeInstanceOf(Array);
    restoreFrozenCounter.worklet.process(self as never, [], outputs, stale);
    send({ kind: "restore-prepare", requestId: 2, slots });
    send({ kind: "restore-barrier", requestId: 2 });
    send({ kind: "restore", requestId: 2, slots });
    expect(replies.at(-1)?.kind).toBe("restore-done");
    const replyCount = replies.length;
    restoreFrozenCounter.worklet.process(self as never, [], outputs, stale);
    expect(outputs[0]![0]![127]).toBe(128);
    restoreFrozenCounter.worklet.process(self as never, [], outputs, frozen);
    expect(outputs[0]![0]![127]).toBe(128);
    expect(replies.length).toBe(replyCount);
    send({ kind: "boundary-trace-flush" });
    const dump = replies.at(-1)!;
    expect(dump.kind).toBe("boundary-trace-result");
    expect(dump.dropped).toBe(0);
    const rows = dump.rows as Float64Array;
    const phases = Array.from({ length: dump.used as number }, (_, i) =>
      Array.from(rows.slice(i * 9, i * 9 + 9)),
    );
    expect(phases.filter((row) => row[0]! >= 20 && row[0]! < 30).map((row) => row[0])).toEqual([
      20, 21, 22, 23, 24,
    ]);
    expect(phases.find((row) => row[0] === 24)?.slice(1, 5)).toEqual([2, -1, 3, 0]);
    expect(phases.filter((row) => row[0] === 31).map((row) => [row[3], row[4], row[5]])).toEqual([
      [0, 0, 1],
      [0, 128, 0],
      [3, 128, 0],
      [3, 128, 1],
    ]);
  });
}
