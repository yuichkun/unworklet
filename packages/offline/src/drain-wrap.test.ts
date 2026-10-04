import * as core from "@unworklet/core";
import { defineProcessor, event, extractWorkletMeta, forSample, state } from "@unworklet/core";
import { expect, test, vi } from "vite-plus/test";

import { renderOffline } from "./index.ts";

for (const kind of ["event", "midi"] as const) {
  for (const seed of [0, 0x7ffffffe, -2]) {
    test.each([
      { capacity: 16, count: 2 },
      { capacity: 16, count: 18 },
      { capacity: 16, count: 0 },
    ] as const)(
      `${kind} drain at counter ${seed} preserves order and empties the ring: %j`,
      async ({ capacity, count }) => {
        const processor = defineProcessor(() => {
          const block = state.i32(0);
          const port =
            kind === "event"
              ? event<{ value: number }>({ to: "main", name: "wrap", capacity })
              : event.midi({ to: "main", name: "wrap", capacity });
          return {
            process() {
              forSample((i) => {
                if (kind === "event") {
                  (port as ReturnType<typeof event<{ value: number }>>).emitIf(i.lt(count), {
                    value: block.read().mul(32).add(i),
                    atSample: i,
                  });
                } else {
                  (port as ReturnType<typeof event.midi>).emitIf(i.lt(count), {
                    type: "noteOn",
                    channel: 0,
                    note: block.read().mul(32).add(i),
                    velocity: 100,
                    atSample: i,
                  });
                }
              });
              block.write(block.read().add(1));
            },
          };
        });
        let header: Int32Array | undefined;
        let memory: ArrayBufferLike | undefined;
        const compile = core.compile;
        const compileSpy = vi
          .spyOn(core, "compile")
          .mockImplementation(async (processor, options) => {
            const compiled = await compile(processor, options);
            const meta = extractWorkletMeta(
              compiled.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
            );
            const base = (
              kind === "event" ? meta.layout.regions.eventRings : meta.layout.regions.midiRings
            ).slots.wrap!.base;
            const instantiate = compiled.driver.instantiate.bind(compiled.driver);
            compiled.driver.instantiate = async () => {
              const instance = await instantiate();
              const buffer = instance.memory.buffer as ArrayBuffer;
              memory = buffer;
              header = new Int32Array(buffer, base, 3);
              header[0] = seed;
              header[1] = seed;
              return instance;
            };
            return compiled;
          });
        // Bound a broken synchronous drain so the regression fails without hanging the runner.
        let reads = 0;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the original DataView receiver below.
        const getInt32 = DataView.prototype.getInt32;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the original DataView receiver below.
        const getUint8 = DataView.prototype.getUint8;
        const intSpy = vi
          .spyOn(DataView.prototype, "getInt32")
          .mockImplementation(function (this: DataView, offset, littleEndian) {
            if (this.buffer === memory && ++reads > 512) throw new Error("unbounded ring drain");
            return getInt32.call(this, offset, littleEndian);
          });
        const byteSpy = vi
          .spyOn(DataView.prototype, "getUint8")
          .mockImplementation(function (this: DataView, offset) {
            if (this.buffer === memory && ++reads > 512) throw new Error("unbounded ring drain");
            return getUint8.call(this, offset);
          });
        try {
          const result = await renderOffline(processor, {
            sampleRate: 48000,
            duration: 384 / 48000,
          });
          const expected = Array.from({ length: 3 }, (_, block) =>
            Array.from({ length: Math.min(count, capacity) }, (_, index) => {
              const atSample = Math.max(0, count - capacity) + index;
              const value = block * 32 + atSample;
              return {
                name: "wrap",
                atSample,
                payload:
                  kind === "event"
                    ? { value }
                    : { type: "noteOn", channel: 0, note: value, velocity: 100 },
              };
            }),
          ).flat();
          expect(result.events).toEqual(expected);
          expect(Array.from(header!)).toEqual([
            (seed + 3 * count) | 0,
            (seed + 3 * count) | 0,
            3 * Math.max(0, count - capacity),
          ]);
        } finally {
          byteSpy.mockRestore();
          intSpy.mockRestore();
          compileSpy.mockRestore();
        }
      },
    );
  }
}
