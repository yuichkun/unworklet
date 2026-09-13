/**
 * Black-box tests for SIMD (f32x4) (`01-dsl.md` §7, Q59).
 *
 * Vector ops run on the pure audio thread; correctness is verified by observing
 * output PCM through the compile + driver pipeline.
 * f32x4 results are reduced to scalar f32 via sumLanes / .lane and observed through audioOutput.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import "../../simd.ts"; // side-effect: register `.lane` method + SIMD types
import { audioOutput, state } from "../../dsl/declarations.ts";
import { f32, i32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { addVec, mulVec, splat, sumLanes, vec4 } from "../../simd.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("Node<'f32x4'> exposes only vector ops at the type level (type-only guard)", () => {
  // Never called — the body asserts the f32x4 method surface (`01-dsl.md` §7.2).
  // The `@ts-expect-error` lines fail `vp check` if a scalar method ever leaks
  // onto f32x4 (= the Phase 10 "types pass but capture throws" regression).
  const _guard = (): void => {
    const v = splat(f32(1));
    v.add(v); // ✓ vector arithmetic is available
    v.mul(v); // ✓
    v.lane(0); // ✓ lane extraction
    // @ts-expect-error sin is float-scalar-only — not on Node<'f32x4'>
    v.sin();
    // @ts-expect-error sqrt is float-scalar-only
    v.sqrt();
    // @ts-expect-error abs is numeric-scalar-only
    v.abs();
    // @ts-expect-error clamp is numeric-scalar-only
    v.clamp(splat(f32(0)), splat(f32(1)));
    // @ts-expect-error comparison is numeric-scalar-only
    v.lt(v);
  };
  expect(typeof _guard).toBe("function");
});

test("SIMD: splat(2) × vec4(1,2,3,4) → sumLanes = 20", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const v = mulVec(splat(2), vec4(1, 2, 3, 4)); // [2, 4, 6, 8]
          out.ch(0).at(i).write(sumLanes(v)); // 2+4+6+8 = 20
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(outputs.main![0]![k]).toBe(20);
});

test("SIMD: extract each lane of addVec(vec4, vec4) via lane(i)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const v = addVec(vec4(10, 20, 30, 40), vec4(1, 2, 3, 4)); // [11, 22, 33, 44]
          // lane 0 + lane 2 = 11 + 33 = 44, confirming each lane holds the correct value.
          out
            .ch(0)
            .at(i)
            .write(v.lane(0).add(v.lane(2)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(outputs.main![0]![k]).toBe(44);
});

test("SIMD: method-form splat(2).mul(vec4) works on f32x4 (type-safe and runtime-correct)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const v = splat(2).mul(vec4(1, 2, 3, 4)); // [2, 4, 6, 8]
          out.ch(0).at(i).write(sumLanes(v)); // 20
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(outputs.main![0]![k]).toBe(20);
});

test("SIMD: buf.loadVec / storeVec round-trips 4 lanes through a buffer", async () => {
  // buf[0..3] = 1,2,3,4 → loadVec(0) = [1,2,3,4] → ×splat(10) = [10,20,30,40]
  // → storeVec(4) writes buf[4..7] = 10,20,30,40 → read(4)+read(7) = 10+40 = 50.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 8 });
    return {
      process: () => {
        forSample((i) => {
          buf.write(0, f32(1));
          buf.write(1, f32(2));
          buf.write(2, f32(3));
          buf.write(3, f32(4));
          const v = mulVec(buf.loadVec(0), splat(10));
          buf.storeVec(4, v);
          out
            .ch(0)
            .at(i)
            .write(buf.read(4).add(buf.read(7)));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(outputs.main![0]![k]).toBe(50);
});

test.each([
  { offset: -536_870_912, start: 0 },
  { offset: 0, start: 0 },
  { offset: 0.25, start: 1 },
  { offset: 1, start: 4 },
  { offset: 536_870_912, start: 8 },
])(
  "SIMD: computed store offset $offset preserves computed lanes and neighboring memory",
  async ({ offset, start }) => {
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 8, name: "main" });
      const before = state.buffer.f32({ size: 4 });
      const buf = state.buffer.f32({ size: 12 });
      const after = state.buffer.f32({ size: 4 });
      const position = state.f32(offset);
      const gain = state.f32(0.25);
      return {
        process: () => {
          forSample((i) => {
            before.write(3, 17);
            after.write(0, 19);
            buf.write(0, -7);
            buf.write(11, -9);
            const lane = sumLanes(splat(sumLanes(splat(gain.read()))));
            buf.storeVec(
              i32(sumLanes(splat(position.read()))),
              vec4(lane, lane.add(1), lane.add(2), lane.add(3)),
            );
            gain.write(gain.read().add(0.25));
            out.ch(0).at(i).write(buf.read(start));
            out
              .ch(1)
              .at(i)
              .write(buf.read(start + 1));
            out
              .ch(2)
              .at(i)
              .write(buf.read(start + 2));
            out
              .ch(3)
              .at(i)
              .write(buf.read(start + 3));
            out.ch(4).at(i).write(buf.read(0));
            out.ch(5).at(i).write(buf.read(11));
            out.ch(6).at(i).write(before.read(3));
            out.ch(7).at(i).write(after.read(0));
          });
        },
      };
    });
    const { outputs } = await render(proc, { blocks: 2 });
    const channels = outputs.main!;
    for (let sample = 0; sample < 2 * SAMPLES_PER_BLOCK; sample++) {
      const lane = 4 * (sample + 1);
      expect(channels.slice(0, 4).map((channel) => channel[sample])).toEqual([
        lane,
        lane + 1,
        lane + 2,
        lane + 3,
      ]);
      expect(channels.slice(4).map((channel) => channel[sample])).toEqual([
        start === 0 ? lane : -7,
        start === 8 ? lane + 3 : -9,
        17,
        19,
      ]);
    }
  },
);
