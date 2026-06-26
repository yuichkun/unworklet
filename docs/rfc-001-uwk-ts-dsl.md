# RFC 001 — `.uwk.ts` authoring frontend

A pure-TypeScript authoring layer on top of `@unworklet/core`. End-users write `.uwk.ts` files containing ordinary TypeScript syntax with five lightweight conveniences (operator sugar on `Node<T>`, index access for I/O / buffer / param, `if`-statement sugar, the `$prev` keyword, variable-name → `name` auto-derive), plus a `.pipe()` method / `pipe()` free function pair that improves chain readability. A `.uwk.ts` file lowers to today's `defineProcessor((ctx) => { ... return { process: () => {...} } })` shape and feeds into the existing `compile()` pipeline. No change to WASM emission, realtime-safety invariants, or any other v1.0.0 spec — strictly an additive authoring surface.

## Status

**Draft.** Not ratified. Not part of the v1.0.0 14-phase roadmap (`10-roadmap.md` §2). Targeted for grilling toward v1.1.0 after v1.0.0 ship.

> **Surface note.** This draft predates two ratified core changes: scalar state
> read/write is `.read()` / `.write()` (not `.load()` / `.store()`), and the
> message / midiInput / midiOutput surface was unified into the **event family**
> (`event<T>({ from | to: "main" })` + `event.midi`, see `decisions-log.md` Q87 /
> Q88). Where the prose below shows the older names, the current core surface is
> `01-dsl.md`.

Author: AI agent draft on branch `claude/dsl-syntax-compiler-design-wGngh`, awaiting human reviewer grilling.

## Summary

The v1.0.0 surface (`01-dsl.md`) is a TypeScript-first chain DSL: every `Node<T>` operation is a method call (`a.mul(b).add(c)`), every sample-offset access is a chain (`audioIn.ch(c).at(i)`), every conditional is a 3-arg `select(cond, x, y)`. Robust and statically guaranteed, but pays a readability tax: a one-line audio formula reads as a nested method chain rather than a math expression.

This RFC proposes a thin authoring layer for end-users:

1. **File format** — `.uwk.ts` extension, ordinary TypeScript syntax. GitHub highlights as TS. TS LSP works out of the box. No SFC blocks, no custom parser.
2. **Top-level structure** — module-level declarations + a single `process(() => { ... })` ambient macro call marks the process body. The compiler wraps these into `defineProcessor(...)` at build time.
3. **Sugar surface** — five lightweight transforms applied via AST rewrite:
   - JavaScript operators on `Node<T>` (`+ - * / % == != < > <= >= ! ?:`) lower to chain primitives.
   - Index access on I/O / buffer / param (`audioIn.left[i]`, `out.left[i] = v`, `buf[idx]`, `param[i]`).
   - Bare-`state` auto-load in `Node<T>` positions (write stays explicit `.store(v)`).
   - `if` statement sugar with `Node<'bool'>` condition (3 accepted shapes).
   - `$prev` contextual keyword inside `defineSubgraph` method bodies for IIR feedback.
4. **Variable-name → `name` auto-derive** — `const cutoff = param.f32({...})` auto-injects `name: 'cutoff'` from the binding (= spec already requires a name per Q76; the compiler fills it in). Same for `audioInput`, `audioOutput`, `event`, `message`, `midiInput`, `midiOutput`. For name-optional helpers (`state` / `buffer` / `instantiate`), the `.named()` / `.expose({})` marker preserves the plain vs named distinction.
5. **Ambient default I/O** — when no `audioInput` / `audioOutput` is declared, default stereo `input` / `out` bindings are visible in `<process>`. Explicit declaration overrides via TS shadowing.
6. **Pipe composition** — `.pipe(f)` method on `Node<T>` + `pipe(x, ...fs)` free function. Pure TS, no parser extension, improves chain readability for user-defined L1 helpers.

The proposal is **strictly additive**: every `.uwk.ts` file lowers to a `defineProcessor(...)` value identical in semantics to a hand-written `.ts` file. No new graph node, no new WASM opcode, no change to `00-foundations.md` §5 realtime-safety invariants. Tier A `.ts` chain DSL stays the library-author surface; Tier B / C `.uwk.ts` is the app-author / live-coding surface.

## Motivation

### Pain in the v1.0.0 chain DSL

Three sites from `12-canonical-examples.md` show where the chain DSL accumulates ceremony around real DSP math:

**Ex 2 — Audio EQ Cookbook peaking coefficients (`12-canonical-examples.md` §2):**

```typescript
const b0Raw = add(1, alpha.mul(A));
const b1Raw = cosw0.mul(-2);
const b2Raw = sub(1, alpha.mul(A));
const inv = div(1, add(1, alpha.div(A)));
```

The math is `1 + α·A`, `-2·cos(ω0)`, `1 - α·A`, `1 / (1 + α/A)`. The chain form reads bottom-up; the textbook reads top-down.

**Ex 4 — Lookahead limiter inner loop (`12-canonical-examples.md` §4):**

```typescript
const gr = select(e.gt(ceilingLin), ceilingLin.div(e), 1);
const wIdx = headBlock.add(i).mod(LOOKAHEAD_SAMPLES);
out.left.at(i).write(dlyL.read(wIdx).mul(gr));
```

`e > ceilingLin ? ceilingLin / e : 1`, `(headBlock + i) % LOOKAHEAD_SAMPLES`, `out.left[i] = dlyL[wIdx] * gr` would each fit textbook notation.

**Ex 5 — Granular sampler voice pitch advance (`12-canonical-examples.md` §5):**

```typescript
voicePos[v].store(
  select(
    gate,
    pos.add(
      pitch.at(i).mul(
        f32(activeNote.load().sub(60))
          .mul(Math.LN2 / 12)
          .exp(),
      ),
    ),
    pos,
  ),
);
```

The math is `if gate: voicePos[v] = pos + pitch[i] · exp((activeNote − 60) · ln2/12)`. The chain form expands to 11 lines.

### `name` repetition tax

Almost every declaration that needs main-thread visibility, snapshot inclusion, or AudioParam identity also requires a `name` string that **matches the variable binding**:

```typescript
const cutoff = param.f32({...}).named('cutoff');           // 'cutoff' twice
const meterL = state.f32(0).expose({ name: 'meterL', ... });  // 'meterL' twice
const noteIn = midiInput({ name: 'noteIn' });              // 'noteIn' twice
const uploadIR = message<...>({ name: 'uploadIR' });       // 'uploadIR' twice
```

Across canonical Ex 1-10, this duplication accounts for 60-70% of all `name:` literals. Every rename requires editing two places.

### Mental-model cost separate from readability

`defineProcessor((ctx) => { ... return { process: () => {...} } })` packs two phase boundaries into one anonymous-function nesting. The boundary is the `return { process:` line. New users, live coders, and REPL users pay this cost on every file even though the meta-program model itself isn't complex.

### What this RFC does **not** try to solve

- The static graph guarantee (`00-foundations.md` §3 "Process body" + §5 realtime-safety invariants). Keep all of it.
- The two-phase model (declaration scope vs expression scope). Keep it; make the boundary visible at module top level instead of inside lambda nesting.
- The chain DSL itself. Keep it as the lowering target so existing `.ts` library code keeps compiling.

## Goals

1. **Authoring-layer-only change.** No new graph node, no new WASM opcode, no new runtime contract. Every `.uwk.ts` file lowers to a `.ts`-equivalent `defineProcessor(...)` value.
2. **Math reads as math.** Audio EQ Cookbook formulas, biquad direct-form-II equations, envelope-follower one-liners all read as infix arithmetic, not as method chains.
3. **`name` ceremony falls away.** Variable-name → `name` auto-derive removes the duplication for the common case; explicit `.named('X')` is still available for override.
4. **GitHub readability works on day one.** The file is parsed as TypeScript by Linguist; no Linguist registration required.
5. **TS LSP works in any editor with zero setup.** No custom parser, no language server plugin required for basic editor support; Volar.js / unworklet-specific plugin only adds optional refinements.
6. **Live coding / REPL fit.** The minimal `.uwk.ts` file is a `process()` macro call. A REPL cell = one `.uwk.ts` file.
7. **Graduation path.** Library authors stay on Tier A `.ts`. App authors use Tier B `.uwk.ts`. Live coders use Tier C `.uwk.ts` with ambient defaults. All three coexist at the module boundary.
8. **Q22-a-compatible.** Q22-a rejected `Node<T>` operator overloading via runtime dispatch (`Symbol.toPrimitive`) and via type-system magic. This RFC introduces compile-time **source-level** rewriting on `.uwk.ts` files only; Tier A `.ts` files are untouched and operators still error there. The mechanism is the same kind of build-time transform Vue 3 / Svelte 5 / Astro use for their compiler magic.

## Non-Goals

1. **Not a new compiler backend.** WASM emission stays in `@unworklet/core` (`03-compiler.md` §4). `.uwk.ts` files reach the emission stage as identical `CapturedGraph` values to `.ts` files.
2. **Not a new mental model.** Declaration scope / expression scope / `forSample` / handler drain — all unchanged.
3. **Not a runtime cost.** `.uwk.ts` → lowered `.ts` is a build-time AST transform; the audio thread sees the same WASM.
4. **Not a Faust replacement.** Faust's block-diagram algebra (`:`, `~`, `<:`, `:>`) is intentionally out of scope (`00-foundations.md` §2 non-goals).
5. **Not a temporal-recursion DSL.** mimium's `@time` scheduling is out of scope; the per-block / per-sample lexical model stays the only time axis.
6. **Not SFC.** An earlier draft of this RFC explored Vue-style block syntax (`<setup>` / `<process>`); rejected — see §"Alternatives considered" A1.

## File format: `.uwk.ts`

A processor source file is named `<name>.uwk.ts`. The double extension is intentional.

### Why `.uwk.ts` and not plain `.ts`

- **Cheap detection.** The Vite plugin globs for `**/*.uwk.ts` to identify processor sources. Plain `.ts` would force scanning every file in the repo to identify the few that contain `process(...)` calls.
- **Tooling boundary.** Editors, linters, and other tools see the `.uwk.ts` suffix and apply unworklet-specific rules (ambient declarations, sugar lowering) only to those files. Regular `.ts` files are unaffected.
- **GitHub Linguist compatibility.** Linguist picks the longest extension match; `.uwk.ts` is recognized as TypeScript and highlights perfectly. No new language registration needed.
- **TS LSP works directly.** A `.uwk.ts` file is syntactically TypeScript — the TS language server highlights, type-checks, and refactors it without any plugin. Volar.js / unworklet-lang plugins add refinements (auto-derive name hints, `$prev` recognition) on top.
- **Convention precedent.** Double extensions are well-established in the TS ecosystem: `.test.ts`, `.spec.ts`, `.d.ts`, `.config.ts`, `.story.ts`. `.uwk.ts` fits the same pattern.

### Why not `.uwk` alone

GitHub Linguist would render `.uwk` as plain text until/unless the language is registered (= 200+ unique users threshold, slow process). Editors would need custom syntax-highlighting extensions per editor. The `.uwk.ts` form avoids both costs immediately.

### Why not `'use unworklet'` directive on regular `.ts` files

Directives (= React's `'use client'`, `'use server'` pattern) would force the Vite plugin to read every `.ts` file's first line to determine if it's a processor. Cheap per file but I/O-heavy across a large monorepo. The extension-based check is faster and more discoverable.

A `'use unworklet/strict'` directive **inside `.uwk.ts` files** is reserved as a future opt-out for ambient default I/O (= explicit declaration required, see §"Open Questions" O3). Not part of v1.1.0 first cut.

## Three authoring tiers

A `.uwk.ts` file resolves to a `CompiledProcessor<C>` value identical in shape to a `defineProcessor(...)` return value. Three tiers describe **how much sugar** the author opts into; all three coexist and interoperate at the module boundary.

| Tier  | Format    | Wrap                                       | Imports   | Sugar                                                                                   | Default I/O                                          |
| ----- | --------- | ------------------------------------------ | --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **A** | `.ts`     | explicit `defineProcessor((ctx) => {...})` | explicit  | chain DSL (`a.mul(b)`, `select(c,x,y)`)                                                 | explicit                                             |
| **B** | `.uwk.ts` | `process(() => {...})` macro               | ambient   | infix operators + index access + ternary + `$prev` + auto-name + `if`-sugar + `.pipe()` | explicit `audioInput` / `audioOutput` declarations   |
| **C** | `.uwk.ts` | same as B                                  | same as B | same as B                                                                               | ambient `input` / `out` available; user can override |

Tier C is not a separate file format — it's "Tier B without an `audioInput` / `audioOutput` declaration". The compiler detects the absence and injects ambient defaults at the lowered virtual module's top.

### Graduation path

- Start in Tier C: write a `process(...)` macro call, no I/O declarations needed.
- As the processor grows, declare named state / params (= still Tier C if `audioInput` / `audioOutput` defaults are accepted).
- When custom I/O channel counts are needed, declare `audioInput` / `audioOutput` explicitly (= moves to Tier B).
- When publishing to npm, transcribe to Tier A `.ts` for the canonical library shape.

Tier A → B → C is **strictly opt-in sugar**; B → A is mechanical desugaring (= the Vite plugin can emit the lowered `.ts` for inspection or for an "eject" workflow).

### Interoperability

A Tier B `.uwk.ts` file can `import` Tier A `.ts` modules (= L1 helpers, `defineSubgraph` values published as a library). The TS LSP resolves the imported types normally; the lowering layer doesn't intervene.

A Tier A `.ts` file **cannot** import from a `.uwk.ts` source file directly — `.uwk.ts` is a processor file that resolves to a `?worklet` URL via the Vite plugin, not a regular module. (Future: `eject` flow that emits a Tier A `.ts` from a Tier B `.uwk.ts` for npm publishing.)

## Surface — what's new

Each transform is described as a 1:1 lowering from `.uwk.ts` source to existing chain-DSL constructs. No new semantics enter.

### S1. Arithmetic operators on `Node<T>`

```text
a + b       ⇒  add(a, b)        ⇔  a.add(b)
a - b       ⇒  sub(a, b)
a * b       ⇒  mul(a, b)
a / b       ⇒  div(a, b)
a % b       ⇒  mod(a, b)
-a          ⇒  neg(a)
```

**Dispatch rule:** operator lowers to the primitive call **iff at least one operand has a TypeScript type that is or extends `Node<T>`**. Two `number` operands stay as build-time JavaScript arithmetic (unchanged).

Literal lift (Q33 + Q36-a) already handles `Node<T> op literal` and `literal op Node<T>` — `(1 - mix)` lifts `1` to `Node<'f32'>` via the surrounding `mix: Node<'f32'>`. No new lift rule.

### S2. Comparison operators

```text
a == b      ⇒  eq(a, b)
a != b      ⇒  not(eq(a, b))
a <  b      ⇒  lt(a, b)
a <= b      ⇒  lte(a, b)
a >  b      ⇒  gt(a, b)
a >= b      ⇒  gte(a, b)
```

Return type: `Node<'bool'>`. Same dispatch rule as S1.

### S3. Logical `!` operator + new `not(b)` primitive

A new primitive is added to `01-dsl.md` §2.1:

```typescript
not(b: Node<'bool'>): Node<'bool'>
```

Method form per Q77 hybrid policy: `b.not()` on `Node<'bool'>` is equivalent to `not(b)`.

Sugar:

```text
!b          ⇒  not(b)            where b: Node<'bool'>
```

**WASM emit:** `Node<'bool'>` is internally `i32` (= 0 / 1, per `01-dsl.md` §3.1). `not` lowers to a single `i32.eqz` WASM instruction (= "equals zero"; 1-cycle, no branch).

**Q-ratify required.** Recorded as part of this RFC (new primitive listing in `01-dsl.md` §2.1).

Logical `&&` / `||` are deferred to v1.2.0 (= no eager-evaluation use case has appeared yet; `if`-sugar covers most short-circuit needs). See §"Alternatives considered" A4.

### S4. Ternary on `Node<'bool'>`

```text
cond ? x : y   ⇒  select(cond, x, y)
```

Dispatch: lowering applies iff `cond` is `Node<'bool'>`. JS `boolean` ternary remains build-time. The free-function `select(cond, x, y)` form stays in scope and is used at chain starts and inside complex expressions per the v1.0.0 Q77 hybrid policy.

### S5. Index access for I/O / buffer / param

```text
audioIn.ch(c).at(i)              ⇒  audioIn.ch(c)[i]              // read
audioIn.left.at(i)               ⇒  audioIn.left[i]               // stereo sugar read
audioOut.ch(c).at(i).write(v)    ⇒  audioOut.ch(c)[i] = v         // write
audioOut.left.at(i).write(v)     ⇒  audioOut.left[i] = v          // stereo sugar write
param.at(i)                      ⇒  param[i]
buf.read(idx)                    ⇒  buf[idx]
buf.write(idx, v)                ⇒  buf[idx] = v
```

The intermediate types `InputChannelView<T>` / `OutputChannelView<T>` / `OutputChannelSample<T>` (`01-dsl.md` §1.6.1) gain TypeScript index-signature shapes in the virtual `.ts` so `[i]` / `[i] = v` type-check correctly.

Non-index methods (`.readInterpolated(pos)` / `.copyFrom(src)` / `.loadVec(offset)` / `.storeVec(offset, v)`) stay as method calls — they have no natural index-form lowering.

### S6. Bare `state` auto-load

```text
state                            ⇒  state.load()       // in Node<T> expression context
state.store(v)                   ⇒  state.store(v)     // unchanged — no write sugar
```

**Lowering rule (type-directed):**

- A `State<T>` reference used in a `Node<T>`-typed position auto-lowers to `state.load()`.
- A `State<T>` reference passed to a parameter typed `State<T>` (= L1 helper / subgraph instance call) stays a reference, **no** lowering. TypeScript's contextual typing disambiguates.

**Write stays explicit** as `state.store(v)`. A custom `<-` / `:=` write operator was considered and rejected (= adds parser complexity for a write site that's already short; see §"Alternatives considered" A2).

`state.load()` chain form **remains available** as a fallback for cases where the author prefers explicit form.

### S7. `if` statement sugar (3 accepted shapes)

Inside `process()` body and subgraph method bodies, an `if` statement with a `Node<'bool'>` condition lowers to a `select` / `emitIf` form. Three body shapes are accepted:

**Shape 1 — single state / buffer write, no else:**

```typescript
if (cond) state.store(v);
// ⇒  state.store(select(cond, v, state.load()))

if (cond) buf[idx] = v;
// ⇒  buf.write(idx, select(cond, v, buf.read(idx)))
```

**Shape 2 — symmetric if-else writing the same target:**

```typescript
if (cond) state.store(a);
else state.store(b);
// ⇒  state.store(select(cond, a, b))

if (cond) buf[idx] = a;
else buf[idx] = b;
// ⇒  buf.write(idx, select(cond, a, b))

if (cond) out.left[i] = a;
else out.left[i] = b;
// ⇒  out.left.at(i).write(select(cond, a, b))
```

**Shape 3 — guarded emit (no else):**

```typescript
if (cond) port.emit({ atSample: i, level: v });
// ⇒  port.emitIf(cond, { atSample: i, level: v })

if (cond) {
  arpOut.emit({ type: "noteOn", atSample: i, note, velocity, channel: 0 });
  stepFired.emit({ atSample: i, step: nextStep, note });
}
// ⇒  arpOut.emitIf  (cond, { ... });
//    stepFired.emitIf(cond, { ... });
```

The compiler exposes an `.emit(payload)` method on `EventDecl<T>` / `MidiOutputHandle` that exists **only inside a sugar-applicable `if`** — calling `.emit(...)` outside such an `if` is a graph-capture-time error pointing the author at `.emitIf(cond, payload)`. (Same enforcement layer as Q32-c constant-truthy-emitIf.)

**Rejected shapes** (= TS / graph-capture error with refactor hint):

- `if` with a JS `boolean` condition — stays as build-time `if` (= existing meta-program path, unchanged).
- Output write with no else — `out.left[i] = v` is write-only, has no "current value" to read. Author specifies both branches or uses ternary on the RHS.
- Asymmetric targets — `if (cond) state1.store(a); else state2.store(b);` reject. Author writes the two stores explicitly.
- Multi-statement bodies mixing emit / store / write — reject.
- `if` body containing declarations or `forSample` calls — same as today's scope rules (`03-compiler.md` §2.6 `scope-violation`).

### S8. `$prev` keyword

A contextual identifier `$prev` inside a `defineSubgraph` method body refers to the method's **previous-call return value**. The compiler injects a `state.<T>(0)` slot in the surrounding subgraph's declaration scope, stores the method's final return value into the slot at the end of each invocation, and rewrites references to `$prev` as `slot.load()`.

The `$`-prefix follows the **Svelte 5 runes pattern** (= `$state(0)`, `$derived(x)`, `$effect(() => ...)`): visually obvious as a compiler-recognized identifier, distinct from regular variables, immediately searchable. mimium's `self` was the original inspiration; rename was needed because `AudioWorkletGlobalScope` already binds `self === globalThis`, and a magic identifier shadowing the global would create author-intuition collisions.

**Where `$prev` is in scope:**

- **Allowed:** inside the body of any `defineSubgraph` method whose declared / inferred return type is `Node<T>` for some `T`. The injected slot's type matches.
- **Rejected at graph-capture time** with refactor hint:
  - Inside L1 helper bodies (= no caller-owned state).
  - Inside `defineProcessor` `process(...)` body top-level (= no method-return-value semantics).
  - Inside handler bodies (`onReceive`, `onEvent` — handlers do not return values).
  - Inside `forSample` callbacks at the processor level (same reason).
  - Inside subgraph methods whose return type is `void`.

**Multi-method subgraphs** — each method gets its own `$prev` slot, slots are independent:

```typescript
const stereoOnepole = defineSubgraph((coef: Node<"f32">) => ({
  processL: (input: Node<"f32">) => coef * input + (1 - coef) * $prev, // slot A
  processR: (input: Node<"f32">) => coef * input + (1 - coef) * $prev, // slot B (distinct)
}));
```

**Custom initial value, named slot for snapshot** — `$prev` defaults to `0` initial and worklet-private (no snapshot entry). For custom init or snapshot inclusion, fall back to explicit form:

```typescript
const onepole = defineSubgraph((coef: Node<"f32">) => {
  const y = state.f32(0.5).named(); // auto-named 'y', snapshot-included
  return {
    process: (input: Node<"f32">) => coef * input + (1 - coef) * y,
  };
});
```

**Precision inference** at generic call sites — for `defineSubgraph(<P extends 'f32' | 'f64'>(coef: Node<P>) => ({ process: (input: Node<P>) => ... }))`, `$prev` is `Node<P>` and the injected slot is `state.<P>(0)`. The slot factory uses the concrete `P` resolved at `instantiate(...)` time. See §"Open Questions" O5.

### S9. Variable-name → `name` auto-derive

A module-top-level `const X = ...` declaration whose RHS is a unworklet declaration helper auto-injects `name: 'X'` (or `.named('X')` for chain-method-named helpers) when the name slot is unfilled. The trigger condition differs between helpers whose `name` is **required** by the v1.0.0 spec and helpers where it's **optional** (= plain vs named distinction).

**Name-required helpers — auto-derive triggers when no `name` is provided.** No explicit marker needed; absence of name in the source IS the trigger. Per `01-dsl.md` + Q76, these helpers reject anonymous declarations at the TS level today; auto-derive fills in the binding name to satisfy the spec.

| Declaration                                                            | Injection                          |
| ---------------------------------------------------------------------- | ---------------------------------- |
| `const X = audioInput({...})` (no `name` field)                        | inject `name: 'X'` into options    |
| `const X = audioOutput({...})` (no `name` field)                       | inject `name: 'X'` into options    |
| `const X = param.<T>({...})` (no `.named()` / `.expose({name})` chain) | inject `.named('X')` at chain tail |
| `const X = event<T>({...})` (no `name` field)                          | inject `name: 'X'` into options    |
| `const X = event<T>()` (no options)                                    | emit `event<T>({ name: 'X' })`     |
| `const X = message<T>({...})` (no `name` field)                        | inject `name: 'X'` into options    |
| `const X = midiInput({...?})` (no `name` field)                        | inject `name: 'X'` into options    |
| `const X = midiOutput({...?})` (no `name` field)                       | inject `name: 'X'` into options    |

**Name-optional helpers — auto-derive triggers when an explicit "name me" marker is present but unfilled.** The marker preserves the plain-vs-named distinction: plain stays worklet-private, `.named()` no-arg or `.expose({...without name})` switches to named with auto-derived identity.

| Declaration                                                  | Effect                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `const X = state.<T>(init)` (no chain)                       | **plain** — worklet-private, no snapshot, no main-side identity (unchanged from v1.0.0) |
| `const X = state.<T>(init).named()` (no-arg)                 | named — inject `'X'` as argument                                                        |
| `const X = state.<T>(init).expose({...without name...})`     | named — inject `name: 'X'` into expose options                                          |
| `const X = buffer.<T>({...})` (no chain)                     | **plain** — worklet-private (unchanged)                                                 |
| `const X = buffer.<T>({...}).named()`                        | named — inject `'X'`                                                                    |
| `const X = buffer.<T>({...}).expose({...without name...})`   | named — inject `name: 'X'`                                                              |
| `const X = instantiate(decl, ...args)` (no options arg)      | inject `, { name: 'X' }`                                                                |
| `const X = instantiate(decl, ...args, {...without name...})` | inject `name: 'X'` into options                                                         |

**API addition needed for name-optional helpers:** `.named()` no-arg overload added to `01-dsl.md` §3 State / Buffer chain — see §"Open Questions" O2.

**Override path** — explicit `.named('Y')` or `name: 'Y'` always wins:

```typescript
const cutoffParam = param.f32({...}).named('cutoff');
//    ^ variable used internally,            ^ external name fixed for migration stability
```

**Restrictions:**

- LHS must be a plain `Identifier` (not destructure, not computed property).
- RHS chain must be syntactically a declaration helper at the outermost level (= `const x = foo(bar(...))` where `bar(...)` is the helper doesn't qualify — the outermost expression is what's auto-decorated).
- Auto-derive applies only to module top-level declarations. Inside subgraph bodies, the same rule applies at the subgraph's declaration-scope top-level.

**Persistent slot rename caveat** — auto-derived names match the variable binding. Renaming a binding renames the slot, which changes the snapshot schema hash. The Vite plugin emits a build-time warning when the current schema hash is unreachable from the existing `migrations` chain (= same Q5-e `migrations-unreachable` warning that already exists). For high-stakes persistent slots, authors should write explicit `.named('Y')` to lock the name across renames.

### S10. `.pipe(f)` method + `pipe(x, ...fs)` free function

Two additions to the chain DSL that improve readability of L1 helper composition. Strictly speaking these are **orthogonal** to the new tier — they also benefit Tier A `.ts` chain code — but they're included in this RFC because they target the same "audio code should read as audio flow" theme.

**Method form on `Node<T>`** (declaration merging into `01-dsl.md` §2):

```typescript
interface Node<T> {
  pipe<U>(fn: (x: Node<T>) => Node<U>): Node<U>;
}
```

**Free function** (additional ambient in `.uwk.ts`, exported from `@unworklet/core` for Tier A):

```typescript
function pipe<T0>                 (x: T0): T0;
function pipe<T0, T1>             (x: T0, f1: (x: T0) => T1): T1;
function pipe<T0, T1, T2>         (x: T0, f1: (x: T0) => T1, f2: (x: T1) => T2): T2;
function pipe<T0, T1, T2, T3>     (x: T0, f1: (x: T0) => T1, f2: (x: T1) => T2, f3: (x: T2) => T3): T3;
function pipe<T0, T1, T2, T3, T4> (...): T4;
function pipe<T0, T1, T2, T3, T4, T5> (...): T5;
// up to 7-8 overloads
```

**Usage:**

```typescript
// method chain — extends naturally from chain DSL
const out = audioIn.left[i]
  .abs()
  .pipe(softclip) // L1 helper
  .mul(postGain)
  .pipe(dcBlocker); // L1 helper

// free function — reads as left-to-right composition
const env = pipe(audioIn.left[i], abs, tanh, softclip);
```

Both forms are pure TypeScript — no parser extension, full type-safety via standard inference, immediate IDE support.

**Why not the TC39 `|>` operator** — see §"Alternatives considered" A3. Briefly: TC39 hasn't settled F# vs Hack variants, TS doesn't ship native support, edit-time experience requires a parser plugin that introduces transient red squiggles. `.pipe()` / `pipe()` cover the 95% case in native TS.

### S11. `process(() => {...})` macro + module-level declarations

The structural shape of a `.uwk.ts` file:

```typescript
// stereoGain.uwk.ts

// === module-level declaration scope ===
// All declaration helpers + L1 helper definitions + build-time constants
const gain = param.f32({ default: 1, min: 0, max: 4 });

// === process body ===
process(() => {
  // forSample, handler registrations, per-block code
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
  });
});

// === optional ===
migrations([
  // ... Migration[] entries
]);

options({ migrationsStrict: true });
```

The compiler:

1. Scans top-level statements in source order.
2. Splits into 4 groups by call shape: declarations (= helper calls), L1 helper / class definitions, the single `process(...)` call (= process body), the optional `migrations(...)` / `options(...)` calls.
3. Generates a virtual lowered `.ts` module:

```typescript
import { defineProcessor, /* etc */ } from '@unworklet/core';

export default defineProcessor((ctx) => {
  // ... all declarations + helper defs in source order
  return {
    process: () => {
      // ... the process() callback body
    },
  };
}, {
  migrations: [...],
  ...optionsObject,
});
```

4. The lowered module is fed to the existing `compile()` pipeline (`03-compiler.md` §1).

**`process` clash with Node.js global** — `process` is a Node.js global (`process.env`, `process.argv`). Inside `.uwk.ts`, the ambient `process(...)` macro shadows the Node global; outside `.uwk.ts`, Node's `process` is untouched. If a `.uwk.ts` file genuinely needs Node's `process` (= unlikely, since it's a worklet source), the author writes `globalThis.process` to reach it explicitly.

**Exactly-one `process(...)` rule** — a `.uwk.ts` file must contain exactly one top-level `process(...)` call. Zero is an error (= no process body); more than one is an error (= ambiguous, which one is the entry?).

### S12. Ambient default I/O (Tier C)

When a `.uwk.ts` file's top-level declarations contain no `audioInput(...)` call, the compiler injects:

```typescript
const input = audioInput({ channels: 2, name: "main" });
```

Same for `audioOutput`. (Note: `'main'` matches the canonical Ex 1 convention; see §"Open Questions" O4 for grilling on whether `'input'` / `'out'` derived names would be more consistent with S9 auto-derive.)

**Override path** — declaring `const input = audioInput({...})` explicitly suppresses the ambient injection. TypeScript's standard shadowing handles the rest:

```typescript
const input = audioInput({ channels: 1 }); // mono — auto-derived name 'input'
// ambient stereo `input` not injected

process(() => {
  forSample((i) => {
    out.ch(0)[i] = input.ch(0)[i] * 0.5; // typed as mono, .left would be TS error
  });
});
```

**TS LSP support** — the `.uwk.ts` ambient `.d.ts` declares:

```typescript
declare const input: AudioInputHandle<2>;
declare const out: AudioOutputHandle<2>;
```

These are visible when no `const input` / `const out` is in scope. When the user shadows them with a `const`, TS narrows the type to the user's declaration.

**Tier C limits** — ambient defaults cover the single most common case (stereo in / stereo out). Multi-port, sidechain, multi-bus processors require explicit declarations.

## Capture mechanics

The Vite plugin (`@unworklet/unplugin`) gains a `.uwk.ts` loader that transforms the file via AST passes and routes the result through the existing `compile()` invocation pipeline (`07-unplugin.md` §2).

### Lowering pipeline

```
.uwk.ts source
  ↓ TypeScript parser (= standard `@typescript-eslint/parser` or `oxc-parser`)
TypeScript AST
  ↓ Pass 1: operator pass (S1, S2, S3, S4)
  │   visit BinaryExpression / UnaryExpression / ConditionalExpression
  │   when an operand's type is or extends Node<T>, rewrite to primitive call
  ↓ Pass 2: index access pass (S5)
  │   visit ElementAccessExpression + AssignmentExpression with index LHS
  │   when object type is InputChannelView / OutputChannelView / Buffer / Param,
  │   rewrite to .at(i) / .write(v) / .read(idx) / .write(idx, v)
  ↓ Pass 3: bare state pass (S6)
  │   visit Identifier with State<T> type used in Node<T> position
  │   rewrite to <id>.load()
  ↓ Pass 4: if-sugar pass (S7)
  │   visit IfStatement with Node<'bool'> cond, match against 3 accepted shapes,
  │   rewrite or emit refactor-hint error
  ↓ Pass 5: $prev pass (S8)
  │   walk defineSubgraph method bodies, inject state slot per method that uses
  │   $prev, rewrite reads and end-of-body store
  ↓ Pass 6: auto-name pass (S9)
  │   visit module-top-level VariableDeclaration, inject name based on binding
  ↓ Pass 7: ambient injection pass (S12)
  │   if no audioInput / audioOutput declared, prepend ambient defaults
  ↓ Pass 8: wrap pass (S11)
  │   group top-level statements into defineProcessor(...) shape
  ↓ TypeScript codegen
virtual lowered .ts module
  ↓ existing compile() pipeline (= 03-compiler.md §1)
WASM binary
```

Each pass is independent — testable in isolation, composes by AST traversal order. Type information for the operator dispatch comes from the TypeScript Compiler API (= `typescript` package's `TypeChecker`) used as a one-shot type query at build time.

### Source maps

Two-stage chain:

```
.uwk.ts source position
  ↓ (AST rewrite passes 1-8 preserve original-position annotations)
virtual lowered .ts position
  ↓ (existing 03-compiler.md §7 source-map pipeline)
AST DAG node
  ↓ (binaryen WASM emit)
.wasm position
```

Each stage composes via standard `sourcemap-codec` / `magic-string` utilities. Error messages from any layer project back to the original `.uwk.ts` position; the IDE shows squiggles at the author's actual source.

### IDE support

**Baseline (= zero setup):** any editor with TypeScript LSP highlights `.uwk.ts` as TypeScript, type-checks against the ambient `.d.ts` for `audioInput` / `state` / `process` / etc., and supports refactor / rename / go-to-def. Operator sugar appears as type errors at edit time (= "operator '+' cannot be applied to Node<'f32'> and Node<'f32'>") unless the unworklet-lang LSP plugin is installed.

**With unworklet-lang plugin:** operator sugar type-checks correctly (= the plugin teaches TS that `+` on `Node<T>` returns `Node<T>`), auto-derive name is hinted in the hover, `$prev` is highlighted as a special identifier.

The plugin ships in `@unworklet/lang` (= new package, see §"Package layout"). Editors that don't load the plugin still get full file-level navigation, just with red squiggles on operator-sugared lines (= compile still succeeds; squiggles are edit-time-only).

## Examples

### Ex 1 — Stereo gain + level meter

Full canonical Ex 1 (`12-canonical-examples.md` §1) in three tiers.

**Tier A (`.ts`, chain DSL, unchanged):**

```typescript
import { defineProcessor, audioInput, audioOutput, param, state, forSample } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param
    .f32({
      default: 1.0,
      min: 0.0,
      max: 4.0,
      automationRate: "a-rate",
    })
    .named("gain");
  const meterL = state.f32(0).expose({
    name: "meterL",
    snapshot: "transient",
    publish: { rateFps: 30 },
  });
  const meterR = state.f32(0).expose({
    name: "meterR",
    snapshot: "transient",
    publish: { rateFps: 30 },
  });
  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);
        meterL.store(l.abs().max(meterL.load()));
        meterR.store(r.abs().max(meterR.load()));
      });
      meterL.store(meterL.load().mul(0.95));
      meterR.store(meterR.load().mul(0.95));
    },
  };
});
```

**Tier B (`.uwk.ts`, explicit I/O, auto-name):**

```typescript
// stereoGain.uwk.ts

const input = audioInput({ channels: 2 }); // auto-name 'input'
const out = audioOutput({ channels: 2 }); // auto-name 'out'
const gain = param.f32({
  default: 1.0,
  min: 0,
  max: 4,
  automationRate: "a-rate",
}); // auto-name 'gain' (= helper that requires a name)
const meterL = state.f32(0).expose({
  snapshot: "transient",
  publish: { rateFps: 30 },
}); // auto-name 'meterL' (= via expose)
const meterR = state.f32(0).expose({
  snapshot: "transient",
  publish: { rateFps: 30 },
}); // auto-name 'meterR'

process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    const r = input.right[i] * gain[i];
    out.left[i] = l;
    out.right[i] = r;
    meterL.store(max(abs(l), meterL));
    meterR.store(max(abs(r), meterR));
  });
  meterL.store(meterL * 0.95);
  meterR.store(meterR * 0.95);
});
```

**Tier C (`.uwk.ts`, ambient I/O):**

```typescript
// stereoGain.uwk.ts (Tier C)

const gain = param.f32({ default: 1, min: 0, max: 4 });
const meterL = state.f32(0).expose({ publish: { rateFps: 30 } });
const meterR = state.f32(0).expose({ publish: { rateFps: 30 } });

process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    const r = input.right[i] * gain[i];
    out.left[i] = l;
    out.right[i] = r;
    meterL.store(max(abs(l), meterL));
    meterR.store(max(abs(r), meterR));
  });
  meterL.store(meterL * 0.95);
  meterR.store(meterR * 0.95);
});
```

**Line count:** 30 (Tier A) → 22 (Tier B) → 17 (Tier C). The signal-processing math drops from chain to infix; `name` boilerplate drops to zero; `input` / `out` declarations drop in Tier C.

### Ex 2 — Three-band biquad EQ with `$prev` and math sugar

Excerpt — `peakingCoeffs` L1 helper + `peakingBand` subgraph.

**Tier A (chain):**

```typescript
function peakingCoeffs(freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">, sr: number) {
  const A = gainDb.mul(0.05 * Math.LN10).exp();
  const w0 = freq.mul((2 * Math.PI) / sr);
  const cosw0 = w0.cos();
  const sinw0 = w0.sin();
  const alpha = sinw0.div(q.mul(2));

  const b0Raw = add(1, alpha.mul(A));
  const b1Raw = cosw0.mul(-2);
  const b2Raw = sub(1, alpha.mul(A));
  const a0Raw = add(1, alpha.div(A));
  const a1Raw = cosw0.mul(-2);
  const a2Raw = sub(1, alpha.div(A));
  const inv = div(1, a0Raw);
  return {
    b0: b0Raw.mul(inv),
    b1: b1Raw.mul(inv),
    b2: b2Raw.mul(inv),
    a1: a1Raw.mul(inv),
    a2: a2Raw.mul(inv),
  };
}

function biquadDFIIT(
  x: Node<"f32">,
  b0: Node<"f32">,
  b1: Node<"f32">,
  b2: Node<"f32">,
  a1: Node<"f32">,
  a2: Node<"f32">,
  z1: State<"f32">,
  z2: State<"f32">,
) {
  const y = b0.mul(x).add(z1.load());
  const z1n = b1.mul(x).add(z2.load()).sub(a1.mul(y));
  const z2n = b2.mul(x).sub(a2.mul(y));
  z1.store(z1n);
  z2.store(z2n);
  return y;
}

const peakingBand = defineSubgraph((sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (input, freq, q, gainDb) => {
      const c = peakingCoeffs(freq, q, gainDb, sr);
      return biquadDFIIT(input, c.b0, c.b1, c.b2, c.a1, c.a2, z1, z2);
    },
  };
});
```

**Tier B (`.uwk.ts`):**

```typescript
function peakingCoeffs(freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">, sr: number) {
  const A = exp(gainDb * (0.05 * Math.LN10));
  const w0 = freq * ((2 * Math.PI) / sr);
  const cosw0 = cos(w0);
  const alpha = sin(w0) / (q * 2);
  const inv = 1 / (1 + alpha / A);
  return {
    b0: (1 + alpha * A) * inv,
    b1: -2 * cosw0 * inv,
    b2: (1 - alpha * A) * inv,
    a1: -2 * cosw0 * inv,
    a2: (1 - alpha / A) * inv,
  };
}

function biquadDFIIT(
  x: Node<"f32">,
  b0: Node<"f32">,
  b1: Node<"f32">,
  b2: Node<"f32">,
  a1: Node<"f32">,
  a2: Node<"f32">,
  z1: State<"f32">,
  z2: State<"f32">,
) {
  const y = b0 * x + z1;
  z1.store(b1 * x + z2 - a1 * y);
  z2.store(b2 * x - a2 * y);
  return y;
}

const peakingBand = defineSubgraph((sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (input, freq, q, gainDb) => {
      const c = peakingCoeffs(freq, q, gainDb, sr);
      return biquadDFIIT(input, c.b0, c.b1, c.b2, c.a1, c.a2, z1, z2);
    },
  };
});
```

`peakingCoeffs` reads as the Audio EQ Cookbook formula. `biquadDFIIT` reads as the Direct Form II Transposed update equations; only the writes are explicit (`.store(...)`).

**Trivial one-pole with `$prev`:**

```typescript
const onepole = defineSubgraph((coef: Node<"f32">) => ({
  process: (input: Node<"f32">) => coef * input + (1 - coef) * $prev,
}));
```

9-line declaration drops to 3 lines. `$prev` injects an unnamed `state.f32(0)` slot and a post-return store.

### Ex 4 — Lookahead limiter (ternary, if-sugar, pipe)

Inner forSample loop and the `envelopeFollow` helper.

**Tier A:**

```typescript
function envelopeFollow(
  x: Node<"f32">,
  attackCoef: Node<"f32">,
  releaseCoef: Node<"f32">,
  prev: State<"f32">,
): Node<"f32"> {
  const r = x.abs();
  const coef = select(r.gt(prev.load()), attackCoef, releaseCoef);
  const y = r.sub(prev.load()).mul(coef).add(prev.load());
  prev.store(y);
  return y;
}

// ... declarations ...

return {
  process: () => {
    const ceilingLin = ceiling
      .at(0)
      .mul(Math.LN10 * 0.05)
      .exp();
    const releaseSamples = releaseMs.at(0).mul(ctx.sampleRate / 1000);
    const releaseCoef = sub(1, div(-1, releaseSamples).exp());
    const attackCoef = 1.0;
    const headBlock = dlyHead.load();

    forSample((i) => {
      const peak = input.left.at(i).abs().max(input.right.at(i).abs());
      const e = envelopeFollow(peak, attackCoef, releaseCoef, env);
      const gr = select(e.gt(ceilingLin), ceilingLin.div(e), 1);
      const grDb20 = gr.log().mul(20 / Math.LN10);

      const wIdx = headBlock.add(i).mod(LOOKAHEAD_SAMPLES);
      dlyL.write(wIdx, input.left.at(i));
      dlyR.write(wIdx, input.right.at(i));

      const rIdx = wIdx.add(1).mod(LOOKAHEAD_SAMPLES);
      out.left.at(i).write(dlyL.read(rIdx).mul(gr));
      out.right.at(i).write(dlyR.read(rIdx).mul(gr));

      overshoot.emitIf(input.left.at(i).abs().gt(ceilingLin), {
        atSample: i,
        channel: 0,
        level: input.left.at(i).abs(),
      });
      overshoot.emitIf(input.right.at(i).abs().gt(ceilingLin), {
        atSample: i,
        channel: 1,
        level: input.right.at(i).abs(),
      });

      gainReductionDb.store(gainReductionDb.load().min(grDb20));
    });

    dlyHead.store(headBlock.add(SAMPLES_PER_BLOCK).mod(LOOKAHEAD_SAMPLES));
    gainReductionDb.store(gainReductionDb.load().mul(0.85));
  },
};
```

**Tier B (`.uwk.ts`):**

```typescript
function envelopeFollow(
  x: Node<"f32">,
  attackCoef: Node<"f32">,
  releaseCoef: Node<"f32">,
  prev: State<"f32">,
): Node<"f32"> {
  const r = abs(x);
  const coef = r > prev ? attackCoef : releaseCoef;
  const y = (r - prev) * coef + prev;
  prev.store(y);
  return y;
}

// ... declarations with auto-name ...

process(() => {
  const ceilingLin = exp(ceiling[0] * (Math.LN10 * 0.05));
  const releaseSamples = releaseMs[0] * (ctx.sampleRate / 1000);
  const releaseCoef = 1 - exp(-1 / releaseSamples);
  const attackCoef = 1.0;
  const headBlock = dlyHead;

  forSample((i) => {
    const peak = max(abs(input.left[i]), abs(input.right[i]));
    const e = envelopeFollow(peak, attackCoef, releaseCoef, env);
    const gr = e > ceilingLin ? ceilingLin / e : 1;
    const grDb20 = log(gr) * (20 / Math.LN10);

    const wIdx = (headBlock + i) % LOOKAHEAD_SAMPLES;
    dlyL[wIdx] = input.left[i];
    dlyR[wIdx] = input.right[i];

    const rIdx = (wIdx + 1) % LOOKAHEAD_SAMPLES;
    out.left[i] = dlyL[rIdx] * gr;
    out.right[i] = dlyR[rIdx] * gr;

    if (abs(input.left[i]) > ceilingLin)
      overshoot.emit({ atSample: i, channel: 0, level: abs(input.left[i]) });
    if (abs(input.right[i]) > ceilingLin)
      overshoot.emit({ atSample: i, channel: 1, level: abs(input.right[i]) });

    gainReductionDb.store(min(gainReductionDb, grDb20));
  });

  dlyHead.store((headBlock + SAMPLES_PER_BLOCK) % LOOKAHEAD_SAMPLES);
  gainReductionDb.store(gainReductionDb * 0.85);
});
```

Every line reads as the limiter's textbook design. The two `overshoot.emit` lines collapse from 6 lines (chain) to 2 lines (if-sugar). The envelope-follower coefficient line `1 - exp(-1 / releaseSamples)` reads as the analog response formula.

**Pipe variant** — if `envelopeFollow` had a single-input shape, the inner loop opening could read as a pipeline:

```typescript
const env = pipe(audioIn.left[i], abs, (x) => envelopeFollow(x, attackCoef, releaseCoef, env));
// or
const env = audioIn.left[i].abs().pipe((x) => envelopeFollow(x, attackCoef, releaseCoef, env));
```

### Ex 5 — Granular sampler voice pitch advance

**Tier A — 16 lines for one statement:**

```typescript
voicePos[v].store(
  select(
    gate,
    pos.add(
      pitch.at(i).mul(
        f32(activeNote.load().sub(60))
          .mul(Math.LN2 / 12)
          .exp(),
      ),
    ),
    pos,
  ),
);
```

**Tier B — 1 line via if-sugar + infix:**

```typescript
if (gate) voicePos[v].store(pos + pitch[i] * exp(f32(activeNote - 60) * (Math.LN2 / 12)));
```

Or with the else branch explicit (= no semantic change, same `select` lowering):

```typescript
voicePos[v].store(gate ? pos + pitch[i] * exp(f32(activeNote - 60) * (Math.LN2 / 12)) : pos);
```

### Ex 6 — MIDI arpeggiator (if-emit sugar)

**Tier A — 6 lines for two emits:**

```typescript
arpOut.emitIf(roll, {
  type: "noteOn",
  atSample: i,
  note: fireNote,
  velocity: lastVel.load(),
  channel: 0,
});
stepFired.emitIf(roll, { atSample: i, step: nextStep, note: fireNote });
```

**Tier B — 4 lines with if-emit sugar + bare state:**

```typescript
if (roll) {
  arpOut.emit({ type: "noteOn", atSample: i, note: fireNote, velocity: lastVel, channel: 0 });
  stepFired.emit({ atSample: i, step: nextStep, note: fireNote });
}
```

`lastVel.load()` collapses to bare `lastVel`. Two `emitIf` calls collapse into one `if` block with two `emit` calls.

### Ex 2 helper with `.pipe()` showing the full chain

**Tier A:**

```typescript
const A = gainDb.mul(0.05 * Math.LN10).exp();
const w0 = freq.mul((2 * Math.PI) / sr);
const cosw0 = w0.cos();
```

**Tier B with `.pipe()` (= when an L1 helper sits mid-chain):**

```typescript
const sat = audioIn.left[i]
  .mul(preGain)
  .pipe(softclip) // L1 helper
  .mul(postGain)
  .pipe(dcBlocker); // L1 helper
```

vs the same in chain form:

```typescript
const sat = dcBlocker(softclip(audioIn.left.at(i).mul(preGain)).mul(postGain));
```

The `.pipe()` form preserves left-to-right signal flow when user-defined L1 helpers interleave with primitive operations.

## Volar.js / TS LSP integration

### Two-layer model

**Layer 1: standard TypeScript LSP** (= zero setup)

Any editor that knows TypeScript handles `.uwk.ts` as a TS file. The `@unworklet/lang` package ships an ambient `.d.ts` file that's auto-included via TS's `types` field in `tsconfig.json`:

```typescript
// @unworklet/lang/ambient.d.ts (= included for .uwk.ts files via tsconfig path)

declare const input: AudioInputHandle<2>;
declare const out: AudioOutputHandle<2>;

declare function audioInput<C extends number>(opts: {...}): AudioInputHandle<C>;
declare function audioOutput<C extends number>(opts: {...}): AudioOutputHandle<C>;
declare const state: {...};
declare const buffer: {...};
declare const param: {...};
declare function event<T>(opts?: {...}): EventDecl<T>;
declare function message<T>(opts?: {...}): MessageDecl<T>;
declare function midiInput(opts?: {...}): MidiInputHandle;
declare function midiOutput(opts?: {...}): MidiOutputHandle;
declare function defineSubgraph<...>(...): SubgraphDecl<...>;
declare function instantiate<...>(...): ...;
declare function forSample(...): void;
declare function process(callback: () => void): void;
declare function migrations(list: Migration[]): void;
declare function options(opts: ProcessorOptions): void;
declare function select<T>(...): Node<T>;
declare function pipe(...): ...;

// math primitives, scalar constructors, build-time constants
declare function sin<T>(x: Node<T>): Node<T>;
// ... etc

declare const SAMPLES_PER_BLOCK: 128;
declare const CAPACITY_16: 16;
// ...
```

With this in place, `.uwk.ts` files type-check correctly except for the operator sugar. Operator sites show TS errors at edit time (= "operator '+' cannot be applied to ..."). These errors don't block the build — the operator pass rewrites them before TS sees the lowered module — but they're visually noisy in the editor.

**Layer 2: `@unworklet/lang` LSP plugin** (= optional, recommended)

A TS LSP plugin (= via `tsconfig.json` `plugins` field) teaches the TS server that operators on `Node<T>` are valid and return `Node<T>`. This eliminates the red squiggles at edit time. The plugin also:

- Highlights `$prev` as a special token (= different color, signaling "compiler magic").
- Shows auto-derived `name: 'X'` on hover for declarations that triggered S9.
- Provides quick-fixes for if-sugar rejected shapes ("convert to select form", "split into two emitIfs").
- Adds completion entries for the ambient set.

The plugin is `npm install`-grade; no editor-specific install. Works in VS Code, Cursor, WebStorm, Neovim, Helix — anywhere the TS LSP runs.

### Volar.js usage

Volar.js (= the meta-framework behind Vue 3.3+ / Astro / Slidev) is the recommended foundation for the LSP plugin's complex transforms (= operator type rewriting). For unworklet, Volar.js does **not** create virtual SFC files (= no SFC blocks); it provides the TS language service plugin infrastructure for the operator dispatch teaching.

### Source map fidelity

Error messages from the lowering pipeline (compile-time graph capture, static analysis, WASM emission) project back to `.uwk.ts` positions via the two-stage source-map chain. The IDE's "go to definition" / "go to error" works against the original `.uwk.ts` text.

## Compatibility with v1.0.0 spec

This RFC is **strictly additive** to the v1.0.0 surface (`10-roadmap.md` §1 acceptance criteria F1). No ratified decision is retracted.

### Q-references reaffirmed

- **Q22-a** (`Node<T>` as a structural type rejecting JS operators): the rejection was for runtime dispatch (`Symbol.toPrimitive`) and for type-system magic. This RFC introduces **build-time source-level rewriting** on `.uwk.ts` files only — a separate axis from runtime dispatch. Tier A `.ts` `Node<T>` branded type is unchanged; operators still error in Tier A. Source-level transforms are the same kind of build-time mechanism Vue 3 / Svelte 5 / Astro use for their compiler magic.
- **Q22-aprime** (process body's lexical-position phase model): preserved. The `process(() => {...})` macro is the lexical container for the process body; declarations live at module top-level above it. Top-to-bottom source order inside `process()` is preserved exactly.
- **Q22-b** (single form for sample-offset primitives): preserved. Index access (`audioIn.left[i]`) is sugar that lowers to the same single form (`.at(i)`). The "no sugar" rationale targeted runtime-distinguishable forms that hid `i`; here `i` stays visible at every call site.
- **Q22-c** (three error layers): preserved. The RFC adds L1 TypeScript-error coverage for some scope violations (= ambient-aware scope checks) that today only surface at L2 (`scope-violation`). No layer removed.
- **Q22-d** (Rust-style error template + stable IDs): preserved. New stable error IDs added by this RFC follow the same template.
- **Q33 + Q36-a** (context-dependent literal lift): preserved. Operator sugar uses the existing rule unchanged.
- **Q37** (no output coverage requirement, source-order last-write-wins): preserved.
- **Q43** (`everyNSamples` delivered as 2nd `forSample` callback arg): preserved.
- **Q49 / Q74** (variable-length payloads, sysex emit surface): preserved.
- **Q76** (named-only `param`): preserved. The spec invariant "every `param` declaration ends up with a name" is unchanged; auto-derive S9 fills the name from the variable binding before the lowered module reaches `compile()`. The TS surface in `.uwk.ts` ambient `.d.ts` types `param.<T>({...})` as a valid declaration without explicit `.named('X')` — the name is auto-injected at the AST-rewrite stage.
- **Q77** (hybrid free-function / method-call primitive forms): preserved as the Tier A surface and as the lowering target. `.pipe()` method form (S10) is a natural extension.
- **Q79** (`.named()` / `.expose()` chain order invariance): preserved. Auto-derive (S9) lands the injected `name` at whichever chain position the user has already opened with `.named()` / `.expose({...})`.

### New Q-ratify items introduced by this RFC

1. **`not(b: Node<'bool'>): Node<'bool'>`** primitive — `01-dsl.md` §2.1 addition.
2. **`Node<T>.pipe<U>(fn: (x: Node<T>) => Node<U>): Node<U>`** method — `01-dsl.md` §2 addition via declaration merging.
3. **`pipe(x, ...fs)`** free function — `@unworklet/core` export with variadic-overload typing.
4. **`@unworklet/lang` package** — `09-repo-structure.md` §2.4 addition (= new 5th public package).
5. **`.uwk.ts` file format** — `07-unplugin.md` §2 / §3 addition: the Vite plugin globs for `**/*.uwk.ts`, applies the lowering pipeline, and emits the same artifact set as `.ts` processors.
6. **`'use unworklet/strict'` directive** — reserved name; not implemented in v1.1.0 first cut. Future opt-out for ambient default I/O.

### Canonical examples integrity rule (`AGENTS.md`)

The RFC does not modify any v1.0.0 spec doc, including `12-canonical-examples.md`. Examples in this RFC are written as **proposed `.uwk.ts` equivalents** of existing canonical examples, demonstrating the lowering target — they do not enter the canonical set.

When the RFC graduates from draft to ratified, the spec change will land as a paired commit that:

1. Adds the new surface to `01-dsl.md` (or a new component doc `14-frontend.md`).
2. Updates `12-canonical-examples.md` to either dual-render each example in Tier A and Tier B, or moves Tier B to primary and demotes Tier A to an appendix. Decision deferred to ratification step.
3. Adds the relevant Q entries (Q83 family) to `decisions-log.md` recording the ratification rationale.

The integrity rule fires at that commit; this draft does not touch the canonical set.

### v1.0.0 acceptance criteria interaction

The RFC has **no impact on v1.0.0 ship**. Acceptance criteria A / B / C / D / E / F (`10-roadmap.md` §1) reference v1.0.0 surface only; the RFC's surface enters v1.1.0 at earliest. Existing Tier A `.ts` consumer code keeps compiling unchanged.

## Open questions

Items to grill before ratification. Each has a stable label so we can cross-reference during grilling without renumbering.

### O1 — Ambient default I/O port name: `'main'` vs `'input'` / `'out'`

Should the ambient default declarations use `name: 'main'` (= matching canonical Ex 1 convention) or `name: 'input'` / `name: 'out'` (= matching S9 auto-derive style)?

- **(a) `'main'`** — preserves canonical Ex 1 main-thread accessor pattern (`node.inputs.main`).
- **(b) `'input'` / `'out'`** — consistent with auto-derive: explicit `const input = audioInput({...})` produces `name: 'input'`, which matches the ambient.

Recommendation: (b). The ambient `input` / `out` names should match what the corresponding explicit declarations would produce. Canonical Ex 1 (Tier A) keeps its `'main'` name for the existing library form; new Tier B / C files use the new naming.

### O2 — `.named()` no-arg form for name-optional helpers (`state` / `buffer`)

For `state.<T>(init)` and `buffer.<T>({...})`, the plain-vs-named distinction matters (= plain is worklet-private, named enters snapshot blob and main-side `node.state.<name>` accessor). To switch from plain to named without typing the name string, we need a marker.

Should `.named()` (no arguments) be added to the `01-dsl.md` §3 State / Buffer chain API as the explicit "use my binding name" marker, or should auto-derive trigger only via `.expose({...without name...})`?

- **(a) Add `.named()` no-arg** — terse, dedicated marker for the "I want named but default policy" common case.
- **(b) Only `.expose({...})` without `name`** — fewer API surfaces, but requires `.expose({})` for the common case.

Recommendation: (a). `.named()` no-arg is short, mnemonic, and signals intent better than an empty options bag.

(Note: this does NOT apply to `param` / `audioInput` / `audioOutput` / `event` / `message` / `midiInput` / `midiOutput`. Those helpers have name **required** per Q76 + existing spec — no plain factory — so the absence of an explicit name in the source IS the auto-derive trigger; no `.named()` marker needed.)

### O3 — `'use unworklet/strict'` directive: v1.1.0 first cut or later?

Should `.uwk.ts` files support a top-of-file directive that disables ambient default I/O (= forces explicit declaration)?

- **(a) Ship in v1.1.0** — production-grade processors get an explicit opt-out.
- **(b) Defer to v1.2.0** — minimal first cut; demand can drive inclusion later.

Recommendation: (b). Single directive isn't critical; can land additively without spec change.

### O4 — `$prev` precision inference at generic call sites

For `defineSubgraph(<P extends 'f32' | 'f64'>(coef: Node<P>) => ({ process: (input: Node<P>) => ... }))`, `$prev` must be typed `Node<P>` and the injected slot must be `state.<P>(0)`. Implementation:

- The slot factory uses the concrete `P` resolved at `instantiate(...)` time.
- If the method has no `Node<T>` argument from which `P` can be inferred, emit a graph-capture-time error pointing at the explicit `state.<T>(0)` form.

Confirmation needed during implementation.

### O5 — Multi-target asymmetric `if` (= rejected, but revisit?)

This RFC rejects asymmetric `if` shapes (= `if (cond) state1.store(a); else state2.store(b);`). Promoting them is mechanical:

```text
state1.store(select(cond, a, state1.load()));
state2.store(select(!cond, b, state2.load()));
```

Recommendation: keep rejected for v1.1.0. The lowered form has non-obvious "each store happens unconditionally with a select" semantics that's surprising to readers.

### O6 — TC39 `|>` operator: defer or revisit when settled?

Recommendation: defer. Revisit if TC39 advances to Stage 3 with a settled (F#-vs-Hack) decision.

### O7 — `&&` / `||` logical operators on `Node<'bool'>`

Useful for edge detection and combined guards (`(gate > 0) && !(prevGate > 0)`). Lowering: `a && b` → `and(a, b)`, `a || b` → `or(a, b)`. Eager evaluation (= both branches captured into the graph), no short-circuit (= same as `select`'s both-branch evaluation per Q22-aprime).

Recommendation: defer to v1.2.0. The `!` operator + `if`-sugar cover most short-circuit-feeling needs; logical combinations can wait for real demand.

### O8 — `pipe()` overload arity limit

The free-function `pipe(x, ...fs)` requires TS function overloads to express variadic typing. Each overload arity adds an overload signature. Where to cap?

- 7-8 overloads matches RxJS / fp-ts convention.
- TS 5+ variadic tuple types may collapse overloads to one signature in the future; revisit when TS supports it cleanly.

Recommendation: 8 overloads in v1.1.0 first cut.

### O9 — Persistent slot rename CI warning surface

When an auto-derived `name` changes (= variable renamed by IDE refactor), the schema hash drifts. Current Q5-e `migrations-unreachable` warning fires. Should the warning be loud (= require explicit acknowledgement) or quiet (= log only) when the slot is `'persistent'`?

Recommendation: loud — emit as an error in `migrationsStrict: true` mode, warning otherwise. Match the existing Q5-e severity model.

## Alternatives considered

### A1 — Vue-SFC-style blocks (rejected)

An earlier draft of this RFC proposed `<setup>` / `<process>` / `<migrations>` / `<options>` blocks inside `.uwk` files, with Volar.js-style embedded language tooling.

**Rejected because:**

- GitHub Linguist doesn't recognize `.uwk`; readers see plain text until/unless the language is registered (= years away). The `.uwk.ts` Pure TS path gets free Linguist support immediately.
- Editor LSP support requires a Volar.js plugin per editor; basic features (highlight, type-check) don't work without it. The Pure TS path inherits full TS LSP everywhere.
- A custom SFC parser is needed; Pure TS uses the standard TS parser.
- SFC block boundaries add a new mental model concept (= "what tag is this code in?"). Pure TS uses lexical position relative to the `process(() => {...})` call, which mirrors the existing `defineProcessor` lambda structure.
- Source map chain has one fewer stage (= no virtual-file mapping for block boundaries).
- The visual phase separation that SFC provided can be achieved with comments / labeled function calls / linter rules.

The full SFC draft is preserved in this branch's earlier commit history for reference if SFC is revisited.

### A2 — Custom write operator (`<-` or `:=`, rejected)

The SFC draft proposed `state <- v` or `state := v` as sugar for `state.store(v)`.

**Rejected because:**

- `<-` conflicts with TS tokenization (`state<-v` is ambiguous with `state < -v`); a custom parser would be required.
- `:=` is parser-safe but adds a non-standard JS operator that the TS LSP doesn't understand → red squiggles at edit time without a plugin.
- Write frequency is roughly 1/10 of read frequency in DSP code; the ergonomic win is marginal.
- `state.store(v)` is already short and explicit; the sugar's benefit doesn't justify the parser complexity.

`state.store(v)` stays as the write form. Bare `state` for read (= S6) is the only state-related sugar.

### A3 — TC39 `|>` pipe operator (deferred)

A pipe operator (`x |> f |> g`) would improve L1 helper composition syntax. TC39 has a [Stage 2 proposal](https://github.com/tc39/proposal-pipeline-operator) that's been stuck on the F# vs Hack variant decision for years.

**Deferred because:**

- TS doesn't ship native `|>` support; using it requires a parser plugin.
- F# vs Hack variants have different syntax and aren't trivially interchangeable; committing to one risks misalignment with the eventual TC39 settlement.
- At edit time, `|>` would show as a TS error until the LSP plugin loads (= transient red squiggles).
- The `.pipe()` method + `pipe()` free function (S10) cover the 95% case in native TS.

Revisit if TC39 advances `|>` to Stage 3 with a settled variant.

### A4 — `&&` / `||` logical operators (deferred)

See §"Open Questions" O7.

### A5 — `'use unworklet/strict'` directive (deferred)

See §"Open Questions" O3.

### A6 — Faust block-diagram operators (rejected)

Faust's `:` / `,` / `~` / `<:` / `:>` operators express DSP as block-diagram algebra. Rejected per `00-foundations.md` §2 non-goals — unworklet's per-block / per-sample lexical model is structurally different from Faust's signal-flow algebra. This RFC does not revisit.

### A7 — mimium `@time` temporal recursion (rejected)

mimium's `f()@time` operator schedules `f` at a future time. Rejected per §"Non-Goals" in this RFC. Existing `everyNSamples` + `state.i32` counter + `emitIf` patterns cover the use case without a separate time axis.

### A8 — TypeScript transformer plugin (`ts-patch`, rejected)

Using TS Compiler API plugins to rewrite operator usage inside plain `.ts` files. No new file format.

**Rejected because:**

- TS Compiler plugins have poor IDE integration (= plugin runs at build time only, not at edit time).
- File-format ambiguity — `.ts` files mixing chain DSL and operator sugar in the same file confuse readers.
- The `.uwk.ts` extension keeps a clean separation.

### A9 — Tagged template literal DSL (`dsp\`...\``, rejected)

Embed a DSL inside template literals (= `dsp\`out = input \* gain\``).

**Rejected because:**

- Type inference inside template literals is poor (= TS treats the body as a string).
- IDE integration requires a custom embedded language plugin (= same effort as Volar.js without the established ecosystem).
- Live coding fit is worse than file-level processors (= cell delimitation is by template literal start / end, not by visible file structure).

### A10 — JSX-like processor definitions (rejected without serious consideration)

`<Processor><Input.../><Out.../><Process>...</Process></Processor>` shape. Rejected — JSX is for tree-shaped UI declaration, not signal processing graphs; the shoehorning would be uncomfortable.

## Effort estimate

Best estimate for production quality (= 98% branch coverage gate per `AGENTS.md`, source maps, IDE integration, canonical-example bit-exact regression).

| Subsystem                                                        | Effort (human-days, no AI) | With AI assist (2-3x) |
| ---------------------------------------------------------------- | -------------------------- | --------------------- |
| `.uwk.ts` file detection + Vite plugin glob                      | 1                          | 0.5                   |
| Pass 1: operator sugar (S1, S2, S3, S4)                          | 3                          | 1.5                   |
| Pass 2: index access sugar (S5)                                  | 1                          | 0.5                   |
| Pass 3: bare state read (S6)                                     | 1                          | 0.5                   |
| Pass 4: if-sugar (S7, 3 shapes + reject paths)                   | 2                          | 1                     |
| Pass 5: `$prev` keyword (S8)                                     | 4                          | 2                     |
| Pass 6: auto-derive name (S9)                                    | 2                          | 1                     |
| Pass 7: ambient injection (S12)                                  | 1                          | 0.5                   |
| Pass 8: wrap + `process()` macro recognition (S11)               | 1                          | 0.5                   |
| `not(b)` primitive + WASM emit                                   | 1                          | 0.5                   |
| `.pipe()` method + `pipe()` free function (S10)                  | 1                          | 0.5                   |
| Ambient `.d.ts` for `.uwk.ts`                                    | 1                          | 0.5                   |
| `@unworklet/lang` TS LSP plugin (Volar.js base)                  | 4                          | 2                     |
| Source-map chain                                                 | 1                          | 0.5                   |
| Canonical example port + bit-exact regression                    | 3                          | 1.5                   |
| `@unworklet/lang` package skeleton                               | 1                          | 0.5                   |
| Decision-log Q83-family ratify writeup + new component doc draft | 2                          | 1                     |
| **Total**                                                        | **29**                     | **13**                |

Ship vehicle: dedicated phase **post-v1.0.0**, between Phase 14 ship and v1.1.0 cut. The 14-phase v1.0.0 roadmap (`10-roadmap.md` §2) is unaffected.

## Package layout

The proposal introduces one new public package:

- **`@unworklet/lang`** — `.uwk.ts` lowering pipeline + TS LSP plugin + ambient `.d.ts`. Depends on `@unworklet/core` (= imports `defineProcessor`, type imports). Re-export contract documented in `09-repo-structure.md` §2.4 when ratified.

Existing packages affected:

- **`@unworklet/unplugin`** — gains a `.uwk.ts` loader that invokes `@unworklet/lang` for the lowering pipeline. Output artifact set unchanged (`07-unplugin.md` §6.3).
- **`@unworklet/core`** — additive: `not(b)` primitive (`01-dsl.md` §2.1), `Node<T>.pipe()` method (§2.x), `pipe()` free function (§2.x export). No breaking changes.
- **`@unworklet/test`** — no change.
- **`@unworklet/offline`** — no change.

## References

### unworklet (internal)

- `00-foundations.md` §3 — meta-program / declaration scope / expression scope vocabulary.
- `00-foundations.md` §5 — realtime-safety invariants preserved by this RFC.
- `01-dsl.md` §§1-10 — Tier A chain DSL surface this RFC lowers to.
- `01-dsl.md` §5.5.1 — declaration scope vs expression scope canonical definitions.
- `01-dsl.md` §5.6 — `defineSubgraph` / `instantiate` (= `$prev` keyword's host).
- `01-dsl.md` §8.1 — slot identity rules + named chain semantics (= S9 auto-derive target).
- `03-compiler.md` §1, §2, §7 — compile pipeline + source-map propagation.
- `03-compiler.md` §2.4 — three error layers preserved by this RFC.
- `03-compiler.md` §2.6 — stable error IDs (this RFC adds new IDs additively).
- `07-unplugin.md` §2, §3, §5 — Vite plugin integration point.
- `09-repo-structure.md` §2.1, §2.4 — public package layout for the proposed `@unworklet/lang`.
- `10-roadmap.md` §1, §2 — v1.0.0 acceptance criteria + 14-phase roadmap (= unaffected).
- `12-canonical-examples.md` — production examples this RFC translates as comparisons.
- `decisions-log.md` Q5 / Q22 / Q33 / Q36 / Q37 / Q43 / Q76 / Q77 / Q79 — ratifications preserved.

### Other DSLs surveyed

- [mimium-rs (active repo)](https://github.com/mimium-org/mimium-rs) — the `self` keyword for IIR feedback inside unit-generator functions, renamed to `$prev` for this RFC.
- [mimium-rs `fmpiano.mmm` example](https://github.com/mimium-org/mimium-rs/blob/main/examples/fmpiano.mmm) — 6-op FM piano with `self * feedback` per operator, demonstrating the IIR sugar's reach.
- [mimium FARM 2021 paper](https://dl.acm.org/doi/10.1145/3471872.3472969) — original design rationale.
- [Faust syntax manual](https://faustdoc.grame.fr/manual/syntax/) — block-diagram composition operators (rejected per A6).
- [Faust libraries](https://faustlibraries.grame.fr/libs/filters/) — production DSP idioms.

### Compiler-magic precedents

- Vue 3.3+ `<script setup>` macros (`defineProps`, `defineEmits`, `defineModel`) — compile-time-only function calls that look like ordinary calls. Inspiration for `process()` / `migrations()` / `options()` ambient macros.
- Svelte 5 runes (`$state(0)`, `$derived(x)`, `$effect(() => ...)`) — `$`-prefixed identifiers as compiler-recognized tokens. Inspiration for `$prev`.
- Volar.js — language tooling framework for embedded languages and TS LSP plugins.
- React Server Components `'use client'` / `'use server'` directives — file-level mode markers. Inspiration for the reserved `'use unworklet/strict'` directive (O3).

### Operator proposal

- [TC39 pipeline operator proposal](https://github.com/tc39/proposal-pipeline-operator) — `|>` operator at Stage 2 (deferred per A3).

## Appendix — full lowered virtual `.ts` for Ex 1 Tier C

For implementation reference. Given the Tier C `.uwk.ts` file in §"Examples":

```typescript
// stereoGain.uwk.ts
const gain = param.f32({ default: 1, min: 0, max: 4 });
const meterL = state.f32(0).expose({ publish: { rateFps: 30 } });
const meterR = state.f32(0).expose({ publish: { rateFps: 30 } });

process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    const r = input.right[i] * gain[i];
    out.left[i] = l;
    out.right[i] = r;
    meterL.store(max(abs(l), meterL));
    meterR.store(max(abs(r), meterR));
  });
  meterL.store(meterL * 0.95);
  meterR.store(meterR * 0.95);
});
```

Lowered virtual module (= what `compile()` sees):

```typescript
// virtual: stereoGain.uwk.ts.virtual.ts
// Generated by @unworklet/lang from stereoGain.uwk.ts.
// DO NOT EDIT — edit the .uwk.ts file instead.

import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  abs,
  max,
} from "@unworklet/core";

export default defineProcessor((ctx) => {
  // Ambient I/O injected by Pass 7 (S12) — no audioInput / audioOutput in source.
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  // Auto-derived names by Pass 6 (S9).
  const gain = param.f32({ default: 1, min: 0, max: 4 }).named("gain");
  const meterL = state.f32(0).expose({ name: "meterL", publish: { rateFps: 30 } });
  const meterR = state.f32(0).expose({ name: "meterR", publish: { rateFps: 30 } });

  return {
    process: () => {
      // <process> body — operators lowered to chain (Pass 1), index lowered (Pass 2),
      // bare state lowered to .load() (Pass 3).
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);
        meterL.store(max(abs(l), meterL.load()));
        meterR.store(max(abs(r), meterR.load()));
      });
      meterL.store(meterL.load().mul(0.95));
      meterR.store(meterR.load().mul(0.95));
    },
  };
});
```

The lowered file is bit-identical in behavior to a hand-written Tier A `.ts` file. `compile()` on this virtual module produces the same WASM as `compile()` on the equivalent Tier A source.
