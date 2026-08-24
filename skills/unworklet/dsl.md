| `node.midi.<name>` | direction-narrowed: `{ from: "main" }` → `send(event, atTime?)` / `connectFromWebMIDI(input)` / `diagnostics`; `{ to: "main" }` → `onEvent(type, handler)` / `diagnostics`# unworklet — DSL / API reference

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

Related references: build-time type-checking → see `ide-and-typecheck.md`; offline render +
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
  subgraph files). Write relative imports WITH the file extension
  (`./tables.ts`, not `./tables`): the build path evaluates processor modules
  under Node ESM resolution, which demands explicit extensions — an
  extensionless specifier fails the build (the error names the exact suffix to
  add). — `lower.ts:350`
- **Your own `export`s survive too** — an exported declaration moves to module
  scope in the lowered module, together with any module-level bindings it
  references, as long as none of them touch the DSL (`export const GAIN = 0.5`
  shared with a sibling file works as written). An export whose value is tied
  to the DSL (`export const gain = param.f32(...)`), an `export default`, or an
  exported destructuring declaration is rejected with `uwk-export-unsupported`
  — expose DSL values through the processor surface (param / state / event)
  instead.
- **Type-checking:** add `// @ts-nocheck` at the top, OR use the editor plugin /
  `unworklet-tsc` (see `ide-and-typecheck.md`). The `// @ts-nocheck` is needed _only_ without
  the editor plugin.

### Ambient global surface (names usable unimported in `.uwk.ts`)

Source: `packages/lang/src/ambient.ts:17` (= shipped `dist/ambient.d.ts`).

- Decl helpers: `state` `param` `event` `defineSubgraph` `instantiate`
  `audioInput` `audioOutput` `noiseSource`
- Loop / control: `forSample` `select`
- Scalar constructors: `f32` `f64` `i32` `i64` `bool`
- Free fns: `add sub mul div mod neg eq lt gt lte gte not and or sin cos tan tanh exp
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
| `a && b` `a \|\| b` (both bool)         | `and(a, b)` `or(a, b)`                 |
| `cond ? x : y` (cond is DSP)            | `select(cond, x, y)`                   |

Closed operator set: `classify.ts:120` (`isSugarBinaryOperator`). Method chains
interoperate with operators in the same body (core `Node` methods classify as
DSP): `raw.mul(I32_SCALE).tanh()`, `shaped.sub(dcPrev * DC_POLE)`.

**Nothing here short-circuits.** `&&` / `||` evaluate both operands, and so does
`select(cond, a, b)` — it picks a value, it does not guard evaluation. WASM
realtime has no branch-free short-circuit primitive, and every DSP node runs at
audio rate anyway, so there is nothing to save.

This matters when a branch is not just a value: an unchosen `noiseSource.next()`
still advances the PRNG, and an unchosen `i32` division by zero still traps. To
keep an expression out of the graph, do not write it — restructure so the
dangerous operand is always safe (clamp the divisor, hoist the read), rather than
expecting a conditional to skip it.

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

**Multi-statement bodies with the same `Node<'bool'>` guard**: an `if (c) { s1.write(a); s2.write(b); port.emit(payload) }` isn't one of the 3 shapes. Write each side as its own guarded statement — the sugar lowers each individually and the pass optimizer coalesces them, so the runtime cost is identical:

```ts
// A block-body `if (c) { s1.write(a); s2.write(b); port.emit(p) }` is not sugar.
// Write each side explicitly — same runtime, same guard `c` factored per statement.
if (c) s1.write(a);
if (c) s2.write(b);
port.emitIf(c, p);
```

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
- Bitwise `& | ^ << >>` and compound assignment `+= -= *= /= %=` are **not**
  sugar. — `classify.ts:120`, `index.ts:43`
- Logical `&&` / `||` on two `Node<'bool'>` operands **do** lower (to `and` /
  `or`, both operands evaluate — see §2 operator table), but the JavaScript
  short-circuit semantics are NOT preserved.
- A `Node<'bool'>` `if` outside the 3 shapes → `uwk-unsupported-if`; use `select`.
- `migrations()` / `options()` are processor-only and cannot reference a
  process-body binding → `uwk-options-binding` / `uwk-options-without-process`.
- `options({ id: "my-synth" })` sets the processor's stable IDENTITY (also
  `defineProcessor(body, { id })` in `.processor.ts`). It is stamped into every
  snapshot blob: `schemaHash` covers declarations only, so two different
  processors with the same slot schema share a hash — without an id, a preset
  from one restores "successfully" into the other and corrupts its state. When
  both a blob and a processor carry an id, a mismatch makes `restore()` return
  `{ ok: false, error: { step: "identity" } }` (stable ID `processor-mismatch`;
  `renderOffline`'s `config.restore` throws instead — a cross-processor restore
  in a test is a test bug). Id-less blobs and processors keep the legacy
  hash-and-name matching. Set it for any processor whose presets you save, and
  KEEP IT STABLE — renaming orphans saved blobs the way a schema change without
  a migration does. `replaceProcessor` across two DIFFERENT ids refuses the
  same way (its dev-flow use — reloading an edited processor — keeps one id).
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

Each constructor takes an initial value in the scalar type's native JS form:
`number` for the float / int-32 slots, `bigint` for `i64` (no number lift), and
`boolean` for `bool`.

```ts
state.f32(initial: number):   State<"f32">
state.f64(initial: number):   State<"f64">
state.i32(initial: number):   State<"i32">
state.i64(initial: bigint):   State<"i64">   // bigint only — `state.i64(0)` is a type error, use `state.i64(0n)`
state.bool(initial: boolean): State<"bool">  // `state.bool(false)`, not `state.bool(0)`
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
- Literal indexes are range-checked at graph-capture time. A runtime
  `Node<"i32">` index SATURATES to the buffer bounds — `[0, size-1]` for scalar
  `read`/`write`, `[0, size-4]` for the 4-lane `loadVec`/`storeVec` — instead of
  trapping or touching a neighboring region. Out-of-range reads return the
  nearest element's value; wrap-around (a circular delay line) is still yours to
  express with `% size`.
- Float buffer stores flush subnormals to `0` (|v| < 1e-30), the same policy as
  scalar state stores — a decaying feedback tail (delay line / comb / reverb)
  cannot park in the denormal range and spike the audio-thread CPU. Applies to
  `write`, and lane-wise to `storeVec`.
- Audio OUTPUT samples are scrubbed at the write: a NaN / ±Inf produced by the
  DSP (`0/0`, `x/0`, runaway accumulator) is replaced with `0` instead of
  propagating silence/clicks through the Web Audio graph downstream. Each
  replacement is counted — read it as `renderOffline(...).diagnostics
.scrubbedSamples` in tests (a healthy render reports `0`). The value itself is
  unchanged inside expressions; only the output boundary scrubs.
- **Default snapshot policy is `"transient"`** — the buffer is NOT captured by
  `node.snapshot()` and is re-zeroed on `restore()`. A `state.buffer.f32({
size }).named("tape")` on its own restores to silence, which surprises
  delay / sampler / reverb authors expecting audio content to survive. Opt in
  explicitly: `.expose({ snapshot: "persistent" })`. Same default (and same
  opt-in) applies to scalar `state.<type>` (§Scalar state).
- In `.uwk.ts`: `buf[i]` (read) / `buf[i] = v` (write).
- Capacity sizes for messaging rings are the `CAPACITY_16` … `CAPACITY_16384`
  constants (values live at `packages/core/src/dsl/constants.ts:11-23`, re-exported
  via `packages/core/src/index.ts:9-22`; the `Capacity` type union is at
  `packages/core/src/types.ts:44-55`). SIMD `.loadVec` / `.storeVec` exist on the
  buffer handle but are a `.processor.ts` + `@unworklet/core/simd` concern (§6).

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
  a user-defined name, and `rateFps` must be positive finite. On a BUFFER,
  `publish` is rejected at graph capture (stable ID `buffer-publish-unsupported`;
  the type surface `BufferExposeOptions` omits it too) — the publish pipeline is
  scalar-only, so fan values out into scalar state slots to observe a buffer
  live, or read it back via `node.snapshot()`. `snapshot: "persistent"` also
  requires a user-defined name. — `declarations.ts:229,240`
- A published slot is read on the main thread as `node.state.<name>` (§5).

### Events — `event<T>` (typed message ports)

Direction is in the options; the return type and worklet-side methods narrow to it.

```ts
event<T>({ from: "main"; name; capacity?: Capacity; payloadCapacity?: number })  // main → worklet
event<T>({ to:   "main"; name; capacity?: Capacity; payloadCapacity?: number })  // worklet → main
```

- Inbound (`from: "main"`): worklet handles with `.onReceive(handler)`. —
  `declarations.ts:1159,1439`
- Outbound (`to: "main"`): worklet sends with `.emitIf(cond, payload)` only —
  there is no bare `.emit(payload)` on the worklet-side handle (calling it
  throws `TypeError: emit is not a function`). Use `port.emitIf(bool(true), p)`
  for the unconditional case, or write `if (cond) port.emit(p)` inside the
  process body and the if-sugar (§2) rewrites it to `emitIf`. —
  `declarations.ts:951,955`
- Main-thread side is `node.events.<name>` (§5). — `declarations.ts:828,1466`
- Every outbound payload has an implicit `atSample: number` field the worklet
  must fill in (the sample index within the current quantum). The type-checker
  requires it and the runtime uses it for main-thread ordering:
  `port.emitIf(cond, { atSample: i, ...userFields })`. In `forSample((i) =>
…)` bodies, pass the loop's `i` as `atSample`.
- **Payload field wire types** — a declared `T = { foo: number; ... }`
  maps each `number` field to the **f32 wire** by default (that's what
  the worklet-side capture sees + what the main-thread type surfaces as
  `number`). The one exception is the implicit `atSample`, which is
  always `i32`. If you need integer semantics on a user field, write
  `i32(value)` in the emit call — the witness / type system still sees
  `number` on both sides but the payload reaches main as an integer.
  `boolean` fields default to the f32 wire too and are sealed to `bool`
  the moment the field flows into a boolean position (a `boolean` state
  write, a `select` cond, a `not()`, an `emitIf` cond, etc.). Forwarding a
  field straight into another `emit` is not a boolean position: a field
  that is only ever forwarded, never consumed, stays on the f32 wire on
  both sides. That is harmless — it round-trips 0/1 unchanged — but if you
  want the `bool` wire on a pass-through, consume it once (for example
  `emitIf(f.on, ...)` or `select(f.on, a, b)`).

### MIDI ports — `event.midi`

```ts
event.midi({ from: "main"; name; capacity?: Capacity }): MidiInputHandle   // inbound MIDI
event.midi({ to:   "main"; name; capacity?: Capacity }): MidiOutputHandle  // outbound MIDI
```

- Inbound: worklet handles per type with
  `.onEvent("noteOn", ({ note, velocity, … }) => …)`. — `declarations.ts:1290,1455`
- Per-event-type handler field shapes (all fields are `Node<"i32">`; combine
  with `f32(...)` for float math). The source of truth is `MidiEvent` in
  `packages/core/src/types.ts`:
  - `"noteOn"` / `"noteOff"` — `{ channel, note, velocity, atSample }`
  - `"cc"` (control change) — `{ channel, controller, value, atSample }`
  - `"pitchBend"` — `{ channel, value, atSample }` (value is 14-bit signed)
  - `"programChange"` — `{ channel, program, atSample }`
  - `"channelPressure"` — `{ channel, pressure, atSample }`
  - `"aftertouch"` (poly key pressure) — `{ channel, note, pressure, atSample }`
  - `"sysex"` — `{ bytes, atSample }` where `bytes` is a byte-array field
  - `"systemRealtime"` — `{ status, atSample }` (status = 0xF8..0xFF)
- Sysex boundaries: a port accepts/produces sysex only when the processor
  handles or emits sysex on it (that is what allocates its content region);
  `node.midi.<name>.send()` THROWS on sysex to a port without one (stable ID
  `sysex-unsupported-port`). One sysex message holds at most **1020 bytes**
  (including 0xF0/0xF7): `send()` throws past the limit rather than
  truncate-and-deliver a terminator-less message (stable ID
  `sysex-payload-too-large`), and an outbound emit whose source `buffer.u8` is
  bigger than 1020 bytes is a build error (stable ID
  `sysex-buffer-exceeds-chunk`). Split larger transfers into multiple messages.
- Outbound: worklet sends with `.emitIf(cond, event)` only — same rule as
  typed `event<T>` above (no bare `.emit` on the worklet-side handle). The
  MIDI event must include `atSample: number` (the sample index within the
  current quantum). — `declarations.ts:1307,1331`
- Events/MIDI carry **no** infix sugar; the helper/handler shapes are identical
  in both forms. Handler BODIES still get operator / bare-state lowering in `.uwk.ts`.
- Main-thread side is `node.midi.<name>` with the full `MidiEvent` union (§5).

```ts
// .uwk.ts MIDI synth — one binding per `const` statement (the auto-name pass
// skips comma-separated multi-declarators, so `const hz = …, gate = …` would
// break `.named()`).
const out = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });
const hz = state.f32(440).named();
const gate = state.f32(0).named();
const phase = state.f32(0).named();
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

**Cross-type math needs an explicit cast.** Arithmetic primitives (`add` / `mul`
/ etc.) refuse mixed-scalar operands with `add() got operands of different
scalar types (i32 and f32)`. Wrap one side in the target-type constructor when
you need to mix — most often to combine a `param[i]` (which returns
`Node<"f32">`) with an `i32` counter, or to bring an inbound MIDI field
(`e.note: Node<"i32">`) into float math:

```ts
// param.f32 read is Node<"f32">; the counter is Node<"i32">. Cast to combine:
const bpm = param.f32({ default: 120, min: 40, max: 200 }).named();
const step = state.i32(0).named();
step.write(step + (i32(bpm[i]) % 16)); // OR: f32(step) + bpm[i]

// MIDI note comes as Node<"i32">; cast for float pitch math:
keys.onEvent("noteOn", ({ note }) => {
  hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440);
});
```

### Math / logic free-functions

`packages/core/src/dsl/primitives.ts`. Each also exists as a `Node` method
(`a.mul(b)`, `x.tanh()`, `x.clamp(lo, hi)`, …). A bare `number` is accepted
anywhere a `Node` is and lifts to the operand's type.

| group              | signatures → result                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| arithmetic         | `add` `sub` `mul` `div` `mod` `(a, b) → Node<T>`; `neg(x) → Node<T>`                 |
| compare            | `eq` `lt` `gt` `lte` `gte` `(a, b) → Node<"bool">`                                   |
| logic              | `not(b) → Node<"bool">`; `and(a, b)` `or(a, b) → Node<"bool">` (both operands eager) |
| float math (unary) | `sin cos tan tanh exp log sqrt floor ceil frac (x) → Node<T>`                        |
| numeric            | `abs(x) → Node<T>`; `min(a, b)` `max(a, b) → Node<T>`; `clamp(x, lo, hi) → Node<T>`  |
| composition        | `pipe(x, f1, f2, …) → applies fns left-to-right`                                     |

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
  `boolean`); the type widening lives in the runtime `LiftArg<A>` union at
  `packages/core/src/processor.ts:125` — no sugar pass rewrites `instantiate`
  args, the literal just satisfies the widened signature and any downstream
  primitive (`mul` / `add` / …) lifts it in place. A plain-`number` config arg
  is not lifted.
- An instance with a named / persistent / published internal slot **must** be
  given an explicit `{ name }` (snapshot-path stability). — `processor.ts:214`

### White-noise source — `noiseSource`

```ts
noiseSource(options?: { seed?: number }): { next(): Node<"f32"> }
```

Declares a private xorshift32 PRNG. Instantiated in declaration scope like `state` / `param`; the returned handle exposes `.next()` which advances the internal seed one step and returns the next sample in `[-1, 1)`.

`seed` must be an integer in the int32 range; a fractional or non-finite value throws at graph capture rather than silently truncating to a different stream. `seed: 0` is accepted (the emitter substitutes a non-zero constant, because xorshift32 locks at zero).

```ts
const n = noiseSource({ seed: 42 }); // pin the output byte-for-byte
const nL = noiseSource(); // omit seed → framework auto-assigns 1
const nR = noiseSource(); // 2 (per declaration order, decorrelated from nL)

process(() => {
  forSample((i) => {
    out.left[i] = nL.next() * 0.3;
    out.right[i] = nR.next() * 0.3;
  });
});
```

- **`seed` (optional, compile-time integer)**: pin the output for golden-snapshot tests / preset reproducibility. Omit it to have the framework auto-assign per declaration order (1, 2, 3, …), so two `noiseSource()` declarations in the same processor decorrelate without you picking values.
- `seed === 0` is silently substituted with a sentinel (xorshift32 locks at zero — the framework prevents the trap).
- Each `.next()` call advances the internal state; hold a sample in a local (`const s = n.next()`) if you need to reuse it in multiple places within one iteration.
- The internal seed is framework-managed (private slot allocated at graph capture); no user-visible state.

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
import is typed. — `packages/unplugin/src/index.ts:1551-1613`, `client.d.ts:11`

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

| member                    | type / behavior                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node.node`               | the raw `AudioWorkletNode` (escape hatch)                                                                                                                                                                                                                                                                                                                       |
| `node.inputs.<name>`      | `AudioNode` pass-through proxy (one per `audioInput`); connect Web Audio into it                                                                                                                                                                                                                                                                                |
| `node.outputs.<name>`     | `{ connect(target: AudioNode \| AudioParam): void; disconnect(): void }`                                                                                                                                                                                                                                                                                        |
| `node.params.<name>`      | native `AudioParam` (`.value`, `setValueAtTime`, `linearRampToValueAtTime`, …)                                                                                                                                                                                                                                                                                  |
| `node.state.<name>`       | `{ readonly value; subscribe(handler): () => void }` — latest published value. Only slots declared with `publish` appear here; `snapshot: "persistent"` alone is a worklet-side retention flag and does NOT open a main-thread channel — add `publish: { rateFps: N }` alongside to make the slot readable on the main thread (the two options are orthogonal). |
| `node.events.<name>`      | `EventSurface<T>` — `.on(handler)` (out) / `.emit(payload)` (in) / `.diagnostics.overflowCount()`; direction-narrowed                                                                                                                                                                                                                                           |
| `node.midi.<name>`        | `{ send(event, atTime?); connectFromWebMIDI(input); onEvent(type, handler); diagnostics }`                                                                                                                                                                                                                                                                      |
| `node.diagnostics`        | `{ readonly transport: "sab" \| "postMessage" }`                                                                                                                                                                                                                                                                                                                |
| `node.onError(handler)`   | subscribe to `NodeErrorEvent` (`wasm-trap` / `queue-overflow` / `sab-unavailable` / `block-length-mismatch` / `worklet-initialize-not-called`); returns unsubscribe                                                                                                                                                                                             |
| `node.snapshot(options?)` | `Promise<Uint8Array>` — block-atomic state capture; `options?: { profile?: string }`                                                                                                                                                                                                                                                                            |
| `node.restore(blob)`      | `Promise<RestoreResult>` — runs migrations, applies slots + param values; never throws (returns `{ ok }`)                                                                                                                                                                                                                                                       |
| `node.dispose()`          | idempotent teardown; stops polling, removes listeners, disconnects proxies; does not touch your graph edges                                                                                                                                                                                                                                                     |

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

|            | `.uwk.ts` (primary)                                                               | `.processor.ts` (explicit)                                 |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| wrapper    | none — `process(() => …)` ambient macro; file IS the body                         | `export const x = defineProcessor((ctx) => ({ process }))` |
| imports    | none — DSL ambient, injected on lower                                             | explicit `import { … } from "@unworklet/core"`             |
| DSP exprs  | `*`, `[i]`, bare-state read, `?:`, `if`, `$prev`                                  | `.mul()` `.add()` `.at(i)` `.read()` `.write()` `select()` |
| I/O        | ambient stereo injected if omitted                                                | every port declared explicitly                             |
| `ctx`      | ambient binding                                                                   | the `defineProcessor` callback param                       |
| type-check | `// @ts-nocheck`, OR editor plugin / `unworklet-tsc` (see `ide-and-typecheck.md`) | plain `.ts`, stock `tsc`                                   |
| SIMD       | none                                                                              | full surface incl. `@unworklet/core/simd`                  |
| extension  | `.uwk.ts`                                                                         | `.processor.ts` / `.ts`                                    |

Do not write a `defineProcessor` wrapper inside a `.uwk.ts`. Mixing operator sugar
with core `Node` method chains _inside_ a `.uwk.ts` is fine and common (§2).

---

## 7. Build / tooling (brief)

- **Bundler plugin** `@unworklet/unplugin` lowers + compiles `?worklet` imports
  and serves the DevTools dock (production build compiles the dock to nothing). —
  see `devtools.md`.
- **Type-check** `.uwk.ts` sugar with the `@unworklet/lang/typescript-plugin`
  TS-server plugin (editor) or the `unworklet-tsc --noEmit` CLI (CI). — see `ide-and-typecheck.md`.
- **Browser live-coding:** `compileSource(src)` (full lower→compile→worklet) /
  `lowerToProcessor(src)` from `@unworklet/lang/browser`. **Programmatic:**
  `lower(uwkSource, { exportName })` → virtual `.ts` string. — `packages/lang/src/index.ts:7,19`
- **Test:** render with `@unworklet/offline` (`renderOffline`) + assert with
  `@unworklet/test` matchers. — see `testing.md`.
