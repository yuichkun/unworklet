/**
 * Black-box tests for L2 subgraph (defineSubgraph / createSubgraph) (`01-dsl.md` §5.6, Q53/54).
 *
 * A subgraph is a reusable component with internal state. Tests verify independent state +
 * per-instance args across multiple instances by observing output PCM (pure audio-thread).
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

// Subgraph that accumulates by a given step (internal state: acc). Each instance has a
// different step and an independent acc — the minimal fixture to confirm instances do not
// interfere. tick (store) and value (load) are separated to avoid the no-CSE gotcha
// (re-loading already-stored state).
const accum = defineSubgraph((step: number) => {
  const acc = state.f32(0);
  return {
    tick: () => {
      acc.write(acc.read().add(step));
    },
    value: () => acc.read(),
  };
});

test("subgraph: two instances maintain independent state and per-instance args", async () => {
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
  // L = step-1 accumulation (k+1 at sample k), R = step-10 accumulation (10×(k+1)). Independent = no interference.
  expect(outputs.main![0]![0]).toBe(1);
  expect(outputs.main![1]![0]).toBe(10);
  expect(outputs.main![0]![9]).toBe(10);
  expect(outputs.main![1]![9]).toBe(100);
  expect(outputs.main![0]![127]).toBe(128);
  expect(outputs.main![1]![127]).toBe(1280);
});

test("subgraph: user-named internal state does not collide across instances due to instance prefix", async () => {
  // Both instances name their state 'acc', but the prefixes ('a/acc', 'b/acc') prevent collision.
  // Without prefixes, checkStateName would throw on the duplicate.
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

test("subgraph: user-named internal buffer does not collide across instances due to instance prefix (Q53/Q54)", async () => {
  // Both instances name their buffer 'buf', but the prefixes ('a/buf', 'b/buf') prevent collision.
  // Without prefixes, checkBufferName would throw on the duplicate.
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

// L1 helper = pure TS function over Node<T> (§5.5). Called at capture time, it only
// pushes internal primitives onto the AST — works with the existing mechanism as-is.
test("L1 helper: pure TS function over Node is inlined inside forSample", async () => {
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

// §5.6.4 / Q34: createSubgraph(...) and declarations (state.* / buffer.* / ...) are
// restricted to declaration scope (top of defineProcessor / defineSubgraph body, before
// return). Calling them in expression scope (forSample / everyNSamples / handler body)
// throws at graph-capture time. defineProcessor runs process() during capture, so the
// throw surfaces at defineProcessor call time.
test("createSubgraph called inside forSample (expression scope) throws at graph-capture time (§5.6.4/Q34)", () => {
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

test("state declaration called inside forSample (expression scope) throws at graph-capture time", () => {
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

// §8.1 / Q41: Creating a subgraph that contains named-factory slots (user-named / persistent /
// publish) without an instance name causes the slot's snapshot path to use an auto prefix
// '__sg_N/...' that depends on instantiation order (positional drift) → graph-capture-time error.
test("createSubgraph without an instance name throws when the subgraph contains named slots (§8.1/Q41)", () => {
  const namedSlot = defineSubgraph((step: number) => {
    const acc = state.named("acc").f32(0); // user-named slot requires a stable snapshot path
    return {
      tick: () => acc.write(acc.read().add(step)),
      value: () => acc.read(),
    };
  });
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const a = createSubgraph(namedSlot, 1); // no instance name + named slot = error
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

test("subgraph with only anonymous slots can be created without an instance name (plain-only, §8.1)", async () => {
  // accum uses state.f32(0) = anonymous slot = no snapshot path drift = no name required.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const a = createSubgraph(accum, 5); // no instance name + anonymous slot = ok
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
  expect(outputs.main![0]![0]).toBe(5); // first sample: +5/tick
});

// createSubgraph(subgraph, ...lambdaArgs, options?): when the outer lambda takes a
// {name}-shaped config object, createSubgraph(sg, {name:"osc"}) must bind that object as
// the lambda argument (no options present). Runtime must match the type (type⟺behavior).
// Distinction from the options form ({name} only) is made by arity: only when
// rest.length > lambda arity is the trailing argument treated as options.
test("createSubgraph: lambda taking a {name} config object is not mistaken for instance options (type⟺behavior)", async () => {
  const labeled = defineSubgraph((cfg: { name: string }) => {
    const len = cfg.name.length; // build-time number; observable in output if config was delivered
    return { value: () => f32(len) };
  });
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sg = createSubgraph(labeled, { name: "osc" }); // "osc".length=3, bound as lambda arg not options
    return {
      process: () => {
        forSample((i) => out.ch(0).at(i).write(sg.value()));
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(3); // confirms cfg.name="osc" was delivered
});
