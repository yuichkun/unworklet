/**
 * Black-box behavior: `buffer.<type>` scalar access (Stage 2).
 *
 * Each test builds a real processor through the public DSL surface, renders it
 * via the `compile`+`driver` harness, and asserts on output PCM only. Buffer
 * contents are observed by reading them back out to an `audioOutput` (memory is
 * not inspectable through the driver). Integer / i64 / bool / u8 reads are
 * surfaced through an `f32(...)` / `select(...)` conversion at the output.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioInput, audioOutput, buffer, state } from "../../dsl/declarations.ts";
import { bool, f32, f64, i32, i64 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { select } from "../../dsl/primitives.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("buffer.f32 write then read at the same index round-trips the value", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, f32(i).mul(0.01));
          out.ch(0).at(i).write(buf.read(i));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k * 0.01, 5);
  }
});

test("buffer.i32 round-trips an integer value (observed via f32)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.i32({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, i32(42));
          out
            .ch(0)
            .at(i)
            .write(f32(buf.read(i)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(42));
});

test("buffer.i64 round-trips a 64-bit value (observed via i32 → f32)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.i64({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, i64(2n ** 40n + 7n));
          out
            .ch(0)
            .at(i)
            .write(f32(i32(buf.read(i))));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  // 2^40 + 7 wrapped to i32 low 32 bits = 7.
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(7));
});

test("buffer.f64 round-trips a double value (observed via f32)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f64({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, 0.5);
          out
            .ch(0)
            .at(i)
            .write(f32(buf.read(i)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(0.5));
});

test("buffer.bool round-trips a boolean (observed via select)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.bool({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, bool(true));
          out
            .ch(0)
            .at(i)
            .write(select(buf.read(i), f32(1), f32(0)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(1));
});

test("buffer.u8 stores the low 8 bits and reads back through Node<i32>", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.u8({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          // 0x142 = 322; low 8 bits = 0x42 = 66.
          buf.write(i, i32(0x142));
          out
            .ch(0)
            .at(i)
            .write(f32(buf.read(i)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(66));
});

test("buffer.f32 readInterpolated linearly interpolates between two taps", async () => {
  // Fill buf[k] = k (a ramp), then sample it at the fractional position k/2.
  // Linear interpolation of an identity ramp at position p returns p, so the
  // output is the input position itself: out[k] = k/2. (At sample k the taps
  // floor(k/2) and floor(k/2)+1 are already written, both ≤ k.)
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, f32(i));
          out
            .ch(0)
            .at(i)
            .write(buf.readInterpolated(f32(i).mul(0.5)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k * 0.5, 4);
  }
});

test("buffer.f64 readInterpolated interpolates in the f64 domain", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f64({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, f64(i)); // buf[k] = k (f64)
          out
            .ch(0)
            .at(i)
            .write(f32(buf.readInterpolated(f32(i).mul(0.5))));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k * 0.5, 4);
  }
});

test("buffer.i32 readInterpolated reads the integer tap (frac 0) and surfaces it", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.i32({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, i32(i)); // buf[k] = k
          // integer position k → tap k exactly (frac 0); result truncates to i32.
          out
            .ch(0)
            .at(i)
            .write(f32(buf.readInterpolated(f32(i))));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k, 4);
  }
});

test("buffer.i64 readInterpolated interpolates a constant-filled buffer to that constant", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.i64({ size: 128 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(i, i64(100n)); // every cell = 100
          out
            .ch(0)
            .at(i)
            .write(f32(i32(buf.readInterpolated(f32(i).mul(0.5)))));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect([...outputs.main![0]!]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(100));
});

test("buffer ring delay: an impulse is delayed by 100 samples", async () => {
  const DELAY = 100;
  const SIZE = 128;
  const proc = defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: SIZE });
    const head = state.i32(0);
    return {
      process: () => {
        forSample((i) => {
          const h = head.read();
          // read (n - DELAY) mod SIZE = the sample written DELAY samples ago.
          const delayed = buf.read(h.add(i32(SIZE - DELAY)).mod(i32(SIZE)));
          buf.write(h, inp.ch(0).at(i));
          out.ch(0).at(i).write(delayed);
          // advance the write head last (= load-before-store discipline).
          head.write(h.add(i32(1)).mod(i32(SIZE)));
        });
      },
    };
  });
  const input = new Float32Array(SAMPLES_PER_BLOCK);
  input[0] = 1;
  const { outputs } = await render(proc, { inputs: { main: [input] } });
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(k === DELAY ? 1 : 0, 6);
  }
});

// literal な index / offset / pos は graph-capture 時に range-check されて隣接 memory
// access を防ぐ (= §3.2、dynamic Node<'i32'> は caller 責任)。
test("buffer literal index は範囲外を graph-capture で reject する", () => {
  const build = (body: (buf: ReturnType<typeof buffer.f32>) => void): (() => void) => {
    return () =>
      defineProcessor(() => {
        const buf = buffer.f32({ size: 8 });
        return { process: () => body(buf) };
      });
  };
  expect(build((buf) => buf.read(-1))).toThrow(/out of range/);
  expect(build((buf) => buf.read(8))).toThrow(/out of range/); // size = 8 = 上限外
  expect(build((buf) => buf.write(8, f32(1)))).toThrow(/out of range/);
  expect(build((buf) => buf.read(1.5))).toThrow(/out of range/); // 非整数
  // in-range は throw しない (= 0 と size-1)。
  expect(build((buf) => buf.read(0))).not.toThrow();
  expect(build((buf) => buf.read(7))).not.toThrow();
});
