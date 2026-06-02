/**
 * Byte-identity fingerprint for the issue #10 rename (Phase A regression oracle).
 *
 * The DSL 4-concept rename is designed to leave the compiled IR untouched: only
 * the authoring surface (factory / method names) changes, while internal
 * declaration `kind`s and AST ops stay fixed. This module captures a
 * deterministic fingerprint of the compiled artifact so a frozen golden can
 * prove that invariant — if any fingerprint field drifts after the rename, the
 * rename leaked into the IR and must be fixed (the golden is never regenerated
 * mid-rename).
 *
 * Fields, in decreasing order of directness:
 * - `schemaHash`   — declaration-schema content hash (FNV-1a). Cheapest drift signal.
 * - `graph`        — the full `CapturedGraph` (declarations + statements) = the IR
 *                    itself. A structural diff here pinpoints exactly where a rename
 *                    leaked. `bigint` (i64 literals) are stringified as `<n>n`.
 * - `layout`       — the full `Layout` (region byte offsets / sizes).
 * - `wasmSha`      — sha256 of the emitted WASM. Strongest single check, but binaryen
 *                    output can vary by version, so it is a bonus on top of graph/layout.
 * - `pcm` / `snapshot` — sha256 of the `renderOffline` output PCM / end-of-render
 *                    snapshot blob = deterministic behavioral identity.
 */

import { createHash } from "node:crypto";

import { compile, type CompiledProcessor } from "@unworklet/core";

import { renderOffline, type RenderOfflineConfig } from "../index.ts";

/** Deterministic JSON: sorted object keys + `bigint` → `"<n>n"` (JSON cannot carry bigint). */
export function stableStringify(value: unknown): string {
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

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export type GoldenFingerprint = {
  schemaHash: string;
  /** Canonicalized `CapturedGraph` JSON string (the IR) — structurally compared on drift. */
  graph: string;
  /** Canonicalized `Layout` JSON string (region offsets / sizes) — structurally compared on drift. */
  layout: string;
  wasmSha: string;
  pcm: string | null;
  snapshot: string | null;
};

/** A golden case: a processor authored on the current surface + a fixed offline render config. */
export type GoldenCase<C = unknown> = {
  name: string;
  processor: CompiledProcessor<C>;
  /** Fixed render config for the behavioral (PCM / snapshot) pin. Omit to skip the behavioral pin. */
  config?: RenderOfflineConfig;
};

const SAMPLE_RATE = 48000;

export async function fingerprint(testCase: GoldenCase): Promise<GoldenFingerprint> {
  const result = await compile(testCase.processor, { sampleRate: SAMPLE_RATE });
  let pcm: string | null = null;
  let snapshot: string | null = null;
  if (testCase.config !== undefined) {
    const rendered = await renderOffline(testCase.processor, testCase.config);
    const pcmBytes: number[] = [];
    for (const channels of Object.values(rendered.outputs)) {
      for (const channel of channels) pcmBytes.push(...channel);
    }
    pcm = sha256(stableStringify(pcmBytes));
    snapshot = sha256(rendered.state);
  }
  return {
    schemaHash: result.schemaHash,
    graph: stableStringify(result.graph),
    layout: stableStringify(result.memory),
    wasmSha: sha256(result.wasm),
    pcm,
    snapshot,
  };
}
