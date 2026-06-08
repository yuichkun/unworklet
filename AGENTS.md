# AGENTS.md

Guidance for AI agents implementing unworklet v1.0.0.

> **Using unworklet (not contributing to it)?** This file is the _contributor /
> implementation_ contract. If you are an AI agent helping someone _build with_
> unworklet, the consumer-facing entry points are:
>
> - [`llms.txt`](./llms.txt) — install-time entry point + DSL quick reference.
> - Package READMEs with the exact call forms:
>   [`packages/core/README.md`](./packages/core/README.md),
>   [`packages/unplugin/README.md`](./packages/unplugin/README.md),
>   [`packages/lang/README.md`](./packages/lang/README.md),
>   [`packages/offline/README.md`](./packages/offline/README.md),
>   [`packages/test/README.md`](./packages/test/README.md).
> - [`.claude/skills/unworklet/SKILL.md`](./.claude/skills/unworklet/SKILL.md) — the same surface as a skill.

## What this repository is

A from-scratch implementation of `unworklet` — a TypeScript-first framework for declarative Audio Worklet DSP, compiled to WebAssembly. The v1.0.0 implementation is being driven by AI agents working in parallel against the specifications in `docs/`.

## Source of truth

- **`docs/`** is the authoritative specification. Read `docs/README.md` first to learn the read order and which component you own. Every component doc links to `docs/decisions-log.md` for the "why" behind any decision.
- If your work touches an area that is not yet covered in `docs/`, **stop and surface the gap** to the human reviewer rather than inventing the missing decision.

## Canonical examples integrity rule (HARD CONTRACT)

`docs/12-canonical-examples.md` is the **integrity anchor** for the entire spec. It is a curated set of self-contained, end-to-end plugin examples that exercise the full surface of unworklet (every primitive, every declaration, every main-side method). Any change to any other file in `docs/` — primitive shapes, declaration shapes, surface listings, decisions, transport contracts — must be cross-checked against the examples there before the change is accepted.

**Required process when modifying any `docs/*.md` (other than `12-canonical-examples.md` itself)**:

1. Identify which examples in `12-canonical-examples.md` exercise the surface you are changing (the `## Coverage` table at the top of that doc maps concept → example numbers).
2. Apply the proposed change to those examples (mentally or as a draft) and verify they still:
   - Compile under the changed surface (no broken signatures, types, or references).
   - Make sense for the realistic use case the example was designed for (no awkward workarounds, no apologetic comments).
   - Preserve the user's mental-model simplicity — the change should not force a production-grade audio plugin author to re-learn a concept they already understood.
3. **If any example breaks or becomes awkward, the proposed change is rejected** until either (a) the change is revised to preserve the example, or (b) the example is updated together with the change as a single coherent revision (and the resulting UX cost is made visible to the human reviewer in the same diff).

This rule is non-negotiable. Spec changes that pass review without an accompanying check against `12-canonical-examples.md` are **out of process**.

The same rule applies in the reverse direction: changes to `12-canonical-examples.md` itself trigger a re-read of the affected component docs to ensure the new example shape matches the spec — examples cannot drift from the spec, the spec cannot drift from the examples.

The purpose of this rule is to keep one question answerable at any time during spec evolution: **"is the user experience still simple, coherent, and production-ready?"** If the canonical examples no longer read that way, the spec change is the wrong shape regardless of how clean it looks in isolation.

## Implementation invariant (HARD CONTRACT)

unworklet v1.0.0 is built incrementally as 14 vertical slices (see `docs/10-roadmap.md` §2). **Minimal / vertical-slice implementations within a phase are by design acceptable**, but the following are **absolutely prohibited**:

1. **Ad hoc implementations that diverge from the spec** — the public API surface (public types, argument shapes, return value shapes, as defined in `09-repo-structure.md` §2.1 + §2.2 and each component doc) must match the spec exactly. Shipping a temporary shape with the intention of fixing it later within a phase is not allowed.
2. **Implementations that are not forward-compatible** — designs that conflict with surfaces added in later phases (e.g. adding declaration kinds, new primitives, main-side methods, or messaging surface extensions) are not allowed. Whatever is implemented within a phase must be a strict **subset** of the final architecture, shaped so that subsequent phases can expand it to a **superset** without rework.

At the start of each phase, consult every doc that touches the surfaces you are working on (`00-foundations.md`, `01-dsl.md`, the relevant component docs, and the applicable questions in `decisions-log.md`), and implement as a subset of the final target shape. "Minimal" means the smallest correct subset — it does not mean "whatever works now, rewrite later."

Even in skeleton phases (e.g. `docs/10-roadmap.md` §2 Phase 2), **declare public types in their final form**. Stub implementations (`throw new Error('not implemented')`, etc.) are fine for the body, but the public type / argument shape / return value shape must match the spec. Subsequent phases fill in the bodies of the already-declared surface.

Violating this rule means the phase completion criteria are not met. A retract in the same commit is required, exactly as with the canonical examples integrity rule.

## Build, test, and lint — Vite+ only

This project uses [Vite+](https://viteplus.dev). All workflows go through `vp`. **Never invoke `npm`, `pnpm`, `yarn`, or `npx` directly** — not in shell, not in scripts, not in CI config, not in test-plan commands.

| Action                                                                          | Command                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Install deps                                                                    | `vp install` (alias `vp i`)                                    |
| Setup git hooks (one-time; runs `vp check --fix` on staged files at pre-commit) | `vp config`                                                    |
| Add a dep                                                                       | `vp add <pkg>` (dev: `vp add -D <pkg>`)                        |
| Remove a dep                                                                    | `vp remove <pkg>` (aliases `vp rm`, `vp un`, `vp uninstall`)   |
| Update / outdated / list / why / info                                           | `vp update` / `vp outdated` / `vp list` / `vp why` / `vp info` |
| Dev server                                                                      | `vp dev`                                                       |
| Build                                                                           | `vp build`                                                     |
| Library pack                                                                    | `vp pack`                                                      |
| Tests                                                                           | `vp test`                                                      |
| Combined typecheck + lint + format                                              | `vp check` (auto-fix: `vp check --fix`)                        |
| Run a `package.json` script                                                     | `vp run <script>`                                              |
| One-off tool                                                                    | `vp dlx <pkg>` (replaces `npx`)                                |
| One-off local binary                                                            | `vp exec <binary>`                                             |

There is no `vp typecheck`, `vp tsc`, `vp vitest`, or `vp oxlint`. `vp check` covers all gates and `vp test` runs Vitest under the hood.

**Critical gotcha:** `vp dev` / `vp build` / `vp test` / `vp lint` / `vp fmt` / `vp check` always invoke the Vite+ built-in tool, NOT a same-named script in `package.json`. If `package.json` defines its own `dev` (e.g. chaining multiple processes), invoke it as `vp run dev`.

If unsure of the Vite+ equivalent for a task, consult `node_modules/vite-plus/AGENTS.md` (when installed) or fetch <https://viteplus.dev>. Falling back to `npm` / `pnpm` because something is uncertain is never acceptable.

### Imports

Do not install `vitest`, `oxlint`, `oxfmt`, `tsdown`, or `vite` directly — they are wrapped by Vite+. Import from `vite-plus`:

- `import { defineConfig } from 'vite-plus'`
- `import { expect, test, vi } from 'vite-plus/test'`

If existing code imports from `vitest` or `vite`, treat that as a bug to fix.

### Validation loop

After any change:

```sh
vp check
vp test
```

Both must pass before declaring work complete.

## Testing policy (HARD CONTRACT)

unworklet is developed with **TDD**. Write comprehensive behavior-based test cases before filling in the implementation. The path of writing implementation first and adding tests afterward is treated as a violation — if a violating commit must land, it requires a follow-up task to resolve it.

### Coverage gate

- **Branch coverage must be 98% or above, enforced per package.** CI fails if any single package drops below the threshold.
- Provider: standard Vitest (`@vitest/coverage-v8`). Set `test.coverage.thresholds.branches` to `98` in each package's `vite.config.ts`.
- No requirements on line / function / statement coverage — branches only.

### Test placement

- Co-located `src/**/*.test.ts` files, placed next to the implementation file they test.
- Example: the test for `packages/core/src/compile/capture.ts` lives at `packages/core/src/compile/capture.test.ts`.
- The build artifact produced by `vp pack` (`dist/`) does not include `.test.ts` files (Vite+ default behavior).

### Coverage exclusions

- **Types-only files** (no functions or branches, e.g. `packages/core/src/types.ts`)
- **Public surface re-export hubs** (`index.ts` files that contain only `export` statements)
- **`experiments/*`** (Phase 1 learning PoCs, outside the main implementation)
- **`examples/*`** (consumer-facing samples; behavioral tests may be added at Step 3.7 and later, but they are outside the coverage gate scope)

List the applicable paths in `test.coverage.exclude` in each package's `vite.config.ts`.

### When a TDD-violating commit must land

- Obtain explicit approval from the human reviewer before the commit goes in.
- Immediately open a follow-up task to write behavior-based tests for the affected area and restore 98% branch coverage.
- Do not advance to the next phase while the follow-up task is still open.

## Code style

- **Comments**: prefer none. When required, explain _why_, never _what_ — the code already tells the reader what it does.
- **No temporal language** in comments or docs: avoid "now", "currently", "previously", "before", "after", "used to", "updated to", "new", "old", "legacy", "originally", "initially". Git history covers change tracking.
- **Dead code**: delete it. No `_unused` rename hacks, no "removed because …" comments, no compatibility shims for unreachable cases.
- **No defensive code for impossible cases**. Trust internal callers and framework guarantees; validate only at system boundaries (user input, external APIs).
- **No premature abstractions**. Three similar lines beats a wrong helper.

## Boundaries

- Do not modify `docs/` to match the code. `docs/` is the contract; if reality has diverged, surface the mismatch to the human reviewer to fix the spec, not the spec to fit the code.
- Do not push to remote, open / close PRs, or perform shared-system actions without explicit approval.
- The realtime-safety invariants in `docs/00-foundations.md` §5 are non-negotiable: no allocation, no unbounded loops, no I/O on the audio thread, no GC-triggering operations. If a design appears to require violating one, stop and surface it.

## DevTools panel — recurring violations to avoid (HARD CONTRACT)

These 5 design directions surfaced during the 5-F panel grill and were **explicitly rejected** by the reviewer. Treat them as permanently blocked — do not re-introduce them under refactor, plan revisions, or "wouldn't it be nice if..." arguments. Each entry carries the reason so the rule survives future re-evaluation.

1. **MediaRecorder for audio capture.** Reject. WebM is browser-internal; bug reports need to be openable in any DAW or audio tool. The only sanctioned recording path is `AnalyserNode` → main-thread ring buffer (10 s rolling) → in-house 16-bit signed PCM WAV encoder. See `docs/07-unplugin.md` §6 Audio sub-tab.
2. **Domain-specific layout baked into the framework UI** (e.g. polysynth "voice 8 grid", envelope chips, amp meter bars). Reject. unworklet does not interpret user domain; the panel surfaces declared `state.publish` / `buffer.publish` slots through type-driven representations + a switchable dropdown. Anything beyond that is user-land UI.
3. **Jump-to-source button in the Build errors modal.** Reject. The modal already shows the source snippet + line + Why + Fix. Opening an IDE adds a side step the audio engineer didn't ask for.
4. **Swap history panel for `replaceProcessor`.** Reject. `replaceProcessor` returns `ReplaceResult` synchronously, and the Q63 accumulation warning fires once. There is no need to model a history surface — framework does not orchestrate the swap (`docs/decisions-log.md` Q50).
5. **Time-travel debugging (= scrubbing to past sample state).** Reject. Cannot satisfy realtime invariants + IIR state cannot be deterministically rewound. Use the Record sub-tab to capture short windows for offline analysis instead.

If any of these proposals re-appear in a new panel grill, the conversation stops until the proposer either argues why the rejection reason no longer applies, or the proposal is dropped.

## Mock data rule (HARD CONTRACT)

DevTools UI mocks are not decoration. They are the design contract that real composables get swapped into at the end of Phase 6. Therefore every mock obeys three properties:

1. **Real-world**: drawn from `docs/12-canonical-examples.md` Ex 1-10, not invented for visual polish. Slot names, port names, capacities, sysex byte patterns reflect what an actual unworklet processor would declare.
2. **Diverse**: covers every published type the framework exposes (= `state.f32` / `state.i32` / `state.bool` + `buffer.f32` / `buffer.i32` / `buffer.bool` / `buffer.u8`) through natural use cases rather than padding one type across many slots.
3. **Integrated**: values move in causally-linked ways across nodes (= polysynth meter rises → limiter gain reduction increases → reverb wet meter trails behind). A mock that puts each slot on an independent random walk fails this rule.

When adding a new mock or replacing one, verify all three before treating it as ready. A "make it pretty for the screenshot" mock is rejected on the same grounds as a domain-specific layout — both let the framework pretend to understand the user's domain.
