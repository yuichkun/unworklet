/**
 * L2 subgraph (defineSubgraph / createSubgraph) の黒箱テスト (`01-dsl.md` §5.6、Q53/54)。
 *
 * subgraph は内部 state を持つ再利用可能な部品。複数 instance で独立 state +
 * per-instance args を、出力 PCM で観測する黒箱で検証 (= pure audio-thread)。
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput, buffer, state } from "../../dsl/declarations.ts";
import { f32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { createSubgraph, defineProcessor, defineSubgraph } from "../../processor.ts";
import type { Node } from "../../types.ts";

import { render } from "./render.ts";

// step ずつ加算する subgraph (= 内部 state acc)。 instance ごとに step が違い、
// acc は独立 = 複数 instance が干渉しないことを確認する最小部品。 tick (store) と
// value (load) を分ける = no-CSE gotcha (= store 済 state の再 load) を踏まない形。
const accum = defineSubgraph((step: number) => {
  const acc = state.f32(0);
  return {
    tick: () => {
      acc.store(acc.load().add(step));
    },
    value: () => acc.load(),
  };
});

test("subgraph: 2 instance が独立 state + per-instance args を持つ", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 2, name: "main" });
    const a = createSubgraph(accum, 1); // +1 / tick
    const b = createSubgraph(accum, 10); // +10 / tick
    return {
      process: () => {
        forSample((i) => {
          a.tick();
          b.tick();
          out.ch(0).at(i).write(a.value()); // 1, 2, 3, ...
          out.ch(1).at(i).write(b.value()); // 10, 20, 30, ...
        });
      },
    };
  });
  const { outputs } = await render(proc);
  // L = step1 の累積 (sample k で k+1)、R = step10 の累積 (10×(k+1))。 独立 = 干渉ナシ。
  expect(outputs.main![0]![0]).toBe(1);
  expect(outputs.main![1]![0]).toBe(10);
  expect(outputs.main![0]![9]).toBe(10);
  expect(outputs.main![1]![9]).toBe(100);
  expect(outputs.main![0]![127]).toBe(128);
  expect(outputs.main![1]![127]).toBe(1280);
});

test("subgraph: user-named 内部 state は instance prefix で衝突しない", async () => {
  // 両 instance が同じ 'acc' を named するが、prefix ('a/acc' 'b/acc') で衝突ナシ
  // (= prefix ナシなら checkStateName で重複 throw するはずの形)。
  const named = defineSubgraph((step: number) => {
    const acc = state.named("acc").f32(0);
    return {
      tick: () => {
        acc.store(acc.load().add(step));
      },
      value: () => acc.load(),
    };
  });
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 2, name: "main" });
    const a = createSubgraph(named, 1, { name: "a" });
    const b = createSubgraph(named, 10, { name: "b" });
    return {
      process: () => {
        forSample((i) => {
          a.tick();
          b.tick();
          out.ch(0).at(i).write(a.value());
          out.ch(1).at(i).write(b.value());
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(1);
  expect(outputs.main![1]![0]).toBe(10);
  expect(outputs.main![0]![127]).toBe(128);
  expect(outputs.main![1]![127]).toBe(1280);
});

test("subgraph: user-named 内部 buffer は instance prefix で衝突しない (Q53/Q54)", async () => {
  // 両 instance が同じ 'buf' を named するが、prefix ('a/buf' 'b/buf') で衝突ナシ
  // (= prefix ナシなら checkBufferName で重複 throw する形)。
  const cell = defineSubgraph((val: number) => {
    const buf = buffer.named("buf").f32({ size: 4 });
    return {
      tick: () => buf.write(0, f32(val)),
      value: () => buf.read(0),
    };
  });
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 2, name: "main" });
    const a = createSubgraph(cell, 3, { name: "a" });
    const b = createSubgraph(cell, 7, { name: "b" });
    return {
      process: () => {
        forSample((i) => {
          a.tick();
          b.tick();
          out.ch(0).at(i).write(a.value()); // 3
          out.ch(1).at(i).write(b.value()); // 7
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(3);
  expect(outputs.main![1]![0]).toBe(7);
});

// L1 helper = pure TS function over Node<T> (= §5.5)。 capture 時に呼ばれて内部
// primitive が AST を積むだけ = 既存機構でそのまま動く。
test("L1 helper: pure TS function over Node が forSample 内でインライン展開される", async () => {
  const scaledSum = (x: Node<"f32">, y: Node<"f32">): Node<"f32"> => x.add(y).mul(0.5);
  const proc = defineProcessor(() => {
    const o = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          o.ch(0)
            .at(i)
            .write(scaledSum(f32(3), f32(7))); // (3+7)*0.5 = 5
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(outputs.main![0]![k]).toBe(5);
});
