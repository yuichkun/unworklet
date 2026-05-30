/**
 * forSample.byN + everyNSamples の黒箱テスト (`01-dsl.md` §10 + §9、Q43)。
 *
 * pure audio-thread loop primitive = cross-thread transport ナシ = compile + driver
 * で出力 PCM を直接観測する黒箱ハーネスで検証 (= web e2e 不要)。
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

test("forSample.byN(4) は 4 サンプルおきに body を実行する (= 櫛状)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(f32(0)); // 全 sample を 0 に
        });
        forSample.byN(4, (i) => {
          out.ch(0).at(i).write(f32(1)); // 4 サンプルおきに 1
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBe(k % 4 === 0 ? 1 : 0);
  }
});

test("forSample.byN(1) は全サンプルで body を実行する (= stride 1 と等価)", async () => {
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

test("forSample.byN(8) は前ブロックの state を引き継ぐ (= cross-block stride)", async () => {
  // byN(8) で counter を +1 → 1 ブロック 16 回。2 ブロックで 32。出力 = counter。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const count = state.i32(0);
    return {
      process: () => {
        forSample.byN(8, () => {
          count.store(count.load().add(1));
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(count.load()));
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 2 });
  // outputs.main[0] = ch0 の flat 配列 (= blocks × 128)。block 1 = [0..127]、block 2 = [128..255]。
  // byN(8) は 1 ブロック 16 回。block 1 末 counter = 16、block 2 末 = 32。
  expect(outputs.main![0]![0]).toBe(16);
  expect(outputs.main![0]![128]).toBe(32);
});

test("everyNSamples(32) は 32 サンプルごとに sub-block を実行し、間は zero-order hold", async () => {
  // everyNSamples(32) で counter を +1 (= 1 ブロック 128 で 4 回: sample 0/32/64/96)。
  // 出力 = counter (held) → 階段状 1,2,3,4。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const c = state.i32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(32, () => {
            c.store(c.load().add(1));
          });
          out.ch(0).at(i).write(f32(c.load()));
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

test("everyNSamples の counter は block 跨ぎで継続する (= 非 block-aligned divisor)", async () => {
  // everyNSamples(48) は 128 を割り切らない。counter が block 跨ぎで継続すれば、
  // fire 位置は block ごとにズレる (= 0, 48, 96, [block2] 144=16, ...)。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const c = state.i32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(48, () => {
            c.store(c.load().add(1));
          });
          out.ch(0).at(i).write(f32(c.load()));
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks: 2 });
  const ch = outputs.main![0]!;
  // block1: fire at 0,48,96 → counter 1,2,3。 block2 (= global 128..255): 次 fire は
  // global 144 (= block2 sample 16) → そこで 4。block2 sample 0..15 = 3 (held)。
  expect(ch[0]).toBe(1);
  expect(ch[47]).toBe(1);
  expect(ch[48]).toBe(2);
  expect(ch[96]).toBe(3);
  expect(ch[128]).toBe(3); // block2 sample 0 = held 3 (= 128%48 = 32 ≠ 0)
  expect(ch[128 + 16]).toBe(4); // global 144 = 48×3 で fire
});

test("forSample.byN は 128 を割り切らない stride を compile で reject する", async () => {
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

// everyNSamples(N) の N は §9.5 で「compile-time な正の整数」。N=0 は emit が
// i32.rem_u(counter, 0) を吐いて audio thread で除算 trap、負/非整数は無効。
// → analyze が compile-time に reject する (= audio thread に届かせない)。
const everyN = (n: number) =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const acc = state.f32(0);
    return {
      process: () => {
        forSample((i, everyNSamples) => {
          everyNSamples(n, () => {
            acc.store(acc.load().add(f32(1)));
          });
          out.ch(0).at(i).write(acc.load());
        });
      },
    };
  });

test("everyNSamples(0) は compile で reject する (= audio thread の 0 除算 trap を防ぐ)", async () => {
  await expect(compile(everyN(0))).rejects.toThrow(/illegal-everyn-divisor/);
});

test("everyNSamples は負/非整数の N を compile で reject する (= §9.5 正の整数)", async () => {
  await expect(compile(everyN(-2))).rejects.toThrow(/illegal-everyn-divisor/);
  await expect(compile(everyN(3.5))).rejects.toThrow(/illegal-everyn-divisor/);
});

test("everyNSamples(1) は正当 (= 毎サンプル実行) で compile を通る", async () => {
  // N=1 は下限の正当値 (= 128 を割り切る必要はない、§9.5)。reject されない。
  await expect(compile(everyN(1))).resolves.toBeDefined();
});
