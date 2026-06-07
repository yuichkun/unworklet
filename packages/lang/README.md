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
# For `.uwk.ts` authoring — the editor plugin, the `unworklet-tsc` build checker,
# and `lower()`. Add it directly: a bin only resolves for a direct dependency.
npm install -D @unworklet/lang
```

## What a `.uwk.ts` file looks like

Same declarations as core, but the `process` body uses operators. There is no
`defineProcessor` wrapper and no `return { process }` — the file _is_ the
processor body, and `process(() => { ... })` is ambient. The core DSL names
(`audioInput`, `state`, `param`, `forSample`, …) are ambient too: **write no
import** — the lowering injects the `@unworklet/core` import for you. `ctx` is
ambient as well — the same `ProcessorContext` that core's `defineProcessor((ctx)
=> …)` passes you, so `ctx.sampleRate` is how a generator reaches the sample rate.
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
`ctx.sampleRate * 0.5`) is left untouched — only expressions involving a
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

## Building a `.uwk.ts` project

A Vite build script usually type-checks first, then builds (`tsc && vite build`).
But `tsc` doesn't run the editor plugin, so it flags the raw `.uwk.ts` sugar
(`a * b` on two `Node`s) and fails the build.

Use `unworklet-tsc` in place of `tsc`. It's a drop-in `tsc` — every flag passes
through — that understands `.uwk.ts`, type-checking the sugar with the _same_
language plugin the editor uses, so your `.uwk.ts` files are checked at build
rather than skipped:

```jsonc
// package.json
{
  "scripts": {
    "build": "unworklet-tsc --noEmit && vite build",
  },
}
```

`unworklet-tsc` checks against your existing `tsconfig.json`, so make sure it
`include`s your `.uwk.ts` files. It injects the language plugin itself — so it
works whether or not the tsconfig carries the editor's `plugins` entry (that entry
is only for your editor). Run it ad-hoc the same way:

```bash
npx unworklet-tsc --noEmit
```

The Vite plugin lowers + compiles `.uwk.ts` at build regardless (surfacing any
`lower()` error there); `unworklet-tsc` adds the type-check, and the editor
plugin gives the same diagnostics while you edit — all three driven by one
desugar, so they never disagree.

If you'd rather not type-check the sugar at build, `"exclude": ["**/*.uwk.ts"]`
in `tsconfig.json` keeps plain `tsc` from flagging it (the Vite plugin compiles
those files regardless; they're just unchecked at build).

## Compile in the browser (live coding)

`@unworklet/lang/browser` runs the whole lower → compile → worklet pipeline in the
browser, so a `.uwk.ts` source **string** becomes a playable processor at runtime
— the live-coding / editor path, with no Vite plugin or build step involved.

```ts
import { createNode, replaceProcessor } from "@unworklet/core";
import { compileSource } from "@unworklet/lang/browser";

const ctx = new AudioContext();
let node = await createNode(ctx, await compileSource(editor.value));
node.outputs.main.connect(ctx.destination);

// recompile the edited source and hot-swap it, live:
runButton.onclick = async () => {
  const swapped = await replaceProcessor(node, await compileSource(editor.value));
  node = swapped.node;
};
```

`compileSource(source)` returns a `CompiledProcessor` ready for `createNode`;
`lowerToProcessor(source)` stops at the processor (no worklet module) for an
in-browser headless render. (For Node, import `lowerToProcessor` from the root
`@unworklet/lang` — the same call, resolved off disk, pulling in no compiler.)
The WASM compiler (binaryen) ships in this entry,
so the browser bundle includes it — import `@unworklet/lang/browser` lazily if you
only need it behind a live-coding UI. (A build-time `"node:module" … externalized,
imported by binaryen` warning is expected and harmless: binaryen's Node-only path
is stubbed for the browser; its in-browser path is what runs.)

## API

```ts
import { lower, LowerError } from "@unworklet/lang";

const tsSource = lower(uwkSource, { exportName: "myProcessor" });
// LowerError carries a source location for malformed sugar.
```

For a headless render, `lowerToProcessor(source)` lowers straight to a
`CompiledProcessor` for `@unworklet/offline` in Node — see that package's README.

Most projects don't import this — `@unworklet/vite-plugin` lowers `.uwk.ts`
imports on the fly. Plain `.ts` / `.processor.ts` processors (the core API) work
everywhere `.uwk.ts` does; the sugar is opt-in.

## Related packages

- `@unworklet/core` — the primitives `.uwk.ts` lowers to (`audioInput`, `state`, `param`, `forSample`, …).
- `@unworklet/vite-plugin` — lowers `.uwk.ts` imports on the fly via `?worklet`.
- `@unworklet/offline` — render a processor to PCM in Node/Bun/Deno.
- `@unworklet/test` — audio/event/MIDI assertions for Vitest.

License: MIT.
