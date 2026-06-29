# unworklet — DSL / API reference

TypeScript-first declarative Audio Worklet DSP, compiled to WebAssembly. You
declare ports/params/state and write a per-sample `process` body; the toolchain
compiles it to a `CompiledProcessor` you load on the main thread with
`createNode`.

Two authoring forms, **same compiled result**:

- **`.uwk.ts` — the primary, recommended form.** No imports, no wrapper; infix
  operators and `x[i]` index sugar. The plugin _lowers_ it to a plain
  `@unworklet/core` module that makes the exact same DSL calls a hand-written
  core processor makes, so it compiles byte-identically. — `packages/lang/src/lower.ts:310`
- **`.processor.ts` — the explicit, lower-level alternative (§6).** Plain `.ts`
  with `defineProcessor` + method chains + explicit imports. Use it only for a
  surface `.uwk.ts` does not expose (e.g. SIMD).

Every form below is verified against real source/tests with cited paths. Forms
not present in the source are omitted, not guessed.

Related references: build-time type-checking → see `tsc.md`; offline render +
matchers → see `testing.md`; the Vite DevTools dock → see `devtools.md`.

---

## 1. `.uwk.ts` — primary authoring form

The file _is_ the processor body. No `defineProcessor` wrapper, no
`return { process }`, no imports.

```ts
// stereo-gain.uwk.ts
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });

process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
    out.right[i] = input.right[i] * gain[i];
  });
});
```

Rules (all in `packages/lang/src/lower.ts`):

- **Exactly one `process(() => …)`.** It is an ambient macro; lowering wraps it
  into `export default defineProcessor((ctx) => { …decls; return { process } })`
  (or `export const <name> = …` when an export name is given). Zero `process` +
  no export → throws `uwk-empty`; more than one → `uwk-multiple-process`. —
  `lower.ts:187,328,364,391`
- **DSL names are ambient — write no imports.** Lowering injects the
  `@unworklet/core` import listing only the names actually used. — `lower.ts:138,457`
- **Ambient stereo I/O is injected when omitted:** with no `audioInput`
  referenced, `const input = audioInput({ channels: 2, name: "input" })` is
  added (same for `out`). An explicit declaration suppresses it. — `lower.ts:445`
- **`ctx` is ambient** — it is the `defineProcessor((ctx) => …)` parameter, so
  `ctx.sampleRate` reaches the host rate. — `lower.ts:207`
- **Your own `import`s survive** at module scope (shared consts, sibling
  subgraph files). — `lower.ts:350`
- **Type-checking:** add `// @ts-nocheck` at the top, OR use the editor plugin /
  `unworklet-tsc` (see `tsc.md`). The `// @ts-nocheck` is needed _only_ without
  the editor plugin.

### Ambient global surface (names usable unimported in `.uwk.ts`)

Source: `packages/lang/src/ambient.ts:17` (= shipped `dist/ambient.d.ts`).

- Decl helpers: `state` `param` `event` `defineSubgraph` `instantiate`
  `audioInput` `audioOutput`
- Loop / control: `forSample` `select`
- Scalar constructors: `f32` `f64` `i32` `i64` `bool`
- Free fns: `add sub mul div mod neg eq lt gt lte gte not sin cos tan tanh exp
log sqrt floor ceil frac abs min max clamp pipe`
- Constants: `SAMPLES_PER_BLOCK`, `CAPACITY_16` … `CAPACITY_16384`
- `.uwk.ts`-only ambients: `process` `migrations` `options` `input` `out` `ctx`
  `$prev`
- Type aliases (for annotating helper / subgraph params): `Node<T>` `State<T>`

---

## 2. `.uwk.ts` sugar forms

The sugar is type-directed: an operator/index lowers **iff** an operand is — or
lowers to — a `Node<T>` (`isDspExpr`, `packages/lang/src/classify.ts:147`). Pure
`number op number` (e.g. `Math.LN2 / 12`, `ctx.sampleRate * 0.5`) stays
build-time JS. Operands recurse bottom-up, so JS precedence is preserved.

### Operators → free-fn calls (`packages/lang/src/passes/operators.ts`)

| sugar                                   | lowers to                              |
| --------------------------------------- | -------------------------------------- |
| `a + b` `a - b` `a * b` `a / b` `a % b` | `add` `sub` `mul` `div` `mod` `(a, b)` |
| `-a` `!b`                               | `neg(a)` `not(b)`                      |
| `a == b` / `a === b`                    | `eq(a, b)`                             |
| `a != b` / `a !== b`                    | `not(eq(a, b))`                        |
| `a < b` `a > b` `a <= b` `a >= b`       | `lt` `gt` `lte` `gte` `(a, b)`         |
| `cond ? x : y` (cond is DSP)            | `select(cond, x, y)`                   |

Closed operator set: `classify.ts:120` (`isSugarBinaryOperator`). Method chains
interoperate with operators in the same body (core `Node` methods classify as
DSP): `raw.mul(I32_SCALE).tanh()`, `shaped.sub(dcPrev * DC_POLE)`.

### Index / element-access (`packages/lang/src/passes/index.ts`)

Rewritten by the **object's** type:

| sugar                                             | lowers to                 | object             |
| ------------------------------------------------- | ------------------------- | ------------------ |
| `input.left[i]` `input.right[i]` `input.ch(c)[i]` | `…at(i)`                  | input channel view |
| `param[i]`                                        | `param.at(i)`             | param              |
| `buf[i]` (read)                                   | `buf.read(i)`             | buffer             |
| `out.left[i] = v` `out.ch(c)[i] = v`              | `out.left.at(i).write(v)` | output view        |
| `buf[i] = v`                                      | `buf.write(i, v)`         | buffer             |

A write is an assignment whose LHS is an element access. — `index.ts:51,60,61`

### Bare-state read (`packages/lang/src/passes/bareState.ts`)

A scalar `State<T>` used in a `Node<T>` position auto-reads. **Read-only sugar —
the write stays explicit** (`state.write(v)`; there is no `state = v` sugar).

```ts
env.write(env * 0.99); // → env.write(mul(env.read(), 0.99))
```

Fires when the contextual type accepts `Node<…>`, as an `emit`/`emitIf` payload
field, or as a JS-boolean ternary branch. A `State` passed where a `State` is
expected (subgraph/helper arg) keeps its reference. — `bareState.ts:75,81,89`

### `if` → branch-free `select` / `emitIf` (`packages/lang/src/passes/ifSugar.ts`)

An `if` with a `Node<'bool'>` condition lowers; a JS-boolean condition stays a
build-time `if`. **Only three shapes lower**; any other DSP-conditioned `if`
throws `uwk-unsupported-if` (rewrite to `select(...)`).

| sugar                                             | lowers to                                 |
| ------------------------------------------------- | ----------------------------------------- |
| `if (c) s.write(v)`                               | `s.write(select(c, v, s.read()))`         |
| `if (c) buf[i] = v`                               | `buf.write(i, select(c, v, buf.read(i)))` |
| `if (c) s.write(a) else s.write(b)` (same target) | `s.write(select(c, a, b))`                |
| `if (c) port.emit(p)` (block of emits)            | `port.emitIf(c, p)` (each)                |

— `ifSugar.ts:149,155,159,164`

### `$prev` — subgraph feedback (`packages/lang/src/passes/prev.ts`)

Inside a `defineSubgraph` method, `$prev` is that method's previous-call return
value. Lowering injects a hidden `state` slot per method that uses it, rewrites
`$prev` → `slot.read()`, and stores each return into the slot. — `prev.ts:76`

```ts
const onepole = defineSubgraph((coef: Node<"f32">) => ({
  process: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = instantiate(onepole, f32(0.5), { name: "lp" });
```

### Auto-name (`packages/lang/src/passes/autoName.ts`)

On a module-top-level `const X = <decl helper>`, the binding name fills a missing
declared name; an explicit name always wins.

| written                                             | lowers to                                 |
| --------------------------------------------------- | ----------------------------------------- |
| `const cutoff = param.f32({…})`                     | `param.f32({…}).named("cutoff")`          |
| `const input = audioInput({ channels })`            | `audioInput({ channels, name: "input" })` |
| `const notes = event.midi({ from })`                | `event.midi({ from, name: "notes" })`     |
| `const meterL = state.f32(0).expose({…})` (no name) | `…expose({…, name: "meterL" })`           |
| `const tap = state.f32(0).named()` (no-arg marker)  | `state.f32(0).named("tap")`               |

Name-REQUIRED helpers (`param` / `audioInput` / `audioOutput` / `event` /
`event.midi`) always derive. Name-OPTIONAL `state` / `state.buffer` derive ONLY
via an explicit marker (`.expose({})` without a name, or a no-arg `.named()`); a
plain `state.f32(0)` stays anonymous. — `autoName.ts:104,108,114,124`

### Does NOT lower (confirmed absences — do not emit as DSP)

- `number op number` stays build-time JS (intended).
- Logical `&&` `||`, bitwise `& | ^ << >>`, and compound assignment
  `+= -= *= /= %=` are **not** sugar. — `classify.ts:120`, `index.ts:43`
- A `Node<'bool'>` `if` outside the 3 shapes → `uwk-unsupported-if`; use `select`.
- `migrations()` / `options()` are processor-only and cannot reference a
  process-body binding → `uwk-options-binding` / `uwk-options-without-process`.
- **No SIMD in `.uwk.ts`** (only the `Node<"f32x4">` type alias exists). Use
  `.processor.ts` + `@unworklet/core/simd` (§6).

---

## 3. Core declaration API (used by both forms)

These are the real `@unworklet/core` exports. In `.uwk.ts` they are ambient; in
`.processor.ts` you `import` them. The values and chains are identical.
Source: `packages/core/src/dsl/declarations.ts`, `…/loop.ts`, `…/primitives.ts`,
`…/constructors.ts`, `…/pipe.ts`, `packages/core/src/processor.ts`.

### Audio I/O — `audioInput` / `audioOutput`

```ts
audioInput<C>({ channels: C, name: string }):  AudioInputHandle<C>
audioOutput<C>({ channels: C, name: string }): AudioOutputHandle<C>
```

- `.ch(c)` → a channel view for any channel index. `.left` / `.right` are
  getters present **only when `channels === 2`**; on a non-stereo port they
  throw, pointing you at `.ch(...)`. — `declarations.ts:766,795`
- Input view: `view.at(i) → Node<"f32">`. Output view: `view.at(i).write(v)`.
- In `.uwk.ts`: `input.left[i]` / `out.ch(c)[i] = v` (index sugar, §2).

### Params — `param.f32`

```ts
param.f32({ default: number; min: number; max: number;
            automationRate: "a-rate" | "k-rate"; unit?: string }): Param
```

- Chain (order-free): `.named(name)`, `.expose(options)` (§ExposeOptions).
  `param.named("x").f32({…})` ≡ `param.f32({…}).named("x")`.
- Read a sample: `param.at(i) → Node<"f32">` (`.uwk.ts`: `param[i]`).
- The host `AudioParam` is reachable on the main thread as `node.params.<name>` (§5).
- — `declarations.ts:645,655,708`

### Scalar state — `state.<type>`

```ts
state.f32(initial) | state.f64(i) | state.i32(i) | state.i64(i) | state.bool(i): State<T>
```

- Handle: `.read() → Node<T>`, `.write(v: Node<T> | scalar)`, plus order-free
  `.named(name)` / `.expose(options)`. `state.named("x").f32(0)` ≡
  `state.f32(0).named("x")` (after-wins merge).
- `.read()` eager-captures the value at that lexical point — a later `.write`
  cannot change an already-bound read. — `declarations.ts:166,291`
- In `.uwk.ts`: a bare `state` in a value position auto-reads (§2); the write
  stays explicit `state.write(v)`.

### Buffers — `state.buffer.<type>`

Fixed-size arrays (the array form of state; only reachable via `state.buffer`).

```ts
state.buffer.f32({ size: number }): Buffer<"f32">
//          .f64 | .i32 | .i64 | .bool | .u8   (u8 surfaces as i32)
```

- Handle: `.read(i) → Node<T>`, `.write(i, v)`,
  `.readInterpolated(pos: Node<"f32"> | number) → Node<T>` (2-tap), order-free
  `.named(name)` / `.expose(options)`. — `declarations.ts:357,450,620`
- Literal indexes are range-checked at graph-capture time; a `Node<"i32">` index
  is the caller's responsibility.
- In `.uwk.ts`: `buf[i]` (read) / `buf[i] = v` (write).
- Capacity sizes for messaging rings are the `CAPACITY_16` … `CAPACITY_16384`
  constants (`packages/core/src/types.ts:44`). SIMD `.loadVec` / `.storeVec`
  exist on the buffer handle but are a `.processor.ts` + `@unworklet/core/simd`
  concern (§6).

### Slot exposure — `ExposeOptions`

`packages/core/src/types.ts:211-224`:

```ts
type ExposeOptions = {
  name?: string;
  snapshot?: "persistent" | "transient" | Record<string, "persistent" | "transient">;
  publish?: { rateFps: number }; // live value mirrored to the main thread
};
```

- `publish` is allowed only on `state.f32` / `state.i32` / `state.bool`, requires
  a user-defined name, and `rateFps` must be positive finite. `snapshot:
"persistent"` also requires a user-defined name. — `declarations.ts:229,240`
- A published slot is read on the main thread as `node.state.<name>` (§5).

### Events — `event<T>` (typed message ports)

Direction is in the options; the return type and worklet-side methods narrow to it.

```ts
event<T>({ from: "main"; name; capacity?: Capacity; payloadCapacity?: number })  // main → worklet
event<T>({ to:   "main"; name; capacity?: Capacity; payloadCapacity?: number })  // worklet → main
```

- Inbound (`from: "main"`): worklet handles with `.onReceive(handler)`. —
  `declarations.ts:1159,1439`
- Outbound (`to: "main"`): worklet sends with `.emit(payload)` /
  `.emitIf(cond, payload)`. — `declarations.ts:951`
- Main-thread side is `node.events.<name>` (§5). — `declarations.ts:828,1466`

### MIDI ports — `event.midi`

```ts
event.midi({ from: "main"; name; capacity?: Capacity }): MidiInputHandle   // inbound MIDI
event.midi({ to:   "main"; name; capacity?: Capacity }): MidiOutputHandle  // outbound MIDI
```

- Inbound: worklet handles per type with
  `.onEvent("noteOn", ({ note, velocity, … }) => …)`. — `declarations.ts:1290,1455`
- Outbound: worklet sends with `.emit(...)` / `.emitIf(cond, ...)`. — `declarations.ts:1307`
- Events/MIDI carry **no** infix sugar; the helper/handler shapes are identical
  in both forms. Handler BODIES still get operator / bare-state lowering in `.uwk.ts`.
- Main-thread side is `node.midi.<name>` with the full `MidiEvent` union (§5).

```ts
// .uwk.ts MIDI synth (verbatim-verified to lower)
const out = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });
const hz = state.f32(440).named(),
  gate = state.f32(0).named(),
  phase = state.f32(0).named();
process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440);
    gate.write(1);
  });
  keys.onEvent("noteOff", () => gate.write(0));
  forSample((i) => {
    phase.write((phase + hz / 48000) % 1);
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});
```

### Per-sample loop — `forSample` / `.byN` / `everyNSamples`

`packages/core/src/dsl/loop.ts`:

```ts
forSample((i: Node<"i32">, everyNSamples) => { … });           // every sample of the quantum
forSample.byN(stride, (i, everyNSamples) => { … });            // once per `stride` samples
```

- `everyNSamples` is delivered as the **second callback parameter** (not a free
  import): `everyNSamples(n: number, body: () => void)` runs `body` once per `n`
  samples (sub-rate work). — `loop.ts:23,76`
- `stride` must be a power of two that divides the render quantum 128: one of
  `1, 2, 4, 8, 16, 32, 64, 128`. `everyNSamples`'s `n` must be a compile-time
  positive integer. — `packages/core/src/compile/analyze.ts:196,219`
- `forSample` nests; each level gets its own loop counter.

```ts
forSample((i, everyNSamples) => {
  out.ch(0)[i] = osc[i];
  everyNSamples(128, () => {
    meter.write(peak);
  }); // ~once per block
});
```

### Branch-free select — `select`

```ts
select(cond: Node<"bool"> | boolean, then, else_): Node<T>   // T from the branches
```

Numeric branches give a numeric select; a literal boolean branch only matches the
bool overload (a boolean mixed with a numeric branch is a type error). In
`.uwk.ts` write `cond ? then : else_`. — `primitives.ts:483`

### Scalar constructors

`packages/core/src/dsl/constructors.ts`. A `number` lifts to a literal; a
`Node<T>` cross-converts.

```ts
f32(number | Node): Node<"f32">      f64(number | Node): Node<"f64">
i32(number | Node): Node<"i32">      i64(bigint): Node<"i64">     // bigint only, no number lift
bool(boolean | Node): Node<"bool">
```

### Math / logic free-functions

`packages/core/src/dsl/primitives.ts`. Each also exists as a `Node` method
(`a.mul(b)`, `x.tanh()`, `x.clamp(lo, hi)`, …). A bare `number` is accepted
anywhere a `Node` is and lifts to the operand's type.

| group              | signatures → result                                                                 |
| ------------------ | ----------------------------------------------------------------------------------- |
| arithmetic         | `add` `sub` `mul` `div` `mod` `(a, b) → Node<T>`; `neg(x) → Node<T>`                |
| compare            | `eq` `lt` `gt` `lte` `gte` `(a, b) → Node<"bool">`                                  |
| logic              | `not(b) → Node<"bool">`                                                             |
| float math (unary) | `sin cos tan tanh exp log sqrt floor ceil frac (x) → Node<T>`                       |
| numeric            | `abs(x) → Node<T>`; `min(a, b)` `max(a, b) → Node<T>`; `clamp(x, lo, hi) → Node<T>` |
| composition        | `pipe(x, f1, f2, …) → applies fns left-to-right`                                    |

In `.uwk.ts` arithmetic/compare/`neg`/`not` are written with operators (§2); the
named functions remain available and `sin`/`exp`/`clamp`/`pipe`/etc. are written
directly.

### `defineSubgraph` / `instantiate` (reusable DSP units)

`packages/core/src/processor.ts:104,152`:

```ts
defineSubgraph((...args) => methods): SubgraphDecl
instantiate(subgraph, ...args, options?: { name?: string }): methods
```

- Instantiate in **declaration scope only** (top of a `defineProcessor` /
  `defineSubgraph` body, before the returned `process` / method record);
  instantiating inside `forSample` / `everyNSamples` / a handler throws
  (`scope-violation`). Each instance gets independent internal state. — `processor.ts:152,190`
- A `Node<"f32">` arg also accepts a bare `number` (and a `Node<"bool">` arg a
  `boolean`); the `.uwk.ts` sugar wraps a bare literal, so `instantiate(onepole,
0.2)` works. A plain-`number` config arg is not lifted. — `processor.ts:125`
- An instance with a named / persistent / published internal slot **must** be
  given an explicit `{ name }` (snapshot-path stability). — `processor.ts:214`

### Compile-time context — `ctx.sampleRate`

`ctx` is the `defineProcessor((ctx) => …)` parameter (ambient in `.uwk.ts`):

```ts
type ProcessorContext = { readonly sampleRate: number }; // types.ts:475
```

`ctx.sampleRate` is a build-time-known number, so rate-dependent coefficients
(`440 / ctx.sampleRate`, etc.) const-fold into the WASM. The processor recompiles
per host rate from this value.

---

## 4. Subgraph in its own file (library module)

A `.uwk.ts` with **no `process()` but ≥1 export** is a library module: its
exports are emitted verbatim at module scope, subgraph-body sugar still lowers,
and there is no `defineProcessor` wrap / no ambient I/O. — `lower.ts:364`

```ts
// onepole.uwk.ts
export const onepole = defineSubgraph((coef: Node<"f32">) => {
  const z1 = state.f32(0).named("z1");
  return {
    tick: (x: Node<"f32">) => {
      const y = z1 + (x - z1) * coef; // bare z1 reads; write explicit
      z1.write(y);
      return y;
    },
  };
});
```

```ts
// synth.uwk.ts — import the sibling by its explicit .uwk.ts path (NOT ?worklet)
import { onepole } from "./onepole.uwk.ts";
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
const lpf = instantiate(onepole, 0.2, { name: "lpf" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = lpf.tick(input.ch(0)[i]);
  });
});
```

Publishing such a library: declare `@unworklet/core` as a `peerDependency` (never
bundle a second copy).

---

## 5. Loading + the main-thread node

`@unworklet/core` exports `createNode`, `inspect`, `replaceProcessor`. —
`packages/core/src/index.ts:124,127`

### `?worklet` import (identical for both authoring forms)

The plugin lowers (if `.uwk.ts`) + compiles, and the **default** export is a
`CompiledProcessor<C>` augmented with bundler URLs + identity + baked rate. Typing
needs a one-line triple-slash reference (like `vite/client`); only the default
import is typed. — `packages/unplugin/src/index.ts:261,1760`, `client.d.ts:11`

```ts
/// <reference types="@unworklet/unplugin/client" />
import stereoGain from "./stereo-gain.uwk.ts?worklet"; // primary
// or: import stereoGain from "./stereo-gain.processor.ts?worklet";
```

The export name is the filename camel-cased (`noise-drive.uwk.ts` → `noiseDrive`).

### `createNode(context, processor, options?)`

```ts
function createNode<C>(
  context: BaseAudioContext, // AudioContext | OfflineAudioContext
  processor: CompiledProcessor<C>, // the ?worklet default import
  options?: { initial?: Partial<Record<string, number>> }, // seeds initial param values
): Promise<UnworkletNode<C>>; // async — await it
```

`packages/core/src/client.ts:319`. It loads the worklet module (cached per
context+url), compiles the WASM, picks the transport (`"sab"` when
`SharedArrayBuffer` + `crossOriginIsolated`, else `"postMessage"`), constructs the
`AudioWorkletNode`, and resolves on a `ready` port message (rejects on init error
/ `processorerror` / 10 s timeout).

```ts
const ctx = new AudioContext({ sampleRate: 48000 });
const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
```

### Rate gate — `?worklet` bakes 48 kHz

The WASM bakes rate-dependent coefficients at build time, so `createNode`
**throws** when `context.sampleRate !== bakedSampleRate`. A `?worklet` import bakes
`DEFAULT_SAMPLE_RATE = 48000` unless compiled otherwise — create the context at
the baked rate. — `client.ts:350`, `packages/core/src/compile/index.ts:54`

```ts
new AudioContext({ sampleRate: 48000 });
new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: 48000 });
```

### `UnworkletNode<C>` surface

`packages/core/src/types.ts:908`, built in `client.ts:1711`. `C` may be the config
or a `CompiledProcessor`, so `UnworkletNode<typeof import("./x.uwk.ts?worklet")>`
names the type.

| member                    | type / behavior                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node.node`               | the raw `AudioWorkletNode` (escape hatch)                                                                                                                           |
| `node.inputs.<name>`      | `AudioNode` pass-through proxy (one per `audioInput`); connect Web Audio into it                                                                                    |
| `node.outputs.<name>`     | `{ connect(target: AudioNode \| AudioParam): void; disconnect(): void }`                                                                                            |
| `node.params.<name>`      | native `AudioParam` (`.value`, `setValueAtTime`, `linearRampToValueAtTime`, …)                                                                                      |
| `node.state.<name>`       | `{ readonly value; subscribe(handler): () => void }` — latest published value                                                                                       |
| `node.events.<name>`      | `EventSurface<T>` — `.on(handler)` (out) / `.emit(payload)` (in) / `.diagnostics.overflowCount()`; direction-narrowed                                               |
| `node.midi.<name>`        | `{ send(event, atTime?); connectFromWebMIDI(input); onEvent(type, handler); diagnostics }`                                                                          |
| `node.diagnostics`        | `{ readonly transport: "sab" \| "postMessage" }`                                                                                                                    |
| `node.onError(handler)`   | subscribe to `NodeErrorEvent` (`wasm-trap` / `queue-overflow` / `sab-unavailable` / `block-length-mismatch` / `worklet-initialize-not-called`); returns unsubscribe |
| `node.snapshot(options?)` | `Promise<Uint8Array>` — block-atomic state capture; `options?: { profile?: string }`                                                                                |
| `node.restore(blob)`      | `Promise<RestoreResult>` — runs migrations, applies slots + param values; never throws (returns `{ ok }`)                                                           |
| `node.dispose()`          | idempotent teardown; stops polling, removes listeners, disconnects proxies; does not touch your graph edges                                                         |

`MidiEvent` is a discriminated union (`noteOn` / `noteOff` / `cc` / `pitchBend` /
`programChange` / `channelPressure` / `aftertouch` / `systemRealtime` / `sysex`). —
`types.ts:377`

```ts
merger.connect(node.inputs["main"]!);
node.outputs["main"]!.connect(ctx.destination);
node.params["gain"]!.setValueAtTime(0.8, t);
const unsub = node.state["meterL"]!.subscribe((v) => values.push(v));
node.events["peak"]!.on((p) => received.push(p));
node.midi["out"]!.onEvent("noteOn", (e) => received.push(e));
node.midi["in"]!.send({ type: "noteOn", channel: 3, note: 60, velocity: 100 });
const off = node.onError((e) => errors.push(e));
```

### `inspect(blob)`

Pure, non-realtime blob decode — needs no `AudioContext` or live node.
`InspectionResult = { version; schemaHash; profile; slots }`. — `client.ts:1824`,
`types.ts:994`

(`replaceProcessor` live-swaps a processor while preserving state; it is exported
but out of scope here.)

---

## 6. `.processor.ts` — the explicit core-method alternative (secondary)

Same compiled result; plain `.ts` checked by stock `tsc`. Use it when you need a
surface `.uwk.ts` does not expose (SIMD via `@unworklet/core/simd`). Authoring is
explicit: `defineProcessor` wrapper, explicit imports, method chains.

```ts
// stereo-gain.processor.ts
import { audioInput, audioOutput, defineProcessor, forSample, param, state } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  const meterL = state
    .f32(0)
    .expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });
  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        meterL.write(l.abs().max(meterL.read()));
      });
    },
  };
});
```

```ts
defineProcessor<C>((ctx: ProcessorContext) => ProcessorBody, options?: ProcessorOptions): CompiledProcessor<C>
```

— `processor.ts:68`. `options.migrations` declares snapshot migrations.

|            | `.uwk.ts` (primary)                                                 | `.processor.ts` (explicit)                                 |
| ---------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| wrapper    | none — `process(() => …)` ambient macro; file IS the body           | `export const x = defineProcessor((ctx) => ({ process }))` |
| imports    | none — DSL ambient, injected on lower                               | explicit `import { … } from "@unworklet/core"`             |
| DSP exprs  | `*`, `[i]`, bare-state read, `?:`, `if`, `$prev`                    | `.mul()` `.add()` `.at(i)` `.read()` `.write()` `select()` |
| I/O        | ambient stereo injected if omitted                                  | every port declared explicitly                             |
| `ctx`      | ambient binding                                                     | the `defineProcessor` callback param                       |
| type-check | `// @ts-nocheck`, OR editor plugin / `unworklet-tsc` (see `tsc.md`) | plain `.ts`, stock `tsc`                                   |
| SIMD       | none                                                                | full surface incl. `@unworklet/core/simd`                  |
| extension  | `.uwk.ts`                                                           | `.processor.ts` / `.ts`                                    |

Do not write a `defineProcessor` wrapper inside a `.uwk.ts`. Mixing operator sugar
with core `Node` method chains _inside_ a `.uwk.ts` is fine and common (§2).

---

## 7. Build / tooling (brief)

- **Bundler plugin** `@unworklet/unplugin` lowers + compiles `?worklet` imports
  and serves the DevTools dock (production build compiles the dock to nothing). —
  see `devtools.md`.
- **Type-check** `.uwk.ts` sugar with the `@unworklet/lang/typescript-plugin`
  TS-server plugin (editor) or the `unworklet-tsc --noEmit` CLI (CI). — see `tsc.md`.
- **Browser live-coding:** `compileSource(src)` (full lower→compile→worklet) /
  `lowerToProcessor(src)` from `@unworklet/lang/browser`. **Programmatic:**
  `lower(uwkSource, { exportName })` → virtual `.ts` string. — `packages/lang/src/index.ts:7,19`
- **Test:** render with `@unworklet/offline` (`renderOffline`) + assert with
  `@unworklet/test` matchers. — see `testing.md`.
