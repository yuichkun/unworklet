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

With the DevTools dock — install the `@vitejs/devtools` host and its 5 kit / adapter packages at `0.4.x` (Vite 8 compatible; the 0.3 line was Vite 6/7 only), and gate the host to `command === "serve" && !process.env.VITEST`:

```bash
npm install -D @vitejs/devtools@0.4 @vitejs/devtools-kit@0.4 \
  @vitejs/devtools-rolldown@0.4 @vitejs/devtools-oxc@0.4 \
  @vitejs/devtools-vitest@0.4 @vitejs/devtools-vite@0.4
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
    // would keep the test runner from exiting. Vitest passes `command: "serve"`
    // to plugins, so `command === "serve"` alone is NOT enough — also gate on
    // `!process.env.VITEST`, or Vitest opens the host and every `vitest run`
    // hangs 10s at close ("close timed out after 10000ms").
    ...(command === "serve" && !process.env.VITEST ? [DevTools({ builtinDevTools: false })] : []),
  ],
}));
```

- `unworklet()` needs NO extra config — it auto-docks once the `@vitejs/devtools`
  host is present; there is no devtools-enable option.
- The `@vitejs/devtools-kit` major must match `@unworklet/unplugin`'s peer (`^0.4.0`). A different major uses a different anonymous-RPC scope and every panel push is silently rejected. Full rationale, the 4 panels, and cross-origin isolation → devtools.md.
- **`vite.config.ts` itself falls inside the seeded tsconfig's `include`** (the
  glob picks up every `.ts` in the project). The `.uwk.ts` ambient
  `process(cb: () => void)` therefore shadows node's `process` global, so
  writing `process.env.VITEST` above type-errors with `TS2339`. Follow §3's
  extending pattern and add `"node"` to `types` so `process.env` type-checks in
  the config file too: `"types": ["@unworklet/unplugin/client", "node"]`.

(Auto-dock hook: `packages/unplugin/src/index.ts:1686-1696`.)

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

(The plugin seeds `.unworklet/` synchronously in `configResolved`, and
`unworklet-tsc` self-seeds it too — see `packages/lang/src/seed-unworklet-dir.ts`
for the exact `GENERATED_TSCONFIG` and `packages/unplugin/src/index.ts:903` for
where it's called on Vite's side.)

- Add `.unworklet/` to `.gitignore` — it is a generated artifact.
- Do NOT add your own `include` to this tsconfig: `extends` does not merge
  `include`, so the generated one must own it.
- VS Code: run **"TypeScript: Select TypeScript Version → Use Workspace
  Version"** — the editor plugin loads only under the workspace TypeScript.
- Build / CI typecheck: `@unworklet/lang` ships `unworklet-tsc`, a drop-in `tsc`
  that also checks `.uwk.ts`. See `ide-and-typecheck.md`.

**Cold-checkout gotcha**: on a fresh clone the extending tsconfig points at a
file that doesn't exist yet. Running `unworklet-tsc --noEmit` once (or any
`vite dev` / `vite build`) materialises `.unworklet/tsconfig.json`; both entry
points seed synchronously up front so a single command resolves the chicken/
egg. The IDE has no seeder — VS Code opened on a fresh clone reports TS5083
("Cannot read file `./.unworklet/tsconfig.json`") until you've run one of the
seeding entry points once.

**Cold-checkout per-processor witness gotcha (build script order matters)**:
seeding is two-stage. `unworklet-tsc` (and every entry point) writes
`.unworklet/tsconfig.json` + an EMPTY `.unworklet/worklets.d.ts`; the
per-processor entries in that witness (which type `import x from
"./x.processor.ts?worklet"` more specifically than `CompiledProcessor<unknown>`)
are populated only by `vite build` when it actually compiles each `.uwk.ts` /
`.processor.ts` through the unplugin. **On a cold clone, run `vite build` (or
`vite dev`) at least once BEFORE the first `unworklet-tsc --noEmit`** — a
build script written as `"build": "vite build && unworklet-tsc --noEmit"`
just works; the flipped `"unworklet-tsc --noEmit && vite build"` order lets
tsc see the empty witness on run #1 and falls back to the wildcard
`unknown`-typed `?worklet` module. Subsequent runs are clean either way. On
CI, prefer the build-then-typecheck order for a clean first run.

**First `vite build` warning**: esbuild reads the extending tsconfig BEFORE the
plugin's `configResolved` runs, so the very first invocation prints
`▲ [WARNING] Cannot find base config file "./.unworklet/tsconfig.json"` and
then heals itself the same run. Subsequent builds are clean. `unworklet-tsc`
does not have this ordering because it seeds before it hands the config to
tsc.

**Need to override the seeded compilerOptions?** `extends` merges
compilerOptions (consumer wins), so an extending tsconfig can override any
seeded field — for example adding `"strict": true` or replacing `"types"`
with a superset. That's how you re-enable node types on a test file that
imports `node:fs`:

```bash
npm install -D @types/node
```

```jsonc
// tsconfig.json — extending + overriding types to include node
{
  "extends": "./.unworklet/tsconfig.json",
  "compilerOptions": {
    "types": ["@unworklet/unplugin/client", "node"],
  },
}
```

The `npm install -D @types/node` step is required — the seeded
`"types": ["@unworklet/unplugin/client"]` disables automatic `@types`
loading, so consumer test / server code that needs `node:*` must both
`npm install -D @types/node` AND re-add `"node"` in its own `"types"`
list. Without the install, TypeScript reports `TS2688: Cannot find type
definition file for 'node'` on any `.ts` that references `process.env`
or imports `node:*`. Stock TypeScript rule, not unworklet-specific.

Can't restructure an existing tsconfig? Write the settings directly (still no
`vite-env.d.ts`), matching what `GENERATED_TSCONFIG` seeds so a subgraph
import (`./x.uwk.ts` specifier) doesn't fail with `TS5097`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["@unworklet/unplugin/client"],
    "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
    "allowImportingTsExtensions": true,
    "noEmit": true,
  },
  "include": ["src", ".unworklet/worklets.d.ts"],
}
```

List `.unworklet/worklets.d.ts` explicitly in `include` — a `**/*` glob skips
the dot-folder. If this is your first `types` entry, also list the type
packages you already rely on (e.g. `"node"`), since `types` disables automatic
`@types` loading.

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
`packages/core/src/types.ts` L697-706) The full load sequence and the
`UnworkletNode` surface (`params` / `state` / `events` / `midi` / `inputs` /
`outputs`) → loading.md.
