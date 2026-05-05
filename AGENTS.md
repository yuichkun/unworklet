# AGENTS.md

Guidance for AI agents implementing unworklet v1.0.0.

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
   - Preserve the user's mental-model simplicity — the change should not force a JUCE / VST / m4l / native-AudioWorklet author to re-learn a concept they already understood.
3. **If any example breaks or becomes awkward, the proposed change is rejected** until either (a) the change is revised to preserve the example, or (b) the example is updated together with the change as a single coherent revision (and the resulting UX cost is made visible to the human reviewer in the same diff).

This rule is non-negotiable. Spec changes that pass review without an accompanying check against `12-canonical-examples.md` are **out of process**.

The same rule applies in the reverse direction: changes to `12-canonical-examples.md` itself trigger a re-read of the affected component docs to ensure the new example shape matches the spec — examples cannot drift from the spec, the spec cannot drift from the examples.

The purpose of this rule is to keep one question answerable at any time during spec evolution: **"is the user experience still simple, coherent, and production-ready?"** If the canonical examples no longer read that way, the spec change is the wrong shape regardless of how clean it looks in isolation.

## Build, test, and lint — Vite+ only

This project uses [Vite+](https://viteplus.dev). All workflows go through `vp`. **Never invoke `npm`, `pnpm`, `yarn`, or `npx` directly** — not in shell, not in scripts, not in CI config, not in test-plan commands.

| Action | Command |
|---|---|
| Install deps | `vp install` (alias `vp i`) |
| Add a dep | `vp add <pkg>` (dev: `vp add -D <pkg>`) |
| Remove a dep | `vp remove <pkg>` (aliases `vp rm`, `vp un`, `vp uninstall`) |
| Update / outdated / list / why / info | `vp update` / `vp outdated` / `vp list` / `vp why` / `vp info` |
| Dev server | `vp dev` |
| Build | `vp build` |
| Library pack | `vp pack` |
| Tests | `vp test` |
| Combined typecheck + lint + format | `vp check` (auto-fix: `vp check --fix`) |
| Run a `package.json` script | `vp run <script>` |
| One-off tool | `vp dlx <pkg>` (replaces `npx`) |
| One-off local binary | `vp exec <binary>` |

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

## Code style

- **Comments**: prefer none. When required, explain *why*, never *what* — the code already tells the reader what it does.
- **No temporal language** in comments or docs: avoid "now", "currently", "previously", "before", "after", "used to", "updated to", "new", "old", "legacy", "originally", "initially". Git history covers change tracking.
- **Dead code**: delete it. No `_unused` rename hacks, no "removed because …" comments, no compatibility shims for unreachable cases.
- **No defensive code for impossible cases**. Trust internal callers and framework guarantees; validate only at system boundaries (user input, external APIs).
- **No premature abstractions**. Three similar lines beats a wrong helper.

## Boundaries

- Do not modify `docs/` to match the code. `docs/` is the contract; if reality has diverged, surface the mismatch to the human reviewer to fix the spec, not the spec to fit the code.
- Do not push to remote, open / close PRs, or perform shared-system actions without explicit approval.
- The realtime-safety invariants in `docs/00-foundations.md` §5 are non-negotiable: no allocation, no unbounded loops, no I/O on the audio thread, no GC-triggering operations. If a design appears to require violating one, stop and surface it.
