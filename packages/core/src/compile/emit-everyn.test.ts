import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts";
import { f32 } from "../dsl/constructors.ts";
import { audioOutput, noiseSource } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";
import type { Layout } from "./layout.ts";

async function scheduler(divisor: number, stride = 1) {
  const compiled = await compile(
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "out" });
      return {
        process: () => {
          forSample((i) => out.ch(0).at(i).write(f32(0)));
          forSample.byN(stride, (i, every) => {
            every(divisor, () => out.ch(0).at(i).write(f32(1)));
          });
        },
      };
    }),
  );
  const instance = await compiled.driver.instantiate();
  const layout = compiled.memory as unknown as Layout;
  const offset = Object.values(layout.regions.everyNSamplesCounters.slots)[0]!;
  const output = new Float32Array(128);
  return {
    instance,
    offset,
    output,
    render: () => {
      instance.process();
      instance.readOutput("out", 0, output);
      return [...output];
    },
  };
}

test.each([
  1,
  3,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 32 + 1,
  Number.MAX_SAFE_INTEGER,
  2 ** 53,
  2 ** 64,
  2 ** 100,
  Number.MAX_VALUE,
])("divisor %s keeps its accepted period without truncation or traps", async (divisor) => {
  const run = await scheduler(divisor);
  for (let block = 0; block < 3; block++) {
    expect(run.render()).toEqual(
      Array.from({ length: 128 }, (_, i) =>
        BigInt(block * 128 + i) % BigInt(divisor) === 0n ? 1 : 0,
      ),
    );
  }
});

test.each([1, 2, 4, 8, 16, 32, 64, 128])(
  "stride %s retains the intersection of sample and divisor cadence",
  async (stride) => {
    for (const divisor of [1, 3, 48, 256, 2 ** 32 + 1]) {
      const run = await scheduler(divisor, stride);
      for (let block = 0; block < 3; block++) {
        expect(run.render()).toEqual(
          Array.from({ length: 128 }, (_, i) =>
            i % stride === 0 && BigInt(block * 128 + i) % BigInt(divisor) === 0n ? 1 : 0,
          ),
        );
      }
    }
  },
);

test.each([
  [3, 0n],
  [3, 1n],
  [3, 2n],
  [2 ** 32 - 1, 3n],
  [2 ** 32, 3n],
  [2 ** 32 + 1, 3n],
  [2 ** 32 + 1, 2n ** 32n],
  [2 ** 64, 2n ** 32n],
  [2 ** 100, 2n ** 64n],
  [Number.MAX_VALUE, 2n ** 992n],
] as const)("divisor %s advances a remaining countdown of %s exactly", async (divisor, seed) => {
  const run = await scheduler(divisor);
  const view = new DataView(run.instance.memory.buffer);
  let remaining = seed;
  let word = 0;
  do {
    view.setUint32(run.offset + word * 4, Number(remaining & 0xffff_ffffn), true);
    remaining >>= 32n;
    word++;
  } while (remaining > 0n);
  remaining = seed;
  for (let block = 0; block < 3; block++) {
    const expected = Array.from({ length: 128 }, () => {
      const fires = remaining === 0n;
      remaining = fires ? BigInt(divisor) - 1n : remaining - 1n;
      return fires ? 1 : 0;
    });
    expect(run.render()).toEqual(expected);
    let actual = 0n;
    const words = Math.max(1, Math.ceil((BigInt(divisor) - 1n).toString(2).length / 32));
    for (let index = words - 1; index >= 0; index--) {
      actual = (actual << 32n) | BigInt(view.getUint32(run.offset + index * 4, true));
    }
    expect(actual).toBe(remaining);
  }
});

test("nested and independent schedulers retain separate invocation phases", async () => {
  const compiled = await compile(
    defineProcessor(() => {
      const out = audioOutput({ channels: 2, name: "out" });
      return {
        process: () =>
          forSample((i, every) => {
            out.ch(0).at(i).write(f32(0));
            out.ch(1).at(i).write(f32(0));
            every(3, () => every(5, () => out.ch(0).at(i).write(f32(1))));
            every(7, () => out.ch(1).at(i).write(f32(1)));
          }),
      };
    }),
  );
  const instance = await compiled.driver.instantiate();
  for (let block = 0; block < 3; block++) {
    instance.process();
    for (const [channel, period] of [15, 7].entries()) {
      const output = new Float32Array(128);
      instance.readOutput("out", channel, output);
      expect([...output]).toEqual(
        Array.from({ length: 128 }, (_, i) => ((block * 128 + i) % period === 0 ? 1 : 0)),
      );
    }
  }
});

test("counter storage stays compact and does not overlap adjacent counters or noise state", async () => {
  const compiled = await compile(
    defineProcessor(() => {
      noiseSource({ seed: 123 });
      return {
        process: () =>
          forSample((_, every) => {
            every(3, () => {});
            every(2 ** 32, () => {});
            every(2 ** 32 + 1, () => {});
            every(Number.MAX_VALUE, () => {});
            every(5, () => {});
          }),
      };
    }),
  );
  const layout = compiled.memory as unknown as Layout;
  const offsets = Object.values(layout.regions.everyNSamplesCounters.slots);
  const base = offsets[0]!;
  expect(offsets.map((offset) => offset - base)).toEqual([0, 4, 8, 16, 144]);
  expect(layout.regions.noiseSources!.base).toBe(base + 148);
  const instance = await compiled.driver.instantiate();
  instance.process();
  instance.process();
  const view = new DataView(instance.memory.buffer);
  expect(view.getUint32(offsets[4]!, true)).toBe(4);
  expect(view.getUint32(layout.regions.noiseSources!.base, true)).toBe(123);
});
