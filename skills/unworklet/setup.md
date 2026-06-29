# Setup

Scaffold an unworklet project: install the `@unworklet/*` packages, register the
Vite plugin (optionally with the DevTools dock), wire TypeScript through the
generated tsconfig, and create the `AudioContext` at the baked 48 kHz. This file
is the project wiring; authoring the DSP (uwk.md) and the load/`createNode` API
(loading.md) have their own files.

**`.uwk.ts` is the primary, recommended authoring form.** `.processor.ts` (the
explicit `@unworklet/core` method API) is the secondary, lower-level alternative —
it compiles to the same result; reach for it only when you need a surface
`.uwk.ts` does not expose (e.g. SIMD). Never treat `.uwk.ts` as optional or
skippable sugar. See uwk.md.

## 1. Install the packages

```bash
# runtime dependency — your app imports createNode + the typed node from it
npm install @unworklet/core
# dev — ?worklet loader/compiler, .uwk.ts editor support + the unworklet-tsc CLI
npm install -D @unworklet/unplugin @unworklet/lang
# dev — headless testing toolchain (optional; see testing.md)
npm install -D @unworklet/offline @unworklet/test
```

(`README.md` L33-34)

| package               | install as      | for                                                                                                                                                                        |
| --------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@unworklet/core`     | `dependency`    | the DSL, the WASM compiler, the worklet runtime, and `createNode` — the typed main-thread node. Your app imports it at runtime (export `.` → `createNode`).                |
| `@unworklet/unplugin` | `devDependency` | the Vite plugin: `?worklet` imports, lowering + compiling each processor to WASM, source maps, DevTools panels, analysis JSON.                                             |
| `@unworklet/lang`     | `devDependency` | the `.uwk.ts` authoring frontend (lowers `.uwk.ts` → virtual `.ts`). Provides the editor TS-server plugin `@unworklet/lang/typescript-plugin` and the `unworklet-tsc` bin. |
| `@unworklet/offline`  | `devDependency` | pure-JS offline renderer (Node / Bun / Deno) — headless render of a processor to PCM. See testing.md.                                                                      |
| `@unworklet/test`     | `devDependency` | Vitest matchers (wraps `@unworklet/offline`) — audio / event / MIDI / state assertions. See testing.md.                                                                    |

(descriptions: `packages/{core,unplugin,lang,offline,test}/package.json`)

- **Why install `@unworklet/lang` directly** even though `@unworklet/unplugin`
  already depends on it (`packages/unplugin/package.json` → `dependencies`): build-time
  lowering resolves it transitively, but the editor plugin
  `@unworklet/lang/typescript-plugin` and the `unworklet-tsc` bin
  (`packages/lang/package.json` L21-23) must resolve from _your_ project.
- `vite` (`^6 || ^7 || ^8`) and `@unworklet/core` are `@unworklet/unplugin` peer
  deps — your app already brings both. (`packages/unplugin/package.json` →
  `peerDependencies`)

## 2. `vite.config.ts`

Minimal (no DevTools):

```ts
// vite.config.ts
import unworklet from "@unworklet/unplugin";
export default { plugins: [unworklet()] };
```

(`README.md` L37-42)

With the DevTools dock — install the host + kit pinned to **exactly `0.3.3`**, and
gate the host to `command === "serve"`:

```bash
npm install -D @vitejs/devtools@0.3.3 @vitejs/devtools-kit@0.3.3
```

```ts
// vite.config.ts
import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/unplugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    unworklet(),
    // Dev only — the host is a long-lived server, pointless in a build and it
    // would keep the test runner from exiting.
    ...(command === "serve" ? [DevTools({ builtinDevTools: false })] : []),
  ],
}));
```

- `unworklet()` needs NO extra config — it auto-docks once the `@vitejs/devtools`
  host is present; there is no devtools-enable option.
- The `0.3.3` pin is exact and required (a mismatched host silently shows empty
  panels). Full rationale, the 4 panels, and cross-origin isolation → devtools.md.

(`README.md` L294-296, L298-314; `packages/unplugin/src/index.ts` L1821-1830)

## 3. TypeScript — extend the generated tsconfig

The plugin writes `.unworklet/` (a `tsconfig.json` plus a `worklets.d.ts` carrying
your processors' types) on `vite dev` / `vite build`. Extend it with one line —
this wires both the main-thread `?worklet` types AND the `.uwk.ts` editor checker,
so `node.params.<name>` (plus `state` / `events` / `midi` / `inputs` / `outputs`)
are typed and `.uwk.ts` sugar type-checks with **no `@ts-nocheck`**:

```jsonc
// tsconfig.json
{ "extends": "./.unworklet/tsconfig.json" }
```

(`README.md` L47-62; the plugin seeds `.unworklet/` synchronously on
`configResolved`: `packages/unplugin/src/index.ts` L824-870, L1033; tests
`packages/unplugin/src/worklet-dts-emit.test.ts` L65-114,
`packages/unplugin/src/worklet-dts-integration.test.ts` L110, L129)

- Add `.unworklet/` to `.gitignore` — it is a generated artifact. (`README.md` L57-59)
- Do NOT add your own `include` to this tsconfig: `extends` does not merge
  `include`, so the generated one must own it. (`README.md` L60-62)
- VS Code: run **"TypeScript: Select TypeScript Version → Use Workspace
  Version"** — the editor plugin loads only under the workspace TypeScript.
  (`README.md` L64-65)
- Build / CI typecheck: `@unworklet/lang` ships `unworklet-tsc`, a drop-in `tsc`
  that also checks `.uwk.ts`. See tsc.md.

Can't restructure an existing tsconfig? Write the same three settings directly
(still no `vite-env.d.ts`):

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["@unworklet/unplugin/client"],
    "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
  },
  "include": ["src", ".unworklet/worklets.d.ts"],
}
```

List `.unworklet/worklets.d.ts` explicitly in `include` — a `**/*` glob skips the
dot-folder. If this is your first `types` entry, also list the type packages you
already rely on (e.g. `"node"`), since `types` disables automatic `@types`
loading. (`README.md` L69-91)

## 4. File conventions

| extension       | role                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`.uwk.ts`**   | **primary, recommended authoring form** — top-level declarations + a bare `process(() => …)` with operator (`*`) and index (`x[i]`) sugar; no `defineProcessor` wrapper, no imports (the DSL is ambient). The plugin lowers it at build time. One file = one processor — OR a subgraph library module (`export` + no `process()`). |
| `.processor.ts` | secondary, explicit alternative — `defineProcessor(() => ({ process }))` with the `@unworklet/core` method API (`.at(i)`, `.mul()`, `.write()`) and explicit imports.                                                                                                                                                              |

Both compile to the same `CompiledProcessor` and both load identically via
`?worklet`. (`packages/unplugin/src/client-types.test.ts` L136-138) Authoring
detail (sugar, the core method API, subgraphs) → uwk.md; the `?worklet` import +
`createNode` → loading.md.

## 5. AudioContext — must run at 48 kHz

A `?worklet` import bakes rate-dependent WASM coefficients at **48 kHz** by
default (`bakedSampleRate = DEFAULT_SAMPLE_RATE = 48000`;
`packages/core/src/compile/index.ts` L54, L60). `createNode` **throws** when the
`AudioContext` rate differs from the baked rate, so create the context at 48000 Hz:

```ts
const ctx = new AudioContext({ sampleRate: 48000 });
// headless: new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: 48000 });
```

(rate gate `packages/core/src/client.ts` L350-364; rationale
`packages/core/src/types.ts` L667-676) The full load sequence and the
`UnworkletNode` surface (`params` / `state` / `events` / `midi` / `inputs` /
`outputs`) → loading.md.
