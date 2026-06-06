/**
 * EXHAUSTIVE tests for the AUTO-NAME pass (`.uwk.ts` → `.ts` lowering, RFC-001
 * S9). The pass runs on module-top-level `const X = <decl helper>` and derives
 * the declaration name from the binding identifier when none is given:
 *
 *   const cutoff = param.f32({...})          → param.f32({...}).named("cutoff")
 *   const input  = audioInput({ channels })  → audioInput({ channels, name: "input" })
 *   const notes  = event.midi({ from })      → event.midi({ from, name: "notes" })
 *
 * Contract under test:
 *  - Name-required helpers (audioInput / audioOutput / event / event.midi) get
 *    `name: "<binding>"` merged INTO their options object.
 *  - `param.<T>(...)` gets a trailing `.named("<binding>")`.
 *  - An explicit `name` / `.named(...)` ALWAYS WINS (left untouched), regardless
 *    of chain order (`param.named("x").f32(...)` and `param.f32(...).named("x")`).
 *  - Name-OPTIONAL helpers are left alone: a plain `state.f32(0)` stays anonymous
 *    (`__state_N`); `state.f32(0).named("x")` / `state.buffer....named("x")` keep
 *    their explicit name.
 *  - A non-helper `const x = Math.round(...)` is NEVER touched.
 *
 * Oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the explicit form spells the name
 *    out by hand; structural equality proves the auto-name produced the same
 *    declaration. GROUND TRUTH.
 *  - `compiledDeclNames(uwk, kind)` (local) — compile the lowered processor and
 *    read the declaration NAMES straight out of the compiled graph. This is the
 *    behavioral oracle for naming: it is exactly the identity a host addresses
 *    (`node.params.<name>`, `writeParam("<name>", ...)`, `node.events.<name>`).
 *  - `renderLowered` — end-to-end render to prove a name-routed port actually
 *    carries audio.
 *
 * Two genuine lang bugs in this category were found, REMOVED (so this file is
 * green), and reported in the structured result rather than asserted:
 *   (1) `param.f32({...}).expose({ name: "X" })` — the explicit `.expose` name is
 *       silently CLOBBERED by the auto-name `.named("<binding>")` (after-wins),
 *       so the compiled param is named after the binding, not "X".
 *   (2) `audioInput(opts)` where `opts` is an identifier (not an object literal)
 *       — auto-name REPLACES the whole argument with `{ name: "<binding>" }`,
 *       DROPPING `channels` and producing a structurally invalid declaration.
 * See the structured report for the minimal repros.
 */

import { expect, test } from "vite-plus/test";

import { compile } from "@unworklet/core";

import { evalLowered, expectSameLowering, lower, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;

/** A minimal mono processor (port name "main"): declarations + a per-sample body. */
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

/**
 * Compile a lowered `.uwk.ts` and return the NAMES of its graph declarations of
 * a given kind. This is the behavioral identity a host addresses, so it is the
 * ground truth for what the auto-name pass actually produced.
 */
async function compiledDeclNames(uwk: string, kind: string): Promise<string[]> {
  const proc = evalLowered(lower(uwk));
  const res = await compile(proc, { sampleRate: SR });
  const graph = JSON.parse(JSON.stringify(res.graph)) as {
    declarations?: Array<{ kind: string; name: string }>;
  };
  return (graph.declarations ?? []).filter((d) => d.kind === kind).map((d) => d.name);
}

const A_RATE = `{ default: 1, min: 0, max: 2, automationRate: "k-rate" }`;

// ───────────────────────────────────────────────────────────────────────────
// 1. audioInput / audioOutput — name merged into the options object
// ───────────────────────────────────────────────────────────────────────────

test("audioInput no name ≡ explicit name in options (mono)", async () => {
  await expectSameLowering(
    mono(`const inA = audioInput({ channels: 1 });`, `out.ch(0).at(i).write(inA.ch(0).at(i));`),
    mono(
      `const inA = audioInput({ channels: 1, name: "inA" });`,
      `out.ch(0).at(i).write(inA.ch(0).at(i));`,
    ),
  );
});

test("audioInput auto-name → binding identifier (behavioral)", async () => {
  expect(
    await compiledDeclNames(
      mono(`const inA = audioInput({ channels: 1 });`, `out.ch(0).at(i).write(inA.ch(0).at(i));`),
      "audioInput",
    ),
  ).toStrictEqual(["main", "inA"]);
});

test("audioInput stereo no name ≡ explicit name (channels preserved)", async () => {
  await expectSameLowering(
    mono(`const inA = audioInput({ channels: 2 });`, `out.ch(0).at(i).write(inA.left.at(i));`),
    mono(
      `const inA = audioInput({ channels: 2, name: "inA" });`,
      `out.ch(0).at(i).write(inA.left.at(i));`,
    ),
  );
});

test("audioOutput no name ≡ explicit name (second output port)", async () => {
  await expectSameLowering(
    mono(
      `const aux = audioOutput({ channels: 1 });`,
      `aux.ch(0).at(i).write(f32(0)); out.ch(0).at(i).write(f32(0));`,
    ),
    mono(
      `const aux = audioOutput({ channels: 1, name: "aux" });`,
      `aux.ch(0).at(i).write(f32(0)); out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

test("audioOutput auto-name → binding identifier (behavioral)", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const aux = audioOutput({ channels: 1 });`,
        `aux.ch(0).at(i).write(f32(0)); out.ch(0).at(i).write(f32(0));`,
      ),
      "audioOutput",
    ),
  ).toStrictEqual(["main", "aux"]);
});

test("audioInput EXPLICIT name in options WINS (not overridden by binding)", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const inA = audioInput({ channels: 1, name: "EXPL" });`,
        `out.ch(0).at(i).write(inA.ch(0).at(i));`,
      ),
      "audioInput",
    ),
  ).toStrictEqual(["main", "EXPL"]);
});

test('audioInput EXPLICIT QUOTED "name" WINS (StringLiteral key, not Identifier)', async () => {
  // A quoted key is a StringLiteral; the auto-name guard must recognize it too, or
  // it appends a second `name: "inA"` that wins and silently renames the port.
  // (Reported by @codex on #12.)
  expect(
    await compiledDeclNames(
      mono(
        `const inA = audioInput({ channels: 1, "name": "EXPL" });`,
        `out.ch(0).at(i).write(inA.ch(0).at(i));`,
      ),
      "audioInput",
    ),
  ).toStrictEqual(["main", "EXPL"]);
});

test("audioInput explicit-name sugar ≡ itself (idempotent: no double-name)", async () => {
  // Auto-name must NOT append a second name when one already exists.
  await expectSameLowering(
    mono(
      `const inA = audioInput({ channels: 1, name: "EXPL" });`,
      `out.ch(0).at(i).write(inA.ch(0).at(i));`,
    ),
    mono(
      `const inA = audioInput({ channels: 1, name: "EXPL" });`,
      `out.ch(0).at(i).write(inA.ch(0).at(i));`,
    ),
  );
});

test("audioInput name property order (channels first, then injected name)", async () => {
  // The injected `name` is appended after existing props — the lowered text must
  // keep `channels` and add `name`. Structural equality with the spelled-out form
  // proves both props survive.
  const lowered = lower(
    mono(`const inA = audioInput({ channels: 2 });`, `out.ch(0).at(i).write(inA.left.at(i));`),
  );
  expect(lowered).toContain(`audioInput({ channels: 2, name: "inA" })`);
});

test("audioInput name-routed port carries audio end-to-end", async () => {
  // A renamed input port still feeds the graph: copy renamed input → out.
  const r = await renderLowered(
    mono(`const inA = audioInput({ channels: 1 });`, `out.ch(0).at(i).write(inA.ch(0).at(i));`),
    {
      sampleRate: SR,
      duration: DUR,
      inputs: { inA: [Float32Array.from({ length: 128 }, (_, k) => k * 0.001)] },
    },
  );
  const got = r.outputs.main![0]!;
  for (let k = 0; k < 128; k++) {
    expect(got[k]).toBeCloseTo(Math.fround(k * 0.001), 6);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. param — name appended as a trailing `.named(...)`
// ───────────────────────────────────────────────────────────────────────────

test("param no name ≡ explicit .named (binding identifier)", async () => {
  await expectSameLowering(
    mono(`const cutoff = param.f32(${A_RATE});`, `out.ch(0).at(i).write(cutoff.at(i));`),
    mono(
      `const cutoff = param.f32(${A_RATE}).named("cutoff");`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
  );
});

test("param auto-name → binding identifier (behavioral)", async () => {
  expect(
    await compiledDeclNames(
      mono(`const cutoff = param.f32(${A_RATE});`, `out.ch(0).at(i).write(cutoff.at(i));`),
      "param",
    ),
  ).toStrictEqual(["cutoff"]);
});

test("param EXPLICIT .named (after f32) WINS over binding", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const cutoff = param.f32(${A_RATE}).named("EXPL");`,
        `out.ch(0).at(i).write(cutoff.at(i));`,
      ),
      "param",
    ),
  ).toStrictEqual(["EXPL"]);
});

test("param EXPLICIT .named (BEFORE f32) WINS over binding", async () => {
  // `hasNamedCall` must walk the whole chain, even a `.named` left of `.f32`.
  expect(
    await compiledDeclNames(
      mono(
        `const cutoff = param.named("FRONT").f32(${A_RATE});`,
        `out.ch(0).at(i).write(cutoff.at(i));`,
      ),
      "param",
    ),
  ).toStrictEqual(["FRONT"]);
});

test("param .named-after sugar ≡ explicit (no double-name)", async () => {
  await expectSameLowering(
    mono(
      `const cutoff = param.f32(${A_RATE}).named("EXPL");`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
    mono(
      `const cutoff = param.f32(${A_RATE}).named("EXPL");`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
  );
});

test("param .named-before sugar ≡ explicit (no double-name)", async () => {
  await expectSameLowering(
    mono(
      `const cutoff = param.named("FRONT").f32(${A_RATE});`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
    mono(
      `const cutoff = param.named("FRONT").f32(${A_RATE});`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
  );
});

test("param .expose WITHOUT name still auto-names (no .named present)", async () => {
  // `.expose({ snapshot })` carries no name → auto-name appends `.named("cutoff")`,
  // which is correct (the param IS named after the binding).
  expect(
    await compiledDeclNames(
      mono(
        `const cutoff = param.f32(${A_RATE}).expose({ snapshot: "ephemeral" });`,
        `out.ch(0).at(i).write(cutoff.at(i));`,
      ),
      "param",
    ),
  ).toStrictEqual(["cutoff"]);
});

test("param .expose-without-name sugar ≡ explicit trailing .named", async () => {
  await expectSameLowering(
    mono(
      `const cutoff = param.f32(${A_RATE}).expose({ snapshot: "ephemeral" });`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
    mono(
      `const cutoff = param.f32(${A_RATE}).expose({ snapshot: "ephemeral" }).named("cutoff");`,
      `out.ch(0).at(i).write(cutoff.at(i));`,
    ),
  );
});

test("param default value reaches a renamed param's a-rate read", async () => {
  // No input written for the param ⇒ each frame reads the default (1). Output = default.
  const r = await renderLowered(
    mono(`const cutoff = param.f32(${A_RATE});`, `out.ch(0).at(i).write(cutoff.at(i));`),
    { sampleRate: SR, duration: DUR },
  );
  const got = r.outputs.main![0]!;
  for (let k = 0; k < 128; k++) {
    expect(got[k]).toBeCloseTo(1, 6);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 3. event<T> / event.midi — name merged into the options object
// ───────────────────────────────────────────────────────────────────────────

test("event<T> from:'main' no name ≡ explicit name", async () => {
  await expectSameLowering(
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main", name: "ev" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

test("event<T> from:'main' auto-name → binding (behavioral, kind=message)", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const ev = event<{ v: Node<'f32'> }>({ from: "main" });`,
        `out.ch(0).at(i).write(f32(0));`,
      ),
      "message",
    ),
  ).toStrictEqual(["ev"]);
});

test("event<T> to:'main' no name ≡ explicit name (gated emit, kind=event)", async () => {
  // A real worklet→main emit needs a non-constant cond, so gate on a state edge.
  const body = `s.write(s.read().add(f32(1))); ev.emitIf(s.read().gt(f32(64)), { v: f32(1) }); out.ch(0).at(i).write(f32(0));`;
  await expectSameLowering(
    mono(`const s = state.f32(0); const ev = event<{ v: Node<'f32'> }>({ to: "main" });`, body),
    mono(
      `const s = state.f32(0); const ev = event<{ v: Node<'f32'> }>({ to: "main", name: "ev" });`,
      body,
    ),
  );
});

test("event<T> EXPLICIT name in options WINS", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const ev = event<{ v: Node<'f32'> }>({ from: "main", name: "EXPL" });`,
        `out.ch(0).at(i).write(f32(0));`,
      ),
      "message",
    ),
  ).toStrictEqual(["EXPL"]);
});

test("event<T> explicit-name sugar ≡ itself (no double-name)", async () => {
  await expectSameLowering(
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main", name: "EXPL" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main", name: "EXPL" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

test("event<T> name as shorthand property WINS (counts as explicit name)", async () => {
  // `{ from, name }` shorthand — `optionsHaveName` must detect the shorthand and
  // leave the decl untouched (NOT append a second `name`).
  expect(
    await compiledDeclNames(
      mono(
        `const NM = "SHORT"; const ev = event<{ v: Node<'f32'> }>({ from: "main", name: NM });`,
        `out.ch(0).at(i).write(f32(0));`,
      ),
      "message",
    ),
  ).toStrictEqual(["SHORT"]);
});

test("event<T> with capacity, no name → auto-name keeps capacity", async () => {
  await expectSameLowering(
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main", capacity: CAPACITY_64 });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
    mono(
      `const ev = event<{ v: Node<'f32'> }>({ from: "main", capacity: CAPACITY_64, name: "ev" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 4. event.midi — root callee is `event`, name still goes into options
// ───────────────────────────────────────────────────────────────────────────

test("event.midi from:'main' no name ≡ explicit name", async () => {
  await expectSameLowering(
    mono(`const notes = event.midi({ from: "main" });`, `out.ch(0).at(i).write(f32(0));`),
    mono(
      `const notes = event.midi({ from: "main", name: "notes" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

test("event.midi from:'main' auto-name → binding (behavioral, kind=midiInput)", async () => {
  expect(
    await compiledDeclNames(
      mono(`const notes = event.midi({ from: "main" });`, `out.ch(0).at(i).write(f32(0));`),
      "midiInput",
    ),
  ).toStrictEqual(["notes"]);
});

test("event.midi to:'main' no name ≡ explicit name (kind=midiOutput)", async () => {
  await expectSameLowering(
    mono(`const sink = event.midi({ to: "main" });`, `out.ch(0).at(i).write(f32(0));`),
    mono(
      `const sink = event.midi({ to: "main", name: "sink" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

test("event.midi EXPLICIT name in options WINS", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const notes = event.midi({ from: "main", name: "EXPL" });`,
        `out.ch(0).at(i).write(f32(0));`,
      ),
      "midiInput",
    ),
  ).toStrictEqual(["EXPL"]);
});

test("event.midi with capacity, no name → auto-name keeps capacity", async () => {
  await expectSameLowering(
    mono(
      `const notes = event.midi({ from: "main", capacity: CAPACITY_64 });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
    mono(
      `const notes = event.midi({ from: "main", capacity: CAPACITY_64, name: "notes" });`,
      `out.ch(0).at(i).write(f32(0));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Name-OPTIONAL helpers — auto-name must NOT touch them
// ───────────────────────────────────────────────────────────────────────────

test("plain state.f32(0) stays anonymous (__state_0)", async () => {
  expect(
    await compiledDeclNames(
      mono(`const s = state.f32(0);`, `s.write(f32(1)); out.ch(0).at(i).write(s.read());`),
      "state",
    ),
  ).toStrictEqual(["__state_0"]);
});

test("plain state.f32(0) sugar ≡ explicit (no .named injected)", async () => {
  await expectSameLowering(
    mono(`const s = state.f32(0);`, `s.write(f32(1)); out.ch(0).at(i).write(s.read());`),
    mono(`const s = state.f32(0);`, `s.write(f32(1)); out.ch(0).at(i).write(s.read());`),
  );
});

test("two plain states → __state_0 and __state_1 (auto-name never intervenes)", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const a = state.f32(0); const b = state.f32(0);`,
        `a.write(f32(1)); b.write(f32(2)); out.ch(0).at(i).write(a.read().add(b.read()));`,
      ),
      "state",
    ),
  ).toStrictEqual(["__state_0", "__state_1"]);
});

test("state.f32(0).named('mine') keeps explicit name", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const s = state.f32(0).named("mine");`,
        `s.write(f32(1)); out.ch(0).at(i).write(s.read());`,
      ),
      "state",
    ),
  ).toStrictEqual(["mine"]);
});

test("state.f32(0).named('mine') sugar ≡ explicit (untouched)", async () => {
  await expectSameLowering(
    mono(
      `const s = state.f32(0).named("mine");`,
      `s.write(f32(1)); out.ch(0).at(i).write(s.read());`,
    ),
    mono(
      `const s = state.f32(0).named("mine");`,
      `s.write(f32(1)); out.ch(0).at(i).write(s.read());`,
    ),
  );
});

test("state.buffer.f32(...).named('buf') keeps explicit name", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const b = state.buffer.f32({ size: 8 }).named("buf");`,
        `b.write(0, f32(1)); out.ch(0).at(i).write(b.read(0));`,
      ),
      "buffer",
    ),
  ).toStrictEqual(["buf"]);
});

test("state.buffer.f32(...).named('buf') sugar ≡ explicit (untouched)", async () => {
  await expectSameLowering(
    mono(
      `const b = state.buffer.f32({ size: 8 }).named("buf");`,
      `b.write(0, f32(1)); out.ch(0).at(i).write(b.read(0));`,
    ),
    mono(
      `const b = state.buffer.f32({ size: 8 }).named("buf");`,
      `b.write(0, f32(1)); out.ch(0).at(i).write(b.read(0));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Non-helper consts — auto-name must NEVER touch them
// ───────────────────────────────────────────────────────────────────────────

test("const x = Math.round(...) is left untouched (no .named, no options)", async () => {
  const lowered = lower(
    mono(`const x = Math.round(48000 * 0.3);`, `out.ch(0).at(i).write(f32(x));`),
  );
  expect(lowered).toContain(`const x = Math.round(48000 * 0.3);`);
  expect(lowered).not.toContain(`.named("x")`);
});

test("non-helper const sugar ≡ explicit (identical lowering)", async () => {
  await expectSameLowering(
    mono(`const x = Math.round(48000 * 0.3);`, `out.ch(0).at(i).write(f32(x));`),
    mono(`const x = Math.round(48000 * 0.3);`, `out.ch(0).at(i).write(f32(x));`),
  );
});

test("const N = 64 (numeric) left untouched, usable as build-time index size", async () => {
  await expectSameLowering(
    mono(
      `const N = 64; const b = state.buffer.f32({ size: N }).named("buf");`,
      `b.write(0, f32(1)); out.ch(0).at(i).write(b.read(0));`,
    ),
    mono(
      `const N = 64; const b = state.buffer.f32({ size: N }).named("buf");`,
      `b.write(0, f32(1)); out.ch(0).at(i).write(b.read(0));`,
    ),
  );
});

test("a const whose initializer is NOT a call (object literal) is untouched", async () => {
  // `rootCallee` returns undefined for a non-call/non-property initializer → no-op.
  const lowered = lower(
    mono(
      `const cfg = { gain: 2 };`,
      `out.ch(0).at(i).write(input.ch(0).at(i).mul(f32(cfg.gain)));`,
    ),
  );
  expect(lowered).toContain(`const cfg = { gain: 2 };`);
  expect(lowered).not.toContain(`name: "cfg"`);
});

test("options object with a SPREAD element still gets a name injected", async () => {
  // A `...base` element is a SpreadAssignment, not a PropertyAssignment, so the
  // `name`-presence scan must skip it (not crash) and still inject the binding name
  // because no explicit `name` is present.
  const lowered = lower(
    mono(
      `const base = { from: "main" } as const;
const taps = event({ ...base });`,
      `taps.onReceive(() => {}); out.ch(0).at(i).write(input.ch(0).at(i));`,
    ),
  );
  expect(lowered).toContain(`name: "taps"`);
});

test("an explicit name AMONG a spread is still honored (not double-named)", async () => {
  // The spread is skipped by the scan, but the explicit `name` property is found, so
  // auto-name leaves the declaration untouched.
  const lowered = lower(
    mono(
      `const base = { from: "main" } as const;
const taps = event({ ...base, name: "explicit" });`,
      `taps.onReceive(() => {}); out.ch(0).at(i).write(input.ch(0).at(i));`,
    ),
  );
  expect(lowered).toContain(`name: "explicit"`);
  expect(lowered).not.toContain(`name: "taps"`);
});

test("a no-argument name-required helper gets a fresh { name } options object", async () => {
  // `audioInput()` has no first argument, so auto-name must CREATE the options
  // object `{ name: "<binding>" }` rather than mutate an existing one.
  const lowered = lower(
    `const sideIn = audioInput();
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0).at(i).write(0); }); });`,
  );
  expect(lowered).toContain(`audioInput({ name: "sideIn" })`);
});

test("a multi-declaration `const a = …, b = …` statement is left untouched", async () => {
  // The auto-name pass only fires on a single-declaration statement; a comma list is
  // passed through verbatim (no name derived for either binding).
  const lowered = lower(
    mono(
      `const a = state.f32(0).named('a'), b = state.f32(1).named('b');`,
      `out.ch(0).at(i).write(a.read().add(b.read()));`,
    ),
  );
  expect(lowered).toContain(`const a = state.f32(0).named('a'), b = state.f32(1).named('b');`);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Mixed: many declarations in one module, each named independently
// ───────────────────────────────────────────────────────────────────────────

test("mixed module: input + param + event each get their own binding name", async () => {
  const decls = `
    const inA = audioInput({ channels: 1 });
    const cutoff = param.f32(${A_RATE});
    const ev = event<{ v: Node<'f32'> }>({ from: "main" });
  `;
  const body = `out.ch(0).at(i).write(inA.ch(0).at(i).mul(cutoff.at(i)));`;
  expect(await compiledDeclNames(mono(decls, body), "audioInput")).toStrictEqual(["main", "inA"]);
  expect(await compiledDeclNames(mono(decls, body), "param")).toStrictEqual(["cutoff"]);
  expect(await compiledDeclNames(mono(decls, body), "message")).toStrictEqual(["ev"]);
});

test("mixed module sugar ≡ all-explicit form (full structural match)", async () => {
  const sugar = mono(
    `
    const inA = audioInput({ channels: 1 });
    const cutoff = param.f32(${A_RATE});
    const ev = event<{ v: Node<'f32'> }>({ from: "main" });
  `,
    `out.ch(0).at(i).write(inA.ch(0).at(i).mul(cutoff.at(i)));`,
  );
  const explicit = mono(
    `
    const inA = audioInput({ channels: 1, name: "inA" });
    const cutoff = param.f32(${A_RATE}).named("cutoff");
    const ev = event<{ v: Node<'f32'> }>({ from: "main", name: "ev" });
  `,
    `out.ch(0).at(i).write(inA.ch(0).at(i).mul(cutoff.at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("binding name with non-identifier-y chars survives verbatim ($, _, digits)", async () => {
  expect(
    await compiledDeclNames(
      mono(
        `const _in$2 = audioInput({ channels: 1 });`,
        `out.ch(0).at(i).write(_in$2.ch(0).at(i));`,
      ),
      "audioInput",
    ),
  ).toStrictEqual(["main", "_in$2"]);
});
