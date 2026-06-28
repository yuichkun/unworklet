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
