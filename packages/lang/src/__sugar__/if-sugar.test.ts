/**
 * Exhaustive bit-identity + behavioral tests for the `if`-sugar lowering
 * (RFC-001 S7). An `if` whose condition is a `Node<'bool'>` lowers to a
 * branch-free `select` / `emitIf`; a JS-boolean condition stays a build-time
 * `if` (a meta-program that compiles ONE branch into the graph). Shapes:
 *
 *   shape 1 — single write, no else:
 *     if (c) s.write(v)     → s.write(select(c, v, s.read()))
 *     if (c) buf[i] = v     → buf.write(i, select(c, v, buf.read(i)))
 *   shape 2 — symmetric if-else, same target:
 *     if (c) s.write(a) else s.write(b)  → s.write(select(c, a, b))
 *   shape 3 — guarded emit(s), no else:
 *     if (c) port.emit(p)   → port.emitIf(c, p)   (per emit in the block)
 *
 * `expectSameLowering` proves structural identity against a hand-written explicit
 * chain-DSL form (NO operator / index / bare-state / if sugar) = ground truth.
 * `renderLowered` proves SEMANTICS against a pure-JS reference — the most robust
 * check, since JS math is unambiguous. The select is branch-free: BOTH value
 * sub-graphs are always evaluated; the condition only picks which result lands.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, lower, renderLowered } from "../goldenHarness.ts";
import { LowerError } from "../lower.ts";

const SR = 48000;
const N = 128;

/** A minimal mono processor: declarations + a per-sample body. */
function mono(decls: string, body: string): string {
  return `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;
}

/** A deterministic bipolar ramp input in [-1, ~1). */
function ramp(): Float32Array {
  const x = new Float32Array(N);
  for (let n = 0; n < N; n++) x[n] = (n / N) * 2 - 1;
  return x;
}

/** Render a mono body against a single input channel. */
async function renderBody(
  body: string,
  decls = "",
  x: Float32Array = ramp(),
): Promise<Float32Array> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: N / SR,
    inputs: { main: [x] },
  });
  return r.outputs.main![0]!;
}

/** Round to f32 precision so the JS reference matches WASM f32 storage. */
const f32 = (v: number): number => Math.fround(v);

// ───────────────────────────────────────────────────────────────────────────
// shape 1 — single state write, no else
//   if (c) s.write(v) → s.write(select(c, v, s.read()))
// ───────────────────────────────────────────────────────────────────────────

test("shape1 state: if(c) s.write(v) == s.write(select(c, v, s.read()))", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), input.ch(0).at(i), s.read()));`,
    ),
  );
});

test("shape1 state: behavior — sample-and-hold latches the last x>0 value", async () => {
  // s holds its prior value when the guard is false (s.read() else branch),
  // and takes x when x>0. We mirror that exact recurrence in pure JS.
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  let held = 0;
  for (let n = 0; n < N; n++) {
    // out reads s AFTER the conditional write this sample.
    if (f32(x[n]!) > 0) held = f32(x[n]!);
    expect(got[n]).toBeCloseTo(held, 5);
  }
});

test("shape1 state: nested value expr lowers inside the select then-branch", async () => {
  // value = x*2 + 1, written only when x > 0; else hold.
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) * 2 + 1);`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), add(mul(input.ch(0).at(i), 2), 1), s.read()));`,
    ),
  );
});

test("shape1 state: behavior — nested value expr (x*2+1) only on x>0", async () => {
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) * 2 + 1);\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  let held = 0;
  for (let n = 0; n < N; n++) {
    if (f32(x[n]!) > 0) held = f32(f32(f32(x[n]!) * 2) + 1);
    expect(got[n]).toBeCloseTo(held, 4);
  }
});

test("shape1 state: a bare-State VALUE in the then-write reads (if(c) s.write(v))", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');\nconst v = state.f32(9).named('v');",
      `if (input.ch(0).at(i) > 0) s.write(v);`,
    ),
    mono(
      "const s = state.f32(0).named('s');\nconst v = state.f32(9).named('v');",
      `s.write(select(gt(input.ch(0).at(i), 0), v.read(), s.read()));`,
    ),
  );
});

test("shape1 state: i32 target — integer write under a comparison guard", async () => {
  await expectSameLowering(
    mono("const k = state.i32(0).named('k');", `if (input.ch(0).at(i) > 0) k.write(i32(7));`),
    mono(
      "const k = state.i32(0).named('k');",
      `k.write(select(gt(input.ch(0).at(i), 0), i32(7), k.read()));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// shape 1 — single buffer write, no else
//   if (c) buf[i] = v → buf.write(i, select(c, v, buf.read(i)))
//   (the `buf.write(i, v)` explicit form is identical)
// ───────────────────────────────────────────────────────────────────────────

test("shape1 buffer: if(c) buf[i] = v == buf.write(i, select(c, v, buf.read(i)))", async () => {
  const d = "const buf = state.buffer.f32({ size: 128 }).named('buf');";
  await expectSameLowering(
    mono(d, `if (input.ch(0).at(i) > 0) buf[i] = input.ch(0).at(i);`),
    mono(d, `buf.write(i, select(gt(input.ch(0).at(i), 0), input.ch(0).at(i), buf.read(i)));`),
  );
});

test("shape1 buffer: if(c) buf[wp] = v — wp is a bare State<'i32'>, auto-reads on both sides", async () => {
  // Round 3 dogfood regression. The dogfooder used a moving write pointer:
  // `if (someBoolNode) buf[wp] = value`, where `wp` is a `State<"i32">`.
  // Before this test, the ifSugar rewrite emitted `buf.write(wp, select(c, v,
  // buf.read(wp)))` — but neither `wp` position was read-wrapped (the pass
  // synthesizes the calls, so the bareState pass never gets a shot at those
  // synthesized `wp` uses that live inside the injected `.write(wp, ...)` and
  // `.read(wp)`). Both `wp` uses reached graph capture as raw State handles
  // and crashed with "expected a Node<T> ... received an object".
  const d =
    "const buf = state.buffer.f32({ size: 128 }).named('buf');\n" +
    "const wp = state.i32(0).named('wp');";
  await expectSameLowering(
    mono(d, `if (input.ch(0).at(i) > 0) buf[wp] = input.ch(0).at(i);`),
    mono(
      d,
      `buf.write(wp.read(), select(gt(input.ch(0).at(i), 0), input.ch(0).at(i), buf.read(wp.read())));`,
    ),
  );
});

test("shape1 buffer: index-sugar and write-call forms lower identically", async () => {
  const d = "const buf = state.buffer.f32({ size: 128 }).named('buf');";
  await expectSameLowering(
    mono(d, `if (input.ch(0).at(i) > 0) buf[i] = input.ch(0).at(i);`),
    mono(d, `if (input.ch(0).at(i) > 0) buf.write(i, input.ch(0).at(i));`),
  );
});

test("shape1 buffer: behavior — only positive samples land in the buffer", async () => {
  // Write x into buf[i] when x>0 (else keep prior buf[i], which is 0 first block),
  // then read buf[i] back out the same sample.
  const x = ramp();
  const d = "const buf = state.buffer.f32({ size: 128 }).named('buf');";
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) buf[i] = input.ch(0).at(i);\nout.ch(0).at(i).write(buf[i]);`,
    d,
  );
  for (let n = 0; n < N; n++) {
    // buf starts 0; written to x[n] only when x[n] > 0.
    expect(got[n]).toBeCloseTo(f32(x[n]!) > 0 ? f32(x[n]!) : 0, 5);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// shape 2 — symmetric if-else, same target → select(c, a, b)
// ───────────────────────────────────────────────────────────────────────────

test("shape2 state: if(c) s.write(a) else s.write(b) == s.write(select(c, a, b))", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) s.write(f32(1)); else s.write(f32(2));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), f32(1), f32(2)));`,
    ),
  );
});

test("shape2 state: behavior — picks a above 0, b at/below (full select)", async () => {
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(f32(1)); else s.write(f32(2));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!) > 0 ? 1 : 2, 5);
});

test("shape2 state: braces on both branches lower identically to bare statements", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) { s.write(f32(1)); } else { s.write(f32(2)); }`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), f32(1), f32(2)));`,
    ),
  );
});

test("shape2 state: both value branches are nested exprs — both lower", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) * 2); else s.write(-input.ch(0).at(i));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), mul(input.ch(0).at(i), 2), neg(input.ch(0).at(i))));`,
    ),
  );
});

test("shape2 state: behavior — c ? x*2 : -x equals branch math", async () => {
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) * 2); else s.write(-input.ch(0).at(i));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) {
    const xv = f32(x[n]!);
    expect(got[n]).toBeCloseTo(xv > 0 ? f32(xv * 2) : f32(-xv), 4);
  }
});

test("shape2 buffer: symmetric if-else to the same buf[i] index", async () => {
  const d = "const buf = state.buffer.f32({ size: 128 }).named('buf');";
  await expectSameLowering(
    mono(d, `if (input.ch(0).at(i) > 0) buf[i] = f32(1); else buf[i] = f32(2);`),
    mono(d, `buf.write(i, select(gt(input.ch(0).at(i), 0), f32(1), f32(2)));`),
  );
});

test("shape2 buffer: behavior — select writes 1 above / 2 at-or-below", async () => {
  const x = ramp();
  const d = "const buf = state.buffer.f32({ size: 128 }).named('buf');";
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) buf[i] = f32(1); else buf[i] = f32(2);\nout.ch(0).at(i).write(buf[i]);`,
    d,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!) > 0 ? 1 : 2, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// condition variants — comparison / ! / != / bool-state-derived
// ───────────────────────────────────────────────────────────────────────────

test("cond: each comparison operator forms a valid select guard (>=, <=, <, ==)", async () => {
  for (const [op, fn] of [
    [">=", "gte"],
    ["<=", "lte"],
    ["<", "lt"],
    ["==", "eq"],
  ] as const) {
    await expectSameLowering(
      mono(
        "const s = state.f32(0).named('s');",
        `if (input.ch(0).at(i) ${op} 0) s.write(f32(1)); else s.write(f32(2));`,
      ),
      mono(
        "const s = state.f32(0).named('s');",
        `s.write(select(${fn}(input.ch(0).at(i), 0), f32(1), f32(2)));`,
      ),
    );
  }
});

test("cond: != condition lowers to not(eq(...)) inside the select guard", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) != 0) s.write(f32(1)); else s.write(f32(2));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(not(eq(input.ch(0).at(i), 0)), f32(1), f32(2)));`,
    ),
  );
});

test("cond: !(a > b) negates the comparison guard", async () => {
  await expectSameLowering(
    mono("const s = state.f32(0).named('s');", `if (!(input.ch(0).at(i) > 0)) s.write(f32(1));`),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(not(gt(input.ch(0).at(i), 0)), f32(1), s.read()));`,
    ),
  );
});

test("cond: !(bare bool state) reads-then-negates the state in the guard", async () => {
  // `!c` is an operator operand → the not-pass read-wraps `c` → not(c.read()).
  await expectSameLowering(
    mono(
      "const c = state.bool(false).named('c');\nconst s = state.f32(0).named('s');",
      `if (!c) s.write(f32(1));`,
    ),
    mono(
      "const c = state.bool(false).named('c');\nconst s = state.f32(0).named('s');",
      `s.write(select(not(c.read()), f32(1), s.read()));`,
    ),
  );
});

test("cond: behavior — !c on a false-default state always writes (guard true)", async () => {
  const got = await renderBody(
    `if (!c) s.write(f32(5));\nout.ch(0).at(i).write(s.read());`,
    "const c = state.bool(false).named('c');\nconst s = state.f32(0).named('s');",
  );
  // c stays false → !c always true → s becomes 5 from sample 0.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(5, 6);
});

test("cond: arithmetic-both-sides comparison guard (x*2 > x+0.5 ⇔ x > 0.5)", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) * 2 > input.ch(0).at(i) + 0.5) s.write(f32(1)); else s.write(f32(0));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(mul(input.ch(0).at(i), 2), add(input.ch(0).at(i), 0.5)), f32(1), f32(0)));`,
    ),
  );
});

test("cond: behavior — i32 counter == literal guard fires at exact value", async () => {
  const got = await renderBody(
    `if (k == 3) s.write(i32(1)); else s.write(i32(0));\nk.write(k.read() + 1);\nout.ch(0).at(i).write(f32(s.read()));`,
    "const k = state.i32(0).named('k');\nconst s = state.i32(0).named('s');",
  );
  for (let n = 0; n < 8; n++) expect(got[n]).toBeCloseTo(n === 3 ? 1 : 0, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// shape 3 — guarded emit → emitIf
// ───────────────────────────────────────────────────────────────────────────

test("shape3 emit: if(c) port.emit(p) == port.emitIf(c, p)", async () => {
  const d = "const ev = event<{ level: number }>({ to: 'main', name: 'ev' });";
  await expectSameLowering(
    mono(d, `if (input.ch(0).at(i) > 0) ev.emit({ atSample: i, level: input.ch(0).at(i) });`),
    mono(d, `ev.emitIf(gt(input.ch(0).at(i), 0), { atSample: i, level: input.ch(0).at(i) });`),
  );
});

test("shape3 emit: behavior — fires once per sample where guard is true", async () => {
  // ramp positive for n >= 64 (x = (n/128)*2-1 > 0 ⇔ n > 64). Emit there.
  const x = ramp();
  const r = await renderLowered(
    mono(
      "const ev = event<{ level: number }>({ to: 'main', name: 'ev' });",
      `if (input.ch(0).at(i) > 0) ev.emit({ atSample: i, level: input.ch(0).at(i) });\nout.ch(0).at(i).write(input.ch(0).at(i));`,
    ),
    { sampleRate: SR, duration: N / SR, inputs: { main: [x] } },
  );
  const fired = r.events.filter((e) => e.name === "ev");
  const expectedSamples: number[] = [];
  for (let n = 0; n < N; n++) if (f32(x[n]!) > 0) expectedSamples.push(n);
  expect(fired.map((e) => e.atSample)).toEqual(expectedSamples);
  // each payload level == the input at that sample.
  for (const e of fired) {
    expect((e.payload as { level: number }).level).toBeCloseTo(f32(x[e.atSample]!), 5);
  }
});

test("shape3 emit: behavior — false guard emits nothing", async () => {
  // x <= 0 everywhere (all -1) → no emits.
  const r = await renderLowered(
    mono(
      "const ev = event<{ level: number }>({ to: 'main', name: 'ev' });",
      `if (input.ch(0).at(i) > 0) ev.emit({ atSample: i, level: input.ch(0).at(i) });`,
    ),
    { sampleRate: SR, duration: N / SR, inputs: { main: [new Float32Array(N).fill(-1)] } },
  );
  expect(r.events.filter((e) => e.name === "ev")).toHaveLength(0);
});

test("shape3 emit: MULTI-emit block — each emit becomes its own emitIf", async () => {
  const d =
    "const a = event<{ x: number }>({ to: 'main', name: 'a' });\nconst b = event<{ y: number }>({ to: 'main', name: 'b' });";
  await expectSameLowering(
    mono(
      d,
      `if (input.ch(0).at(i) > 0) { a.emit({ atSample: i, x: f32(1) }); b.emit({ atSample: i, y: f32(2) }); }`,
    ),
    mono(
      d,
      `a.emitIf(gt(input.ch(0).at(i), 0), { atSample: i, x: f32(1) });\nb.emitIf(gt(input.ch(0).at(i), 0), { atSample: i, y: f32(2) });`,
    ),
  );
});

test("shape3 emit: behavior — multi-emit fires BOTH ports on the same guard", async () => {
  const x = ramp();
  const r = await renderLowered(
    mono(
      "const a = event<{ x: number }>({ to: 'main', name: 'a' });\nconst b = event<{ y: number }>({ to: 'main', name: 'b' });",
      `if (input.ch(0).at(i) > 0) { a.emit({ atSample: i, x: f32(1) }); b.emit({ atSample: i, y: f32(2) }); }`,
    ),
    { sampleRate: SR, duration: N / SR, inputs: { main: [x] } },
  );
  const aEv = r.events.filter((e) => e.name === "a");
  const bEv = r.events.filter((e) => e.name === "b");
  const expectedSamples: number[] = [];
  for (let n = 0; n < N; n++) if (f32(x[n]!) > 0) expectedSamples.push(n);
  expect(aEv.map((e) => e.atSample)).toEqual(expectedSamples);
  expect(bEv.map((e) => e.atSample)).toEqual(expectedSamples);
});

test("shape3 emit: a comparison guard with arithmetic operands lowers in the emitIf", async () => {
  const d = "const ev = event<{ level: number }>({ to: 'main', name: 'ev' });";
  await expectSameLowering(
    mono(
      d,
      `if (input.ch(0).at(i) * 2 > 0.5) ev.emit({ atSample: i, level: input.ch(0).at(i) + 1 });`,
    ),
    mono(
      d,
      `ev.emitIf(gt(mul(input.ch(0).at(i), 2), 0.5), { atSample: i, level: add(input.ch(0).at(i), 1) });`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// JS-boolean if STAYS build-time (meta-program) — must NOT become a select
// ───────────────────────────────────────────────────────────────────────────

test("js-if: a build-time-true condition compiles ONLY the then-branch", async () => {
  // K=5; K>3 is a JS boolean → the if is a meta-program: only the then branch
  // (input passthrough) becomes a graph node; no select is emitted.
  const x = ramp();
  const got = await renderBody(
    `if (K > 3) out.ch(0).at(i).write(input.ch(0).at(i)); else out.ch(0).at(i).write(f32(0));`,
    "const K = 5;",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!), 6);
});

test("js-if: a build-time-false condition compiles ONLY the else-branch", async () => {
  const got = await renderBody(
    `if (K > 3) out.ch(0).at(i).write(input.ch(0).at(i)); else out.ch(0).at(i).write(f32(0));`,
    "const K = 2;",
  );
  // 2 > 3 is false → only the constant-0 else branch is compiled.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(0, 6);
});

test("js-if: structural — a true build-time if equals just its then-statement", async () => {
  await expectSameLowering(
    mono(
      "const K = 5;",
      `if (K > 3) out.ch(0).at(i).write(input.ch(0).at(i)); else out.ch(0).at(i).write(f32(0));`,
    ),
    mono("const K = 5;", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("js-if: structural — a false build-time if equals just its else-statement", async () => {
  await expectSameLowering(
    mono(
      "const K = 2;",
      `if (K > 3) out.ch(0).at(i).write(input.ch(0).at(i)); else out.ch(0).at(i).write(f32(0));`,
    ),
    mono("const K = 2;", `out.ch(0).at(i).write(f32(0));`),
  );
});

test("js-if: a build-time guard around a STATE write stays a build-time write (no select)", async () => {
  // N=64 is a JS number; `N > 0` is build-time true → the s.write executes
  // unconditionally as a plain meta-program write — NOT wrapped in select.
  await expectSameLowering(
    mono(
      "const N64 = 64;\nconst s = state.f32(0).named('s');",
      `if (N64 > 0) s.write(input.ch(0).at(i));`,
    ),
    mono("const N64 = 64;\nconst s = state.f32(0).named('s');", `s.write(input.ch(0).at(i));`),
  );
});

test("js-if: behavior — a build-time guard that is FALSE drops the write entirely", async () => {
  // N=0; `N > 0` false → the s.write never compiles; s stays at its default 0.
  const got = await renderBody(
    `if (Z > 0) s.write(f32(9));\nout.ch(0).at(i).write(s.read());`,
    "const Z = 0;\nconst s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(0, 6);
});

// ───────────────────────────────────────────────────────────────────────────
// shapes that must NOT lower to select — left as build-time `if`
// (these are unsupported by if-sugar; the pass returns undefined)
// ───────────────────────────────────────────────────────────────────────────

test("reject: asymmetric if-else to DIFFERENT targets throws (would silently drop a branch)", () => {
  // Different write targets ⇒ sameTarget() is false ⇒ no select shape. Leaving it as
  // a build-time `if` is the footgun if-sugar exists to prevent: the forSample body
  // runs once at capture, where the Node<'bool'> condition is a truthy object, so
  // only `a.write(1)` would ever be compiled and `b.write(2)` is silently dropped.
  // Refuse it instead. (Reported by @codex on #12.)
  const src = mono(
    "const a = state.f32(0).named('a');\nconst b = state.f32(0).named('b');",
    `if (input.ch(0).at(i) > 0) a.write(f32(1)); else b.write(f32(2));`,
  );
  expect(() => lower(src)).toThrow(LowerError);
  try {
    lower(src);
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-unsupported-if");
  }
});

// ───────────────────────────────────────────────────────────────────────────
// adversarial — precedence / nesting / value sub-graph sharing
// ───────────────────────────────────────────────────────────────────────────

test("adversarial: a nested ternary INSIDE the written value lowers fully", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) > 0.5 ? f32(2) : f32(1)); else s.write(f32(0));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `s.write(select(gt(input.ch(0).at(i), 0), select(gt(input.ch(0).at(i), 0.5), f32(2), f32(1)), f32(0)));`,
    ),
  );
});

test("adversarial: behavior — guarded nested-ternary value matches JS reference", async () => {
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i) > 0.5 ? f32(2) : f32(1)); else s.write(f32(0));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) {
    const xv = f32(x[n]!);
    const expected = xv > 0 ? (xv > 0.5 ? 2 : 1) : 0;
    expect(got[n]).toBeCloseTo(expected, 5);
  }
});

test("adversarial: the same input feeds both the guard and the value", async () => {
  // Half-wave rectifier: pass x when x>0, else hold 0. value === guard operand.
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(input.ch(0).at(i)); else s.write(f32(0));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!) > 0 ? f32(x[n]!) : 0, 5);
});

test("adversarial: branch-free — the else sub-graph still evaluates (no NaN leak)", async () => {
  // The then value contains a sqrt of a possibly-negative input; because select is
  // branch-free, sqrt(x) is ALWAYS evaluated, but the guard masks negatives away.
  // We only assert the SELECTED result; the unselected NaN must not leak.
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) s.write(sqrt(input.ch(0).at(i))); else s.write(f32(0));\nout.ch(0).at(i).write(s.read());`,
    "const s = state.f32(0).named('s');",
  );
  for (let n = 0; n < N; n++) {
    const xv = f32(x[n]!);
    expect(got[n]).toBeCloseTo(xv > 0 ? f32(Math.sqrt(xv)) : 0, 4);
  }
});

test("adversarial: i64 value branch — no implicit number lift, uses i64(BigInt)", async () => {
  await expectSameLowering(
    mono(
      "const m = state.i64(0n).named('m');",
      `if (input.ch(0).at(i) > 0) m.write(i64(7n)); else m.write(i64(3n));`,
    ),
    mono(
      "const m = state.i64(0n).named('m');",
      `m.write(select(gt(input.ch(0).at(i), 0), i64(7n), i64(3n)));`,
    ),
  );
});

test("adversarial: i64 behavior — selects the right BigInt branch through to f32", async () => {
  const x = ramp();
  const got = await renderBody(
    `if (input.ch(0).at(i) > 0) m.write(i64(7n)); else m.write(i64(3n));\nout.ch(0).at(i).write(f32(i32(m.read())));`,
    "const m = state.i64(0n).named('m');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!) > 0 ? 7 : 3, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// rejection — a Node<'bool'> condition that matches NONE of the three shapes is
// refused, NOT left as a build-time `if`. A `.uwk.ts` file is `@ts-nocheck`, so
// at graph-capture time the condition is a truthy DSP object and a JS `if` would
// silently capture only the then-branch → wrong audio. (Reported by @codex on #12.)
// ───────────────────────────────────────────────────────────────────────────

test("reject: a DSP-cond if with two different writes throws (not silently dropped)", () => {
  const src = mono(
    "const s = state.f32(0).named('s');\nconst t = state.f32(0).named('t');",
    `if (input.ch(0).at(i) > 0) { s.write(input.ch(0).at(i)); t.write(input.ch(0).at(i)); }`,
  );
  expect(() => lower(src)).toThrow(LowerError);
  try {
    lower(src);
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-unsupported-if");
  }
});

test("accept: a JS-boolean if stays a build-time branch (the guard only fires on Node<'bool'>)", () => {
  // A plain JS condition is the meta-program path: it must NOT trip the new guard.
  const src = mono(
    "const s = state.f32(0).named('s');",
    `if (1 > 0) s.write(input.ch(0).at(i)); else s.write(0);`,
  );
  expect(() => lower(src)).not.toThrow();
});

// ───────────────────────────────────────────────────────────────────────────
// more unsupported DSP-cond shapes — each must throw `uwk-unsupported-if`, never
// silently lower to one branch. These pin the rejection of every then/else shape
// the three sugar forms (single write / symmetric write / guarded emit) reject.
// ───────────────────────────────────────────────────────────────────────────

/** Lower `src` and return the thrown LowerError id (or "<no throw>"). */
function lowerErrorId(src: string): string {
  try {
    lower(src);
  } catch (e) {
    return (e as LowerError).id;
  }
  return "<no throw>";
}

test("reject: then-branch is a single NON-write statement (a bare read)", () => {
  // `s.read()` is not a write, so no single-write shape matches → refuse, don't drop.
  const src = mono("const s = state.f32(0).named('s');", `if (input.ch(0).at(i) > 0) s.read();`);
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: then-branch is a declaration (not an expression statement)", () => {
  const src = mono(
    "const s = state.f32(0).named('s');",
    `if (input.ch(0).at(i) > 0) { let z = i; }`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: an empty then-block matches neither emit nor write", () => {
  const src = mono("const s = state.f32(0).named('s');", `if (input.ch(0).at(i) > 0) {}`);
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: writing to an output-channel sample inside a DSP-cond if", () => {
  // `out.ch(0).at(i).write(v)` is a `.write` call, but the target is not a state /
  // two-arg buffer write, so the single-write shape does not match.
  const src = mono("", `if (input.ch(0).at(i) > 0) out.ch(0).at(i).write(f32(1));`);
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: symmetric if-else writing DIFFERENT kinds (state vs buffer)", () => {
  const src = mono(
    "const s = state.f32(0).named('s');\nconst buf = state.buffer.f32({ size: 8 }).named('buf');",
    `if (input.ch(0).at(i) > 0) s.write(f32(1)); else buf[i] = f32(2);`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: symmetric if-else writing two DIFFERENT buffers", () => {
  const src = mono(
    "const a = state.buffer.f32({ size: 8 }).named('a');\nconst b = state.buffer.f32({ size: 8 }).named('b');",
    `if (input.ch(0).at(i) > 0) a[i] = f32(1); else b[i] = f32(2);`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: symmetric if-else where the then-branch has two statements", () => {
  const src = mono(
    "const s = state.f32(0).named('s');\nconst t = state.f32(0).named('t');",
    `if (input.ch(0).at(i) > 0) { s.write(f32(1)); t.write(f32(2)); } else s.write(f32(3));`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: a then-block mixing a declaration with an emit is not a guarded emit", () => {
  const src = `const out = audioOutput({ channels: 1, name: "main" });
const input = audioInput({ channels: 1, name: "main" });
const ev = event<{ x: number }>({ to: "main", name: "ev" });
process(() => { forSample((i) => {
  if (input.ch(0)[i] > 0) { const z = f32(1); ev.emit({ atSample: i, x: z }); }
}); });`;
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: symmetric if-else writing two DIFFERENT states (target mismatch)", () => {
  // Both branches are state writes but to different slots, so the symmetric-write
  // shape does not match — the two targets are not the same.
  const src = mono(
    "const s = state.f32(0).named('s');\nconst t = state.f32(0).named('t');",
    `if (input.ch(0).at(i) > 0) s.write(f32(1)); else t.write(f32(2));`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});

test("reject: symmetric if-else writing the SAME buffer at DIFFERENT indices", () => {
  // Same buffer, but `buf[i]` vs `buf[head]` are different index expressions, so the
  // write targets are not identical.
  const src = mono(
    "const buf = state.buffer.f32({ size: 8 }).named('buf');\nconst head = state.i32(0).named('head');",
    `if (input.ch(0).at(i) > 0) buf[i] = f32(1); else buf[head] = f32(2);`,
  );
  expect(lowerErrorId(src)).toBe("uwk-unsupported-if");
});
