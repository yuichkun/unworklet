/**
 * Black-box tests for `forIndex(count, cb)`: a loop whose trip count is fixed
 * by `count`, not by the render quantum the processor is compiled for.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { compile } from "../../compile/index.ts";
import { audioOutput, state } from "../../dsl/declarations.ts";
import { f32 } from "../../dsl/constructors.ts";
import { forIndex, forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

const QUANTA = [32, 128, 256, 441];

/** A processor that runs `count` increments per call, then writes the running total to every sample. */
const counting = (count: number) =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const total = state.f32(0);
    return {
      process: () => {
        forIndex(count, () => {
          total.write(total.read().add(1));
        });
        forSample((i) => out.ch(0).at(i).write(total.read()));
      },
    };
  });

test("forIndex runs exactly count times per call at every render quantum", async () => {
  for (const q of QUANTA) {
    const { outputs } = await render(counting(5), { renderQuantumSize: q, blocks: 3 });
    const out = outputs.main![0]!;
    expect(out.length).toBe(3 * q);
    for (let block = 0; block < 3; block++) {
      expect(Array.from(out.subarray(block * q, (block + 1) * q))).toEqual(
        Array.from({ length: q }, () => 5 * (block + 1)),
      );
    }
  }
});

test("forIndex accepts a count larger than the render quantum", async () => {
  const { outputs } = await render(counting(300), { renderQuantumSize: 32 });
  expect(outputs.main![0]![31]).toBe(300);
});

test("forIndex's index counts 0 through count - 1", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sum = state.f32(0);
    return {
      process: () => {
        sum.write(f32(0));
        forIndex(10, (k) => {
          sum.write(sum.read().add(f32(k)));
        });
        forSample((i) => out.ch(0).at(i).write(sum.read()));
      },
    };
  });
  const { outputs } = await render(proc, { renderQuantumSize: 64 });
  expect(outputs.main![0]![0]).toBe(45);
});

test("a bin loop over a buffer keeps its length when the quantum changes", async () => {
  // 64 bins written then summed per call: 2 * (0 + … + 63) = 4032, whatever the quantum.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const bins = state.buffer.f32({ size: 64 });
    const sum = state.f32(0);
    return {
      process: () => {
        forIndex(64, (k) => bins.write(k, f32(k).mul(2)));
        sum.write(f32(0));
        forIndex(64, (k) => {
          sum.write(sum.read().add(bins.read(k)));
        });
        forSample((i) => out.ch(0).at(i).write(sum.read()));
      },
    };
  });
  for (const q of [32, 128, 256]) {
    const { outputs } = await render(proc, { renderQuantumSize: q });
    expect(outputs.main![0]![q - 1]).toBe(4032);
  }
});

test("forIndex nested in forSample repeats per sample, and forSample nested in forIndex repeats per index", async () => {
  const proc = defineProcessor(() => {
    const perSample = audioOutput({ channels: 1, name: "perSample" });
    const perIndex = audioOutput({ channels: 1, name: "perIndex" });
    const a = state.f32(0);
    const b = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          forIndex(3, () => {
            a.write(a.read().add(1));
          });
          perSample.ch(0).at(i).write(a.read()); // 3 * (i + 1) on the first call
        });
        forIndex(2, () => {
          forSample(() => {
            b.write(b.read().add(1));
          });
        });
        forSample((i) => perIndex.ch(0).at(i).write(b.read()));
      },
    };
  });
  const q = 32;
  const { outputs } = await render(proc, { renderQuantumSize: q });
  expect(Array.from(outputs.perSample![0]!)).toEqual(
    Array.from({ length: q }, (_, k) => 3 * (k + 1)),
  );
  expect(outputs.perIndex![0]![0]).toBe(2 * q);
});

test("an outer forIndex index still resolves inside a nested loop body", async () => {
  const proc = defineProcessor((ctx) => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sum = state.f32(0);
    return {
      process: () => {
        sum.write(f32(0));
        forIndex(4, (k) => {
          // Runs once per index (stride == quantum, so j == 0): sum = 0 + 1 + 2 + 3.
          forSample.byN(ctx.renderQuantumSize, (j) => {
            sum.write(sum.read().add(f32(k)).add(f32(j)));
          });
        });
        forSample((i) => out.ch(0).at(i).write(sum.read()));
      },
    };
  });
  const { outputs } = await render(proc, { renderQuantumSize: 64 });
  expect(outputs.main![0]![0]).toBe(6);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
  "compile rejects forIndex count %s",
  async (count) => {
    await expect(compile(counting(count))).rejects.toThrow(/\[illegal-forindex-count\]/);
  },
);

test("compile accepts the largest forIndex count, 2^31 - 1", async () => {
  const result = await compile(counting(2 ** 31 - 1));
  expect(result.diagnostics).toEqual([]);
});

test("everyNSamples inside a forIndex body is rejected at capture", () => {
  expect(() =>
    defineProcessor(() => ({
      process: () => {
        forSample((_i, everyNSamples) => {
          forIndex(4, () => {
            everyNSamples(2, () => {});
          });
        });
      },
    })),
  ).toThrow(/everyNSamples\(\.\.\.\) inside a forIndex body[\s\S]*'scope-violation'/);
});
