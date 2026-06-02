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
import** — the lowering injects the `@unworklet/core` import for you. A
`// @ts-nocheck` header is expected: the sugar is intentionally a type error
until the plugin lowers it. `.named()` / `.expose({...})` with no name derive it
from the binding.

```ts
// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
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
