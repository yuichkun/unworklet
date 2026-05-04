# Decisions log

Cross-cutting reference: every resolved design question, recorded with its rationale and the alternatives that were rejected. Component docs link here for the "why" rather than restating it inline.

## Status

skeleton — populated as questions resolve

## Index

| # | Topic | Decision | Authoritative section |
|---|---|---|---|
| Q1 | Scalar type defaults | f32 literal default; explicit conversion only; no implicit widening | `00-foundations.md` §4 |
| Q2 | Third-party DSP helper integration layer | resolved — 2 layers (L1 + L2), no L3; L1/L2 surfaces and instantiation rules settled | `01-dsl.md` §5 |
| Q3 | SIMD scope for v1.0.0 | resolved — opt-in via `@unworklet/core/simd`; v1.0.0 = f32x4 MVP; parallel families | `00-foundations.md` §4 + `01-dsl.md` §7 |
| Q4 | MIDI integration design | resolved — input+output; type-discriminated events; raw-bytes wire; transport API out of scope | `11-midi.md` |
| Q5 | State snapshot / restore API | resolved — `Uint8Array` blob; hybrid profile (short form + per-profile record); block-atomic timing; declarative migration chain; full surface in v1.0.0 | `01-dsl.md` §3, §8 + `05-client.md` §2.6, §6 |
| Q6 | Multi-output processors | resolved — declaration helpers (`audioInput` / `audioOutput`); always explicit (no default I/O sugar); required `name`; typed `node.inputs.<name>` / `node.outputs.<name>` access | `01-dsl.md` §1 |
| Q7 | Sub-rate computation | resolved — `everyNSamples(N, () => ...)` graph-capture-time meta primitive in expression scope; param automation rate untouched | `01-dsl.md` §9 |
| Q8 | Multi-block lookahead | resolved — out of scope (raw materials `buffer` + `state` + `defineSubgraph` + `createDelay` are sufficient; framework abstraction would violate either AudioContext ownership or declarative core philosophy) | `05-client.md` §7 (recipe) |
| Q9 | Cross-processor communication | resolved — out of scope ((a)(b)(e) audio routing covered by Q6 `connect()`; (c) message relay covered by upcoming generic messaging Q; (d) audio-thread SAB sharing left to consumer via `processorOptions`) | `decisions-log.md` Q9 |
| Q10 | Transport / tempo sync | resolved — out of scope (third-party domain) | `11-midi.md` §5 |
| Q11 | Browser quirk normalization | (open) | `08-deployment.md` §2 |
| Q12 | Monorepo tool | (open) | `09-repo-structure.md` §1 |
| Q13 | Initial package layout | (open) | `09-repo-structure.md` §2 |
| Q14 | v1.0.0 acceptance criteria | (open) | `10-roadmap.md` §1 |
| Q15 | License | (open) | `09-repo-structure.md` §3 |
| Q16 | npm scope | (open) | `09-repo-structure.md` §4 |
| Q17 | Math precision variants | (open) | `01-dsl.md` §2 |
| Q18 | Render quantum handling | (open) | `04-worklet-runtime.md` §3 |
| Q19 | Channel-count specialization | (open) | `04-worklet-runtime.md` §4 |
| Q20 | Pre-warm correctness | (open) | `04-worklet-runtime.md` §5 |
| Q21 | Denormal handling | (open) | `04-worklet-runtime.md` §6 |
| Q22 | Graph capture model and process body structure | resolved (a / aprime / b fixed; c 3-layer fixed; d open) | `00-foundations.md` §3 + `01-dsl.md` §1, §10 + `03-compiler.md` §2 |
| Q23 | Hot reload semantics | (open) | `07-tooling.md` §4 |
| Q24 | Bundler integration scope | (open) | `08-deployment.md` §1 |
| Q25 | Source maps | (open) | `03-compiler.md` §7 |
| Q26 | TypeScript version | (open) | `09-repo-structure.md` §5 |

---

## Q1 — Scalar type defaults

**Status:** resolved.
**Decision:** authoritative wording in `00-foundations.md` §4. Summary: numeric literals lift to `Node<'f32'>`; cross-precision conversion is explicit (`f32(node)` / `f64(node)`); operations on mixed-precision operands are a compile-time type error.
**Rationale:** AudioWorklet I/O is `Float32Array`-typed end-to-end; `f32` default avoids per-sample boundary conversions and matches the Web Audio data plane. Audio-rate DSP overwhelmingly uses f32.
**Rejected:**
- *`f64` literal default* — would force per-sample f32↔f64 conversions at every I/O boundary and double linear-memory footprint. Mismatched with the data plane.
- *Mandatory type hints on every literal* (e.g. `add(node, f32(0.4))`) — maximally explicit but verbose enough to harm readability of typical DSP expressions, with no precision benefit over the chosen default.

<!-- Subsequent entries follow the same shape: Status / Decision (with cross-ref) / Rationale / Rejected. -->

---

## Q2 — Third-party DSP helper integration layer

**Status:** resolved.

**Decision (Q2-a):** authoritative wording in `01-dsl.md` §5.1–§5.4. Summary: two integration layers — L1 (pure TS function, inlined) and L2 (`defineSubgraph`, stateful, inlined into the parent WASM module). No "separate processor + connect" L3 layer — that case is covered by `AudioWorkletNode.connect()` directly and is outside unworklet's API surface.

**Decision (Q2-b):** authoritative wording in `01-dsl.md` §5.5. Summary:

- L1 helpers are stateless TypeScript functions inlined at the call site, living entirely in expression scope.
- Parameters: `Node<T>`, caller-owned `State<T>` (with `load`/`store`), caller-owned `Param` (callable as `param()` or `param.at(i)`), caller-owned `AudioInputHandle` / `AudioOutputHandle`, optional `i: Node<'i32'>` for explicit-form internals, and compile-time constants.
- Return: single `Node<T>`, tuples, records, or `void`. Each returned `Node` is an independent graph terminal.
- Precision-generic via TypeScript generics over `'f32' | 'f64'`; Q1's no-implicit-widening still holds inside the body.
- Body forbids new `state.*` / `buffer.*` / `param.*` / `audioInput` / `audioOutput` declarations, `defineSubgraph` declarations, L2 instantiations, and `message` / `event` declarations; allows primitives, `load` / `store` on parameter `State`, sugar (`param()`) and explicit (`param.at(i)`) param access on parameter `Param`, sugar (`audioIn.read(c)`, `audioOut.write([...])`) and explicit (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`) audio I/O on parameter handles, calls to other L1 helpers, and `forSample(...)` (rare).
- Violations are caught at graph-capture / static-analysis time (compile time, never runtime) and surfaced with refactor-hint error messages. Detailed error-UX policy lives in `03-compiler.md` §2 (Q22).

**Decision (Q2-c):** authoritative wording in `01-dsl.md` §5.6. Summary:

- Subgraph body uses the same two-scope shape as `defineProcessor`: declaration scope at the top, expression scope inside a `process` lambda. Symmetry is intentional — L2 and root processors share one mental model.
- Instantiation syntax is the direct call form `subgraph(args)`, mirroring L1 helpers so consumers can compose subgraphs and L1 helpers interchangeably.
- The `process` lambda's return becomes the subgraph's output and follows the same shapes as L1 helpers (single `Node<T>`, tuple, record, `void`); the instantiation expression's type is inferred from this return.
- Subgraphs may only be instantiated in declaration scope (the body of `defineProcessor` or another `defineSubgraph`, before its `process` lambda) — never inside an expression scope. Conditional output is expressed by instantiating both branches and choosing with `select`.
- Inside the subgraph body: declaration scope allows declarations and L2 instantiations; expression scope (`process` lambda) follows the same rules as L1 bodies.
- Violations are graph-capture / static-analysis errors with refactor-hint messages.

**Rationale (Q2-a):** L1/L2 inlining means the helper boundary has zero runtime cost, which is the precondition for a healthy third-party ecosystem (filters, oscillators, envelopes, FFT helpers, …) where users can compose freely without worrying about call overhead. The state/no-state split is the cleanest rule for choosing between the two; anything more implicit (auto-promotion, shape inference) blurs graph-capture vs type-inference responsibilities.

**Rationale (Q2-b):**

- *Caller-owned `State<T>` parameters*: lets a parent processor own state across multiple call sites (e.g. per-channel) and delegate logic to a single L1 helper without forcing every state-aware helper into L2.
- *Tuple / record returns*: stereo or multi-tap helpers (e.g. an SVF returning low/band/high) are common; capturing each output as an independent terminal incurs no extra cost.
- *Precision-generic helpers*: avoids forcing third-party authors to ship two definitions for f32/f64. TS generics carry no runtime cost and the no-implicit-widening rule still type-checks inside the generic body.
- *Compile-time enforcement of body constraints*: violations are detectable statically from the source position of `state.*` / `defineSubgraph` calls; surfacing them at runtime would either compromise realtime safety (errors on the audio thread) or require silent fallbacks. Refactor-hint error messages turn the constraint into actionable guidance for the helper author.

**Rationale (Q2-c):**

- *Two-scope body symmetric with `defineProcessor`*: a unified mental model for L2 and root processors. Helper authors learn one shape, error messages reference one set of scope rules, and the implementation can share graph-capture machinery between the two.
- *Direct-call instantiation*: keeps consumer-side composition syntax identical between L1 and L2 (`helper(args)` either way). Wrapping in an explicit `.instantiate(...)` would split L1 vs L2 in the consumer's mind without buying any expressiveness.
- *L1-aligned return shapes*: L2 inherits the same multi-output flexibility decided in Q2-b. No reason to constrain L2 outputs more narrowly than L1 returns.
- *Instantiation in declaration scope only*: each instantiation is a declaration of an independent state slot, so it belongs with other declarations. Allowing instantiation in expression scope makes it tempting to read subgraphs as runtime-allocated, blurring the static graph-structure guarantee. Conditional dispatch is already expressible via `select` over multiple pre-instantiated branches.

**Rejected:**

- *Single unified layer with auto-promotion* (Q2-a) — would auto-classify a function as L1 or L2 based on whether its body calls `state.*`. Makes graph capture and type inference jointly responsible for the layer decision; explicit separation isolates the rules.
- *Four+ layers (e.g. "stateful + sub-processor")* (Q2-a) — premature for v1.0.0; the rare case of needing an internal sub-processor can be assembled at the host level by composing two `defineProcessor`s.
- *Wrapping `AudioWorkletNode.connect()` as an L3* (Q2-a) — adds API surface for a thing that is already a Web Audio standard. The wrapper would either re-expose the standard verbatim (no value) or paper over its semantics (worse than direct use).
- *User-defined compile-time macros* (Q2-a) — deferred. L1/L2 cover the bulk of the third-party use case; macros can be revisited post-v1.0.0 if a concrete need surfaces.
- *L1 with no `State<T>` parameters allowed* (Q2-b) — would force every state-touching helper into L2, even simple per-channel `smoothFollow`-style functions. Adds boilerplate without isolating any meaningful invariant.
- *L1 with single-`Node<T>` return only* (Q2-b) — would force common multi-output helpers (stereo, SVF, multi-band split) into L2 or split returns, losing readability without performance benefit.
- *Precision-fixed helpers (no generics)* (Q2-b) — would force third-party authors to ship two copies of every helper for f32/f64, structurally lagging f64 ecosystem coverage.
- *Runtime-checked body constraints* (Q2-b) — would either compromise realtime safety (error on the audio thread) or silently fall back; both worse than static rejection.
- *Subgraph body with declaration and expression intermixed in the top scope (no `process` lambda)* (Q2-c) — saves 1–2 lines of boilerplate but breaks the mental-model symmetry with `defineProcessor` and gives error messages no consistent location to point at. The boilerplate cost is trivial compared to the parallel-structure benefit.
- *Explicit `.instantiate(...)` method on subgraphs* (Q2-c) — adds asymmetry between L1 helper calls and L2 instantiations on the consumer side without buying expressiveness.
- *Subgraph instantiation allowed in expression scope* (Q2-c) — makes graph structure dependent on what a `process` lambda chose to call, breaking the "instance count is statically known" guarantee. Conditional dispatch is already cleanly expressible via `select` over pre-instantiated branches.

---

## Q3 — SIMD scope for v1.0.0

**Status:** resolved.

**Decision:** authoritative wording in `00-foundations.md` §4 (vector types) and `01-dsl.md` §7 (opt-in SIMD surface). Summary:

- **Q3-a (opt-in & namespaced):** SIMD primitives and vector types are exposed exclusively via the import path `@unworklet/core/simd`. Code that does not import this path never references `Node<'f32x4'>` or any vec primitive.
- **Q3-b (v1.0.0 MVP, phased rollout):** v1.0.0 ships the minimal surface — `Node<'f32x4'>`, `vec4` / `splat` construction, `addVec` / `subVec` / `mulVec` / `divVec`, `lane` access (compile-time-constant index), `loadVec` / `storeVec`. The comprehensive surface (`f64x2`, `i32x4`, mask vectors, `shuffle`, comparisons, gather / scatter) rolls out additively across v1.x.0; rollout order is settled in Q14.
- **Q3-c (parallel families, not generic):** scalar (`Node<'f32'>` etc.) and vector (`Node<'f32x4'>` etc.) primitives are separate functions over separate types. `add` and `addVec` are distinct primitives; mixed scalar / vec operations are type errors and require explicit `splat` / `lane` conversion.

**Rationale:**

- *Opt-in via separate import path*: scalar-only authors never encounter SIMD concepts in IDE completions, type-checker errors, or code reviews. SIMD-using authors get first-class access without compromise. This is the framework's expression of "users who don't need it never see it; users who do need it have it natively" — feature reduction is not a substitute for mental-model unification.
- *Phased rollout*: shipping the minimal MVP first lets v1.x.0 extend additively based on observed user demand (which lane widths and operations show up in DSP packages first), instead of guessing the comprehensive surface up front. The MVP covers hand-vectorized 4-lane DSP — the most common SIMD shape — and downstream extensions do not break the v1.0.0 surface.
- *Parallel families over generics*: distinct scalar and vec primitives keep the scalar surface untouched (a `Node<'f32'>`-only reader never has to read `<T>` in a primitive's signature). Function names also signal "this is vectorized" at the call site, easing performance review. Cross-width generics buy little reuse and would leak SIMD existence into scalar-only callers' types.

**Rejected:**

- *No SIMD in v1.0.0 (scalar-only)* — would tell users with heavy DSP needs (FFT, multi-channel mixers, partitioned convolution) that unworklet is not for them. SIMD coverage is part of the framework's value proposition, not an optional v2 feature. Cutting it for "simpler mental model" conflated mental-model unification with feature reduction.
- *Hidden auto-vectorization (compiler decides silently)* — performance becomes implementation-defined. Users cannot predict whether a hot path is vectorized; small refactors can flip the decision. A silent perf trap is worse than an explicit surface for the users who need control.
- *Single import path with vec primitives mixed in* — would put `f32x4` and `addVec` in the IDE completion of every scalar-only author, contradicting the opt-in principle.
- *Generics across width (`add<T extends 'f32' | 'f32x4'>`)* — would make the same primitive accept scalar or vec, leaking SIMD existence into scalar-only authors' type signatures and IDE tooltips. The reuse benefit is minor; the surface-clarity loss is meaningful.
- *Comprehensive surface in v1.0.0* — premature commitment. f64x2 vs i32x4 vs mask-and-shuffle priorities are best decided after early DSP packages start using the f32x4 MVP.

---

## Q4 — MIDI integration design

**Status:** resolved.

**Decision (Q4-a):** authoritative wording in `11-midi.md` §1 and §3. Summary: unworklet supports both MIDI ingestion and emission. Processors declare involvement via `midiInput()` / `midiOutput()` (either or both, both omittable). The main-thread API is source-agnostic: a low-level `unworkletNode.midi.send(event, atTime?)` plus a Web MIDI convenience bridge `unworkletNode.midi.connectFromWebMIDI(input)`. unworklet does not know or care where events originated; routing MIDI from any other source (DAW MIDI bridges, network, hardware, application logic) is the consumer's responsibility.

**Decision (Q4-b):** authoritative wording in `11-midi.md` §2 and §4. Summary:

- Handler registration is **type-discriminated**: `midiIn.onEvent('noteOn', handler)` etc., one handler per event type, with TypeScript narrowing the argument shape per type.
- Event type representation is **hybrid**: a `MidiEvent` discriminated union on the API surface (noteOn / noteOff / cc / pitchBend / programChange / channelPressure / aftertouch / systemRealtime / sysex), and raw MIDI status bytes on the wire. The compiler generates serializers / deserializers between the two.
- Emission primitive is **`emitIf(cond, event)` only**. There is no unconditional `emit(event)` — every emission is structurally conditional.
- `atSample` is **always present** on handler arguments (and required in `emitIf` events). Handlers fire at the in-block sample offset, not at block boundary; sample accuracy is preserved end-to-end.

**Decision (Q4-c):** authoritative wording in `11-midi.md` §4. Summary:

- **Capacity (Q4-c-i):** ring buffers default to **256 slots** (8 bytes each = 2 KB). Override via `midiInput({ capacity })` / `midiOutput({ capacity })`. Sized for typical use; dense MIDI / sequencer / network-driven loads override.
- **`atSample` semantics (Q4-c-ii):** **block-local** (0 through `renderQuantum - 1`); stored as `u32` for headroom. Global timestamps are derived consumer-side via `audioContext.currentTime + atSample / sampleRate`.
- **Sysex (Q4-c-iii):** **full support in v1.0.0**. Variable-length sysex bodies live in a separate variable-length content buffer; the main ring-buffer slot for a sysex event holds the status byte plus an index into the content buffer.
- **Overflow (Q4-c-iv):** **drop-oldest + diagnostics counter**. The oldest event is overwritten on overflow, and a monotonic `overflowCount` counter is exposed via `midiIn.diagnostics.overflowCount()` for consumer monitoring.

**Decision (Q4-d):** authoritative wording in `11-midi.md` §5. Summary: MIDI clock messages (`0xF8` timing clock, `0xFA` start, `0xFB` continue, `0xFC` stop) are ingested as ordinary `systemRealtime` events. unworklet does **not** provide a built-in transport API (BPM / beat position / play state); transport interpretation is **out of scope** and lives in consumer code or third-party packages. This same decision resolves Q10.

**Rationale (Q4-a):**

- *Both ingestion and emission*: MIDI-driven effects and generators (arpeggiators, sequencers, MIDI delays, harmonizers) are core m4l/VST-equivalent use cases on the web platform. Cutting emission would create a structural hole that no third-party package could fill — the feature-reduction trap conflated with mental-model unification (see `feedback_mental-model-vs-feature-reduction.md`).
- *Symmetry of cost*: ingestion and emission share wire format, transport, and sample-accurate timing machinery. Implementation cost is roughly 1.3–1.5× ingestion alone, not 2×.
- *Opt-in declaration*: processors that don't call `midiInput()` / `midiOutput()` never encounter MIDI concepts — no IDE noise, no runtime cost, no cognitive load for audio-only DSP.
- *Source-agnostic main-thread API*: keeping the surface as `.send()` plus a Web MIDI convenience wrapper avoids coupling unworklet's design to any specific MIDI source category. Application code routes whatever it wants to `.send()`.

**Rationale (Q4-b):**

- *Type-discriminated `onEvent`*: TypeScript narrows the handler argument shape per event type; authors get full IDE completion and refactoring without re-discriminating a union inside a switch. Each handler is also independently graph-captured, simplifying inlining and dead-code elimination during compile.
- *Hybrid type representation (union API / raw-bytes wire)*: gives TypeScript-first authors the type safety they came for, while keeping the wire MIDI-standard (compact, fast to parse, compatible with the byte format every audio engineer already knows). A bytes-only API would push status-byte decoding onto every author; a union-only wire would inflate transport size and cost on the postMessage degradation path.
- *`emitIf` only, no plain `emit`*: every meaningful MIDI emission is conditional (boundary, state transition, input trigger). A plain `emit(event)` invocation in `process` would silently fire every sample (44.1 kHz) and saturate the ringbuffer — a footgun whose only "correct" form is `if (cond) emit(event)` anyway. Forcing the conditional into the primitive's shape eliminates the footgun structurally.
- *`atSample` always required*: unworklet's MIDI integration exists to deliver sample-accurate events. Handlers without `atSample` discard the property the framework was built around. Carrying it unconditionally costs nothing (one number in the shape) and keeps the API uniform.

**Rationale (Q4-c):**

- *Capacity 256 default*: covers the vast majority of MIDI workloads with comfortable headroom against bursts. Override is one keyword for users with dense streams. The "user doesn't have to think" default is the unworklet stance.
- *`atSample` block-local*: "this event fires N samples into the current block" is the question DSP code naturally asks. Global timestamps require subtracting the block start as an extra step. Block-local maps directly to per-sample dispatch logic.
- *Sysex full support in v1.0.0*: sysex is part of the MIDI standard (device controllers, GM/GS/XG extensions, Universal Real Time messages). m4l/VST-equivalent devices commonly need it. Implementation cost is moderate (variable-length content buffer + length prefix); deferring would create a structural hole in the v1.0.0 surface.
- *Drop-oldest + diagnostics counter*: drop-oldest and drop-newest both break MIDI semantics (phantom note off vs hanging note); neither is "correct". The actionable design is to make overflow detectable so consumers can resize capacity or fix the upstream burst. Drop-oldest is the natural ring-buffer behavior and the simplest to implement.

**Rationale (Q4-d):**

- *Out of scope, not deferred*: transport models vary by DAW culture (Ableton Link phase, Tone.js Transport step, Bitwig clip-driven, etc.). unworklet picking one constrains users whose context expects a different model. Keeping transport out of scope lets third-party packages serve different cultures without the framework enforcing a winner.
- *Provide the raw material, not the abstraction*: ingesting `systemRealtime` events with sample-accurate `atSample` is the irreducible primitive; everything above (BPM estimation, beat-position state machines, look-ahead schedulers) can be built from it. unworklet's role ends at delivering the events.
- *Not a feature reduction*: arpeggiator / sequencer / tempo-synced LFO use cases remain fully buildable — the raw material is provided. Only the *abstraction layer* lives elsewhere; that is scope clarification, not feature reduction (see `feedback_mental-model-vs-feature-reduction.md`).
- *Multi-processor sharing already works via Web Audio*: when multiple processors need the same transport, MIDI clock can be routed via `AudioWorkletNode.connect()` or fanned out from the main thread. unworklet does not need to abstract this.

**Rejected (Q4-a):**

- *Input only (no MIDI emission)* — would structurally exclude arpeggiator / sequencer / MIDI-effect use cases, which are part of the "m4l/VST-equivalent web devices" scope (see `project_unworklet-scope-framing.md`).
- *Input only in v1.0.0, Output deferred to v1.x.0* — breaks I/O symmetry from day one and forces consumers to wait for a non-trivial subset of m4l/VST coverage.
- *MIDI source enumeration in unworklet's surface* (e.g. distinguishing "Web MIDI source" vs "application source" at the API level) — unnecessary specialization. A single `.send()` plus a Web MIDI convenience wrapper covers all cases without coupling to source categories.

**Rejected (Q4-b):**

- *Unified `onEvent((event) => switch (event.type) { ... })`* — forces authors to re-implement type narrowing inside a switch. Aggregating all event handling into one closure also defeats per-type graph capture and inlining.
- *Raw-bytes-only API (`{ status, data1, data2, atSample }`)* — pushes MIDI status-byte parsing onto every author and erases the value of writing in TypeScript.
- *Discriminated-union-only wire (no raw bytes underneath)* — bloats transport, especially on the postMessage degradation path, and diverges from the MIDI byte format that downstream consumers (Web MIDI Output, network bridges) expect.
- *Allowing plain `emit(event)`* — silent footgun. Authors who forget the `if (cond)` wrap saturate the ringbuffer at sample rate. `emitIf` makes the conditional shape mandatory.
- *`atSample` as opt-in* — introduces an API split for a property that costs nothing to include unconditionally and is fundamental to the framework's stated goal (sample-accurate ingestion).

**Rejected (Q4-c):**

- *Computed-default capacity (e.g. `blockSize × 8`)* (Q4-c-i) — the user can't easily reason about the resulting size, and the formula provides no benefit over a clear constant. A simple `256` default with override is more transparent.
- *Required explicit capacity* (Q4-c-i) — adds friction to the common case where the default is fine. Users who don't need to tune capacity shouldn't have to type a number.
- *AudioContext-global `atSample`* (Q4-c-ii) — forces every per-sample handler to compute a block-relative offset to do anything useful. The natural DSP-side question is "how far into the current block?", which block-local answers directly.
- *Sysex deferred to v1.x.0* (Q4-c-iii) — leaves a structural hole in the v1.0.0 surface for m4l/VST-equivalent devices. Sysex is part of MIDI; treating it as optional damages coverage.
- *Sysex variant removed entirely from `MidiEvent`* (Q4-c-iii) — unworklet's scope explicitly covers MIDI-driven web devices; dropping a standard MIDI event class is a feature reduction, not mental-model unification.
- *Drop-newest on overflow* (Q4-c-iv) — equally broken (hanging notes from dropped noteOff). Choosing it over drop-oldest does not improve safety; only detection (the counter) does.
- *Halt or throw on overflow* (Q4-c-iv) — would crash the audio thread on a recoverable condition. The realtime-safe behavior is to drop and report.

**Rejected (Q4-d):**

- *Built-in `useTransport()` API in v1.0.0* — picks one transport model (BPM-and-beats, or phase-based, etc.) at the framework level, constraining users whose DAW context expects a different model. Premature commitment.
- *Built-in transport "deferred" to a later v0.x* — implies unworklet eventually adopts one. The framework-level decision is that transport is the consumer's territory, full stop. "Deferred" sends the wrong signal about the project's scope.
- *MIDI clock messages dropped from `MidiEvent`* — eliminates the raw material. arpeggiator / sequencer / tempo-synced LFO use cases would become unbuildable on unworklet alone, which is a feature reduction trap.

---

## Q10 — Transport / tempo sync convention

**Status:** resolved — out of scope (third-party domain).

**Decision:** unworklet does not provide a built-in transport API (BPM, beat position, play state, look-ahead scheduler, etc.). MIDI clock messages are delivered as ordinary `systemRealtime` events through the standard MIDI ingestion path; any abstraction above that lives in consumer code or third-party packages.

This is settled together with Q4-d — see the Q4-d Decision / Rationale / Rejected entries above for the full reasoning.

Authoritative wording: `11-midi.md` §5.

---

## Q5 — State snapshot / restore API

**Status:** resolved.

**Decision (Q5-a):** unworklet ships a state snapshot / restore API in v1.0.0. It exposes the linear-memory contents of a running processor as a `Uint8Array` blob that can be persisted, transmitted, and written back. Authoritative wording: `01-dsl.md` §3, §8 + `05-client.md` §2.6, §6.

**Decision (Q5-b):** authoritative wording in `01-dsl.md` §3, §8.1–§8.2. Summary:

- Each `state` / `buffer` / `param` declaration accepts a `name` field and a `snapshot` field.
- `name` is required when the parent processor calls `snapshot()` (graph-capture-time error otherwise). Subgraph instances also require `name`; slot identity is the slash-joined path from the root.
- `snapshot` is one of `'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }`. Default is `'persistent'` for `state` and `param`, `'transient'` for `buffer`.
- Profile names are user-defined; the framework reserves no names. The set of profiles is the union of keys appearing in declarations.
- `node.snapshot()` (no arg) includes any slot that is `'persistent'` for *any* profile; `node.snapshot({ profile })` includes only slots `'persistent'` for that named profile.
- AudioParam automation queues are not preserved across snapshots — only the current `.value`.

**Decision (Q5-c):** authoritative wording in `05-client.md` §2.6. Summary:

- The single surface shape is `Uint8Array` for both `snapshot()` (output) and `restore()` (input). No JSON-ish or structured-object form on the API.
- v1.0.0 ships an `inspect(blob): InspectionResult` helper for debug and preset-library construction. `inspect` is read-only.
- The blob's binary layout (header, slot table, schema hash) is the framework's internal representation; consumers do not parse it directly. Migration helpers (`parseSlot` / `parseBuffer` / `parseParam` in §8.3.1) are the supported way to read blob contents.

**Decision (Q5-d):** authoritative wording in `05-client.md` §6. Summary:

- `snapshot()` and `restore()` are **block-atomic**: state changes do not happen mid-block, and snapshot reads never observe a half-updated linear memory.
- Synchronization uses a flag protocol (Atomics on SAB, postMessage flags otherwise). Audio-thread cost is one `memcpy` per acquired snapshot or restored blob, not per block.
- `await node.snapshot()` resolves after the snapshot region has been read into a `Uint8Array`. `await node.restore(blob)` resolves at the moment the new state takes effect for subsequent samples (not when the blob was handed off).
- API surface is identical with or without SAB; transport implementation differs (shared region + Atomics vs pre-allocated `Uint8Array` + postMessage transfer). Realtime safety is preserved in both modes.
- The framework does **not** provide audio fade / crossfade. State changes block-atomically; smoothing musical discontinuity is consumer territory. The crossfade-via-`GainNode` pattern is documented as a recipe in `05-client.md` §6.4.

**Decision (Q5-e):** authoritative wording in `01-dsl.md` §8.3. Summary:

- Each blob carries a `schemaHash` derived from the processor's declarations (slot set, types, profile flags, sizes) computed at compile time. The current `schemaHash` is emitted to `dist/schema-hash.json`.
- Restore handles three levels of mismatch:
  - **(a) detection**: blobs from incompatible schemas never silently corrupt — the framework either migrates, partial-restores by name, or rejects with a structured error.
  - **(b) name-match partial restore**: when no migration is registered, slots that share name and compatible type are written back; missing / mismatched slots are reset and reported in `RestoreResult.{ skipped, missing }`.
  - **(c) declarative migration chain**: developers register `migrations([{ from, to, migrate }, ...])`; the framework walks the resulting directed graph from `blob.schemaHash` to `currentSchemaHash`, applying entries in order with hash verification at each step. Adjacent `from → to` steps chain automatically — N-version-skipping migrations work without rewriting earlier steps (ORM-style).
- Compile-time validation: hash format, no duplicate `from`, no cycles, current-schema reachability. Reachability failure is a build warning by default; `{ strict: true }` makes it an error.
- `migrate` receives `MigrationHelpers` (parse / write for slot / buffer / param, profile-scoped variants, metadata). Slots not explicitly written are auto-carried from the old blob to the new blob when name and type match in both schemas.

**Rationale (Q5-a):**

Preset save/load and session restore are foundational to the kinds of audio devices unworklet exists to enable. Cutting them ("the consumer can serialize params themselves") would force every processor author to hand-build a state-marshalling layer on top of the framework's primitives — exactly the kind of structural hole that turns a foundation into a toolkit users must complete. The TS-first / graph-capture design also makes the slot-table emission essentially free (compile-time reflection over declarations), so the cost is in implementation not API design.

**Rationale (Q5-b):**

- *Declaration-side `snapshot` flag*: lets the slot itself carry its persistence policy. Centralizing the policy at the declaration site means refactoring a slot does not silently change preset semantics elsewhere.
- *`'persistent'` default for `state` / `param`, `'transient'` default for `buffer`*: tracks the typical case (scalar / param values are usually load-bearing for preset identity; buffers are usually accumulation regions). The default minimizes the amount of `snapshot:` annotations a typical author writes, while leaving full control on either side.
- *Per-profile record form*: the same slot can have different persistence in different contexts (a delay line is `'transient'` for preset-save, `'persistent'` for session-restore). A binary `'persistent' | 'transient'` only would force consumers to maintain parallel processors or post-process blobs — both worse than letting declarations express the dimension natively.
- *User-defined profile names*: `'preset'` and `'session'` are conventions in some DAW cultures, but every host / plugin format / app has its own taxonomy. Reserving names at the framework level would constrain consumers; user-defined names route the constraint to where it belongs (the consumer's data model). Same shape as Q4-d's "deliver the raw material, leave the abstraction to consumer culture" pattern.
- *Auto-collection of profile keys*: graph capture already enumerates declarations to build the slot table; deriving the profile set as a free byproduct keeps the surface declarative and avoids a separate "register profile" step.

**Rationale (Q5-c):**

- *`Uint8Array` blob surface*: a single canonical form keeps the API minimal. `Uint8Array` is universally transportable (IndexedDB, fetch, postMessage, file system, network), maximally compact, and stable across runtime versions in a way that JSON-ish surfaces are not.
- *Read-only `inspect(blob)` in v1.0.0*: debug ergonomics are crucial for preset-library tooling. Shipping the read side from day one eliminates the "I have a blob but no way to look inside" moment without committing to a writable structured form (which would compete with the canonical surface and create two paths to maintain).
- *No structured-object form for write*: would create an alternative source-of-truth for blob contents, with parallel validation paths and migration logic. The blob is the SSoT; new blobs are constructed via `snapshot()` or migrations.

**Rationale (Q5-d):**

- *Block-atomic semantics*: anything sub-block creates either race hazards (main reads partially updated memory) or audible discontinuities (state changes mid-render quantum). Block-atomic is the unique boundary that satisfies both, and it falls naturally out of the audio-thread's render quantum cycle.
- *Flag-based synchronization*: avoids any blocking on the audio thread. The audio thread checks a flag once per block; the cost is a single load per quantum and a `memcpy` only when an operation is in flight. No mutexes, no `Atomics.wait` on the audio side.
- *Promise resolves on application, not handoff*: the consumer's natural mental model is "after `await restore(blob)`, the state is the blob". Resolving on handoff would create a 1-block window where consumers could see stale state, leading to subtle bugs in code like `await restore(); doSomething();`.
- *No built-in fade / crossfade*: musical smoothing is fundamentally a consumer concern (live vs studio context, scene length, curve preference). Embedding one choice in the framework would force consumers whose context expects a different choice to fight the framework. The crossfade-via-`GainNode` pattern is well-known and composable; documenting it as a recipe in §6.4 covers the canonical case without locking it in as API.

**Rationale (Q5-e):**

- *Hash-based schema identity*: derived from declarations at compile time, so it tracks the actual schema state rather than a manually maintained version number. Developers cannot forget to bump it; renames or type changes automatically yield a different hash.
- *Adjacent `from → to` chain (ORM-style)*: lets developers write each schema change once. N-version-skipping migrations work without re-deriving combined transforms — the graph traversal handles arbitrary skips. This is the only design that scales to long-lived plugins (DAW sessions can be opened years after authoring).
- *Three-level fallback (migrate → name-match → declaration default)*: each level handles a distinct severity of mismatch. Migrate covers schema-aware transforms; name-match covers small additions / removals where slot names survived; declaration default covers slots the blob never had. Together they ensure `restore()` never silently corrupts state and always produces a defined result.
- *Reachability validation as build-time warning, not error*: many schema changes are simple additions where name-match restore is sufficient. Forcing a migration entry for every such change would be friction for the common case. `{ strict: true }` lets stricter teams elevate it.

**Rejected (Q5-a):**

- *Defer snapshot/restore beyond v1.0.0* — would force every preset-needing processor to implement state marshalling on top of primitives, leaving a structural hole at the foundation. The cost is in implementation, not in API design (TS-first reflection makes the slot-table emission near-free).
- *Surface only `param` snapshots, leave state/buffer to consumer* — would silently lose internal state (filter z1, oscillator phase, sequencer step), so "loading a preset" would not actually reproduce the same sound. Not a real preset semantics.

**Rejected (Q5-b):**

- *Single `'persistent' | 'transient'` flag, no profile concept* — would force consumers to maintain two separate processors (one for preset, one for session) or to post-process the blob to drop unwanted slots. Both worse than letting declarations express the dimension natively. The "minimal v1.0.0 + add profile in v1.x.0" path was a defer trap (see `feedback_no-preemptive-defer.md`); the per-profile record is shape-on-API and additive insertion would create a two-tier mental model.
- *Framework-reserved profile names (`'preset'`, `'session'` as enums)* — picks a DAW culture (Ableton vs Tone.js vs Bitwig vs custom apps) at the framework level, constraining consumers whose context expects a different taxonomy. Same trap as Q4-d.
- *`'persistent'` default for `buffer`* — would cause large delay lines / FFT scratch buffers to bloat preset blobs by megabytes for the typical case, when the contents are usually irrelevant to preset identity. `'transient'` default with explicit `'persistent'` for wavetables tracks intent more closely.
- *No `name` requirement* — would force the framework to identify slots by source position or AST hash, both of which break under refactoring (reordering declarations, extracting helpers). Explicit names give the developer a stable identity over time.

**Rejected (Q5-c):**

- *Structured-object surface (e.g. `node.snapshot(): Promise<{ slots: Record<string, ...> }>`)* — would compete with the blob as SSoT, creating two parallel paths for serialization, validation, and migration. The blob is the SSoT; structured views are read-only debug helpers.
- *Defer `inspect()` to v1.x.0* — debugging blob contents is a day-one ergonomics need; deferring it would push every author to guess at blob layouts. The implementation cost is small (the slot table is already in the blob), so deferring fails the "is this defer constructive?" test (`feedback_no-preemptive-defer.md`).
- *JSON-text blob form alongside `Uint8Array`* — would force two encodings, two parsers, and two validation paths. The `inspect()` helper covers the human-readable need without doubling the surface.

**Rejected (Q5-d):**

- *Sub-block (sample-accurate) snapshot/restore* — would either require pausing the audio thread (breaking realtime safety) or admit observable mid-quantum state updates (audible discontinuities, race hazards on multi-slot reads). Block-atomic is the realtime-safe boundary.
- *`silent: true` option (output silence during the transition block)* — replaces one discontinuity (state change at block boundary) with another (output drop to zero), so it does not solve the underlying click-on-jump problem. `GainNode`-based crossfade in user code does solve it, and is documented as the canonical pattern in §6.4.
- *Built-in fade with configurable curve / time* — would require the framework to commit to one or more curve families (linear / equal-power / exponential / S-curve) and a default fade time, both of which vary by consumer culture (live vs studio, scene transitions vs AB compare). Q4-d's "raw material, not abstraction" pattern applies.
- *`restore()` Promise resolves on handoff (before audio thread applies)* — creates a 1-block window where consumers could observe pre-restore state, breaking the natural `await restore(); doSomething();` mental model. Resolving on application is the semantically clean choice.

**Rejected (Q5-e):**

- *Single-step migration only (each `migrate` directly produces the current schema)* — works for one schema change but forces developers to rewrite migrations for every prior schema each time the schema changes. Does not scale to long-lived plugins. The chain form lets adjacent steps compose.
- *`fromHash` only, no `toHash`* — leaves the framework guessing at intermediate schema states, so chain validation cannot verify that adjacent migrations actually compose correctly. Explicit `from`/`to` makes errors detectable at build time.
- *No reachability validation* — silently allows unreachable schemas, where users with old blobs hit "blob format error" at runtime instead of seeing a build warning. Build-time validation is cheap and catches the developer before users do.
- *Manual schema versioning (developer maintains a `version: 3` field)* — fragile (developer forgets to bump on schema-changing PRs), error-prone, and decouples version identity from actual schema content. Hash-derived identity is automatic and tracks reality.
- *Auto-migrate everything (including type changes)* — lossy and silent. A type widening (`f32 → f64`) is reasonable to auto-handle, but a type narrowing or unit change is application-specific. The migration `migrate` callback is the right place for those decisions; making them implicit hides intent.

---

## Q6 — Multi-output processors

**Status:** resolved.

**Decision:** authoritative wording in `01-dsl.md` §1. Summary:

- **Declaration helpers**: `audioInput({ channels, name })` and `audioOutput({ channels, name })` live in declaration scope only. Same pattern as `state` / `buffer` / `param`. Calling them in expression scope is a graph-capture-time error.
- **Always explicit**: a processor has no audio I/O unless it declares it. No "default mono in / default mono out" sugar; no implicit return-value-as-output shortcut. Every audio port is a declaration.
- **Required `name`**: every `audioInput` / `audioOutput` must carry a `name`. Names are slot identities for the port and the keys for main-thread typed access.
- **Typed channel access**: both forms narrow `channelIndex` to the legal range for the declared channel count (`channels: 2` → `0 | 1`). The sugar form `read(c)` and explicit form `at(c, i)` both narrow `c`; the sugar form `write(values)` requires a tuple whose length equals `channels`, while the explicit form `set(c, i, v)` narrows `c` and types `v` as `Node<'f32'>`. Both forms are checked at TypeScript / graph-capture time. The two-form split (sugar / explicit) is settled in Q22-b — see `decisions-log.md` Q22.
- **Multi-port support is symmetric**: any number of inputs and outputs can coexist with arbitrary channel counts; the count is the declaration count, mapped directly to Web Audio's `numberOfInputs` / `numberOfOutputs` and `outputChannelCount[]`.
- **Main-thread typed access**: `node.inputs.<name>` and `node.outputs.<name>` provide typed `connect()` / be-connected-to wrappers over the underlying `AudioWorkletNode`. The raw `AudioWorkletNode` is always reachable as `node.node` for advanced patching.

**Rationale:**

- *Declaration helper pattern over `ctx.inputs[i][j]` / `ctx.outputs[i][j]`*: the index-based form (a direct mirror of Web Audio's array-of-array I/O) does not narrow in TypeScript and gives no slot identity for tooling, snapshot, or main-thread access. The declaration pattern produces a typed handle, a stable name, and a uniform mental model with state/buffer/param.
- *Always explicit (no default sugar)*: shipping a "declarations-zero processor returns a `Node<'f32'>` that becomes a default mono output" shortcut would make the API contract of `process` depend on whether declarations exist — two mental models for one feature, and a refactoring cliff when a single-output processor grows a second output. Forcing every processor to declare its I/O explicitly makes the shape stable and the rule one-line.
- *Required `name` even for single I/O*: integrates with the slot-identity rule for snapshot (Q5), keeps main-thread access readable (`node.outputs.main` over `node.outputs.out0`), and matches the convention authors already use mentally when writing the processor.
- *Typed channel access*: leveraging TypeScript's literal types for `channelIndex` and tuple length for `write()` catches a class of bugs (off-by-one channel access, mismatched stereo writes) at edit time rather than runtime — exactly the value proposition of TS-first DSP authoring.
- *Pass-through to Web Audio mixing rules for input channel matching*: the source side of an `AudioWorkletNode` connection is governed by Web Audio's standard `channelInterpretation` / `channelCountMode`. Re-implementing that mixing logic in unworklet would either diverge from spec (surprise) or duplicate behavior already provided by the host (waste). The declaration's `channels` is the worklet's view; sources are normalized to it by the host.
- *Raw `AudioWorkletNode` accessible as `node.node`*: typed wrappers are sufficient for the common cases, but consumers patching unusual graph topologies (input rate-converters, dynamic re-routing, channel splitter/merger nodes) need the raw node. Hiding it would cripple advanced use; exposing it costs nothing.

**Rejected:**

- *Index-based `ctx.outputs[i][j]` API* — direct mirror of Web Audio's I/O array structure, but (1) yields no TypeScript narrowing, (2) gives no slot identity for naming / snapshot / typed main-thread access, (3) does not match the declaration pattern that already governs state/buffer/param. The "Web Audio purism" benefit is hollow because the framework already abstracts most of Web Audio anyway.
- *Default mono in / mono out sugar (declarations-zero processor)* — saves a few lines for the simplest example but introduces a two-mode API contract (declarations or no declarations) and a refactoring cliff. The boilerplate cost is paid once per processor file, the mental-model cost is paid every time someone reads code. The trade-off is one-sided.
- *Optional `name` with default `'in0'` / `'out0'`* — generates names that read worse than the explicit form and split the slot-identity rule (snapshot already requires explicit names; making audio I/O optional creates a two-tier rule for the same concept).
- *Process lambda return value as the default output* — clean for trivial cases but conflicts with the L1 helper return-shape rules (`01-dsl.md` §5.5.3) where return values become independent graph terminals. Reusing the same return-shape grammar for two different purposes (helper terminals vs default audio output) creates an ambiguity that has to be resolved by special cases.
- *`channels: number` validated only at runtime* — undermines TS-first authoring; the framework's job is to surface DSP bugs at edit time, not to discover them via console errors after a deploy.

---

## Q7 — Sub-rate computation

**Status:** resolved.

**Decision:** authoritative wording in `01-dsl.md` §9. Summary:

- **Single primitive `everyNSamples(N, callback)`** in expression scope. Callable from `process` lambdas, L1 helper bodies, and `defineSubgraph` `process` lambdas; not callable from declaration scope.
- **Graph-capture-time meta primitive**: the callback body is evaluated once during graph capture; the resulting nodes are recorded as belonging to an `N`-rate sub-block. Compiled into a WASM branch keyed off the processor's internal sample counter.
- **State slots inside the callback** hold their value between updates (zero-order hold). Reading them in the audio-rate body returns the most recent stored value.
- **No new declarations inside the callback**: callback body is an expression scope; declarations are graph-capture-time errors. Same rule as L1 / subgraph `process` bodies.
- **Multiple sub-rate blocks coexist** at any divisor, sharing the global sample counter, executing independently.
- **Orthogonal to `AudioParam` automation rate**: `param({ automationRate, ... })` continues to be Web Audio's standard k-rate / a-rate; `everyNSamples` is purely about *internal* state-update rate. Reading an `AudioParam` value at a coarse rate is expressed by wrapping the read in an `everyNSamples` callback and storing into a `state` slot.
- **CPU spike is consumer responsibility**: `everyNSamples` reduces average CPU but not worst-case. Spike smoothing (partitioned algorithms, cross-processor offload) is application-level. Q9 (cross-processor communication) is the natural escape hatch for heavy out-of-band computation.
- **v1.0.0 scope**: only `everyNSamples(N, callback)` ships. Future primitives in the same family (`everyTimeMs`, `atSampleRate`, etc.) are additive in v1.x.0 — sample-count-based rate-down is the foundation; alternative units are layered helpers.

**Rationale:**

- *Single primitive over multi-axis declaration*: `everyNSamples` is the smallest surface that covers the entire rate-down use case (LFO, envelope, mod matrix, FFT, automation rate-limiting, etc.). Adding a second declaration kind (case C: `controlState` + `controlProcess`) would force users to learn two parallel models for one concept; the callback form keeps the existing `state` / `buffer` / `param` declaration kinds untouched and adds one expression-scope primitive.
- *Callback form over `if (slot.shouldUpdate())`*: unworklet's core rule prohibits JS `if` as a runtime branch in `process` bodies (control flow is `select`-based). Building rate-down on top of a meta-`if` (case B) would create a special case that contradicts the rule and confuses readers. The callback form makes "this is a graph-capture-time meta primitive" visible in the syntax (`everyNSamples(N, () => ...)`) and contains the special semantics inside that primitive.
- *Callback form over expression-level rate annotation* (case H: `kRate(expr, { divisor })`): rate annotation on a single expression makes multi-statement sub-blocks (FFT stages, multiple correlated state updates) awkward — the user has to bundle them into one expression. The callback form admits any number of statements naturally.
- *Hold semantics on `state.load()` between updates*: zero-order hold is the simplest and most predictable interpolation; framework-provided linear interpolation would commit to a specific smoothing curve that may not match the consumer's needs. Consumers wanting smoothing can write it explicitly (a one-pole IIR over the held value, for instance).
- *Sample-count `N` over time-unit `ms` for v1.0.0*: sample count is the audio thread's natural unit and avoids hidden conversions when sample rate changes. Time-unit primitives (`everyTimeMs`) are useful but build on top of sample-count rate-down — adding them in v1.x.0 does not change the underlying mechanism.
- *Orthogonality with AudioParam automation*: clean separation lets each layer evolve independently. AudioParam automation is Web Audio's territory (and rate-of-arrival is its language); rate-of-internal-computation is unworklet's territory. Mixing the two would require either embedding AudioParam logic into `everyNSamples` or hijacking `automationRate` for sub-rate work — both worse than the orthogonal design.
- *CPU spike not absorbed by the framework*: spike-flattening (partitioned algorithms, dual processors) is application-pattern-specific and depends on tradeoffs (memory, latency, code complexity) only the consumer can resolve. Forcing a flattening strategy into the framework would over-generalize.

**Rejected:**

- *Case A — no rate-down support* — would force users to write `select(eq(mod(c, N), 0), expr, prevValue)`, which two-side-evaluates `expr` every sample due to `select` semantics. Cannot rate-down heavy work (FFT, neural inference); structurally cripples the m4l / VST-equivalent processors that unworklet exists to enable. Same trap as the once-considered "no SIMD in v1.0.0" path (Q3).
- *Case B — `state.f32(..., { updateEvery: N })` + `if (slot.shouldUpdate())`* — needs a graph-capture-time meta-`if` to work, contradicting unworklet's "no JS `if` in process body" rule. The callback form (case D) achieves the same outcome without breaking the rule.
- *Case C — `controlState` + `controlProcess` two-layer model* — adds two new declaration kinds (`controlState`) and a new lambda (`controlProcess`) to express something that fits in one expression-scope primitive. Heavier on learning and on graph-capture machinery; no expressiveness gained over case D.
- *Case E — implicit rate-flow analysis* — relies on framework inference to decide which expressions can be evaluated at coarser rates. Cannot express forced rate-down at arbitrary divisors (only the implicit a-rate / k-rate boundary), and the implicit decision-making makes performance unpredictable to the user.
- *Case H — `kRate(expr, { divisor })` expression-level annotation* — works for single-expression rate-down but bundles multi-statement sub-blocks (FFT stages, correlated state updates) into one expression awkwardly. The callback form composes statements naturally.
- *Auto-flatten CPU spikes inside `everyNSamples`* — would require the framework to decompose user-supplied work into per-sample increments. The decomposition strategy depends on algorithm structure (FFT butterflies, neural-net forward passes, etc.), which the framework cannot infer. Leaving spike management to user code (partitioned algorithms, cross-processor offload via Q9) keeps the primitive simple and lets consumers pick the right pattern.
- *Time-unit primitives (`everyTimeMs`) in v1.0.0* — additive without changing the underlying mechanism (sample-count rate-down). Shipping them in v1.x.0 is non-blocking; deferring is consistent with `feedback_no-preemptive-defer.md` (PoC + parallel agent extension category — sample-count is the foundation primitive, time-unit conversion is a layered helper).

---

## Q8 — Multi-block lookahead

**Status:** resolved — out of scope.

**Decision:** unworklet core does not provide built-in lookahead abstraction. No `audioInput({ lookahead: N })` declaration option; no `node.latency` property; no `defineSubgraph({ latency })` annotation; no compile-time auto-delay insertion; no main-thread `UnworkletManager` mechanism. Authoritative wording: `05-client.md` §7 (recipe for application-side latency compensation).

The raw materials needed to author lookahead-style processors are already in the framework:

- `buffer.f32` for the ring buffer that stores past samples (and provides "future" reads via offset arithmetic against the write position).
- `state.i32` for the write-position counter.
- L1 helper functions and `defineSubgraph` for packaging this pattern into reusable building blocks (e.g. a third-party `lookaheadInput` helper distributed in a downstream DSP package).
- `audioContext.createDelay(...)` on the main thread for application-side latency compensation between processor instances and against parallel paths.

Cross-processor latency compensation is fundamentally application territory in the web platform. Web Audio defines no plugin-latency-reporting API and no host-level automatic compensation; any framework abstraction is forced to either re-implement DAW-host-style coordination (which conflicts with `AudioContext` graph ownership) or remain a partial / opaque solution. Both fail.

**Rationale:**

The scope decision rests on two structurally inseparable points:

1. **Web platform constraint**: Web Audio's `AudioContext` is the graph owner. Plugin-level latency reporting and automatic compensation are not part of the spec, and any framework that bolts a parallel coordinator on top runs into AudioContext / framework dual-ownership conflicts that cannot be resolved cleanly. unworklet's `project_unworklet-scope-framing.md` explicitly lists "latency reporting" as out of scope; this decision affirms that boundary.
2. **Framework declarative philosophy**: any abstraction that auto-inserts delay or rewrites user-authored graphs at compile time violates unworklet's core principle ("the user writes the graph; the compiler emits exactly that graph"). The convenience comes at the cost of debug transparency, consumer-culture independence, and the contract that "code in equals graph out" — see `feedback_framework-magic-anti-pattern.md`.

The raw materials (`buffer`, `state`, `defineSubgraph`, `audioContext.createDelay`) are sufficient to express any lookahead-style processor and any application-level compensation pattern. The "cost" of writing the wiring explicitly is paid back by debugability, predictability, and consumer freedom to pick whichever latency-compensation strategy suits their context (live performance, studio session, scientific phase-precise composition, etc.). This matches the pattern established for transport (Q4-d), snapshot profiles (Q5-b), and sub-rate computation interpolation (Q7): "deliver the raw material, leave the abstraction to consumer culture."

**Rejected alternatives** (each was considered and analyzed against the framework's core philosophy):

- *Direction B — `audioInput({ lookahead: N })` declaration option + internal ring buffer + `node.latency` property*. The internal ring buffer is a thin wrapper over `buffer.f32` + `state.i32` that the user can write themselves; the `node.latency` property has no real consumer (a processor's author already knows its latency at authoring time, and no automatic compensation hooks into it). The option's value collapses to "syntactic sugar for ring buffer wrapping", which is L2-helper-level work, not core-framework work.

- *Direction C — Main-thread `UnworkletManager` coordinator that automatically inserts `DelayNode`s into the audio graph*. Conflicts with `AudioContext` graph ownership (dual API / dual state-tracking with no clean resolution); cannot handle non-unworklet `AudioWorkletNode`s or other Web Audio nodes (partial solution); directly contradicts the "latency reporting out of scope" boundary in `project_unworklet-scope-framing.md`; commits the framework to one specific compensation strategy (min-latency vs branch-isolated vs aligned) at the expense of consumer culture; and would require the framework to own graph viz / debug surfaces that are normally a host's responsibility.

- *Direction D — `defineSubgraph({ latency: N }, ...)` annotation + compile-time graph latency analysis + automatic `DelayLine` insertion in WASM emission*. Violates the framework's core declarative philosophy: user-authored graphs would be silently rewritten with delay nodes the user did not write. Debug transparency is destroyed (the WASM graph diverges from the source code); declared-vs-actual latency mismatches in subgraphs become silent correctness bugs; the framework picks a compensation strategy on the consumer's behalf. The "convenience" appeal of this direction is exactly the warning signal flagged in `feedback_framework-magic-anti-pattern.md`. Direction D is a cleaner-looking variant of Direction C's core failure (framework taking ownership of graph rewriting that should remain explicit user authorship).

- *Direction E — Implicit rate-flow / latency-flow analysis*. Same family of objections as D: silent graph rewriting, opaque debug surface, framework picking strategies on the consumer's behalf.

**The "out of scope" conclusion is reached by full enumeration of the option space, not by giving up.** Each direction was structurally evaluated against the framework's philosophy, the web platform's constraints, and the unworklet scope statement, and each fails on at least one of those axes. The raw materials in unworklet are sufficient.

This decision does not preclude third-party DSP packages from publishing reusable `lookaheadInput`-style L2 helpers built on `defineSubgraph` + `buffer` + `state`. Those are downstream work, governed by package authorship conventions, and explicitly outside unworklet's core surface.

---

## Q9 — Cross-processor communication

**Status:** resolved — out of scope.

**Decision:** unworklet core does not provide a built-in mechanism for direct audio-thread-to-audio-thread communication between `AudioWorkletNode`s (= the case where two `AudioWorkletProcessor`s share state via `SharedArrayBuffer` without going through the main thread). Authoritative wording: this entry.

The umbrella "cross-processor communication" decomposes into five use cases; four are already covered elsewhere, leaving only one for this scope decision:

- (a) Unidirectional **audio signal** between processors → covered by Web Audio's `connect()` and unworklet's typed wrappers (`node.outputs.<name>.connect(otherNode.inputs.<name>)`, see Q6).
- (b) **Side-chain audio** (a separate audio path consumed as `audioInput`) → same as (a).
- (c) Cross-processor **message / event** delivery → main-thread-relayed via the generic typed messaging surface (`node.events.<name>.on(...)` of one processor wired into `node.messages.<name>(...)` of another). The generic messaging core surface itself is tracked as a separate (not-yet-grilled) question in the backlog and is **not** out of scope.
- (d) Cross-processor **shared state via direct SAB sharing between audio threads** (no main-thread relay, no audio routing). This is the one Q9 specifically rules on. **Out of scope** — see rationale.
- (e) **Heavy computation offload** to a parallel processor → covered by (a) at the routing level. Choice of computation strategy (partitioned algorithm, dedicated processor, etc.) is consumer territory.

**Rationale:**

- Web Audio defines no spec-level mechanism for audio-thread-to-audio-thread direct communication. SAB sharing between two `AudioWorkletProcessor`s is technically possible by passing the same SAB through `processorOptions` to both, but the protocol (atomics, ring-buffer layout, lifetime, discovery) is application territory.
- Any framework abstraction that wraps SAB sharing for two unworklet processors needs main-thread wire-up to discover the channel and inject the SAB into both `processorOptions`. That wire-up either (i) happens implicitly in a manager-style coordinator (which conflicts with `AudioContext` graph ownership and consumer-culture independence — same trap as Q8 Direction C) or (ii) is left explicit on the user, in which case the abstraction's value collapses to a thin SAB ring-buffer wrapper, which is L2-helper-level work, not core-framework work.
- The "direct SAB sharing" use case is narrow in practice: most cross-processor needs fall into (a)/(b)/(c)/(e) which are already covered. The remaining cases (e.g. low-latency shared LFO read by multiple processors) are addressable by either routing as audio (a) or relaying through main thread (c), with negligible practical loss.
- Holding to scope here is consistent with `feedback_framework-magic-anti-pattern.md`: framework-managed graph composition that the user did not write themselves is rejected. SAB sharing between processors is exactly such a hidden-by-framework wiring if abstracted at the core level.

**Rejected alternatives:**

- *`crossProcessorChannel` declaration helper that auto-shares a SAB ring buffer between two processors* — relies on a main-thread coordinator to embed the same SAB into both `processorOptions`. Either the coordinator is implicit (= the framework wires it behind the user's back, hitting the same trap as Q8 Direction C) or explicit (= the user writes the wire-up, in which case the abstraction is just a thin SAB-API wrapper, L2-helper-level).
- *Compile-time type-safe channel binding* (`defineChannel<'f32'>(...)` paired between two processors with framework-managed runtime SAB injection) — same coordinator problem; the type-checking layer doesn't change the runtime wire-up issue.
- *`UnworkletManager`-style cross-processor coordinator* — fully equivalent to Q8 Direction C with the same rejection profile (AudioContext dual ownership, consumer-culture lock-in, scope-statement contradiction).

**Recipe (out-of-scope but consumer guidance)**: applications that need audio-thread-to-audio-thread SAB sharing pass the same `SharedArrayBuffer` through both processors' `processorOptions` and implement their own atomics protocol. A worked example may land as a recipe in `08-deployment.md` if a downstream case justifies it; otherwise consumers can author this directly as part of their application code.

**Companion item to file**: the generic typed messaging core surface (referenced above as case (c)'s underlying mechanism) is currently not on the question backlog. It is **not** out of scope — it must be grilled and resolved before v1.0.0. The question backlog will be updated to add it explicitly during the upcoming backlog re-organization.

---

## Q22 — Graph capture model and process body structure

**Status:** resolved (Q22-a / Q22-aprime / Q22-b / Q22-c three-layer structure fixed; Q22-d error message format and refactor-hint structure are open and tracked separately).

**Decision (Q22-a — Mental model):** authoritative wording in `00-foundations.md` §3 + `03-compiler.md` §2. Summary:

- The `process` lambda is **a meta-program evaluated once at build time**. Calls inside its body — `add`, `mul`, `state.load()`, `audioIn.read(0)`, etc. — construct AST nodes; arithmetic does not execute, audio is not read, state is not stored. The lambda's role is to assemble a graph DAG that captures the user's intent.
- The framework emits the captured DAG as the body of a per-sample loop in WebAssembly. The audio thread runs the WASM loop; user TypeScript is not re-entered per sample.
- **Build-time JavaScript is real JavaScript.** `if`, `for`, `+`, `*`, `Math.*` over build-time values (literals, build-time constants, results of static computation) execute normally and shape the captured graph statically. Compile-time loop unrolling, debug-flag pruning, and constant precomputation are first-class authoring patterns, not workarounds.
- **`Node<T>` is incompatible with JavaScript operators at the type level.** Branded types reject `nodeA + nodeB`, `if (nodeBool) { ... }`, `for (... ; nodeCmp ; ...)`. The author writing such code gets an immediate TypeScript type error in the IDE, before any build runs. The framework leverages TS's type system as an **educational lever** that directs authors to `add` / `mul` / `select` without needing runtime checks or lint rules.

**Decision (Q22-aprime — Process body structure):** authoritative wording in `01-dsl.md` §1, §10. Summary:

- All per-sample loops are expressed via the **`forSample` primitive** (working name; the final spelling may be revised before v1.0.0 finalization).
  - `forSample((i: Node<'i32'>) => void)` — the callback body is the per-sample loop body. `i` binds to the loop counter at WASM-emission time.
  - `forSample.byN(stride: number, (i: Node<'i32'>) => void)` — same shape, but iterates with the given compile-time-constant stride. Typical use is `stride = 4` for SIMD bulk operations (paired with `loadVec` / `storeVec`); other strides are permitted.
- A `process` body may contain zero, one, or many `forSample` / `forSample.byN` calls. Each call is a **phase**; multi-phase processors (e.g. input-shaping → bulk SIMD → output-shaping) are written as multiple `forSample` calls, executed in declared order.
- A `process` body that contains zero `forSample` calls and writes per-sample primitives directly is interpreted as having **a single implicit `forSample` wrapping the entire body** — this is the **sugar form**. Single-phase per-sample plugins (gain, oscillator, simple filter) use this form to avoid `forSample(...)` boilerplate.
- The `process` lambda **does not take an `i` argument**. The earlier candidate of `process: ({ i }) => void` is rejected: `forSample` strictly subsumes that form (single-phase `forSample` with no outer code is exactly equivalent), and parallel surfaces would split the mental model.

**Decision (Q22-b — Sample-position primitives):** authoritative wording in `01-dsl.md` §1.2, §1.3, §3.3, §10. Summary:

| Concept | Sugar form (implicit `forSample`) | Explicit form (inside `forSample` callback) |
|---|---|---|
| Read audio input | `audioIn.read(c): Node<'f32'>` | `audioIn.at(c, i): Node<'f32'>` |
| Write audio output | `audioOut.write(values: tuple): void` | `audioOut.set(c, i, v): void` |
| Read parameter | `param(): Node<'f32'>` (callable) | `param.at(i): Node<'f32'>` |

- The two forms have **distinct method names** (`read` vs `at`, `write` vs `set`, callable `param()` vs `param.at(i)`). One glance at a call site reveals which form is in use; readers do not have to count arguments or check surrounding scope.
- Explicit-form primitives (`at` / `set` / `param.at(i)`) require a `Node<'i32'>` argument that originates from a `forSample` callback parameter. A user writing `audioIn.at(0, i)` outside any `forSample` gets a TypeScript scope error (`i` is undefined) — no graph-capture-time error or lint rule needed; standard TypeScript scoping handles enforcement.
- Sugar primitives (`read` / `write` / `param()`) work in **both** contexts. Outside `forSample` they refer to the implicit per-sample iteration; inside an explicit `forSample` they bind to the surrounding `i`. The two are semantically equivalent inside `forSample` (`audioIn.read(0)` ≡ `audioIn.at(0, i)` where `i` is the surrounding callback parameter).
- State (`state.load()` / `state.store(v)`) and buffers (`readBuffer(buf, idx)` / `writeBuffer(buf, idx, v)`) are sample-position-independent primitives shared by both forms; their indices are explicit `Node<'i32'>` values supplied by the user (typically a ring-buffer write head, not a loop counter).
- Mixing sugar and explicit `forSample` in one process body (= top-level direct primitives plus parallel `forSample` calls) is **technically valid**: framework wraps the top-level direct primitives in an implicit `forSample` and runs all phases in declared order. This produces a multi-phase processor. The mix is rarely the cleanest expression of intent (multi-phase processors are usually clearer with explicit `forSample` for every phase), but the framework neither prohibits nor warns; mental-model coherence is a docs / style-guide concern, not a framework-enforced invariant.

**Decision (Q22-c — Error layer structure):** authoritative wording in `03-compiler.md` §2. Summary:

1. **TypeScript type error** (IDE level, before any build): the branded `Node<T>` rejects JS operators. `nodeA + nodeB`, `if (nodeBool)`, `for (... ; nodeCmp ; ...)`, `audioIn.at(0, i)` outside `forSample` (where `i` is undefined). The IDE surfaces these immediately; no framework runtime is involved.
2. **Graph-capture-time error** (build-time, during proxy evaluation of the `process` lambda): scope violations (a declaration call inside expression scope), missing required calls (e.g. `audioOutput.write` not called for a declared output), duplicate stores, declarations missing required `name` for snapshot-using processors, declarations inside `forSample` callbacks, etc. Detected by the framework as it executes the `process` lambda with proxies.
3. **Static-analysis error** (post-capture, before WASM emission): allocation check (an AST pattern would imply heap alloc), unbounded loops (build-time loops without a static bound), memory-size violations (sum of declarations exceeds the configured budget), type-inference inconsistencies. Detected by the framework's analysis pass over the captured DAG.

The detailed format of error messages and refactor-hint structure (Q22-d) is open and will be resolved after `01-dsl.md` and `03-compiler.md` reach the level of detail where concrete examples drive the format choice.

**Rationale (Q22-a):**

- *Meta-program with build-time evaluation*: this is the design that lets "the user writes the graph; the compiler emits exactly that graph" stay tractable. Per-sample primitives become AST builders; the captured DAG is a transparent representation of intent; graph-capture-time analysis catches whole classes of shape violations before WASM is emitted.
- *TS as educational lever*: branded types make `Node<T>` incompatible with JS operators at the type level. This catches the most common authoring mistake (writing `a + b` instead of `add(a, b)`) at edit-time, in the IDE, with zero runtime cost. It is also a positive teaching signal — the type-error message points the author at the primitive they should be using.
- *Build-time JavaScript is real JavaScript*: rejecting `for`, `if`, etc. wholesale would prevent legitimate compile-time uses (loop unrolling, debug-flag pruning, constant precomputation). The clean rule is "JS operates on JS values, primitives operate on `Node<T>` values"; the type system enforces the boundary.

**Rationale (Q22-aprime):**

- *Single primitive (`forSample`) for sample loops*: the SIMD-bulk requirement (Q3 — `loadVec(buf, offset)` for 4-sample-wide processing) demands user control over the loop step. Without an explicit loop primitive, the framework would have to either auto-vectorize (a magic rewrite that violates the declarative principle — see `feedback_framework-magic-anti-pattern.md`) or expose a separate "SIMD mode" parallel surface (which would fragment the API). `forSample` + `forSample.byN(stride, ...)` covers scalar and vector iteration with one primitive family.
- *Multi-phase processors*: production-grade plugins (FFT-based effects, partitioned convolution, oversampling distortion, multiband compressors with bulk pre/post-process) need to express a per-block setup phase, multiple per-sample phases, or a mix. `forSample` exposes phase structure directly; the alternative (squashing everything into one per-sample iteration) either fails to express these patterns or pushes them into ad-hoc helper conventions.
- *Sugar form (implicit `forSample`)*: single-phase per-sample plugins (gain, oscillator, simple filter) make up the majority of teaching examples and a meaningful share of production plugins. Forcing `forSample(...)` boilerplate on these would add visual weight without expressive gain. Treating a `forSample`-free process body as "wrap the whole body in one implicit `forSample`" recovers brevity at zero mental-model cost — the same primitives (`audioIn.read`, `param()`, etc.) work because they bind to the surrounding iteration in both contexts.
- *Rejecting `process: ({ i }) => void`*: this earlier candidate is exactly equivalent to "single `forSample` with no outer setup". Adding it as a parallel surface would create two ways to write the same shape, splitting the mental model and forcing every reader to internalize "is this a `({ i })` processor or a `forSample` processor?". `forSample` is strictly more expressive (multi-phase, outer per-block code) and the sugar form covers the simple case; the `({ i })` form has no remaining niche.

**Rationale (Q22-b):**

- *Distinct method names*: `read` vs `at`, `write` vs `set`, `param()` vs `param.at(i)` make the form visible at every call site. A reader does not have to count arguments or check whether they are inside a `forSample` callback to know which form is active. Naming carries the "sugar form and explicit form should look obviously different" goal directly into the syntax.
- *Scope-based enforcement (no graph-capture error needed)*: `audioIn.at(c, i)` requires a `Node<'i32'>` for `i`. The only source of such a node is a `forSample` callback parameter. Outside any `forSample`, the variable `i` is not in scope, so the call is a TypeScript reference error. The framework enforces nothing at graph-capture time; standard TS scoping does the work, and the user sees the error in the IDE before the build runs.
- *Mixing is technically valid, naturally avoided*: a processor with both top-level direct primitives (sugar) and explicit `forSample` calls is interpreted as a multi-phase processor where the framework treats each contiguous run of top-level direct primitives as an implicit `forSample` phase, and runs all phases — implicit and explicit — in declared (source) order. This is well-defined. In practice, when authors need multiple phases they reach for explicit `forSample` for all of them; the mixed form is unusual rather than wrong, and the framework neither prohibits nor warns. Mental-model coherence is a docs / style-guide concern; the priority gradient is "TS type errors > graph-capture errors > static-analysis errors > runtime errors > docs guidance", and forced uniformity costs land in the lowest-priority bucket.

**Rationale (Q22-c):**

- *Three error layers correspond to three distinct enforcement mechanisms*: (1) TS type errors are surfaced by the editor, require no framework runtime, and catch the largest class of mistakes; (2) graph-capture-time errors run during the build's proxy-evaluation pass and catch shape violations the type system cannot express; (3) static-analysis errors run after capture, on the DAG, and catch deeper violations (memory budget, allocation potential, etc.). The layering reflects "earliest detection is cheapest detection" — every error class is pushed as far up the chain as it can go.

**Rejected (Q22-a):**

- *"`process` runs per sample" mental model* — would force the framework to either re-enter user TypeScript per sample (impossible for realtime safety) or maintain the fiction that it does (sets up wrong intuitions about cost, error timing, and what `if`/`for` mean inside `process`). Build-time evaluation is honest about what is happening.
- *`Node<T>` as a structural type that JS operators can target (operator overloading, `Symbol.toPrimitive`, etc.)* — would either require runtime dispatch (not realtime-safe) or compile-time rewriting (framework magic). Branded types refuse the bait at the type level, the IDE shows the mistake, and the user is directed to the primitive instead.

**Rejected (Q22-aprime):**

- *No loop primitive, only `process: ({ i }) => void`* — cannot express SIMD-stride iteration (4-sample-wide bulk operations) without either auto-vectorization magic or a parallel SIMD declaration. Q3 commits unworklet to first-class SIMD; this candidate is incompatible.
- *Two parallel forms (`process: ({ i }) => void` for single-phase, `forSample` for multi-phase)* — splits mental model, forces readers to track which form a processor uses. `forSample` (with sugar for the single-phase case) covers both with one shape.
- *Auto-vectorization (framework decides 1-step or N-step iteration based on opaque heuristics)* — framework magic. Performance becomes implementation-defined, debugging is opaque, and the rewrite changes observable graph behavior. See `feedback_framework-magic-anti-pattern.md`. The explicit `forSample.byN(N, ...)` lets the user opt into stride-N iteration with full visibility.

**Rejected (Q22-b):**

- *Same method name with arity overload (`audioIn.read(c)` and `audioIn.read(c, i)`, etc.)* — the two forms become visually indistinguishable at call sites. A reader has to count arguments or check the surrounding `forSample` context to know which form is active. Distinct names carry the form information at every call.
- *Property-based current-sample sugar (`param.value` or `param.now()`)* — less direct than the callable form (`param()`). `value` carries the wrong implication ("which value? at what time?"), `now()` injects a sample-position vocabulary that the sugar form is trying to suppress. The callable form reads as "fetch the current value" without committing the sugar form to a sample-position language.
- *Graph-capture-time error or lint rule for "mixing sugar and explicit forms"* — the mix is well-defined; forbidding it costs framework complexity to enforce a docs-level preference. TypeScript scoping already prevents the only invalid mix (using explicit-form `i` outside `forSample`). Other mixes are unusual but not wrong.

**Rejected (Q22-c):**

- *Single-layer error model (everything detected at runtime)* — incompatible with realtime safety. Errors on the audio thread cannot be recovered safely; pre-runtime detection is non-negotiable.
- *Two-layer model (TS errors + runtime errors only)* — collapses graph-capture-time and static-analysis detection into "runtime errors", which lose specificity (the user cannot tell whether the error is about shape, scope, or memory budget). The three-layer structure preserves precise diagnosis.

**Open — Q22-d (Error message format and refactor-hint structure):** the format of error messages produced by each layer (TS type errors, graph-capture-time errors, static-analysis errors) and the structure of refactor hints attached to each error class is not yet resolved. To be addressed once `01-dsl.md` and `03-compiler.md` carry enough concrete examples to drive the format choice.
