/**
 * The render quantum (samples per `process()` call) is fixed at compile time,
 * like the sample rate: `compile(processor, { renderQuantumSize })` re-captures
 * the processor with `ctx.renderQuantumSize` and emits a WASM whose loops, I/O
 * scratch and publish cadence follow that length.
 */

import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts";
import { audioInput, audioOutput, state } from "../dsl/declarations.ts";
import { f32 } from "../dsl/constructors.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";

const ramp = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(f32(i));
      });
    },
  };
});

test("compile records the render quantum it compiled for (default 128)", async () => {
  expect((await compile(ramp)).renderQuantumSize).toBe(128);
  expect((await compile(ramp, { renderQuantumSize: 32 })).renderQuantumSize).toBe(32);
});

test("one process() call runs exactly the compiled quantum of samples", async () => {
  for (const q of [32, 64, 256, 441]) {
    const result = await compile(ramp, { renderQuantumSize: q });
    const instance = await result.driver.instantiate();
    instance.process();
    const block = new Float32Array(q);
    instance.readOutput("main", 0, block);
    expect(Array.from(block)).toEqual(Array.from({ length: q }, (_, k) => k));
  }
});

test("ctx.renderQuantumSize is the compile target at capture time", async () => {
  const seen: number[] = [];
  const probe = defineProcessor((ctx) => {
    seen.push(ctx.renderQuantumSize);
    audioOutput({ channels: 1, name: "main" });
    return { process: () => {} };
  });
  seen.length = 0;
  await compile(probe, { renderQuantumSize: 64 });
  expect(seen).toEqual([64]);
});

test("compile rejects a render quantum that is not a positive integer", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(compile(ramp, { renderQuantumSize: bad })).rejects.toThrow(TypeError);
  }
});

test("compile rejects a processor graph captured for a different quantum than requested", async () => {
  // Without a re-capture thunk compile falls back to the eager graph (captured for 128).
  const eagerOnly = { ...ramp, __capture: undefined };
  await expect(compile(eagerOnly, { renderQuantumSize: 32 })).rejects.toThrow(
    /asked for renderQuantumSize 32, but the processor graph was captured for 128/,
  );
  await expect(compile(eagerOnly)).resolves.toBeDefined();
});

test("forSample.byN rejects a stride that does not divide the quantum, listing the allowed strides", async () => {
  const strided = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample.byN(64, (i) => {
          out.ch(0).at(i).write(f32(1));
        });
      },
    };
  });
  await expect(compile(strided, { renderQuantumSize: 32 })).rejects.toThrow(
    /stride 64 .* render quantum \(32\)\. Allowed: 1, 2, 4, 8, 16, 32/,
  );
  await expect(compile(strided, { renderQuantumSize: 256 })).resolves.toBeDefined();
  // An odd quantum has no power-of-two divisor but 1.
  await expect(compile(strided, { renderQuantumSize: 441 })).rejects.toThrow(
    /render quantum \(441\)\. Allowed: 1 \(stable ID 'illegal-stride'\)/,
  );
});

test("a literal sample offset outside the quantum is rejected at capture", async () => {
  const late = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        out.ch(0).at(0).write(input.ch(0).at(40));
      },
    };
  });
  await expect(compile(late, { renderQuantumSize: 32 })).rejects.toThrow(/out of range \[0, 31\]/);
  await expect(compile(late, { renderQuantumSize: 64 })).resolves.toBeDefined();
});

test("state persists across calls at any quantum (per-sample counter)", async () => {
  const counter = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const n = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          n.write(n.read().add(1));
          out.ch(0).at(i).write(n.read());
        });
      },
    };
  });
  const result = await compile(counter, { renderQuantumSize: 48 });
  const instance = await result.driver.instantiate();
  const block = new Float32Array(48);
  instance.process();
  instance.process();
  instance.readOutput("main", 0, block);
  expect(block[0]).toBe(49);
  expect(block[47]).toBe(96);
});
