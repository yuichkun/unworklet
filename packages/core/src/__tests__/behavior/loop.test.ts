/**
 * Black-box tests for forSample.byN + everyNSamples (`01-dsl.md` §10 + §9, Q43).
 *
 * Pure audio-thread loop primitives with no cross-thread transport — verified by
 * directly observing output PCM through a compile + driver black-box harness
 * (no browser e2e required).
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput, state } from "../../dsl/declarations.ts";
import { f32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { compile } from "../../compile/index.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("forSample.byN(4) executes body every 4 samples (comb pattern)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(f32(0)); // zero all samples
        });
        forSample.byN(4, (i) => {
          out.ch(0).at(i).write(f32(1)); // write 1 every 4 samples
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBe(k % 4 === 0 ? 1 : 0);
  }
});

test("forSample.byN(1) executes body on every sample (equivalent to stride 1)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample.byN(1, (i) => {
          out.ch(0).at(i).write(f32(i).mul(0.01));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k * 0.01, 5);
  }
});

test("forSample.byN(8) carries state across block boundaries (cross-block stride)", async () => {
  // byN(8) increments counter by 1 — 16 times per block. After 2 blocks: 32. Output = counter.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const count = state.i32(0);
    return {
      process: () => {
        forSample.byN(8, () => {
          count.write(count.read().add(1));
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(count.read()));
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 2 });
  // outputs.main[0] = flat array for ch0 (blocks × 128). block 1 = [0..127], block 2 = [128..255].
  // byN(8) fires 16 times per block. Counter after block 1 = 16, after block 2 = 32.
  expect(outputs.main![0]![0]).toBe(16);
  expect(outputs.main![0]![128]).toBe(32);
});

test("everyNSamples(32) executes sub-block every 32 samples with zero-order hold between fires", async () => {
  // everyNSamples(32) increments counter by 1 — 4 times per 128-sample block (at samples 0/32/64/96).
  // Output = held counter value → staircase 1,2,3,4.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const c = state.i32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(32, () => {
            c.write(c.read().add(1));
          });
          out.ch(0).at(i).write(f32(c.read()));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(1);
  expect(outputs.main![0]![31]).toBe(1);
  expect(outputs.main![0]![32]).toBe(2);
  expect(outputs.main![0]![63]).toBe(2);
  expect(outputs.main![0]![64]).toBe(3);
  expect(outputs.main![0]![96]).toBe(4);
  expect(outputs.main![0]![127]).toBe(4);
});

test("everyNSamples counter persists across block boundaries (non-block-aligned divisor)", async () => {
  // everyNSamples(48) does not evenly divide 128. When the counter persists across blocks,
  // fire positions shift each block (= global 0, 48, 96, then [block2] 144=local 16, ...).
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const c = state.i32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(48, () => {
            c.write(c.read().add(1));
          });
          out.ch(0).at(i).write(f32(c.read()));
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 2 });
  const ch = outputs.main![0]!;
  // block1: fires at 0,48,96 → counter 1,2,3. block2 (global 128..255): next fire at
  // global 144 (= block2 sample 16) → counter becomes 4. block2 samples 0..15 = 3 (held).
  expect(ch[0]).toBe(1);
  expect(ch[47]).toBe(1);
  expect(ch[48]).toBe(2);
  expect(ch[96]).toBe(3);
  expect(ch[128]).toBe(3); // block2 sample 0 = held 3 (= 128%48 = 32 ≠ 0)
  expect(ch[128 + 16]).toBe(4); // global 144 = 48×3 fires here
});

test("forSample.byN rejects a stride that does not evenly divide 128 at compile time", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample.byN(3, (i) => {
          out.ch(0).at(i).write(f32(0));
        });
      },
    };
  });
  await expect(compile(proc)).rejects.toThrow(/illegal-stride/);
});

// Per §9.5, the N in everyNSamples(N) must be a positive integer known at compile time.
// N=0 would emit i32.rem_u(counter, 0), causing a division trap on the audio thread;
// negative or non-integer values are likewise invalid.
// → The analyzer rejects these at compile time, preventing them from reaching the audio thread.
const everyN = (n: number) =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const acc = state.f32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(n, () => {
            acc.write(acc.read().add(f32(1)));
          });
          out.ch(0).at(i).write(acc.read());
        });
      },
    };
  });

test("everyNSamples(0) is rejected at compile time (prevents division-by-zero trap on the audio thread)", async () => {
  await expect(compile(everyN(0))).rejects.toThrow(/illegal-everyn-divisor/);
});

test("everyNSamples rejects negative or non-integer N at compile time (§9.5 requires a positive integer)", async () => {
  await expect(compile(everyN(-2))).rejects.toThrow(/illegal-everyn-divisor/);
  await expect(compile(everyN(3.5))).rejects.toThrow(/illegal-everyn-divisor/);
});

test("everyNSamples(1) is valid (executes every sample) and passes compilation", async () => {
  // N=1 is the minimum valid value (need not divide 128 evenly, per §9.5) and must not be rejected.
  await expect(compile(everyN(1))).resolves.toBeDefined();
});
