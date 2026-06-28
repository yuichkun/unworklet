/**
 * Shared golden harness for the lowering tests. Two oracles:
 *
 * - `expectSameLowering(sugar, explicit)` — lower BOTH `.uwk.ts` strings and
 *   assert an identical compiled fingerprint. The explicit form (hand-written
 *   chain DSL inside a `.uwk.ts`, no operator sugar) is the ground truth, and is
 *   far easier to write correctly than a `defineProcessor`. Catches structural
 *   drift in the sugar passes.
 * - `renderLowered(uwk, config)` — lower + eval + `renderOffline`, for behavioral
 *   assertions against a pure-JS reference. Catches SEMANTIC bugs (operator
 *   precedence, literal-lift type, integer vs float ops) that fingerprint
 *   equality alone cannot.
 *
 * The lowered module is evaluated via the shared {@link evalLowered}
 * (`eval-lowered.ts`): AST-precise import-strip + default-export rewrite, then run
 * with the real core exports injected (no module resolution).
 */

import * as core from "@unworklet/core";
import { compile } from "@unworklet/core";
import type { RenderOfflineConfig, RenderOfflineResult } from "@unworklet/offline";
import { renderOffline } from "@unworklet/offline";
import { expect } from "vite-plus/test";

import { evalLowered } from "./eval-lowered.ts";
import { lower } from "./lower.ts";

export { evalLowered, lower };

/** Deterministic JSON: sorted object keys + `bigint → "<n>n"`. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "bigint") return `${val}n`;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

type Fingerprint = { schemaHash: string; graph: string; layout: string };

export async function fingerprintOf(proc: core.CompiledProcessor<unknown>): Promise<Fingerprint> {
  const result = await compile(proc, { sampleRate: 48000 });
  return {
    schemaHash: result.schemaHash,
    graph: stableStringify(result.graph),
    layout: stableStringify(result.memory),
  };
}

/** Assert a lowered `.uwk.ts` is byte-identical to a hand-written Tier-A processor. */
export async function expectByteIdentical(
  uwk: string,
  tierA: core.CompiledProcessor<unknown>,
): Promise<void> {
  const [lf, tf] = await Promise.all([
    fingerprintOf(evalLowered(lower(uwk))),
    fingerprintOf(tierA),
  ]);
  expect(lf.schemaHash).toBe(tf.schemaHash);
  expect(lf.graph).toBe(tf.graph);
  expect(lf.layout).toBe(tf.layout);
}

/**
 * Assert a sugared `.uwk.ts` lowers to the SAME compiled processor as an explicit
 * chain-DSL `.uwk.ts`. The explicit form is the ground truth.
 */
export async function expectSameLowering(sugar: string, explicit: string): Promise<void> {
  const [a, b] = await Promise.all([
    fingerprintOf(evalLowered(lower(sugar))),
    fingerprintOf(evalLowered(lower(explicit))),
  ]);
  expect(a.schemaHash).toBe(b.schemaHash);
  expect(a.graph).toBe(b.graph);
  expect(a.layout).toBe(b.layout);
}

/** Lower + eval + render a `.uwk.ts`, for behavioral (semantic) assertions. */
export async function renderLowered(
  uwk: string,
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  return renderOffline(evalLowered(lower(uwk)), config);
}
