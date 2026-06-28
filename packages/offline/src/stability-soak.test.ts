/**
 * Layer E — soak / stability.
 *
 * Short tests miss the slow-burn failures: an IIR or accumulator that drifts to
 * NaN/Inf after tens of thousands of samples, an unbounded state. This drives a
 * feedback one-pole and a phase accumulator over a long render of seeded
 * noise/impulse and asserts every output sample stays finite and bounded — so a
 * regression that lets the audio path diverge is caught before it ships.
 *
 * The default length is CI-cheap; set SOAK_SAMPLES to crank it for a nightly run.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  forSample,
  select,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

const SR = 48000;
const WANT = Number(process.env["SOAK_SAMPLES"] ?? 192000); // ~4 s
const N = Math.ceil(WANT / 128) * 128; // whole render blocks

/** Deterministic LCG noise in [-1, 1] (reproducible — no Math.random). */
const noise = (n: number, seed: number): Float32Array => {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = (s / 0xffffffff) * 2 - 1;
  }
  return a;
};

const assertFiniteBounded = (ch: Float32Array, bound: number): void => {
  for (let i = 0; i < ch.length; i++) {
    if (!Number.isFinite(ch[i]!) || Math.abs(ch[i]!) > bound) {
      throw new Error(`soak diverged at sample ${i}: ${ch[i]}`);
    }
  }
};

test("a feedback one-pole stays finite and bounded over a long soak", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "in" });
    const out = audioOutput({ channels: 1, name: "out" });
    const y = state.f32(0).named("y");
    return {
      process: () => {
        forSample((i) => {
          // y[n] = 0.999*y[n-1] + 0.001*x[n] — a stable one-pole; |y| <= max|x|.
          const next = y.read().mul(0.999).add(input.ch(0).at(i).mul(0.001));
          y.write(next);
          out.ch(0).at(i).write(next);
        });
      },
    };
  });

  const result = await renderOffline(proc, {
    sampleRate: SR,
    duration: N / SR,
    inputs: { in: [noise(N, 0x1234abcd)] },
  });
  assertFiniteBounded(result.outputs.out![0]!, 2);
  expect(result.outputs.out![0]!.length).toBeGreaterThanOrEqual(N);
});

test("a wrapping phase accumulator stays finite and bounded over a long soak", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const phase = state.f32(0).named("phase");
    return {
      process: () => {
        forSample((i) => {
          // phase += 0.01, wrap into [0,1); a sawtooth that must never drift off.
          const p = phase.read().add(0.01);
          const wrapped = select(p.gt(1), p.add(-1), p);
          phase.write(wrapped);
          out.ch(0).at(i).write(wrapped.mul(2).add(-1));
        });
      },
    };
  });

  const result = await renderOffline(proc, { sampleRate: SR, duration: N / SR });
  assertFiniteBounded(result.outputs.out![0]!, 1.0001);
});
