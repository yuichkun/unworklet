# AGENTS.md

Guidance for AI agents implementing unworklet v1.0.0.

> **Using unworklet (not contributing to it)?** This file is the _contributor /
> implementation_ contract. If you are an AI agent helping someone _build with_
> unworklet, the consumer-facing entry points are:
>
> - Package READMEs with the exact call forms:
>   [`packages/core/README.md`](./packages/core/README.md),
>   [`packages/unplugin/README.md`](./packages/unplugin/README.md),
>   [`packages/lang/README.md`](./packages/lang/README.md),
>   [`packages/offline/README.md`](./packages/offline/README.md),
>   [`packages/test/README.md`](./packages/test/README.md).
> - [`skills/unworklet/SKILL.md`](./skills/unworklet/SKILL.md) — the same surface as an
>   agent skill, installable into any client with
>   `npx skills add https://github.com/yuichkun/unworklet/tree/main/skills/unworklet`.

## What this repository is

`unworklet` — a TypeScript-first framework for declarative Audio Worklet DSP, compiled to WebAssembly. It is published: five packages ship from `packages/`, versioned in lockstep (see `RELEASE.md`).

## Source of truth

- **The implementation is the truth about behaviour.** There is no separate specification to defer to. A design-time spec drove the v1.0.0 build and was deleted once the implementation shipped and was verified against reality — an unverified second description of the same behaviour can only drift. Recover it from git history at the `v0.1.0` tag if you need the archaeology.
- **`skills/unworklet/`** is the authoritative _description_ of that behaviour, and the only one kept honest: it is the guide consumers' agents read, its examples compile in CI, and it is re-verified by building real projects from it alone (the `guidance-dogfood` skill). If you change behaviour, change it there in the same commit.
- **`docs/`** is history only — `decisions-log.md` for why a question was settled the way it was, and the RFCs. Neither describes current behaviour, so neither can contradict it. Do not treat either as a contract.
- If a change requires a decision nobody has made, **stop and surface it** rather than inventing one.

## Integrity anchor: it runs (HARD CONTRACT)

The full surface of unworklet — every primitive, declaration, and main-side method — is anchored by things that **execute**, not by prose:

- **`packages/offline/src/canonical.test.ts`** — realistic end-to-end processors rendered through `renderOffline` and asserted on behaviour.
- **`examples/demo`** — the same shapes driven through the real plugin pipeline in a browser, plus its offline-render tests.
- **`packages/offline/src/docs-examples.test.ts`** — every complete processor example in the READMEs and the Skill is extracted from the markdown and compiled, so a documented example cannot rot into something that no longer builds.

A markdown set of canonical examples used to hold this role, which meant the anchor could silently disagree with the code. It was deleted for that reason. The rule that replaces it:

**Any change to the public surface must leave those three green, and must land with the corresponding change to `skills/unworklet/` in the same commit.** If a realistic example becomes awkward to express — workarounds, apologetic comments, a concept the author now has to re-learn — the change is the wrong shape regardless of how clean it looks in isolation. Say so and surface it rather than absorbing the awkwardness.

## Public surface changes (HARD CONTRACT)

The library is published, so the surface is a contract with people who already installed it.

1. **No shape you intend to fix later.** Public types, argument shapes, and return shapes ship as their final form. A temporary shape becomes someone's code.
2. **Breaking changes are deliberate and versioned, never incidental.** Removing or narrowing a public type, moving a peer-dependency requirement, or making a check start failing builds it used to pass are all breaking. Pre-1.0 they force the minor, because `^0.x.y` resolves `0.x.*` and refuses `0.(x+1).0` — see `RELEASE.md`. Record them in `CHANGELOG.md` with the migration a consumer has to perform.
3. **Additive by default.** Prefer a shape that widens what is accepted over one that invalidates existing code.

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

- Do not edit `docs/` to match the code. It is a historical record, not a description of current behaviour — rewriting history to match the present destroys the only thing it is for. Behaviour is described in `skills/unworklet/`; change that.
- Do not push to remote, open / close PRs, or perform shared-system actions without explicit approval.
- The realtime-safety invariants are non-negotiable: no allocation, no unbounded loops, no I/O on the audio thread, no GC-triggering operations. They are enforced in `packages/core/src/dsl/enforcement.test.ts` and by the worklet-realm lint rules in the root `vite.config.ts`. If a design appears to require violating one, stop and surface it.

## DevTools panel — recurring violations to avoid (HARD CONTRACT)

These 5 design directions surfaced during the 5-F panel grill and were **explicitly rejected** by the reviewer. Treat them as permanently blocked — do not re-introduce them under refactor, plan revisions, or "wouldn't it be nice if..." arguments. Each entry carries the reason so the rule survives future re-evaluation.

1. **MediaRecorder for audio capture.** Reject. WebM is browser-internal; bug reports need to be openable in any DAW or audio tool. The only sanctioned recording path is `AnalyserNode` → main-thread ring buffer (10 s rolling) → in-house 16-bit signed PCM WAV encoder.
2. **Domain-specific layout baked into the framework UI** (e.g. polysynth "voice 8 grid", envelope chips, amp meter bars). Reject. unworklet does not interpret user domain; the panel surfaces declared `state.publish` / `buffer.publish` slots through type-driven representations + a switchable dropdown. Anything beyond that is user-land UI.
3. **Jump-to-source button in the Build errors modal.** Reject. The modal already shows the source snippet + line + Why + Fix. Opening an IDE adds a side step the audio engineer didn't ask for.
4. **Swap history panel for `replaceProcessor`.** Reject. `replaceProcessor` returns `ReplaceResult` synchronously, and the Q63 accumulation warning fires once. There is no need to model a history surface — framework does not orchestrate the swap (`docs/decisions-log.md` Q50).
5. **Time-travel debugging (= scrubbing to past sample state).** Reject. Cannot satisfy realtime invariants + IIR state cannot be deterministically rewound. Use the Record sub-tab to capture short windows for offline analysis instead.

If any of these proposals re-appear in a new panel grill, the conversation stops until the proposer either argues why the rejection reason no longer applies, or the proposal is dropped.

## Mock data rule (HARD CONTRACT)

DevTools UI mocks are not decoration. They are the design contract that real composables get swapped into at the end of Phase 6. Therefore every mock obeys three properties:

1. **Real-world**: drawn from the processors in `packages/offline/src/canonical.test.ts` and `examples/demo`, not invented for visual polish. Slot names, port names, capacities, sysex byte patterns reflect what an actual unworklet processor would declare.
2. **Diverse**: covers every published type the framework exposes (= `state.f32` / `state.i32` / `state.bool` + `buffer.f32` / `buffer.i32` / `buffer.bool` / `buffer.u8`) through natural use cases rather than padding one type across many slots.
3. **Integrated**: values move in causally-linked ways across nodes (= polysynth meter rises → limiter gain reduction increases → reverb wet meter trails behind). A mock that puts each slot on an independent random walk fails this rule.

When adding a new mock or replacing one, verify all three before treating it as ready. A "make it pretty for the screenshot" mock is rejected on the same grounds as a domain-specific layout — both let the framework pretend to understand the user's domain.
