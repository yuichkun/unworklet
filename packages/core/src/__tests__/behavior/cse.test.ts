/**
 * Black-box behavior: shared-subtree / mutable-read evaluation order
 * (`03-compiler.md` §2.7, issue #8).
 *
 * A `state.load()` / `buffer.read()` captures the slot value at the lexical
 * point of the load — a later `store()` must NOT change what an already-bound
 * `Node` evaluates to. The naive lazy emit re-walks the read after the store
 * and observes the post-store value (the bug). These tests pin the correct
 * "value frozen at capture point" semantics through output PCM only.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioInput, audioOutput, buffer, state } from "../../dsl/declarations.ts";
import { f32, num, select, type Node, type State } from "../../index.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("§2.7: a Node bound before store() keeps its pre-store value (single reference)", async () => {
  // const y = s.load().add(10); s.store(100); out.write(y)
  // Block 0: s starts 0 → y = 0 + 10 = 10 (NOT 110). Then s := 100.
  // Block 1: s is 100 → y = 100 + 10 = 110. Then s := 100 again.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const s = state.f32(0);
    return {
      process: () => {
        const y = s.load().add(10);
        s.store(100);
        forSample((i) => {
          out.ch(0).at(i).write(y);
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 2 });
  // Block 0 = 10 everywhere (the bug would yield 110 here).
  expect(outputs.main![0]![0]).toBeCloseTo(10, 5);
  expect(outputs.main![0]![SAMPLES_PER_BLOCK - 1]).toBeCloseTo(10, 5);
  // Block 1 = 110 (s is now 100).
  expect(outputs.main![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(110, 5);
});

test("biquad Direct Form II Transposed impulse response matches a JS reference", async () => {
  const b0 = 0.5,
    b1 = 0.3,
    b2 = 0.1,
    a1 = -0.2,
    a2 = 0.05;

  function biquadDFIIT(x: Node<"f32">, z1: State<"f32">, z2: State<"f32">): Node<"f32"> {
    const y = num(b0).mul(x).add(z1.load());
    const z1n = num(b1).mul(x).add(z2.load()).sub(num(a1).mul(y));
    const z2n = num(b2).mul(x).sub(num(a2).mul(y));
    z1.store(z1n);
    z2.store(z2n);
    return y;
  }

  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const z1 = state.f32(0);
    const z2 = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(biquadDFIIT(input.ch(0).at(i), z1, z2));
        });
      },
    };
  });

  // Impulse input.
  const N = 64;
  const impulse = new Float32Array(N);
  impulse[0] = 1;
  const { outputs } = await render(proc, { inputs: { main: [impulse] } });

  // JS reference (same DF-II-T recurrence) — independent oracle.
  let rz1 = 0,
    rz2 = 0;
  const ref = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const x = impulse[n]!;
    const y = b0 * x + rz1;
    const z1n = b1 * x + rz2 - a1 * y;
    const z2n = b2 * x - a2 * y;
    rz1 = z1n;
    rz2 = z2n;
    ref[n] = y;
  }

  for (let n = 0; n < N; n++) {
    expect(outputs.main![0]![n]).toBeCloseTo(ref[n]!, 4);
  }
});

test("a shared pure subtree evaluates consistently at every reference", async () => {
  // const t = a + b; out = t * t  → (a+b)^2, no store involved.
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const t = input.ch(0).at(i).add(1);
          out.ch(0).at(i).write(t.mul(t));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) x[k] = k * 0.01;
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    const expected = (k * 0.01 + 1) ** 2;
    expect(outputs.main![0]![k]).toBeCloseTo(expected, 4);
  }
});

test("a per-block load used inside forSample reflects the block-start value", async () => {
  // base = s.load() (per-block); forSample writes base; then s.store advances.
  // Each block writes the value of s as of that block's start.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const s = state.f32(7);
    return {
      process: () => {
        const base = s.load();
        forSample((i) => {
          out.ch(0).at(i).write(base);
        });
        s.store(s.load().add(1));
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 3 });
  // Block 0 start = 7, block 1 = 8, block 2 = 9.
  expect(outputs.main![0]![0]).toBeCloseTo(7, 5);
  expect(outputs.main![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(8, 5);
  expect(outputs.main![0]![2 * SAMPLES_PER_BLOCK]).toBeCloseTo(9, 5);
});

test("state slots are seeded with their declared initial value (every scalar type)", async () => {
  // No store before the read → output is purely the declared initial value.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 4, name: "main" });
    const sf = state.f32(3.5);
    const si = state.i32(42);
    const sl = state.i64(2n ** 40n);
    const sb = state.bool(true);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(sf.load());
          out.ch(1).at(i).write(f32(si.load()));
          out.ch(2).at(i).write(f32(sl.load()));
          out
            .ch(3)
            .at(i)
            .write(select(sb.load(), num(1), num(0)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBeCloseTo(3.5, 5);
  expect(outputs.main![1]![0]).toBe(42);
  expect(outputs.main![2]![0]).toBeCloseTo(2 ** 40, 0);
  expect(outputs.main![3]![0]).toBe(1);
});

test("buffer read bound before a write to the same index keeps the pre-write value", async () => {
  // v = buf.read(i) (= 0 initial); buf.write(i, 5); out = v  → 0, not 5.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: SAMPLES_PER_BLOCK });
    return {
      process: () => {
        forSample((i) => {
          const v = buf.read(i);
          buf.write(i, f32(5));
          out.ch(0).at(i).write(v);
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo(0, 5);
  }
});
