/**
 * Byte-identity spine (RFC-001's central claim): a lowered `.uwk.ts` module must
 * compile to the SAME `CompiledProcessor` as the equivalent hand-written Tier-A
 * `.ts` — same declaration schema, same captured graph, same memory layout.
 *
 * The lowered source is evaluated by stripping its `@unworklet/core` import and
 * injecting the real core exports into a `new Function` (no module resolution,
 * no temp files), then both sides are compiled and their fingerprints compared.
 */

import { expect, test } from "vite-plus/test";

import * as core from "@unworklet/core";
import { compile, defineProcessor } from "@unworklet/core";
import ts from "typescript";

import { lower } from "./lower.ts";

/** Deterministic JSON: sorted object keys + `bigint → "<n>n"` (binaryen-stable). */
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

const CORE_KEYS = Object.keys(core).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));

/** Evaluate a lowered `.ts` module to its default-exported CompiledProcessor by
 * injecting the real `@unworklet/core` exports — equivalent to importing core. */
function evalLowered(loweredTs: string): core.CompiledProcessor<unknown> {
  const js = ts.transpileModule(loweredTs, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const body = js
    .replace(/import\s*\{[^}]*\}\s*from\s*["']@unworklet\/core["'];?/g, "")
    .replace(/export\s+default\s+/, "return ");
  // Evaluates the frontend's own generated module (equivalent to importing it)
  // in a test harness — the injected identifiers ARE the real core exports.
  // oxlint-disable-next-line typescript/no-implied-eval
  const fn = new Function(...CORE_KEYS, body) as (
    ...args: unknown[]
  ) => core.CompiledProcessor<unknown>;
  return fn(...CORE_KEYS.map((k) => (core as Record<string, unknown>)[k]));
}

type Fingerprint = { schemaHash: string; graph: string; layout: string };

async function fingerprint(proc: core.CompiledProcessor<unknown>): Promise<Fingerprint> {
  const result = await compile(proc, { sampleRate: 48000 });
  return {
    schemaHash: result.schemaHash,
    graph: stableStringify(result.graph),
    layout: stableStringify(result.memory),
  };
}

async function expectByteIdentical(
  uwk: string,
  tierA: core.CompiledProcessor<unknown>,
): Promise<void> {
  const lowered = lower(uwk);
  const [lf, tf] = await Promise.all([fingerprint(evalLowered(lowered)), fingerprint(tierA)]);
  expect(lf.schemaHash).toBe(tf.schemaHash);
  expect(lf.graph).toBe(tf.graph);
  expect(lf.layout).toBe(tf.layout);
}

test("stereo gain + meters: lowered .uwk.ts ≡ hand-written Tier A", async () => {
  const uwk = `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
const meterL = state.f32(0).named("meterL").expose({ snapshot: "transient", publish: { rateFps: 30 } });
const meterR = state.f32(0).named("meterR").expose({ snapshot: "transient", publish: { rateFps: 30 } });
process(() => {
  forSample((i) => {
    const l = input.left.at(i).mul(gain.at(i));
    const r = input.right.at(i).mul(gain.at(i));
    out.left.at(i).write(l);
    out.right.at(i).write(r);
    meterL.write(l.abs().max(meterL.read()));
    meterR.write(r.abs().max(meterR.read()));
  });
  meterL.write(meterL.read().mul(0.95));
  meterR.write(meterR.read().mul(0.95));
});
`;
  const tierA = defineProcessor(() => {
    const input = core.audioInput({ channels: 2, name: "main" });
    const out = core.audioOutput({ channels: 2, name: "main" });
    const gain = core.param
      .f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" })
      .named("gain");
    const meterL = core.state
      .f32(0)
      .named("meterL")
      .expose({ snapshot: "transient", publish: { rateFps: 30 } });
    const meterR = core.state
      .f32(0)
      .named("meterR")
      .expose({ snapshot: "transient", publish: { rateFps: 30 } });
    return {
      process: () => {
        core.forSample((i) => {
          const l = input.left.at(i).mul(gain.at(i));
          const r = input.right.at(i).mul(gain.at(i));
          out.left.at(i).write(l);
          out.right.at(i).write(r);
          meterL.write(l.abs().max(meterL.read()));
          meterR.write(r.abs().max(meterR.read()));
        });
        meterL.write(meterL.read().mul(0.95));
        meterR.write(meterR.read().mul(0.95));
      },
    };
  });

  await expectByteIdentical(uwk, tierA);
});
