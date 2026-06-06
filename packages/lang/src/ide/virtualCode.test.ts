/**
 * Unit tests for the virtual-code generator. These assert two things directly off
 * the {@link generateVirtualCode} output (no language service):
 *
 *  1. DESUGAR TEXT — the sugar a `.uwk.ts` file uses is rewritten to the exact chain
 *     primitives stock TypeScript accepts (`a * b` → `mul(a, b)`, `out[i] = v` →
 *     `out.at(i).write(v)`, a bare `state` read → `state.read()`, …), and only those.
 *  2. MAPPINGS — every author-written span maps back 1:1 (so hover / rename / errors
 *     land on the real token), and injected glue maps as a zero-width verification
 *     anchor (so diagnostics still project back, invisibly to navigation).
 */

import type { CodeMapping } from "@volar/language-core";
import { expect, test } from "vite-plus/test";

import { generateVirtualCode, type VirtualCodeResult } from "./virtualCode.ts";

/** A mono processor body around `decls` + per-sample `body`. */
function mono(decls: string, body: string): string {
  return `const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}process(() => {
  forSample((i) => {
${body}
  });
});`;
}

const gen = (src: string): VirtualCodeResult => generateVirtualCode(src);
const code = (src: string): string => gen(src).code;

/** A verbatim (author) mapping vs. an injected (synthetic) one. */
const isSynth = (m: CodeMapping): boolean => m.generatedLengths !== undefined;

/** Map a source offset through the FULL (verbatim) mappings to a generated offset. */
function toGenerated(result: VirtualCodeResult, sourceOffset: number): number {
  for (const m of result.mappings) {
    if (isSynth(m)) continue;
    const so = m.sourceOffsets[0]!;
    const len = m.lengths[0]!;
    if (sourceOffset >= so && sourceOffset < so + len) {
      return m.generatedOffsets[0]! + (sourceOffset - so);
    }
  }
  return -1;
}

// ───────────────────────── operator desugaring ──────────────────────────────

test("arithmetic operators lower to the chain primitive call", () => {
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] + 1;`))).toContain(
    "out.ch(0).at(i).write(add(input.ch(0).at(i), 1))",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] * 2;`))).toContain(
    "write(mul(input.ch(0).at(i), 2))",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] - 3;`))).toContain(
    "sub(input.ch(0).at(i), 3)",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] / 4;`))).toContain(
    "div(input.ch(0).at(i), 4)",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] % 5;`))).toContain(
    "mod(input.ch(0).at(i), 5)",
  );
});

test("precedence is preserved by nesting, left-associative", () => {
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] * 2 + 1;`))).toContain(
    "add(mul(input.ch(0).at(i), 2), 1)",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] - 1 - 2;`))).toContain(
    "sub(sub(input.ch(0).at(i), 1), 2)",
  );
});

test("comparison operators lower; != negates eq", () => {
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] > 0 ? 1 : 0;`))).toContain(
    "gt(input.ch(0).at(i), 0)",
  );
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] >= 0 ? 1 : 0;`))).toContain("gte(");
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] <= 0 ? 1 : 0;`))).toContain("lte(");
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i] < 0 ? 1 : 0;`))).toContain("lt(");
  const ne = code(mono("const s = state.bool(false).named();", `s.write(input.ch(0)[i] != 0);`));
  expect(ne).toContain("not(eq(input.ch(0).at(i), 0))");
});

test("unary minus and logical not lower; ternary lowers to select", () => {
  expect(code(mono("", `out.ch(0)[i] = -input.ch(0)[i];`))).toContain("neg(input.ch(0).at(i))");
  const tern = code(
    mono("", `out.ch(0)[i] = input.ch(0)[i] > 0 ? input.ch(0)[i] : -input.ch(0)[i];`),
  );
  expect(tern).toContain(
    "select(gt(input.ch(0).at(i), 0), input.ch(0).at(i), neg(input.ch(0).at(i)))",
  );
  const bnot = code(mono("const b = state.bool(false).named();", `out.ch(0)[i] = !b ? 1 : 0;`));
  expect(bnot).toContain("not(b.read())");
});

test("number op number is NOT lowered (stays build-time JS)", () => {
  const c = code(mono("", `out.ch(0)[i] = input.ch(0)[i] * (2 + 3);`));
  expect(c).toContain("mul(input.ch(0).at(i), (2 + 3))");
  expect(c).not.toContain("add(2, 3)");
});

// ───────────────────────── index access desugaring ──────────────────────────

test("index read lowers by object kind: channel/param → at, buffer → read", () => {
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i];`))).toContain("input.ch(0).at(i)");
  expect(
    code(
      mono(
        'const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });',
        `out.ch(0)[i] = g[i];`,
      ),
    ),
  ).toContain("g.at(i)");
  expect(
    code(mono("const buf = state.buffer.f32({ size: 8 }).named();", `out.ch(0)[i] = buf[i];`)),
  ).toContain("buf.read(i)");
});

test("index write lowers: output channel → at().write(), buffer → write()", () => {
  expect(code(mono("", `out.ch(0)[i] = input.ch(0)[i];`))).toContain(
    "out.ch(0).at(i).write(input.ch(0).at(i))",
  );
  const buf = code(
    mono("const buf = state.buffer.f32({ size: 8 }).named();", `buf[i] = input.ch(0)[i];`),
  );
  expect(buf).toContain("buf.write(i, input.ch(0).at(i))");
});

test("a non-DSL element access is left verbatim (real array indexing untouched)", () => {
  const c = code(mono("const arr = [1, 2, 3];", `out.ch(0)[i] = input.ch(0)[i] * arr[0];`));
  expect(c).toContain("arr[0]");
  expect(c).not.toContain("arr.at(0)");
  expect(c).not.toContain("arr.read(0)");
});

// ───────────────────────── bare state read desugaring ───────────────────────

test("a bare state read in a value position lowers to .read(); a write stays explicit", () => {
  const c = code(
    mono(
      "const env = state.f32(0).named();",
      `out.ch(0)[i] = max(env, 0.5); env.write(env * 0.99);`,
    ),
  );
  expect(c).toContain("max(env.read(), 0.5)"); // call-arg value position reads
  expect(c).toContain("env.write(mul(env.read(), 0.99))"); // operand reads; the write target stays
});

test("$prev is cast to the method's slot scalar (the concrete type the build lowers it to)", () => {
  const src = `const onepole = defineSubgraph((coef: Node<"f32">) => ({
  process: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = input.ch(0)[i]; }); });`;
  const c = code(src);
  // `$prev` stays author text, wrapped in a cast to its slot scalar (here `f32`, the
  // method's `Node<"f32">` param) so the editor sees the concrete type — the broad
  // ambient `Node<ScalarType>` would draw a bogus operator error against the f32 ops.
  // The user's explicit parens around `(1 - coef)` are preserved verbatim.
  expect(c).toContain('add(mul(coef, x), mul((sub(1, coef)), ($prev as Node<"f32">)))');
});

test("$prev's slot scalar follows a return annotation, not the param (bool param, f32 return)", () => {
  const src = `const decay = defineSubgraph(() => ({
  run: (trigger: Node<"bool">): Node<"f32"> => select(trigger, f32(1), $prev * 0.95),
}));
const out = audioOutput({ channels: 1, name: "main" });
const d = createSubgraph(decay, { name: "d" });
process(() => { forSample((i) => { out.ch(0)[i] = 0; }); });`;
  expect(code(src)).toContain('($prev as Node<"f32">)');
});

test("$prev outside any defineSubgraph method is left verbatim (no slot to type it)", () => {
  // A stray `$prev` at module scope is not a feedback site — there is no method slot
  // to give it a scalar, so the IDE leaves it untouched (it stays the ambient Node).
  const c = code(mono("const k = $prev;", `out.ch(0)[i] = input.ch(0)[i];`));
  expect(c).toContain("const k = $prev;");
  expect(c).not.toContain("as Node<");
});

// ───────────────────────── auto-name (S9) for type-checking ─────────────────

test("no-arg .named() is filled with the binding name", () => {
  expect(code(mono("const env = state.f32(0).named();", `out.ch(0)[i] = env;`))).toContain(
    'state.f32(0).named("env")',
  );
});

test("an event with no name gets one injected into its options", () => {
  const c = code(`const taps = event({ from: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => { taps.onReceive(() => {}); forSample((i) => { out.ch(0)[i] = 0; }); });`);
  expect(c).toContain('event({ name: "taps", from: "main" })');
});

test("event.midi with no options object gets a name object injected", () => {
  const c = code(`const m = event.midi();
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = 0; }); });`);
  expect(c).toContain('event.midi({ name: "m" })');
});

test("an explicit name is never overwritten by auto-name", () => {
  const c = code(
    mono(
      `const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("custom");`,
      `out.ch(0)[i] = g[i];`,
    ),
  );
  expect(c).toContain('.named("custom")');
  expect(c).not.toContain('.named("custom").named');
});

test("an explicit name on an event — even quoted — is not duplicated", () => {
  const c = code(`const taps = event({ "name": "explicit", from: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => { taps.onReceive(() => {}); forSample((i) => { out.ch(0)[i] = 0; }); });`);
  expect(c).toContain('event({ "name": "explicit", from: "main" })');
  expect(c).not.toContain('name: "taps"');
});

// ───────────────────────── build-time (non-DSL) pass-through ────────────────

test("a build-time ternary and a prefix-minus on a literal stay as JavaScript", () => {
  // `48000 > 0` is number-vs-number (the forSample index `i` IS a Node, so a
  // comparison against it WOULD lower — a build-time condition must use plain numbers).
  const c = code(mono("", `const k = 48000 > 0 ? 1 : 2; out.ch(0)[i] = input.ch(0)[i] * -2 * k;`));
  expect(c).toContain("48000 > 0 ? 1 : 2"); // number condition → not a select
  expect(c).toContain("mul(mul(input.ch(0).at(i), -2), k)"); // dsp multiply lowers; -2 literal stays
});

test("a plain (non-buffer/non-output) array element write is left verbatim", () => {
  const c = code(mono("const arr = [0, 0, 0];", `arr[0] = i;`));
  expect(c).toContain("arr[0] = i;");
  expect(c).not.toContain("arr.write");
  expect(c).not.toContain("arr.at");
});

test("declaration shapes auto-name skips (multi-declarator, destructure, no-init) pass through", () => {
  const src = `const A = 1, B = 2;
const [first] = [10, 20];
let later;
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = input.ch(0)[i] * A; }); });`;
  const c = code(src);
  expect(c).toContain("const A = 1, B = 2;");
  expect(c).toContain("const [first] = [10, 20];");
  expect(c).toContain("let later;");
  expect(c).toContain("mul(input.ch(0).at(i), A)");
});

// ───────────────────────── module wrapping ──────────────────────────────────

test("the virtual module shadows the Node `process` global and is a module", () => {
  const c = code(mono("", `out.ch(0)[i] = input.ch(0)[i];`));
  expect(c.startsWith("declare function process(callback: () => void): void;\n")).toBe(true);
  expect(c.trimEnd().endsWith("export {};")).toBe(true);
});

// ───────────────────────── mapping invariants ───────────────────────────────

test("every verbatim mapping reproduces the author source byte-for-byte", () => {
  const src = mono(
    "const env = state.f32(0).named();",
    `out.ch(0)[i] = input.ch(0)[i] * 2 + env; env.write(env * 0.99);`,
  );
  const result = gen(src);
  for (const m of result.mappings) {
    if (isSynth(m)) {
      // injected glue: a zero-width source anchor with its own generated length
      expect(m.lengths[0]).toBe(0);
      expect(m.generatedLengths?.[0]).toBeGreaterThan(0);
      continue;
    }
    const srcText = src.slice(m.sourceOffsets[0]!, m.sourceOffsets[0]! + m.lengths[0]!);
    const genText = result.code.slice(
      m.generatedOffsets[0]!,
      m.generatedOffsets[0]! + m.lengths[0]!,
    );
    expect(genText).toBe(srcText);
  }
});

test("generated offsets are non-decreasing (a valid forward source map)", () => {
  const result = gen(mono("", `out.ch(0)[i] = input.ch(0)[i] * 2;`));
  let last = -1;
  for (const m of result.mappings) {
    expect(m.generatedOffsets[0]!).toBeGreaterThanOrEqual(last);
    last = m.generatedOffsets[0]!;
  }
});

test("a source identifier maps to the same identifier text in the generated code", () => {
  const src = mono(
    'const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });',
    `out.ch(0)[i] = input.ch(0)[i] * gain[i];`,
  );
  const result = gen(src);
  // the `gain` use inside the body (the last occurrence) must map to `gain` in the output
  const useOffset = src.lastIndexOf("gain[i]");
  const g = toGenerated(result, useOffset);
  expect(g).toBeGreaterThanOrEqual(0);
  expect(result.code.startsWith("gain", g)).toBe(true);
});

test("comments and whitespace between tokens are preserved verbatim", () => {
  const src = mono("", `// keep me\n    out.ch(0)[i] = input.ch(0)[i]; // trailing`);
  const c = code(src);
  expect(c).toContain("// keep me");
  expect(c).toContain("// trailing");
});
