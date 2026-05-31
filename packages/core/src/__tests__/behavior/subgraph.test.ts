/**
 * L2 subgraph (defineSubgraph / createSubgraph) の黒箱テスト (`01-dsl.md` §5.6、Q53/54)。
 *
 * subgraph は内部 state を持つ再利用可能な部品。複数 instance で独立 state +
 * per-instance args を、出力 PCM で観測する黒箱で検証 (= pure audio-thread)。
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput, state } from "../../dsl/declarations.ts";
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
      acc.write(acc.read().add(step));
    },
    value: () => acc.read(),
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
        acc.write(acc.read().add(step));
      },
      value: () => acc.read(),
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
    const buf = state.buffer.named("buf").f32({ size: 4 });
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

// §5.6.4 / Q34: createSubgraph(...) と宣言 (state.* / buffer.* / ...) は declaration scope
// (= defineProcessor / defineSubgraph body の top、return 前) 専用。expression scope
// (= forSample / everyNSamples / handler body) で呼ぶと graph-capture-time error。
// defineProcessor は capture 中に process() を走らせる = throw は defineProcessor 時。
test("createSubgraph を forSample 内 (expression scope) で呼ぶと graph-capture-time error (§5.6.4/Q34)", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            createSubgraph(accum, 1); // expression scope = NG
            out.ch(0).at(i).write(f32(0));
          });
        },
      };
    }),
  ).toThrow(/scope/i);
});

test("state 宣言を forSample 内 (expression scope) で呼ぶと graph-capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            state.f32(0); // expression scope = NG
            out.ch(0).at(i).write(f32(0));
          });
        },
      };
    }),
  ).toThrow(/scope/i);
});

// §8.1 / Q41: named-factory slot (= user-named / persistent / publish) を持つ subgraph を
// instance 名ナシで createSubgraph すると、slot の snapshot path が auto prefix '__sg_N/...'
// = instantiation 順依存 (= positional drift) になる → graph-capture-time error。
test("named slot 持ちの subgraph を instance 名ナシで createSubgraph すると error (§8.1/Q41)", () => {
  const namedSlot = defineSubgraph((step: number) => {
    const acc = state.named("acc").f32(0); // user-named slot = 安定 snapshot path が要る
    return {
      tick: () => acc.write(acc.read().add(step)),
      value: () => acc.read(),
    };
  });
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const a = createSubgraph(namedSlot, 1); // instance 名ナシ + named slot = NG
      return {
        process: () => {
          forSample((i) => {
            a.tick();
            out.ch(0).at(i).write(a.value());
          });
        },
      };
    }),
  ).toThrow(/name/i);
});

test("anonymous slot だけの subgraph は instance 名ナシでも OK (= plain-only、§8.1)", async () => {
  // accum は state.f32(0) = anonymous slot = snapshot path drift が無い = 名前不要。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const a = createSubgraph(accum, 5); // 名前ナシ + anonymous slot = OK
    return {
      process: () => {
        forSample((i) => {
          a.tick();
          out.ch(0).at(i).write(a.value());
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(5); // +5/tick の 1 sample 目
});

// createSubgraph(subgraph, ...lambdaArgs, options?) で、outer lambda が {name} 形の config
// object を取る場合、createSubgraph(sg, {name:"osc"}) は型上その object を lambda 引数に
// bind する (= options 不在)。runtime も同じく扱うべき (型⟺動く)。options 形 ({name} only)
// との区別は arity で行う (= rest.length > lambda arity の時だけ末尾を options 扱い)。
test("createSubgraph: {name} config を取る lambda は instance options と誤認されない (型⟺動く)", async () => {
  const labeled = defineSubgraph((cfg: { name: string }) => {
    const len = cfg.name.length; // build-time number、config が届けば出力で観測できる
    return { value: () => f32(len) };
  });
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sg = createSubgraph(labeled, { name: "osc" }); // "osc".length=3、options ではなく lambda 引数
    return {
      process: () => {
        forSample((i) => out.ch(0).at(i).write(sg.value()));
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(3); // cfg.name="osc" が届いた証拠
});
