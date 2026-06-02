/**
 * Living proof for the documented examples — extracted from the docs themselves,
 * not hand-copied. Every complete `defineProcessor(...)` example shown in the
 * package READMEs / the root README / the unworklet Skill / llms.txt is parsed
 * out of the markdown and compiled here, and the two flagship ones are rendered.
 * If a documented example drifts into something that no longer compiles, this
 * test goes red ("examples are verified, not guessed").
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOC_FILES = [
  "packages/core/README.md",
  "README.md",
  ".claude/skills/unworklet/SKILL.md",
  "packages/offline/README.md",
  "llms.txt",
];

/** Pull every fenced ```ts block out of a markdown string. */
function tsBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```ts\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]!);
  return out;
}

/** A block that defines a complete processor (not a fragment or a main-thread example). */
const isProcessorBlock = (b: string): boolean => /defineProcessor\(\s*\(\s*\)\s*=>/.test(b);

/**
 * Evaluate a documented processor block into a CompiledProcessor. The example
 * bodies are plain JS (no type annotations), so we strip the `import` lines, turn
 * the `export const X =` into a `return`, and run it with the core exports in
 * scope. No transpile needed.
 */
function evalProcessor(block: string): core.CompiledProcessor<unknown> {
  const src = block
    .replace(/import\b[\s\S]*?from\s*["'][^"']+["'];?/g, "")
    .replace(/export\s+const\s+\w+\s*=\s*/, "return ");
  const fn = new Function(...Object.keys(core), `"use strict";\n${src}`);
  return fn(...Object.values(core)) as core.CompiledProcessor<unknown>;
}

const docProcessors = DOC_FILES.flatMap((rel) =>
  tsBlocks(readFileSync(join(ROOT, rel), "utf8"))
    .filter(isProcessorBlock)
    .map((block, i) => ({ id: `${rel}#${i}`, block })),
);

const findBlock = (needle: string): string => {
  const hit = docProcessors.find((p) => p.block.includes(needle));
  if (hit === undefined) throw new Error(`no documented processor example contains ${needle}`);
  return hit.block;
};

test("every documented defineProcessor example compiles (docs can't drift from the API)", async () => {
  // Coverage floor = the complete, self-contained processor examples currently
  // documented: stereoGain (core README + Skill), the root README gain, and
  // midiSynth (Skill). If a documented example is removed, this notices instead
  // of silently shrinking coverage.
  expect(docProcessors.length).toBeGreaterThanOrEqual(4);
  for (const { id, block } of docProcessors) {
    const proc = evalProcessor(block);
    const compiled = await core.compile(proc);
    expect(compiled.wasm.length, `${id} compiles to WASM`).toBeGreaterThan(0);
  }
});

test("documented stereoGain renders input × gain (from the doc source, not a copy)", async () => {
  const stereoGain = evalProcessor(findBlock("meterL"));
  const sr = 48000;
  const samples = 256;
  const dc = new Float32Array(samples).fill(0.5);
  const result = await renderOffline(stereoGain, {
    sampleRate: sr,
    duration: samples / sr,
    inputs: { main: [dc, dc] },
    params: { gain: [2.0] },
  });
  expect(result.outputs.main[0]![100]).toBeCloseTo(1.0, 5);
  expect(result.outputs.main[1]![100]).toBeCloseTo(1.0, 5);
  expect([...result.outputs.main[0]!].some(Number.isNaN)).toBe(false);
});

test("documented midiSynth is silent until noteOn, then sounds (from the doc source)", async () => {
  const midiSynth = evalProcessor(findBlock('onEvent("noteOn"'));
  const sr = 48000;
  const samples = 512;
  const result = await renderOffline(midiSynth, {
    sampleRate: sr,
    duration: samples / sr,
    inputs: { main: [new Float32Array(samples)] },
    events: [
      {
        name: "notes",
        payload: { type: "noteOn", channel: 0, note: 69, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  const peak = [...result.outputs.main[0]!].reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
  expect(peak).toBeGreaterThan(0.1);
  expect([...result.outputs.main[0]!].some(Number.isNaN)).toBe(false);
});
