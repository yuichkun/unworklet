/**
 * Layer A — validate the static realtime-safety verifier itself.
 *
 * A verifier that mis-classifies an unsafe binary is worse than none (it sells
 * false confidence). So before it gates `compile()`, prove it against hand-built
 * binaryen modules with KNOWN outcomes: it must reject `memory.grow`, a growable
 * memory, an unbounded loop, and a deliberate trap; and it must pass a
 * bounded-loop + memory-access body. Then confirm a real compiled processor
 * passes (the emitter output is realtime-safe and fully traversed — a node the
 * walker cannot traverse is itself a violation, so a clean compile proves full
 * coverage).
 */

import "../dsl/primitives.ts";

import { expect, test } from "vite-plus/test";

import { audioOutput } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";
import { type VerifyRule, verifyRealtimeSafe } from "./verify.ts";

type Bin = (typeof import("binaryen"))["default"];
type Mod = InstanceType<Bin["Module"]>;

const loadBinaryen = async (): Promise<Bin> => (await import("binaryen")).default;

// A module with a `process` function carrying `body(mod)` and a fixed memory
// (initial == max), unless `pages` overrides it.
const moduleWith = (bin: Bin, body: (m: Mod) => number, pages: [number, number] = [1, 1]): Mod => {
  const mod = new bin.Module();
  mod.setMemory(pages[0], pages[1], "memory");
  mod.addFunction("process", bin.none, bin.none, [bin.i32], body(mod));
  return mod;
};

const rules = (bin: Bin, mod: Mod): VerifyRule[] => {
  const v = verifyRealtimeSafe(mod, bin);
  mod.dispose();
  return v.map((x) => x.rule);
};

// A bounded loop with the emitter's shape: a `br_if` exit + a single induction
// increment. Reused as the "safe" inner body.
const boundedLoop = (m: Mod, bin: Bin): number =>
  m.block(null, [
    m.local.set(0, m.i32.const(0)),
    m.block("brk", [
      m.loop(
        "cont",
        m.block(null, [
          m.br_if("brk", m.i32.ge_s(m.local.get(0, bin.i32), m.i32.const(128))),
          m.local.set(0, m.i32.add(m.local.get(0, bin.i32), m.i32.const(1))),
          m.br("cont"),
        ]),
      ),
    ]),
  ]);

test("verify REJECTS memory.grow (an allocation on the audio thread)", async () => {
  const bin = await loadBinaryen();
  expect(
    rules(
      bin,
      moduleWith(bin, (m) => m.drop(m.memory.grow(m.i32.const(1)))),
    ),
  ).toContain("memory-grow");
});

test("verify REJECTS a growable memory (initial != max)", async () => {
  const bin = await loadBinaryen();
  expect(
    rules(
      bin,
      moduleWith(bin, (m) => m.block(null, [m.nop()]), [1, 16]),
    ),
  ).toContain("memory-not-fixed");
});

test("verify REJECTS an unbounded loop (no conditional exit)", async () => {
  const bin = await loadBinaryen();
  // loop { br loop } — an unconditional back-edge, the audio-thread hang.
  expect(
    rules(
      bin,
      moduleWith(bin, (m) => m.loop("spin", m.br("spin"))),
    ),
  ).toContain("unbounded-loop");
});

test("verify REJECTS a deliberate trap (unreachable latches silence)", async () => {
  const bin = await loadBinaryen();
  expect(
    rules(
      bin,
      moduleWith(bin, (m) => m.block(null, [m.unreachable()])),
    ),
  ).toContain("unreachable");
});

test("verify PASSES a bounded loop with memory access and arithmetic", async () => {
  const bin = await loadBinaryen();
  const body = (m: Mod): number =>
    m.block(null, [
      boundedLoop(m, bin),
      m.i32.store(0, 4, m.i32.const(0), m.i32.add(m.i32.const(1), m.i32.const(2))),
      m.drop(m.i32.load(0, 4, m.i32.const(0))),
    ]);
  expect(rules(bin, moduleWith(bin, body))).toEqual([]);
});

test("a real compiled processor passes the proof (emitter output is safe + fully traversed)", async () => {
  // Exercises audio I/O, a bounded forSample loop, arithmetic and a memory
  // store. compile() runs the proof internally and throws on any violation
  // (including a node the walker cannot traverse), so resolving proves it clean.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0.25);
        });
      },
    };
  });
  await expect(compile(proc)).resolves.toBeDefined();
});

test("a module without memory and an imported function require no memory proof", async () => {
  const bin = await loadBinaryen();
  const mod = bin.parseText('(module (import "host" "f" (func $f)) (func $process (return)))');
  expect(rules(bin, mod)).toEqual([]);
});

test("an inner loop's exit does not establish an outer loop bound", async () => {
  const bin = await loadBinaryen();
  const mod = bin.parseText(`(module
    (func $process
      (loop $outer
        (block $done
          (loop $inner (br_if $done (i32.const 1))))
        (nop)
        (br $outer))))`);
  expect(verifyRealtimeSafe(mod, bin)).toEqual([
    { rule: "unbounded-loop", fn: "process", detail: "loop has no conditional exit" },
  ]);
  mod.dispose();
});

const traversableExpressions = [
  ["branch table", "(block $done (br_table $done $done VALUE))", "(i32.const 0)"],
  ["return", "(return VALUE)", "(i32.const 0)"],
  ["indirect call", "(drop (call_indirect (type $fn) VALUE (i32.const 0)))", "(i32.const 0)"],
  ["memory fill", "(memory.fill (i32.const 0) VALUE (i32.const 1))", "(i32.const 0)"],
  ["atomic exchange", "(drop (i32.atomic.rmw.xchg (i32.const 0) VALUE))", "(i32.const 1)"],
  [
    "atomic compare exchange",
    "(drop (i32.atomic.rmw.cmpxchg (i32.const 0) (i32.const 0) VALUE))",
    "(i32.const 1)",
  ],
  [
    "SIMD shuffle",
    "(drop (i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 VALUE (v128.const i32x4 0 0 0 0)))",
    "(v128.const i32x4 0 0 0 0)",
  ],
  ["SIMD shift", "(drop (i32x4.shl (v128.const i32x4 0 0 0 0) VALUE))", "(i32.const 1)"],
  ["SIMD widening load", "(drop (v128.load8x8_u VALUE))", "(i32.const 0)"],
  [
    "SIMD lane load",
    "(drop (v128.load32_lane 0 (i32.const 0) VALUE))",
    "(v128.const i32x4 0 0 0 0)",
  ],
] as const;

test.each(traversableExpressions)(
  "the verifier traverses %s operands",
  async (_, expression, safe) => {
    const bin = await loadBinaryen();
    for (const [value, expected] of [
      [safe, []],
      ["(unreachable)", ["unreachable"]],
    ] as const) {
      const body = expression.replace("VALUE", value);
      const result = expression.startsWith("(return") ? "(result i32)" : "";
      const mod = bin.parseText(`(module
      (type $fn (func (param i32) (result i32)))
      (memory 1 1 shared)
      (table 1 funcref)
      (func $process ${result} ${body}))`);
      mod.setFeatures(bin.Features.All);
      expect(mod.validate()).toBe(1);
      expect(rules(bin, mod)).toEqual(expected);
    }
  },
);

test("memory.init is rejected even with fixed memory and still checks its operands", async () => {
  const bin = await loadBinaryen();
  const mod = bin.parseText(`(module
    (memory 1 1)
    (data $bytes "a")
    (func $process (memory.init $bytes (i32.const 0) (i32.const 0) (memory.grow (i32.const 1)))))`);
  mod.setFeatures(bin.Features.All);
  expect(mod.validate()).toBe(1);
  expect(rules(bin, mod)).toEqual(["memory-init", "memory-grow"]);
});

test("an unsupported operation fails closed inside a loop", async () => {
  const bin = await loadBinaryen();
  const mod = bin.parseText(`(module
    (memory 1 1 shared)
    (func $process (loop $spin
      (drop (memory.atomic.notify (i32.const 0) (i32.const 1)))
      (br $spin))))`);
  mod.setFeatures(bin.Features.All);
  expect(mod.validate()).toBe(1);
  expect(rules(bin, mod)).toEqual(["unbounded-loop", "unhandled-node"]);
});
