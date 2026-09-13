# Changelog

The five published packages — `@unworklet/core`, `@unworklet/lang`,
`@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin` — are versioned in
lockstep, so one entry covers all of them.

This project is pre-1.0: the minor is the breaking-change axis, matching npm's
`^0.1.0` range semantics (`^0.1.0` accepts `0.1.x` and refuses `0.2.0`).

## 0.3.0 — 2026-09-14

Faster repeated offline audio tests, fixes for audio calculations and UI/MIDI
messages, and optional preset identity checks. This release includes
compatibility changes; check the affected APIs below when upgrading from 0.2.x.

### Breaking

**Array messages and SysEx require memory for the requested queue capacity.**
An array event at the defaults requires 16 MiB of audio processing memory, plus
transport memory. A SysEx port at the defaults requires 256 KiB of audio
processing memory, plus transport memory. Large configurations can exceed the
memory budget or the device's available memory. Set `payloadCapacity` to the
largest array you send in one message, in bytes, and `capacity` to the number of
messages the queue should retain. For 128 float samples, `payloadCapacity: 512`
is sufficient. Oversized arrays are truncated to that aligned per-message
limit; excess queued messages discard the oldest entries and count the loss.

**A processor `.uwk.ts` cannot export extra definitions.** A file containing
`process()` rejects additional value, type, default, and re-exports with
`uwk-export-unsupported`. Put constants, functions, and types shared with the UI
in a separate `.ts` or shared `.uwk.ts` file, then import them into the processor.
A shared `.uwk.ts` file without `process()` can export definitions.

For example, a type exported from a processor file in 0.2.x:

```ts
// Before: inside a .uwk.ts file that also contains process(...).
export type Setting = { value: number };
```

moves to a shared module:

```ts
export const LEVEL = 0.375;
export type Setting = { value: number };
```

The processor imports it, and the UI can import the same type and constant:

```ts
import { LEVEL, type Setting } from "./shared.ts";
const setting = event<Setting>({ from: "main" });
const held = state.f32(LEVEL).named();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  setting.onReceive(({ value }) => held.write(value));
  forSample((i) => {
    out.ch(0)[i] = held;
  });
});
```

**Buffers cannot be published with `.expose({ publish: ... })`.** This setting
fails at build time with `buffer-publish-unsupported`. To display a meter or
another individual value in the UI, publish a scalar state such as
`state.f32(0).expose({ name, publish })`. To read an entire buffer, use
`node.snapshot()`.

**Analysis files are opt-in.** Production builds omit graph and other analysis
files by default. If your tooling reads those files, enable
`unworklet({ emitAnalysisArtifacts: true })`. Serialization stops with a warning
when its estimated 8 MiB budget is exceeded; this is not an exact output-file-size
limit.

**SysEx messages must fit the supported size.** Main-thread `send()` and offline
input reject messages over 1,020 bytes on ports that accept SysEx
(`sysex-payload-too-large`). Main-thread `send()` also rejects SysEx on a port
that does not accept it (`sysex-unsupported-port`); declare a SysEx handler on
ports you send it to. Follow the device protocol to split large transfers into
complete messages within the limit. For outbound `emitIf`, a length known to
exceed the source buffer or size limit is a build error; an invalid runtime
length discards the whole message and increments its diagnostic count. The
source buffer itself can be larger than the emitted message.

**SIMD buffer operations require at least four elements.** `loadVec` and
`storeVec` on smaller buffers report `simd-buffer-too-small`. Increase the buffer
size or use scalar `read` and `write` operations.

**Hand-built `RenderOfflineResult` values need `diagnostics`.** If a test creates
its own result object, add
`diagnostics: { scrubbedSamples: 0, droppedSysexMessages: 0 }`, or use
`RenderResultLike` from `@unworklet/test`, where those diagnostics are optional.
Code that compares a complete render result must also account for this field.
The other exported shapes affected by required additions are:

| Hand-built value or implementation     | Required addition                                               |
| -------------------------------------- | --------------------------------------------------------------- |
| `InspectionResult` / `DecodedSnapshot` | `processorId: string \| null`; use `null` for an ID-less preset |
| `CompileInstance`                      | `scrubbedSamples()` and `droppedSysexMessages()` methods        |
| `DevNodeHandle.devDump()` mock         | Return `{ slots, scrubbedSamples }`, as described below         |

**`devDump()` returns an object.** Read `(await handle.devDump()).slots` to access
the slot list. The returned object also contains `scrubbedSamples`.

**Some names are reserved in `.uwk.ts` files.** A conflicting declaration or
import reports `uwk-reserved-binding`; rename it or use an import alias.
`defineProcessor` is reserved in every `.uwk.ts` file. In files using automatic
audio I/O, `input`, `out`, `audioInput`, and `audioOutput` are also reserved.
An explicit `const out = audioOutput({...})` declaration remains valid.

**Presets saved with 0.3.0 cannot be read by 0.2.x.** The saved format is v2;
v1 presets remain readable. Keep separate copies if presets must be used with
both versions.

### Added

- **Optional preset identity checks.** Set `options({ id: "my-synth" })` in
  `.uwk.ts`, or pass `{ id: "my-synth" }` to `defineProcessor`. When the preset
  and receiving processor both have an identity, a mismatch is rejected:
  `restore()` returns an identity failure and `renderOffline` throws
  `processor-mismatch`. An ID-less preset or processor does not get this check.
  `inspect()` includes the preset's identity.
- **Less compilation work in repeated offline tests.** `renderOffline` reuses
  the compilation of the same processor object at the same sample rate within a
  process. Each render has independent state. No additional cache option is required.
- **Render diagnostics.** `scrubbedSamples` counts non-finite output samples
  replaced with zero. `droppedSysexMessages` counts invalid outbound SysEx
  messages discarded by the renderer. Healthy renders report zero for both.
- **Simpler test fixtures.** `@unworklet/test` matchers accept `RenderResultLike`
  objects without requiring the diagnostic fields.

### Fixed

- **Replying to a UI message can no longer corrupt the input being processed
  or stop the processor.** Multiple replies and subsequent reads of the same
  message are supported, including MIDI and SysEx handlers.
- **Nested calculations and SIMD stores preserve their computed values.**
  Fixes cover arithmetic, interpolation, noise, and calculated vector offsets.
  Out-of-range SIMD offsets clamp to valid positions in the buffer.
- **Event and MIDI delivery stays consistent during concurrent use.** Fixes
  address duplicates, mixed message contents, payloads overwriting other queued
  payloads, and false overflow reports during extended use. Callback reentrancy,
  exceptions, and disposal are covered by the corresponding regressions.
- **Event and MIDI reception continues in a hidden tab.** Browser scheduling
  and queue capacity still limit how much traffic an app can retain. Excess
  traffic can discard older messages and is reported by overflow diagnostics.
- **The postMessage compatibility path reduces repeated allocation.** It
  remains available when SharedArrayBuffer is unavailable, but does not provide
  an allocation-free or GC-free guarantee on the audio thread.
- **Very small feedback values in delay/reverb buffers are flushed to zero.**
  Non-finite audio output is also replaced with zero and counted in
  `scrubbedSamples`; calculations inside the processor retain their semantics.
- **Invalid runtime SysEx lengths no longer stop audio processing.** Negative
  or oversized lengths discard the entire message and increment diagnostics.
- **Explicit node type annotations work with `createNode()`.** Both
  `UnworkletNode<typeof processor>` and
  `UnworkletNode<typeof import("./synth.uwk.ts?worklet")>` preserve the declared
  parameter names, message payload types, and event/MIDI directions.
- **Boolean buffers display the correct lengths and indexes in `inspect()`.**
  Preset migration helpers also read and write their logical elements correctly.
- **Explicit-core processors can have both named and default exports.** A
  `.processor.ts` using a named processor declaration followed by
  `export default wave;` is accepted as one processor. This differs from the `.uwk.ts` export
  restriction described above.
- **Missing import extensions get actionable errors.** An extensionless local
  import reports the rule and, when the target exists, the import path to use.
- **Builds remove temporary files left by terminated unworklet build processes.**
- **SysEx injection from the DevTools MIDI panel reaches the processor.**
  Malformed byte values produce a warning.

### Examples

#### Three renders, one compilation, independent state

Load the processor once and reuse that object:

```ts
import { loadUwkProcessor } from "@unworklet/lang";
import { renderOffline } from "@unworklet/offline";

const processor = await loadUwkProcessor("./counter.uwk.ts");
const config = { sampleRate: 48000, duration: 128 / 48000 };

const first = await renderOffline(processor, config);
const second = await renderOffline(processor, config);
const third = await renderOffline(processor, config);
```

The `counter.uwk.ts` used here emits a ramp:

```ts
const count = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() =>
  forSample((i) => {
    out.ch(0)[i] = count / 128;
    count.write(count + 1);
  }),
);
```

These three renders call `WebAssembly.compile` three times in 0.2.0 and once in
0.3.0. Each output starts at `0`; the counter does not continue from the previous
render. Caching requires the same processor object and sample rate within one
process.

#### Reply to a UI message, then continue using its value

`value-message.uwk.ts`:

```ts
const control = event<{ value: number }>({ from: "main" });
const ack = event<{ value: number }>({ to: "main" });
const later = event<{ value: number }>({ to: "main" });
const held = state.f32(0).named();
const out = audioOutput({ channels: 1, name: "main" });

process(() => {
  control.onReceive(({ value }) => {
    ack.emitIf(bool(true), { value });
    held.write(value * 2);
    later.emitIf(bool(true), { value: value + 1 });
  });
  forSample((i) => {
    out.ch(0)[i] = held;
  });
});
```

Application code:

```ts
node.events.ack.on(({ value }) => console.log("ack", value));
node.events.later.on(({ value }) => console.log("later", value));
node.events.control.emit({ value: 0.25 });
```

With `{ value: 0.25 }`, 0.2.0 fails to finish the 128-sample render within the
comparison's eight-second deadline. Version 0.3.0 returns `ack.value === 0.25`,
`later.value === 1.25`, and 128 output samples equal to `0.5`.

#### Array contents stay paired with their message IDs

Declare an input event in the processor:

```ts
const upload = event<{ id: number; samples: Float32Array }>({
  from: "main",
  capacity: CAPACITY_32,
  payloadCapacity: 16,
});
```

If 17 messages arrive before the processor handles the next block:

```ts
for (let id = 0; id < 17; id++) {
  node.events.upload.emit({
    id,
    samples: new Float32Array([id, id + 0.25, -id, id + 0.5]),
  });
}
```

In 0.2.0, the first received ID can be `0` while its array is
`[16, 16.25, -16, 16.5]`. Version 0.3.0 retains all 17 ID/array pairs, starting
with ID `0` and `[0, 0.25, 0, 0.5]`. Seventeen messages fit the configured
32-message capacity. Set `payloadCapacity` for the required per-message bytes;
retaining more messages also requires more memory, as described under Breaking.

#### Finite returned audio does not mean the DSP avoided invalid calculations

This `.uwk.ts` deliberately divides zero by zero:

```ts
const numerator = state.f32(0);
const denominator = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() =>
  forSample((i) => {
    out.ch(0)[i] = numerator / denominator;
  }),
);
```

For 128 mono samples, 0.2.0 returns NaNs. Version 0.3.0 returns zeros and reports
`result.diagnostics.scrubbedSamples === 128`. A test for valid DSP should include
both assertions:

```ts
expectNoNaN(result); // Passes: the invalid output was replaced with zero.
expect(result.diagnostics.scrubbedSamples).toBe(0); // Fails for this 0/0 example.
```

The first assertion passes for this example; the second fails. The diagnostic
reveals the invalid calculation that output replacement would otherwise hide.

#### Name a node's type before assigning it

```ts
import { createNode, type UnworkletNode } from "@unworklet/core";
import processor from "./value-message.uwk.ts?worklet";

export async function connect(context: AudioContext) {
  let node: UnworkletNode<typeof import("./value-message.uwk.ts?worklet")>;
  node = await createNode(context, processor);
  node.events.control.emit({ value: 0.25 });
  return node;
}
```

The assignment fails with TS2322 in 0.2.0 and succeeds in 0.3.0. The alternative
`UnworkletNode<typeof processor>` also works. A malformed payload such as
`{ value: "0.25" }` or an undeclared port remains a type error.

## 0.2.0 — 2026-08-17

Adds `and` / `or` / `noiseSource`, headless multi-file `.uwk.ts` rendering, and a
one-command install for the agent guide. Type-level narrowing and a DevTools peer
bump make this a breaking release — read the migration notes before upgrading.

### Breaking

**DevTools panels now require `@vitejs/devtools` 0.4.x.** The `@vitejs/devtools-kit`
peer moved from the exact pin `0.3.3` to `^0.4.0`. The 0.3 line pinned to Vite 6/7,
so a consumer on Vite 8 could not install at all. Upgrade the whole DevTools stack
together — host, kit, and the four adapters — because the RPC scope prefix they
share changed with the underlying `devframe` major:

```
npm i -D @vitejs/devtools@^0.4 @vitejs/devtools-kit@^0.4 \
         @vitejs/devtools-vite@^0.4 @vitejs/devtools-rolldown@^0.4 \
         @vitejs/devtools-oxc@^0.4 @vitejs/devtools-vitest@^0.4
```

Mixing majors leaves every panel rendering empty rather than erroring, so check
the panel after upgrading. If you do not use the DevTools panel, the peer is
optional and nothing is required of you.

**`node.midi.<name>` is now narrowed by port direction.** It used to expose the
full surface regardless of direction, so a wrong-direction call type-checked and
then threw at runtime. Now an inbound port (`from: "main"`) offers `.send` /
`.connectFromWebMIDI` and an outbound port (`to: "main"`) offers `.onEvent`:

```ts
const arpOut = event.midi({ to: "main", name: "arpOut" });

node.midi.arpOut.send({ type: "noteOn", ... }); // 0.1.0: compiled, threw at runtime
                                                // 0.2.0: compile error
node.midi.arpOut.onEvent("noteOn", handler);    // the correct call for an out port
```

Code that already called the right method is unaffected.

**`node.events.<name>` payloads and `node.state.<name>` values are now typed.**
Both used to degrade to `unknown` even though the generated `?worklet` witness
carried the declared shape, which forced casts. They now recover the declared
types, so a cast that used to compile may now conflict, and a typo that used to
pass now fails:

```ts
const meter = event<{ peak: number }>({ to: "main", name: "meter" });

node.events.meter.on((p) => p.peak); // 0.1.0: unknown, needed a cast. 0.2.0: number
node.events.meter.on((p) => p.pk); // 0.1.0: compiled. 0.2.0: Property 'pk' does not exist
```

Remove the casts; fix what the new types reject. One gap remains: if two
processors in a project share a file basename (`a/tone.uwk.ts` and
`b/tone.uwk.ts`), only one of them gets the typed surface and the other still
resolves to `unknown` — see [#46](https://github.com/yuichkun/unworklet/issues/46).

**`unworklet-tsc` now type-checks against real processor types on a cold
checkout, so it can surface errors it previously hid.** It generates
`.unworklet/worklets.d.ts` itself at startup instead of waiting for a `vite build`
to write it. Before, a first run on a fresh clone fell back to the wildcard
`CompiledProcessor<unknown>` and silently passed genuine mistakes. A build that
passed on 0.1.0 can therefore fail on 0.2.0 — the errors were always real.

Two costs come with it. Every run compiles every `.uwk.ts` in your tsconfig, warm
or cold — there is no caching — which adds a few hundred milliseconds per
processor. And a `.uwk.ts` that cannot be compiled **at all** now fails the run,
even when `tsc` itself reports no type error: the file is named with the reason,
and the exit code is non-zero, because the alternative is passing a typecheck on
a witness known to be incomplete. A file that legitimately has no `process()` (a
subgraph library) is not a failure unless something imports it as a processor.

**`uwkImportSpecifiers` is now `uwkImportRefs`, and takes emitted JS.** The
`@unworklet/lang` helper returned `string[]` from lowered `.uwk.ts` source; it
returns `{ spec, lazy }[]` from the module's _emitted_ JavaScript. Reading the
emit rather than the declarations is what lets a subgraph reached only through
`instantiate()` be discovered, and `lazy` marks the edges that resolve through
`import()`. If you called it directly, read `.spec` off each entry and pass the
emit.

**Processors that declare an inbound `event` / `message` with payload fields get
a new `schemaHash`.** Inbound payload fields carry a per-field wire type now (see
Fixed), and the schema hash covers declarations, so it changes for those
processors only. Two consequences:

- Saved snapshot blobs still restore. The blob format is unchanged, and a blob
  whose hash no longer matches falls back to restoring slots by name, which is
  every slot — the changed declaration is not a snapshot slot.
- **A `migrations` chain anchored on the old hash stops running** for those
  processors, because no chain step reaches the new hash. Re-anchor the final
  `to` of your chain to the new `schemaHash` (read it from
  `CompiledProcessor.schemaHash`).

### Added

- **`and(a, b)` / `or(a, b)` boolean primitives**, plus `Node#and` / `Node#or`.
  In `.uwk.ts`, `&&` and `||` between two `Node<"bool">` lower to them, and a
  bare `state.bool` operand reads first, so `a && b` over two states works. Both
  operands always evaluate — WASM has no branch-free short-circuit — and neither
  does `select(cond, a, b)`, which picks a value rather than guarding
  evaluation. Nothing in the DSL skips an operand, so make every operand safe to
  evaluate (clamp the divisor, hoist the read) rather than expecting a
  conditional to skip it.
- **`noiseSource({ seed })`** — an xorshift32 PRNG declaration primitive; call
  `.next()` per sample. Wired into the `.uwk.ts` ambient surface.
- **`loadUwkProcessor(path)` in `@unworklet/lang`** — loads a `.uwk.ts` and its
  sibling `.uwk.ts` subgraph imports to a `CompiledProcessor`, so `renderOffline`
  can render a multi-file processor with no bundler.
- **The agent guide installs with one command**, giving an agent the DSL reference,
  setup, type-checking, testing, and DevTools docs. It detects the coding agents you
  have — Claude Code, Codex, Cursor, opencode, Zed, Copilot and others — and installs
  for each:

  ```sh
  npx skills add https://github.com/yuichkun/unworklet/tree/main/skills/unworklet
  ```

- **`unworklet-tsc` self-seeds `.unworklet/tsconfig.json`**, so a cold clone whose
  tsconfig `extends` it no longer fails with TS5083 before anything has run.
- `@unworklet/lang` additionally exports `seedUnworkletDir`, `GENERATED_TSCONFIG`,
  `isUwkSource`, `lowerUwkSource`, `materializeLowered`, `importLoweredEntry`,
  `deriveExportName`, `uwkImportRefs`, `workletDts`, and `workletsDts` for tooling
  built on top of it.

### Fixed

- **Fractional numbers sent from the main thread no longer truncate to zero.**
  An inbound `event` / `message` payload field rode a uniform i32 wire, so
  `emit({ gain: 0.8 })` arrived as `0`; boolean fields only worked by accident.
  The wire type is now decided per field — `number` defaults to f32 and keeps its
  fraction, `boolean` seals to bool when consumed in a boolean position.
- **`@unworklet/test`'s chain matchers now type-check for vitest 4 consumers**
  (`@vitest/expect` added as a required peer). The chain entry point augments
  `@vitest/expect`'s `Matchers` interface, so without it installed the
  augmentation had nothing to attach to and `expect(result).toBeSilent()` failed
  to compile with TS2664. Declaring the peer turns that into an install error.
- **DevTools panels render again after the 0.4 upgrade** — the page bridge used
  the pre-0.4 anonymous-RPC prefix and the panel bundle was still built against
  the 0.3 kit, so an authenticated session showed empty panels.
- **`unworklet-tsc` reports the right line and column.** Diagnostics were
  resolved against the virtual module's text, so every error landed a few lines
  above its real position.
- **`&&` / `||` / `?:` over bare state no longer crash the lowering.** `if (a && b)`,
  `(a && b) ? x : y`, `a && b && c`, and `cond ? x : y` with bare-state operands
  threw `and(...).read is not a function`: TypeScript types `State<T> && State<T>`
  as `State<T>`, so the auto-read pass added a `.read()` to an expression the
  operator pass had already replaced with `and(…)`.
- **A multi-file `.uwk.ts` graph that fails to load reports what went wrong
  instead of failing later and elsewhere.** A cycle between two eagerly-imported
  subgraphs surfaced as a raw `ReferenceError` about a deleted temp file; a
  failure under a lazy edge left temp paths recorded but never written, so a
  later static import of the same file was pointed at a file that does not exist;
  and an interrupted load could record a helper as loaded that never was, making
  a subsequent edit to it fail permanently until the process restarted.
- `.uwk.ts` bare-state auto-read now fires in three more positions it missed: a
  buffer index synthesized by `if` sugar, an object-literal shorthand in an
  `emit` payload (`{ peak }`), and a property-name position that previously
  crashed the pass.
- Subgraph types resolve across sibling `.uwk.ts` files.
- Passing a `Param` where a `Node` is expected now fails at graph capture with a
  message naming `Param` and the `param[i]` fix, instead of a misleading `i64`
  overload error.
- `unwrapAst` reports an actionable message for `undefined` / `null` / non-object
  input instead of a bare property access failure.
- The generated tsconfig seeds `module` / `moduleResolution`, so the ambient
  authoring identifiers keep their types in a consumer project.
- The demo handles generator-style processors that declare no audio input.

### Docs

The agent-facing guide (`skills/unworklet/`) was rewritten around `.uwk.ts` as the
primary authoring form and then corrected across five rounds of building real
projects from the guide alone — API names, commands, setup order, and every code
sample now match the implementation. CI compiles every complete example in it.

The guide also documents a `vitest` interaction it cannot fix from inside the
plugin: with the DevTools panel enabled, a `vitest` run hangs 10 seconds at close
(`close timed out after 10000ms`). Gate the DevTools plugins out under `VITEST`
in your own `vite.config.ts` — `setup.md` and `devtools.md` show the two lines.

The design-time specification that drove the v1.0.0 build was deleted, along with
`llms.txt`. Both restated behaviour that `skills/unworklet/` describes, without
being verified against it, and both had drifted. `docs/` now holds history only:
the decisions log and the RFCs. Recover the deleted chapters from git history at
the `v0.1.0` tag if you need them.

## 0.1.0 — 2026-06-28

First public release of the five packages.
