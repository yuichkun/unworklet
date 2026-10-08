# unworklet — DSL / API reference

TypeScript-first declarative Audio Worklet DSP, compiled to WebAssembly. You
declare ports/params/state and write a per-sample `process` body; the toolchain
compiles it to a `CompiledProcessor` you load on the main thread with
`createNode`.

Two authoring forms, **same compiled result**:

- **`.uwk.ts` — the primary, recommended form.** No imports, no wrapper; infix
  operators and `x[i]` index sugar. The plugin _lowers_ it to a plain
  `@unworklet/core` module that makes the exact same DSL calls a hand-written
  core processor makes, so it compiles byte-identically. — [cite: packages/lang/src/lower.ts :: `export function lower(`]
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
  [cite: packages/lang/src/lower.ts :: `export function lower(`] [cite: packages/lang/src/lower.ts :: `function callbackBody(`]
- **DSL names are ambient — write no imports.** Lowering injects the
  `@unworklet/core` import listing only the names actually used. — [cite: packages/lang/src/lower.ts :: `function collectUsedCoreExports(`]
- **Ambient stereo I/O is injected when omitted:** with no `audioInput`
  referenced, `const input = audioInput({ channels: 2, name: "input" })` is
  added (same for `out`). An explicit declaration suppresses it. — [cite: packages/lang/src/lower.ts :: `function makeAudioDecl(`]
- **`ctx` is ambient** — it is the `defineProcessor((ctx) => …)` parameter, so
  `ctx.sampleRate` reaches the host rate. — [cite: packages/lang/src/lower.ts :: `function makeDefineProcessor(`]
- **Your own `import`s survive** at module scope (shared consts, sibling
  subgraph files). Write relative imports WITH the file extension
  (`./tables.ts`, not `./tables`): the build path evaluates processor modules
  under Node ESM resolution, which demands explicit extensions — an
  extensionless specifier fails the build (the error names the exact suffix to
  add). — [cite: packages/lang/src/lower.ts :: `export function lower(`]
- **A processor file cannot export additional declarations.** A `.uwk.ts`
  containing `process()` rejects authored module-level exports with
  `uwk-export-unsupported`, including values, types, default exports, and
  re-exports. Put shared constants, types, and helpers in a separate `.ts` or
  library-only `.uwk.ts` file and import them into the processor. A library-only
  `.uwk.ts` has no `process()` and keeps its exports. The lowering does not move
  declarations across statements or predict callbacks' effects. Expose runtime
  DSP values through the processor surface (param / state / event).
- **The names the lowering generates are reserved** — `defineProcessor` always,
  and the ambient `input` / `out` plus `audioInput` / `audioOutput` when the
  file declares no audio I/O of its own. Declaring one is
  `uwk-reserved-binding`, because the generated code would resolve to your
  binding instead. Declaring your own output (`const out = audioOutput({...})`)
  suppresses the injection, so that canonical line is unaffected.
- **Type-checking:** add `// @ts-nocheck` at the top, OR use the editor plugin /
  `unworklet-tsc` (see `ide-and-typecheck.md`). The `// @ts-nocheck` is needed _only_ without
  the editor plugin.

### Ambient global surface (names usable unimported in `.uwk.ts`)

Source: [cite: packages/lang/src/ambient.ts :: `export const AMBIENT_DTS =`] (= shipped `dist/ambient.d.ts`).

- Decl helpers: `state` `param` `event` `defineSubgraph` `instantiate`
  `audioInput` `audioOutput` `noiseSource`
- Loop / control: `forSample` `select`
- Scalar constructors: `f32` `f64` `i32` `i64` `bool`
- Free fns: `add sub mul div mod neg eq lt gt lte gte not and or sin cos tan tanh exp
log pow sqrt floor ceil frac abs min max clamp pipe`
- Constants: `SAMPLES_PER_BLOCK`, `CAPACITY_16` … `CAPACITY_16384`
- `.uwk.ts`-only ambients: `process` `migrations` `options` `input` `out` `ctx`
  `$prev`
- Type aliases (for annotating helper / subgraph params): `Node<T>` `State<T>`

---

## 2. `.uwk.ts` sugar forms

The sugar is type-directed: an operator/index lowers **iff** an operand is — or
lowers to — a `Node<T>` (`isDspExpr`, [cite: packages/lang/src/classify.ts :: `export function isDspExpr(`]). Pure
`number op number` (e.g. `Math.LN2 / 12`, `ctx.sampleRate * 0.5`) stays
build-time JS. Operands recurse bottom-up, so JS precedence is preserved.

A helper returning DSP arithmetic can use build-time `if`/`else`, `switch`, or
other statement blocks. Arithmetic applied to its return value lowers in the
same way as arithmetic inside the helper.

### Operators → free-fn calls (`packages/lang/src/passes/operators.ts`)

| sugar                                   | lowers to                              |
| --------------------------------------- | -------------------------------------- |
| `a + b` `a - b` `a * b` `a / b` `a % b` | `add` `sub` `mul` `div` `mod` `(a, b)` |
| `a ** b`                                | `pow(a, b)`                            |
| `-a` `!b`                               | `neg(a)` `not(b)`                      |
| `a == b` / `a === b`                    | `eq(a, b)`                             |
| `a != b` / `a !== b`                    | `not(eq(a, b))`                        |
| `a < b` `a > b` `a <= b` `a >= b`       | `lt` `gt` `lte` `gte` `(a, b)`         |
| `a && b` `a \|\| b` (both bool)         | `and(a, b)` `or(a, b)`                 |
| `cond ? x : y` (cond is DSP)            | `select(cond, x, y)`                   |

Generated sugar calls use the core helpers even when an authored binding has
the same name. For example, a local `mul` does not affect DSP `a * b`; an explicit
`mul(a, b)` still calls the authored binding. Generated import aliases avoid
authored names in nested scopes too.
The editor plugin and `unworklet-tsc` use the same helper bindings and preserve
diagnostics on authored calls and operands.
Type-only imports keep their type roles when a generated helper uses the same name.

Closed operator set: [cite: packages/lang/src/classify.ts :: `export function isSugarBinaryOperator(`] (`isSugarBinaryOperator`). Method chains
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

### Local container values

DSP operator results, intrinsic Node method results, and indexed DSP reads can be stored in local `const`
array/object literals and read with literal keys (`values[0]`, `values.left`),
or bound through `const` destructuring of a literal. Nested literal paths and
numeric sibling fields keep their DSP and build-time meanings respectively.
Signed numeric object keys such as `{[-1]: value}` are read through the matching
literal path, such as `values[-1]`.
Bigint keys such as `values[-1n]` retain their integer precision. Boolean and
null literal keys use the JavaScript property names `"true"`, `"false"`, and `"null"`.
String keys also accept template literals without substitutions, such as
``values[`left`]``. Templates with substitutions remain dynamic keys.

This inference requires direct, read-only references to the container. It does
not infer through aliases, value exports, mutation, escapes, dynamic keys, or ambiguous helper or callback
return values. Erased type references such as `type Snapshot = typeof values`
do not expose or mutate the container. Explicit core operations such as `mul(x, 2)` preserve the `Node`
type of stored DSP values for ordinary TypeScript inference.

### Index / element-access (`packages/lang/src/passes/index.ts`)

Rewritten by the **object's** type:

| sugar                                             | lowers to                 | object             |
| ------------------------------------------------- | ------------------------- | ------------------ |
| `input.left[i]` `input.right[i]` `input.ch(c)[i]` | `…at(i)`                  | input channel view |
| `param[i]`                                        | `param.at(i)`             | param              |
| `buf[i]` (read)                                   | `buf.read(i)`             | buffer             |
| `out.left[i] = v` `out.ch(c)[i] = v`              | `out.left.at(i).write(v)` | output view        |
| `buf[i] = v`                                      | `buf.write(i, v)`         | buffer             |

A write is an assignment whose LHS is an element access. — [cite: packages/lang/src/passes/index.ts :: `export function tryIndex(`]

### Bare-state read (`packages/lang/src/passes/bareState.ts`)

A scalar `State<T>` used in a `Node<T>` position auto-reads. **Read-only sugar —
the write stays explicit** (`state.write(v)`; there is no `state = v` sugar).

```ts
env.write(env * 0.99); // → env.write(mul(env.read(), 0.99))
```

Fires when the contextual type accepts `Node<…>`, as an `emit`/`emitIf` payload
field, or as a JS-boolean ternary branch. A `State` passed where a `State` is
expected (subgraph/helper arg) keeps its reference. — [cite: packages/lang/src/passes/bareState.ts :: `export function readsAsBareState(`]

### `if` → branch-free `select` / `emitIf` (`packages/lang/src/passes/ifSugar.ts`)

An `if` with a `Node<'bool'>` condition lowers; a JS-boolean condition stays a
build-time `if`. **Only three shapes lower**; any other DSP-conditioned `if`
throws `uwk-unsupported-if` (rewrite to `select(...)`). The error’s optional
`sourceRange` identifies the condition in the original source using UTF-16
`start` / `length` offsets; other lowering errors may have no position.

| sugar                                             | lowers to                                 |
| ------------------------------------------------- | ----------------------------------------- |
| `if (c) s.write(v)`                               | `s.write(select(c, v, s.read()))`         |
| `if (c) buf[i] = v`                               | `buf.write(i, select(c, v, buf.read(i)))` |
| `if (c) s.write(a) else s.write(b)` (same target) | `s.write(select(c, a, b))`                |
| `if (c) port.emit(p)` (block of emits)            | `port.emitIf(c, p)` (each)                |

Buffer indices in these writes accept the same arithmetic, index-access, and
bare-state sugar as unconditional writes, including `buf[i + 1] = value` and
`buf.write(i + 1, value)`. A symmetric buffer `if`/`else` must use the same buffer
and index expression in both branches.

— [cite: packages/lang/src/passes/ifSugar.ts :: `export function tryIfSugar(`]

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
`$prev` → `slot.read()`, and stores each return into the slot. The slot follows
the method's return type, including single-quoted, double-quoted, and aliased
`Node<T>` annotations. Generated names do not shadow authored bindings.

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
plain `state.f32(0)` stays anonymous. — [cite: packages/lang/src/passes/autoName.ts :: `function autoNamedInit(`]

### Does NOT lower (confirmed absences — do not emit as DSP)

- `number op number` stays build-time JS (intended).
- Bitwise `& | ^ << >>` and compound assignment `+= -= *= /= %=` are **not**
  sugar. — [cite: packages/lang/src/classify.ts :: `export function isSugarBinaryOperator(`], [cite: packages/lang/src/passes/index.ts :: `node.operatorToken.kind === ts.SyntaxKind.EqualsToken`]
- Logical `&&` / `||` on two `Node<'bool'>` operands **do** lower (to `and` /
  `or`, both operands evaluate — see §2 operator table), but the JavaScript
  short-circuit semantics are NOT preserved.
- A `Node<'bool'>` `if` outside the 3 shapes → `uwk-unsupported-if`; use `select`.
- `migrations()` / `options()` are processor-only and cannot reference a
  process-body binding → `uwk-options-binding` / `uwk-options-without-process`.
  Static property names (such as `options({ id: "osc" })`), imported values, and
  bindings local to an inline callback are allowed. Shorthand values, computed
  keys, and callback closures must not capture a processor-body binding.
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
Source: `packages/core/src/dsl/declarations.ts`, `packages/core/src/dsl/loop.ts`, `packages/core/src/dsl/primitives.ts`,
`packages/core/src/dsl/constructors.ts`, `packages/core/src/dsl/pipe.ts`, `packages/core/src/processor.ts`.

### Audio I/O — `audioInput` / `audioOutput`

```ts
audioInput<C>({ channels: C, name: string }):  AudioInputHandle<C>
audioOutput<C>({ channels: C, name: string }): AudioOutputHandle<C>
```

- `.ch(c)` → a channel view for any channel index. `.left` / `.right` are
  getters present **only when `channels === 2`**; on a non-stereo port they
  throw, pointing you at `.ch(...)`. — [cite: packages/core/src/dsl/declarations.ts :: `function defineStereoOnlyGuards(`]
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
- — [cite: packages/core/src/dsl/declarations.ts :: `export type ParamOptions =`] [cite: packages/core/src/dsl/declarations.ts :: `function makeParam(`] [cite: packages/core/src/dsl/declarations.ts :: `export const param: ParamChain =`]

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
  cannot change an already-bound read. — [cite: packages/core/src/dsl/declarations.ts :: `function makeStateHandle<`]
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
  `.named(name)` / `.expose(options)`. — [cite: packages/core/src/dsl/declarations.ts :: `function makeBufferHandle<`]
- Literal indexes are range-checked at graph-capture time. A runtime
  `Node<"i32">` index SATURATES to the buffer bounds — `[0, size-1]` for scalar
  `read`/`write`, `[0, size-4]` for the 4-lane `loadVec`/`storeVec` — instead of
  trapping or touching a neighboring region. Out-of-range reads return the
  nearest element's value; wrap-around (a circular delay line) is still yours to
  express with `% size`.
- `loadVec` / `storeVec` require `size >= 4`. A lane window covers 4 elements,
  so a smaller buffer has no in-bounds offset to saturate to — the declaration
  rejects the call at capture (`simd-buffer-too-small`) rather than emit a
  16-byte access that crosses into the next region.
- `.loadVec(offset)` captures all four lanes at the read's lexical point. Later
  scalar or vector writes cannot change that value. The returned `Node<"f32x4">`
  supports `.add`, `.sub`, `.mul`, and `.div` with another vector or a number
  broadcast to every lane. Use `.lane(0)` … `.lane(3)` or `sumLanes(value)` from
  `@unworklet/core/simd` to reduce it to a scalar.
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
- **Buffers default to `"transient"`** and are omitted from snapshots. Use
  `.expose({ snapshot: "persistent" })` to save their content. Named scalar
  states default to `"persistent"`. Restoring on a running node does not clear
  an omitted buffer; a fresh processor instance starts with its declared
  initial content.
- In `.uwk.ts`: `buf[i]` (read) / `buf[i] = v` (write).
- Capacity sizes for messaging rings are the `CAPACITY_16` … `CAPACITY_16384`
  constants (values live at [cite: packages/core/src/dsl/constants.ts :: `export const CAPACITY_16 =`], re-exported
  via [cite: packages/core/src/index.ts :: `} from "./dsl/constants.ts";`]; the `Capacity` type union is at
  [cite: packages/core/src/types.ts :: `export type Capacity =`]). SIMD `.loadVec` / `.storeVec` exist on the
  buffer handle but are a `.processor.ts` + `@unworklet/core/simd` concern (§6).

### Slot exposure — `ExposeOptions`

[cite: packages/core/src/types.ts :: `export type ExposeOptions =`]

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
  requires a user-defined name. — [cite: packages/core/src/dsl/declarations.ts :: `function validateStateDecl(`]
- A published slot is read on the main thread as `node.state.<name>` (§5).
- In `.uwk.ts`, a trailing core state, buffer, or param `.expose(options)`
  accepts a variable or helper-call
  result as well as an object literal. Non-literal options are evaluated once;
  core reads `name`, `snapshot`, and `publish` lazily from the original object,
  including inherited getters. Custom `expose` methods and receivers whose
  method can be non-core keep their original arguments. An undefined `name` uses the declaration's binding
  name; an explicit name wins. For example, passing a variable containing
  `{ snapshot: "transient", publish: { rateFps: 30 } }` to a scalar state
  declaration named `level` publishes `level` at 30 FPS. Core validation
  applies equally to variable options: `{ publish: { rateFps: 0 } }` is invalid,
  and buffers cannot publish. Whole `null` or `undefined` options fail as they do
  in direct core calls. — `packages/lang/src/passes/autoName.ts`

### Events — `event<T>` (typed message ports)

Direction is in the options; the return type and worklet-side methods narrow to it.

```ts
event<T>({ from: "main"; name; capacity?: Capacity; payloadCapacity?: number })  // main → worklet
event<T>({ to:   "main"; name; capacity?: Capacity; payloadCapacity?: number })  // worklet → main
```

- Inbound (`from: "main"`): worklet handles with `.onReceive(handler)`. —
  [cite: packages/core/src/dsl/declarations.ts :: `function eventFromMain<`]
- Outbound (`to: "main"`): worklet sends with `.emitIf(cond, payload)` only —
  there is no bare `.emit(payload)` on the worklet-side handle (calling it
  throws `TypeError: emit is not a function`). Use `port.emitIf(bool(true), p)`
  for the unconditional case, or write `if (cond) port.emit(p)` inside the
  process body and the if-sugar (§2) rewrites it to `emitIf`. —
  [cite: packages/core/src/dsl/declarations.ts :: `function eventToMain<`]
- Main-thread side is `node.events.<name>` (§5). — [cite: packages/core/src/types.ts :: `export type EventSurface<`]
- Outbound `atSample` is optional. Omission uses the innermost active `forSample`
  index, including inside `everyNSamples`, or zero outside a sample loop.
  A block-level `onReceive` or MIDI `onEvent` handler uses zero, even after a
  sample loop has completed. Set it explicitly with
  `port.emitIf(cond, { atSample: i, ...userFields })` when another offset is
  intended. It is a sample index within the render quantum.
- **Payload retention and memory:** each typed-array ring reserves one content
  chunk per `capacity` slot. `payloadCapacity` is the byte budget for one
  payload, rounded to its element alignment; the default is 65,536 bytes.
  With default `capacity: 256`, this reserves 16 MiB of WASM content per typed
  ring. Shared transport buffers, main-thread snapshots, and bounded input
  staging use additional memory. Set `payloadCapacity` to the largest payload
  you need, such as 512 bytes for 128 float samples. `capacity` controls queued
  message count independently of payload length; variable-length payloads do
  not share storage while retained. Payloads larger than their per-message
  budget are truncated to that budget. The memory-budget diagnostic rejects
  layouts beyond the WASM address-space limit without allocating them.
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
  that is only forwarded stays on the f32 wire and arrives as numeric 0/1.
  Use `bool(f.on)` in the outbound payload when the receiver needs a JavaScript
  boolean, or consume the inbound field in a boolean position such as
  `emitIf(f.on, ...)`.

### MIDI ports — `event.midi`

```ts
event.midi({ from: "main"; name; capacity?: Capacity }): MidiInputHandle   // inbound MIDI
event.midi({ to:   "main"; name; capacity?: Capacity }): MidiOutputHandle  // outbound MIDI
```

- Inbound: worklet handles per type with
  `.onEvent("noteOn", ({ note, velocity, … }) => …)`. — [cite: packages/core/src/dsl/declarations.ts :: `function midiFromMain(`]
- Per-event-type handler field shapes (all fields are `Node<"i32">`; combine
  with `f32(...)` for float math). The source of truth is `MidiEvent` in
  `packages/core/src/types.ts`:
  - `"noteOn"` / `"noteOff"` — `{ channel, note, velocity, atSample }`
  - `"cc"` (control change) — `{ channel, controller, value, atSample }`
  - `"pitchBend"` — `{ channel, value, atSample }` (value is 14-bit signed)
  - `"programChange"` — `{ channel, program, atSample }`
  - `"channelPressure"` — `{ channel, pressure, atSample }`
  - `"aftertouch"` (poly key pressure) — `{ channel, note, pressure, atSample }`
  - `"sysex"` — `{ data, length, atSample }`; `data` is a read-only byte field
    and `length` is a `Node<"i32">`
  - `"systemRealtime"` — `{ status, atSample }` (status = 0xF8..0xFF)
- Sysex boundaries: a port accepts/produces sysex only when the processor
  handles or emits sysex on it (that is what allocates its content region);
  `node.midi.<name>.send()` THROWS on sysex to a port without one (stable ID
  `sysex-unsupported-port`). One sysex message holds at most **1020 bytes**
  (including 0xF0/0xF7): `send()` throws past the limit rather than
  truncate-and-deliver a terminator-less message (stable ID
  `sysex-payload-too-large`). `renderOffline` rejects oversized input on a
  declared sysex port with the same diagnostic. Sysex storage reserves 1024
  bytes per ring slot (256 KiB for default capacity 256), including a four-byte
  length prefix. An outbound `emitIf` follows the same rule on its
  `length`: a build-time-known length past 1020 bytes — or past its own source
  `buffer.u8` — is a build error (stable ID `sysex-emit-exceeds-chunk`), and a
  length computed at runtime that overruns either bound drops the whole message
  and counts it in `renderOffline(...).diagnostics.droppedSysexMessages`. The
  buffer itself may be any size; the emitted `length` is what has to fit. Split
  larger transfers into multiple messages.
- Outbound: worklet sends with `.emitIf(cond, event)` only — same rule as
  typed `event<T>` above (no bare `.emit` on the worklet-side handle). The
  MIDI event must include `atSample: number` (the sample index within the
  current quantum). — [cite: packages/core/src/dsl/declarations.ts :: `function midiToMain(`]
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
  samples (sub-rate work), starting on its first invocation. With `.byN(stride)`,
  it fires where the stride and `n` sample grids coincide: every
  `n / gcd(n, stride)` invocations. Nested call sites advance only when reached.
  Each call site retains its cadence across blocks without counter overflow,
  including periods larger than 32 bits. Scheduler phase is internal and is not
  included in snapshots; restoring named values leaves a running scheduler's
  phase intact. — [cite: packages/core/src/dsl/loop.ts :: `export type EveryNSamples =`] [cite: packages/core/src/dsl/loop.ts :: `export const forSample:`]
- `stride` must be a power of two that divides the render quantum 128: one of
  `1, 2, 4, 8, 16, 32, 64, 128`. `everyNSamples`'s `n` must be a compile-time
  positive integer. These compile-time checks apply to loops in `process`,
  `event(...).onReceive`, and `event.midi(...).onEvent`, including nested loops.
  Invalid values fail with `illegal-stride` or `illegal-everyn-divisor` before
  WASM emission. — `packages/core/src/compile/analyze.ts`
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
`.uwk.ts` write `cond ? then : else_`. — [cite: packages/core/src/dsl/primitives.ts :: `export function select<T extends ScalarType>(`]

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
| power              | `pow(base, exponent) → Node<T>` (float only; `a ** b` in `.uwk.ts`)                  |
| numeric            | `abs(x) → Node<T>`; `min(a, b)` `max(a, b) → Node<T>`; `clamp(x, lo, hi) → Node<T>`  |
| composition        | `pipe(x, f1, f2, …) → applies fns left-to-right`                                     |

In `.uwk.ts` arithmetic/compare/power/`neg`/`not` are written with operators (§2);
the named functions remain available and `sin`/`exp`/`clamp`/`pipe`/etc. are
written directly.

Floating `mod` / `%` uses truncating remainder, with the dividend's sign,
including `-0` for negative exact multiples. It is exact for the operands'
`f32` or `f64` values, including subnormals; `f32` inputs are rounded before
the operation. A zero divisor, infinite dividend, or NaN operand yields NaN;
a finite dividend modulo either infinity is unchanged. Integer-significand
reduction is bounded by 32 steps for `f32` and 186 for `f64`; ordinary nearby
exponents need fewer steps. This does not bypass the separate state/buffer-store
subnormal flush or audio-output non-finite scrub.

`pow` gives what JavaScript's `**` gives, special values included: a negative
base with a fractional exponent is `NaN`, `x ** 0` is 1, `0 ** -1` is `Infinity`.
An integral exponent up to ±127 is multiplied out, so `x ** 2` equals `x * x` and
results JavaScript gives exactly (`10 ** 2`, `2 ** -3`) are exact. Other
exponents go through exp / log, within about 2e-5 relative. All of this holds
while the result stays in the normal float range: a result smaller than about
1e-38 or larger than about 2e38 in magnitude can come out as 0 or `Infinity`
instead, as with `exp`. Both operands are `f32` or `f64` (an `f64` pair is
computed in `f32`, see below); an integer `Node` (a MIDI field, `state.i32`) is
refused with an error, so convert it first: MIDI note → Hz is
`440 * 2 ** (f32(note - 69) / 12)`.

```ts
// gain.uwk.ts — a gain knob in dB
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
const gainDb = param.f32({ default: -6, min: -60, max: 6, automationRate: "a-rate" }).named();

process(() => {
  forSample((i) => {
    out.ch(0)[i] = input.ch(0)[i] * 10 ** (gainDb[i] / 20);
  });
});
```

The `f64` forms of `sin cos tan tanh exp log pow` compute in `f32`: the operands
are converted to `f32` and the result back to `f64`, so `exp(x)` on an `f64` node
equals `f64(exp(f32(x)))`. They carry `f32`'s range and precision. An operand
beyond about ±3.4e38 becomes ±Infinity (`log` of an `f64` 1e100 is `Infinity`),
and rounding the operands to `f32` can outweigh the approximation itself
(`1.0000001 ** 1e6` on `f64` comes out about 2% high). `sqrt floor ceil frac abs
min max` and the arithmetic operators run natively in `f64`.

### `defineSubgraph` / `instantiate` (reusable DSP units)

[cite: packages/core/src/processor.ts :: `export function defineSubgraph<`] [cite: packages/core/src/processor.ts :: `export function instantiate<`]:

```ts
defineSubgraph((...args) => methods): SubgraphDecl
instantiate(subgraph, ...args, options?: { name?: string }): methods
```

- Instantiate in **declaration scope only** (top of a `defineProcessor` /
  `defineSubgraph` body, before the returned `process` / method record);
  instantiating inside `forSample` / `everyNSamples` / a handler throws
  (`scope-violation`). Each instance gets independent internal state. — [cite: packages/core/src/processor.ts :: `if (ctx.currentLoopBody !== null) {`]
- In `.uwk.ts`, a statically known `number` argument is constructed with `f32`,
  `f64`, or `i32` when the subgraph's original argument slot declares exactly that
  `Node` scalar. A statically known `boolean` is constructed with `bool` for a
  `Node<"bool">` slot. This applies to expressions as well as literals; each
  expression is evaluated once. Method bodies and Node pass-through returns
  receive the same Nodes as an explicit constructor call. Runtime lowering and
  editor/CLI virtual code share these constructor decisions. — [cite: packages/lang/src/passes/instantiate.ts :: `export function instantiateArgumentConstructors(`]
- The recognized calls are the ambient `instantiate`, named imports (including
  imported aliases), and direct namespace property calls such as
  `core.instantiate(...)` resolving to core's actual export. Runtime-transparent parentheses, non-null assertions,
  `as` / type assertions, `satisfies`, and explicit callee type instantiation preserve
  this binding check. Custom functions/objects, local or assigned aliases, and
  computed-property, conditional, or comma-expression callees are left unchanged.
  Cross-file subgraphs retain their declared argument types. Metadata intersections,
  interface inheritance, and readonly wrappers retain the original Args through
  core's unique subgraph brand; conflicting argument witnesses stay explicit.
- Construction happens before the subgraph body runs, so arithmetic uses the
  declared scalar even when every supplied value is primitive. With a
  `Node<"f64">` coefficient of `1e8`, `(coef + 1) - coef` evaluates to `1`.
  With a `Node<"i32">` coefficient of `1.75`, `coef + 1` evaluates to `2`, using
  the constructor's truncation. Choose `Node<"f32">` for f32 arithmetic and
  fractional values; `f32(coef)` inside an f64 body explicitly converts that
  value to f32. Converting an i32 value afterward cannot recover a fraction
  discarded during argument construction.
- Existing Nodes, plain primitive/config arguments, and declared primitive
  alternatives such as `Node<"f32"> | number` stay unchanged. Optional slots can
  construct a supplied primitive; omitted or `undefined` arguments stay unchanged.
  Ordinary trailing rest slots are supported, and trailing `{ name }` options
  keep core's existing interpretation.
- This construction is deliberately partial. Use explicit constructors for
  `i64`, SIMD, ambiguous scalar targets, generic/unknown targets, nullable or
  Node-or-primitive argument expressions, and argument positions at or after a
  spread. A tuple with a nonterminal rest or unresolved variadic portion is left
  unchanged. The lowering does not select a scalar from a runtime value or
  recursively construct properties inside config objects.
- Raw-core calls still pass arguments through unchanged. The public
  `LiftArg<A>` signature accepts primitives more broadly than the cases above;
  accepted types alone do not guarantee construction. Pass explicit Nodes, for
  example `instantiate(sg, f32(0.5))`, in raw core and any unsupported lowering
  case. Otherwise method-form calls or Node pass-through use can fail at capture.
  — [cite: packages/core/src/processor.ts :: `type LiftArg<A> =`] [cite: packages/core/src/processor.ts :: `methods = body(...(args as Args));`]
  For `.uwk.ts` code that deliberately needs f32 arithmetic, keep the formal
  parameter and conversion consistent. The first declaration retains an f64 input
  and converts inside the body; the second uses a floating-point formal so a
  fractional input is preserved:

```ts
const f32Arithmetic = defineSubgraph((coef: Node<"f64">) => ({
  tick: () => f32(coef) + 1 - f32(coef),
}));
const fractional = defineSubgraph((coef: Node<"f32">) => ({
  tick: () => coef + 1,
}));
```

In processor declaration scope, `instantiate(f32Arithmetic, 1e8)` produces an
instance whose `tick()` returns `0`; `instantiate(fractional, 1.75)` returns
`2.75` from `tick()`. Passing `f32(...)` into an unchanged `Node<"f64">` or
`Node<"i32">` formal is a type error; changing the caller's constructor alone
is not that migration.

- An instance with a named / persistent / published internal slot **must** be
  given an explicit `{ name }` (snapshot-path stability). — [cite: packages/core/src/processor.ts :: `if (instanceName === undefined) {`]

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
type ProcessorContext = { readonly sampleRate: number };
```

[cite: packages/core/src/types.ts :: `export type ProcessorContext =`]

`ctx.sampleRate` is a build-time-known number, so rate-dependent coefficients
(`440 / ctx.sampleRate`, etc.) const-fold into the WASM. The processor recompiles
per host rate from this value.

---

## 4. Subgraph in its own file (library module)

A `.uwk.ts` with **no `process()` but ≥1 export** is a library module: its
exports are emitted verbatim at module scope, subgraph-body sugar still lowers,
and there is no `defineProcessor` wrap / no ambient I/O. — the library-module branch of `lower()`

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
[cite: packages/core/src/index.ts :: `export { createNode, inspect }`] [cite: packages/core/src/index.ts :: `export { replaceProcessor }`]

### `?worklet` import (identical for both authoring forms)

The plugin lowers (if `.uwk.ts`) + compiles, and the **default** export is a
`CompiledProcessor<C>` augmented with bundler URLs + identity + baked rate. Typing
needs a one-line triple-slash reference (like `vite/client`); only the default
import is typed. — [cite: packages/unplugin/src/index.ts :: `export default __unworkletAugmented;`], [cite: packages/unplugin/client.d.ts :: `declare module "*?worklet" {`]

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

[cite: packages/core/src/client.ts :: `export async function createNode<C>(`]. It loads the worklet module (cached per
context+url), compiles the WASM, picks the transport (`"sab"` when
`SharedArrayBuffer` + `crossOriginIsolated`, else `"postMessage"`), constructs the
`AudioWorkletNode`, and resolves on a `ready` port message (rejects on init error
/ `processorerror` / 10 s timeout).

`"postMessage"` is a compatibility transport with bounded egress buffer reuse.
Receiving messages and recycling transferred buffers can allocate on the audio
thread, so this path is outside the allocation-free and GC-free guarantee.
The emitted DSP's fixed-memory, bounded-work constraints apply to both paths.
Neither transport waits for the main thread while processing audio. Shared
out-ring publication uses a single try-acquire; contention postpones publication
while DSP continues. A full WASM ring follows its drop-oldest policy and reports
overflow through the ring's diagnostics.

For shared inbound events and MIDI, `emit` / `send` copies caller data
synchronously into bounded main-thread staging. Publication retries if the
audio thread owns the shared ring. Audio takes ownership of copied entries in
its own bounded WASM ring, acknowledges that transfer, and runs handlers without
holding the shared ring. Staging, the shared ring, and the WASM ring each retain
at most the declared capacity; overflow counts actual entries discarded at those
stages. In-flight copies can therefore use additional storage. Disposal cancels
pending retries.

```ts
const ctx = new AudioContext({ sampleRate: 48000 });
const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
```

### Rate gate — `?worklet` bakes 48 kHz

The WASM bakes rate-dependent coefficients at build time, so `createNode`
**throws** when `context.sampleRate !== bakedSampleRate`. A `?worklet` import bakes
`DEFAULT_SAMPLE_RATE = 48000` unless compiled otherwise — create the context at
the baked rate. — [cite: packages/core/src/client.ts :: `contextSampleRate !== bakedSampleRate`], [cite: packages/core/src/compile/index.ts :: `const DEFAULT_SAMPLE_RATE = 48000;`]

```ts
new AudioContext({ sampleRate: 48000 });
new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: 48000 });
```

### `UnworkletNode<C>` surface

`C` may be the config, a `CompiledProcessor`, or a module namespace whose default
export is a processor. `UnworkletNode<typeof import("./x.uwk.ts?worklet")>` and
`UnworkletNode<typeof processor>` both name the type of the node created from
that default import, including its declared parameters and message payloads.

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

Processors with no declared audio ports use one silent native output to satisfy
Web Audio's constructor requirements. Their public `inputs` and `outputs` remain
empty. `dispose()` sends a shutdown message; once the worklet receives it, DSP
execution stops and `process()` returns `false` to release the processor's lifetime.

`MidiEvent` is a discriminated union (`noteOn` / `noteOff` / `cc` / `pitchBend` /
`programChange` / `channelPressure` / `aftertouch` / `systemRealtime` / `sysex`). —
[cite: packages/core/src/types.ts :: `export type MidiEvent =`]

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

Snapshot and devtools parameter captures use the current `AudioParam.value` while
its context is suspended, including before the first render. The context mode and
suspended settings are captured when the request is issued, so a pending resume or
suspend does not change the parameter source. Requests issued while running capture
the last rendered parameter sample. State and buffer restores require the
saved element type and byte length to match the destination declaration; incompatible
slots are skipped. This also applies to offline restore. Use a migration to convert
values when changing a slot's type.

Live restore validates slots before setting accepted native AudioParam values and
committing persistent state. Scheduled automation and modulation connections remain
active; restoring saved scalar values does not rewind an automation timeline.
Overlapping restores and intervening snapshot or DevTools captures retain their
request order. Suspended captures still use the parameter settings from invocation.
A failure after native parameter assignment can leave those assignments in effect;
restore does not provide transactional rollback. Native AudioParam scheduling still
controls the exact sample at which a value takes effect. The ordering barrier does
not guarantee zero stale samples at every suspension/resumption boundary; the
observed native timing limitation is tracked in
[issue #155](https://github.com/yuichkun/unworklet/issues/155).

### `inspect(blob)`

Pure, non-realtime blob decode — needs no `AudioContext` or live node.
`InspectionResult = { version; schemaHash; profile; processorId; slots }`.
`processorId` is the identity a v2 blob carries, `null` for an id-less or v1
blob. — [cite: packages/core/src/client.ts :: `export function inspect(`], [cite: packages/core/src/types.ts :: `export type InspectionResult =`]

Buffer inspection reports logical element counts and a preview of up to 64
elements. Boolean buffers use `0` and `1` at their declared indexes. Migration
helpers read and write boolean buffers as `Uint8Array` values; the snapshot's
four-byte storage per boolean is handled by the codec.

(`replaceProcessor` live-swaps a processor while preserving state; it is exported
but out of scope here.)

---

## 6. `.processor.ts` — the explicit core-method alternative (secondary)

Same compiled result; plain `.ts` checked by stock `tsc`. Use it when you need a
surface `.uwk.ts` does not expose (SIMD via `@unworklet/core/simd`). Authoring is
explicit: `defineProcessor` wrapper, explicit imports, method chains.

The Vite build evaluates plain processor modules in an isolated SSR module graph.
Repeating `build()` in one Node process reloads their direct and transitive local
ESM helpers, including helpers outside the app root. CommonJS helpers and package
dependencies retain native module identity and caching; picking up their edits
requires a process restart.
Each build shares one processor evaluation and compile result between its WASM,
client registration name, and worklet metadata. The next build starts a fresh snapshot.

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

— [cite: packages/core/src/processor.ts :: `export function defineProcessor<`]. `options.migrations` declares snapshot migrations.

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
  `lowerToProcessor(src)` from `@unworklet/lang/browser`.
  [cite: packages/lang/src/browser.ts :: `export function lowerToProcessor(`]
  [cite: packages/lang/src/browser.ts :: `export async function compileSource(`]
  `compileSource` bakes
  48000 Hz: use `new AudioContext({ sampleRate: 48000 })`. `createNode` rejects
  other context rates before module loading; browser compilation has no rate option.
  **Programmatic:**
  `lower(uwkSource, { exportName })` → virtual `.ts` string. — [cite: packages/lang/src/index.ts :: `export { lower, LowerError }`]
- **Test:** render with `@unworklet/offline` (`renderOffline`) + assert with
  `@unworklet/test` matchers. — see `testing.md`.
