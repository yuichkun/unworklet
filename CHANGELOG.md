# Changelog

The five published packages — `@unworklet/core`, `@unworklet/lang`,
`@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin` — are versioned in
lockstep, so one entry covers all of them.

This project is pre-1.0: the minor is the breaking-change axis, matching npm's
`^0.1.0` range semantics (`^0.1.0` accepts `0.1.x` and refuses `0.2.0`).

## 0.3.0 — unreleased

The correctness-and-honesty batch: the audio-thread transport gains its missing
consumer feedback and loses its last per-quantum allocation, buffer DSP gets
the same numeric hygiene as scalar state, and several declared-but-broken or
silently-lossy surfaces now refuse loudly instead. Seven changes are breaking —
read the migrations.

### Breaking

**`publish` on a buffer is rejected at graph capture.** It was accepted but
inert — the publish pipeline is scalar-only, so the slot never appeared on
`node.state` and the first symptom was a distant `TypeError`. A build that
declared it now fails with stable ID `buffer-publish-unsupported` (the type
surface `BufferExposeOptions` omits `publish` too). Migration: remove the
`publish` from buffer `.expose(...)` and fan the values you want to observe
into scalar `state.f32(0).expose({ name, publish })` slots, or read the buffer
back via `node.snapshot()`. Buffer publish returns as a first-class reader in
the upcoming state/buffer rework.

**`emitAnalysisArtifacts` defaults to `false`.** The graph JSON scales with
build-time-unrolled loops and reached hundreds of MB inside `dist/` — data a
deploy pipeline then ships. Migration: pass
`unworklet({ emitAnalysisArtifacts: true })` if you consume the artifacts; even
opted in, a single artifact past ~8 MB is skipped with a warning.

**Sysex boundaries are enforced.** `node.midi.<name>.send()` now throws on a
sysex payload over 1020 bytes (stable ID `sysex-payload-too-large` — a
truncated sysex loses its 0xF7 terminator, which is worse than no message) and
on sysex to a port with no sysex region (`sysex-unsupported-port` — the
processor neither handles nor emits sysex there, and delivering it anyway
corrupted the ring by advancing `head` over a slot it never wrote). An outbound
`emitIf` follows the same rule on its `length`: a build-time-known length past
1020 bytes, or past its own source `buffer.u8`, is a build error
(`sysex-emit-exceeds-chunk`); a runtime length that overruns either bound drops
the whole message and counts it. The backing buffer may be any size — the
emitted `length` is what has to fit. Migration: split larger transfers into
multiple messages; declare a sysex handler on ports you inject sysex into.

**SIMD lane ops require a buffer of at least 4 elements.** `loadVec` /
`storeVec` read and write 16 bytes from their offset, so a buffer holding fewer
than 4 elements has no in-bounds offset at all — the index clamp saturated into
an empty range and the access still crossed into the neighboring region. A
declaration that uses them on a smaller buffer now fails at graph capture with
stable ID `simd-buffer-too-small` (the analyzer carries the same rule for
hand-built graphs). Migration: size the buffer to 4 or more elements, or use
scalar `read` / `write`.

**`RenderOfflineResult` carries a required `diagnostics` field.** It holds two
counters the renderer keeps about corrections it had to make:
`scrubbedSamples` (output samples the non-finite scrub replaced with 0 — see
Fixed; `0` for a healthy render) and `droppedSysexMessages` (outbound sysex
refused because its `length` would not leave whole — see the sysex entry
above). Reading a result is unaffected, but the field is required, so anything
that CONSTRUCTS a `RenderOfflineResult` — a hand-built test fixture — or
deep-compares a whole result now has to account for it. Migration: add
`diagnostics: { scrubbedSamples: 0, droppedSysexMessages: 0 }` to hand-built
fixtures, or type them as `RenderResultLike` from `@unworklet/test`, which
takes `diagnostics` as optional; compare the fields you care about rather than
the whole object.

**`devDump()` returns `{ slots, scrubbedSamples }`.** The dev-subpath X-ray
(`@unworklet/core/dev`) resolved to the slot array alone, so the render-health
counter the worklet already put on the wire had nowhere to arrive. Migration:
read `(await handle.devDump()).slots` where the array was used directly.

**Snapshot blobs are format v2.** The blob gains an optional processor
identity block; 0.3.0 reads v1 blobs unchanged, but blobs saved by 0.3.0 are
not readable by 0.2.x. Migration: none for upgraders; do not feed 0.3.0 blobs
to a 0.2.x build.

### Added

- **`ProcessorOptions.id`** — a stable, human-chosen processor identity
  (`defineProcessor(body, { id: "my-synth" })`, or `options({ id })` in
  `.uwk.ts`), stamped into every snapshot blob. `schemaHash` covers
  declarations only, so two logically different processors with the same slot
  schema share a hash — a preset from one restored "successfully" into the
  other and corrupted its state. When both blob and processor carry an id,
  `restore()` refuses a mismatch with `{ ok: false, error: { step:
"identity" } }` (stable ID `processor-mismatch`); `renderOffline`'s
  `config.restore` throws. An id-less blob or processor matches on schema hash
  and slot names alone, as it does without this option. `inspect()` surfaces
  the blob's id.
- **`renderOffline` reports what it had to correct** — see the `diagnostics`
  entry under Breaking for the two counters and what they mean.
- **`renderOffline` reuses compiles.** Repeat renders of the same processor at
  the same sample rate skip the compile pipeline (~8 s reported on a mid-size
  processor per render, which made one-render-per-test suites time out).
  Instantiation stays fresh per render, so state never leaks between renders.
- **`@unworklet/test` accepts hand-built results** — matcher inputs are typed
  as `RenderResultLike` (a `RenderOfflineResult` whose `diagnostics` is
  optional), so test fixtures built inline keep compiling.

### Fixed

- **A promptly-drained event or MIDI-out ring no longer reports overflow
  forever.** The consumer's drain position never flowed back to the producer,
  so the WASM-side `head - tail >= capacity` check saturated after `capacity`
  lifetime emits — `overflowCount` lied upward and a slow drain lost real
  events. Main now commits its consumed tail (atomically, wrap-safe) and the
  worklet reads it back before each quantum, on both transports.
- **A concurrent drain is no longer counted as an overflow.** On the SAB path,
  `node.events.<name>.emit()` and `node.midi.<name>.send()` read the occupancy,
  then advanced the shared tail; when the worklet drained the ring in between,
  the advance was correctly declined but `overflowCount` ticked anyway,
  reporting losses that never happened. The advance is now a compare-exchange
  from the observed tail, and only the sender that wins it — the one that
  actually overwrote a slot — counts an overflow.
- **The postMessage fallback's audio thread no longer allocates per quantum.**
  Event and MIDI-out egress rode fresh `Uint8Array`s and content-region
  copies built on the audio thread every quantum; they now ride a single
  pooled transferable frame whose buffers main pre-allocates and recycles
  (ownership ping-pong, with consumed-tail acks piggybacked on the recycle).
  The message envelope and its transfer list are bound once at initialize and
  rewritten in place, so nothing on the send path allocates. Receiving a
  returned buffer still rebinds its two views — a transferred ArrayBuffer
  arrives as a fresh identity — but that cost is fixed rather than scaling with
  the frame. The internal page↔worklet wire protocol changed accordingly.
- **A hidden tab no longer loses events and MIDI (stuck notes).** The
  main-side drain ran only on `requestAnimationFrame`, which throttles to ~0
  in hidden tabs while the audio thread keeps emitting; the drain now falls
  back to a timer when the page is hidden or rAF is missing, and flushes
  immediately on visibility transitions.
- **Buffer-backed feedback flushes subnormals; non-finite output is
  scrubbed.** Float buffer stores (and SIMD `storeVec` lanes) flush
  `|v| < 1e-30` to 0 like scalar state always did — a decaying delay-line tail
  parked in the denormal range cost 10-100× CPU on the audio thread. A NaN /
  ±Inf produced by user DSP is replaced with 0 AT THE OUTPUT ONLY (expression
  semantics are unchanged) and counted into `scrubbedSamples`, instead of
  propagating silence/clicks through the downstream Web Audio graph.
- **SIMD `loadVec` / `storeVec` offsets saturate to the buffer bounds.** The
  scalar buffer clamp never covered the vector ops: an out-of-range vector
  access read or wrote neighboring regions, or trapped and latched permanent
  silence. (One golden fixture's frozen PCM turned out to be the product of
  such an out-of-bounds read.) Buffers too small to hold a lane window are
  rejected outright — see Breaking.
- **A runtime-negative sysex `length` no longer traps.** `memory.copy` reads
  its size operand unsigned, so a user-computed length gone negative became a
  ~4 GiB copy — an OOB trap that silenced the node permanently. Lengths clamp
  to `[0, cap]` on every sysex copy path.
- **`.uwk.ts` module-scope exports work.** An `export`ed declaration used to
  be swallowed into the `defineProcessor` wrapper, emitting invalid
  JavaScript. Exports now hoist to module scope together with their
  (DSL-free) dependency closure; a DSL-tied or unsupported export is a loud
  `uwk-export-unsupported` LowerError instead of broken emit. Whether an export
  touches the DSL is decided by resolving each reference against the scopes
  around it, so a pure helper is not rejected for naming its parameters after
  DSL identifiers (`export function clampTo(input, min, max)` hoists).
- **Re-exporting the processor as `default` is accepted.** `export const wave
= defineProcessor(...); export default wave;` was rejected as "multiple
  processors"; the count is now by value identity, and the named binding wins
  as the canonical name.
- **An extensionless relative import inside a processor module fails with the
  fix spelled out.** The build path evaluates processor sources under Node ESM
  resolution (extensions required); the raw `ERR_MODULE_NOT_FOUND` is rewrapped
  with the rule and, when the sibling file exists, the exact specifier to
  write.
- **Crash-stranded `.uwklowered.mjs` / `.uwkfailed.mjs` temps are swept.** The
  temp tag now embeds a parseable owner pid; the next materialization removes
  temps whose owner is provably dead (older-format strays go by age), and
  never touches a live process's files.
- **DevTools MIDI panel sysex injection reaches the processor.** The panel's
  RPC-serialized `number[]` payload is validated and converted to the
  `Uint8Array` that `send()` expects; malformed bytes are dropped with a
  warning instead of silently wrapping into a different message.

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
