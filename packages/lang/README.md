# @unworklet/lang

The `.uwk.ts` authoring frontend for unworklet. Write a processor with infix
operators and bare reads/writes; `lower()` desugars it to a plain
`@unworklet/core` `.ts` module. The Vite plugin runs this automatically for any
`.uwk.ts` file — you normally never call `lower()` yourself.

> **For AI agents:** `.uwk.ts` is _sugar over the exact same primitives_ as
> `@unworklet/core`. The declarations are identical; only the bodies change
> (operators instead of method calls). Don't mix the two styles in one file.

```bash
# Pulled in transitively by the Vite plugin — install that, not this directly:
npm install -D @unworklet/vite-plugin
npm install @unworklet/core
# Only needed if you call `lower()` yourself (custom build step):
npm install -D @unworklet/lang
```

## What a `.uwk.ts` file looks like

Same declarations as core, but the `process` body uses operators. There is no
`defineProcessor` wrapper and no `return { process }` — the file _is_ the
processor body, and `process(() => { ... })` is ambient. The core DSL names
(`audioInput`, `state`, `param`, `forSample`, …) are ambient too: **write no
import** — the lowering injects the `@unworklet/core` import for you.
`.named()` / `.expose({...})` with no name derive it from the binding.

Out of the box, stock TypeScript flags the sugar (`a * b` on two `Node`s is an
"operator cannot be applied" error), so a `// @ts-nocheck` header is needed.
**Install the editor plugin ([IDE support](#ide-support)) and the header goes
away** — the sugar type-checks, with hover / completion / go-to-definition on
the operands.

```ts
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named();
const env = state.f32(0).named(); // auto-named "env" from the binding

process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i]; // index sugar + infix *
    out.right[i] = input.right[i] * gain[i];
    env.write(env * 0.99); // bare read of env; write is explicit
  });
});
```

## The sugar (desugars to core)

| `.uwk.ts`                                    | lowers to `@unworklet/core`                      |
| -------------------------------------------- | ------------------------------------------------ |
| `a * b` `a + b` `a - b` `a / b` `a % b` `-a` | `a.mul(b)` … `a.neg()`                           |
| `a == b` `a < b` `a <= b` `a > b` `a >= b`   | `eq(a, b)` `lt(a, b)` …                          |
| `!b`                                         | `not(b)`                                         |
| `cond ? x : y`                               | `select(cond, x, y)`                             |
| `input.left[i]` / `param[i]` / `buf[i]`      | `.at(i)` / `.read(i)`                            |
| `output.left[i] = v` / `buf[i] = v`          | `output.left.at(i).write(v)` / `buf.write(i, v)` |
| `state` in a read position                   | `state.read()`                                   |
| `$prev` (in a subgraph)                      | injected feedback state                          |

Bare-state sugar is **read-only**: a scalar `state` used in a value position
lowers to `state.read()`, but you still **write** it explicitly with
`state.write(v)` (there is no `state = v` for scalars). Buffer / output element
writes use the index-assignment form above. `number op number` (e.g.
`SAMPLE_RATE * 0.5`) is left untouched — only expressions involving a
`Node`/`State` are lowered.

## IDE support

`.uwk.ts` is syntactically TypeScript, so any editor highlights it and navigates
it with zero setup. To make the **sugar type-check** — no red squiggles on
`a * b`, no `// @ts-nocheck` — add the TypeScript-server plugin to your
`tsconfig.json`. That single entry is the whole setup: the plugin auto-injects the
shipped ambient `.d.ts` (it declares `audioInput` / `state` / `process` / `input` /
`out` / `$prev` … as globals), so there is no `files` or `types` entry to add.

```jsonc
{
  "compilerOptions": {
    "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
  },
}
```

In VS Code, also run **“TypeScript: Select TypeScript Version → Use Workspace
Version”** so the editor loads the plugin (TS-server plugins only load under the
workspace TypeScript, not VS Code's bundled one). You then get, on the sugar
itself: diagnostics, hover (`Node<"f32">`), completion (`input.` → `left` /
`right` / `ch`), rename, and go-to-definition — projected onto your `.uwk.ts`.

How it works (Volar): the plugin generates a virtual TypeScript file where only
the sugar is desugared to the chain primitives stock TS accepts (`a * b` →
`mul(a, b)`, `out.left[i] = v` → `out.left.at(i).write(v)`, a bare `state` read →
`state.read()`), type-checks _that_, and maps every result back to your source.
It uses the same desugar dispatch as the build, so the editor never disagrees
with `lower()`. The plugin is edit-time only; the actual build still runs
`lower()`.

For CI / headless type-checking, the same language plugin drives a Volar program
proxy — see `createUwkLanguagePlugin` in `@unworklet/lang`.

## API

```ts
import { lower, LowerError } from "@unworklet/lang";

const tsSource = lower(uwkSource, { exportName: "myProcessor" });
// LowerError carries a source location for malformed sugar.
```

Most projects don't import this — `@unworklet/vite-plugin` lowers `.uwk.ts`
imports on the fly. Plain `.ts` / `.processor.ts` processors (the core API) work
everywhere `.uwk.ts` does; the sugar is opt-in.

## Related packages

- `@unworklet/core` — the primitives `.uwk.ts` lowers to (`audioInput`, `state`, `param`, `forSample`, …).
- `@unworklet/vite-plugin` — lowers `.uwk.ts` imports on the fly via `?worklet`.
- `@unworklet/offline` — render a processor to PCM in Node/Bun/Deno.
- `@unworklet/test` — audio/event/MIDI assertions for Vitest.

License: MIT.
