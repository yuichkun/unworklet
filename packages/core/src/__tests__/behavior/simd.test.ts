/**
 * SIMD (f32x4) の黒箱テスト (`01-dsl.md` §7、Q59)。
 *
 * vec 演算 = pure audio-thread = compile + driver で出力 PCM を観測する黒箱で検証。
 * f32x4 の結果は sumLanes / .lane で scalar f32 に戻して audioOutput で観測する。
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import "../../simd.ts"; // side-effect: register `.lane` method + SIMD types
import { audioOutput, buffer } from "../../dsl/declarations.ts";
import { f32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { addVec, mulVec, splat, sumLanes, vec4 } from "../../simd.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("Node<'f32x4'> exposes only vector ops at the type level (type-only guard)", () => {
  // Never called — the body asserts the f32x4 method surface (`01-dsl.md` §7.2).
  // The `@ts-expect-error` lines fail `vp check` if a scalar method ever leaks
  // onto f32x4 (= the Phase 10 "型は通るが capture で throw" regression).
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

test("SIMD: addVec(vec4, vec4) の各レーンを lane(i) で取り出す", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const v = addVec(vec4(10, 20, 30, 40), vec4(1, 2, 3, 4)); // [11, 22, 33, 44]
          // lane 0+2 = 11 + 33 = 44 で観測 (= 各 lane が正しい位置)。
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

test("SIMD: method 形 splat(2).mul(vec4) が f32x4 で動く (= 型通り = 動く)", async () => {
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

test("SIMD: buf.loadVec / storeVec で 4 lane を buffer 経由で I/O", async () => {
  // buf[0..3] = 1,2,3,4 → loadVec(0) = [1,2,3,4] → ×splat(10) = [10,20,30,40]
  // → storeVec(4) で buf[4..7] = 10,20,30,40 → read(4)+read(7) = 10+40 = 50。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 8 });
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
