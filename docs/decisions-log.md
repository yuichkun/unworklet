# Decisions log

Cross-cutting reference: every resolved design question, recorded with its rationale and the alternatives that were rejected. Component docs link here for the "why" rather than restating it inline.

## Status

skeleton — populated as questions resolve

## Index

| # | Topic | Decision | Authoritative section |
|---|---|---|---|
| Q1 | Scalar type defaults | f32 literal default; explicit conversion only; no implicit widening | `00-foundations.md` §4 |
| Q2 | Third-party DSP helper integration layer | Q2-a/Q2-b resolved (2 layers; no L3; L1 surface settled); Q2-c TBD | `01-dsl.md` §5 |
| Q3 | SIMD scope for v0.1 | (open) | `00-foundations.md` §4 + `01-dsl.md` §2 |
| Q4 | MIDI integration design | (open) | `11-midi.md` |
| Q5 | State snapshot / restore API | (open) | `05-client.md` (TBD section) |
| Q6 | Multi-output processors | (open) | `01-dsl.md` §1 |
| Q7 | Variable-rate control signals | (open; expected to defer) | `10-roadmap.md` §3 |
| Q8 | Multi-block lookahead | (open) | TBD |
| Q9 | Cross-processor communication | (open; expected to defer) | `10-roadmap.md` §3 |
| Q10 | Transport / tempo sync | (open; expected to defer) | `10-roadmap.md` §3 |
| Q11 | Browser quirk normalization | (open) | `08-deployment.md` §2 |
| Q12 | Monorepo tool | (open) | `09-repo-structure.md` §1 |
| Q13 | Initial package layout | (open) | `09-repo-structure.md` §2 |
| Q14 | v0.1 acceptance criteria | (open) | `10-roadmap.md` §1 |
| Q15 | License | (open) | `09-repo-structure.md` §3 |
| Q16 | npm scope | (open) | `09-repo-structure.md` §4 |
| Q17 | Math precision variants | (open) | `01-dsl.md` §2 |
| Q18 | Render quantum handling | (open) | `04-worklet-runtime.md` §3 |
| Q19 | Channel-count specialization | (open) | `04-worklet-runtime.md` §4 |
| Q20 | Pre-warm correctness | (open) | `04-worklet-runtime.md` §5 |
| Q21 | Denormal handling | (open) | `04-worklet-runtime.md` §6 |
| Q22 | Graph-capture error UX | (open) | `03-compiler.md` §2 |
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

**Status:** Q2-a (layer count) and Q2-b (L1 surface) resolved; Q2-c (L2 surface) TBD.

**Decision (Q2-a):** authoritative wording in `01-dsl.md` §5.1–§5.4. Summary: two integration layers — L1 (pure TS function, inlined) and L2 (`defineSubgraph`, stateful, inlined into the parent WASM module). No "separate processor + connect" L3 layer — that case is covered by `AudioWorkletNode.connect()` directly and is outside unworklet's API surface.

**Decision (Q2-b):** authoritative wording in `01-dsl.md` §5.5. Summary:

- L1 helpers are stateless TypeScript functions inlined at the call site, living entirely in expression scope.
- Parameters: `Node<T>`, caller-owned `State<T>` (with `load`/`store`), caller-owned `Param`, and compile-time constants.
- Return: single `Node<T>`, tuples, records, or `void`. Each returned `Node` is an independent graph terminal.
- Precision-generic via TypeScript generics over `'f32' | 'f64'`; Q1's no-implicit-widening still holds inside the body.
- Body forbids new `state.*` / `buffer.*` / `param.*` declarations, `defineSubgraph` declarations, L2 instantiations, and `message` / `event` declarations; allows primitives, `load` / `store` on parameter `State`, `param.at` on parameter `Param`, and calls to other L1 helpers.
- Violations are caught at graph-capture / static-analysis time (compile time, never runtime) and surfaced with refactor-hint error messages. Detailed error-UX policy lives in `03-compiler.md` §2 (Q22).

**Rationale (Q2-a):** L1/L2 inlining means the helper boundary has zero runtime cost, which is the precondition for a healthy third-party ecosystem (filters, oscillators, envelopes, FFT helpers, …) where users can compose freely without worrying about call overhead. The state/no-state split is the cleanest rule for choosing between the two; anything more implicit (auto-promotion, shape inference) blurs graph-capture vs type-inference responsibilities.

**Rationale (Q2-b):**

- *Caller-owned `State<T>` parameters*: lets a parent processor own state across multiple call sites (e.g. per-channel) and delegate logic to a single L1 helper without forcing every state-aware helper into L2.
- *Tuple / record returns*: stereo or multi-tap helpers (e.g. an SVF returning low/band/high) are common; capturing each output as an independent terminal incurs no extra cost.
- *Precision-generic helpers*: avoids forcing third-party authors to ship two definitions for f32/f64. TS generics carry no runtime cost and the no-implicit-widening rule still type-checks inside the generic body.
- *Compile-time enforcement of body constraints*: violations are detectable statically from the source position of `state.*` / `defineSubgraph` calls; surfacing them at runtime would either compromise realtime safety (errors on the audio thread) or require silent fallbacks. Refactor-hint error messages turn the constraint into actionable guidance for the helper author.

**Rejected:**

- *Single unified layer with auto-promotion* (Q2-a) — would auto-classify a function as L1 or L2 based on whether its body calls `state.*`. Makes graph capture and type inference jointly responsible for the layer decision; explicit separation isolates the rules.
- *Four+ layers (e.g. "stateful + sub-processor")* (Q2-a) — premature for v0.1; the rare case of needing an internal sub-processor can be assembled at the host level by composing two `defineProcessor`s.
- *Wrapping `AudioWorkletNode.connect()` as an L3* (Q2-a) — adds API surface for a thing that is already a Web Audio standard. The wrapper would either re-expose the standard verbatim (no value) or paper over its semantics (worse than direct use).
- *User-defined compile-time macros* (Q2-a) — deferred. L1/L2 cover the bulk of the third-party use case; macros can be revisited post-v0.1 if a concrete need surfaces.
- *L1 with no `State<T>` parameters allowed* (Q2-b) — would force every state-touching helper into L2, even simple per-channel `smoothFollow`-style functions. Adds boilerplate without isolating any meaningful invariant.
- *L1 with single-`Node<T>` return only* (Q2-b) — would force common multi-output helpers (stereo, SVF, multi-band split) into L2 or split returns, losing readability without performance benefit.
- *Precision-fixed helpers (no generics)* (Q2-b) — would force third-party authors to ship two copies of every helper for f32/f64, structurally lagging f64 ecosystem coverage.
- *Runtime-checked body constraints* (Q2-b) — would either compromise realtime safety (error on the audio thread) or silently fall back; both worse than static rejection.
