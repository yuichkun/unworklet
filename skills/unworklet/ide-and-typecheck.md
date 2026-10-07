# IDE types & CI typecheck

`.uwk.ts` is the primary authoring form; `.processor.ts` (explicit core-method API) is the
secondary alternative. Both get editor types/completion and are checked by the `unworklet-tsc`
CLI. (Authoring forms: see dsl.md. Packages / vite config / file conventions: see setup.md.)

Two layers, one setup:

- **Editor** — `?worklet` imports resolve to a typed node, `.uwk.ts` sugar is checked live.
  Wired by extending the plugin-generated tsconfig.
- **CI / build** — `unworklet-tsc`, a drop-in `tsc` that also checks `.uwk.ts`. Runs headless
  and agrees with the editor.

---

## 1. Editor types & completion

### Wire it (recommended) — one line, no `vite-env.d.ts`

```jsonc
// tsconfig.json
{ "extends": "./.unworklet/tsconfig.json" }
```

Inherits both the `?worklet` ambient types and the `.uwk.ts` editor checker.
[cite: packages/unplugin/README.md :: `## Setup`] [cite: README.md :: `{ "extends": "./.unworklet/tsconfig.json" }`] [cite: packages/unplugin/src/worklet-dts-integration.test.ts :: `test("extends: the plugin's generated tsconfig types node.params with a one-line extends"`]

VS Code: run **"TypeScript: Select TypeScript Version → Use Workspace Version"** — the `.uwk.ts`
checker plugin loads only under workspace TS.
[cite: README.md :: `TypeScript: Select TypeScript Version → Use Workspace Version`]

### What you get

```ts
import { createNode } from "@unworklet/core";
import distortion from "./distortion.uwk.ts?worklet"; // resolves to a typed CompiledProcessor
const node = await createNode(ctx, distortion);
node.params.drive.value = 8; // node.params.<name> completes + types (AudioParam)
```

The typed node surface is `params` / `state` / `events` / `midi` / `inputs` / `outputs`
(per-processor). Full surface + `createNode`: see dsl.md.
[cite: README.md :: `node.params.drive.value = 8;`]

### How it resolves (two layers of types)

- **`@unworklet/unplugin/client`** — ambient `declare module "*?worklet"` → default
  `CompiledProcessor<unknown>`. Resolves the import; the per-processor witness is erased to
  `unknown` at this boundary.
  [cite: packages/unplugin/client.d.ts :: `declare module "*?worklet" {`]
  The workspace and published subpath mappings are
  [cite: packages/unplugin/package.json :: `"types": "./src/devbridge.ts", "development": "./src/devbridge.ts", "import": "./dist/devbridge.mjs" }, "./client": { "types": "./client.d.ts" }`]
  and [cite: packages/unplugin/package.json :: `"types": "./dist/devbridge.d.mts", "import": "./dist/devbridge.mjs" }, "./client": { "types": "./client.d.ts" }`].
- **`.unworklet/worklets.d.ts`** — one `declare module "*/<basename>?worklet"` per processor,
  carrying its concrete `params`/`state`/`events`/`midi`/`inputs`/`outputs`. This is what makes
  `node.params.drive` resolve to the real param. Written by the Vite plugin at dev startup and as it compiles, and
  by `unworklet-tsc` for `.uwk.ts` processors before it runs tsc.
  [cite: packages/lang/src/worklet-dts.ts :: `export function workletsDts(`] [cite: packages/unplugin/src/index.ts :: `const writeWorkletsWitness =`] [cite: packages/lang/src/unworklet-tsc.ts :: `async function populateWorkletsWitness(`]
- **`@unworklet/lang/typescript-plugin`** — the editor TS plugin that type-checks `.uwk.ts` sugar.
  [cite: packages/lang/src/typescript-plugin.ts :: `export default createLanguageServicePlugin(`]

### What the plugin writes — the `.unworklet/` dir (generated; gitignore it)

Seeded **synchronously** the moment Vite config resolves, so the `extends` target exists before
the build reads tsconfig (an async write loses the race → "Tsconfig not found"):

- **`.unworklet/tsconfig.json`** — fixed content (below); never changes as you add processors.
- **`.unworklet/worklets.d.ts`** — generated at dev startup from `?worklet` imports in the
  tsconfig's sources and referenced projects, or JavaScript/TypeScript source files under the
  root when there is no tsconfig. No browser request is needed. Processor/helper edits and
  added/removed imports refresh it; invalid or deleted processors lose stale declarations.
  Builds generate types from their loaded processors. Written only on content change
  (no dev-watch loop).
  [cite: packages/lang/src/seed-unworklet-dir.ts :: `export const seedUnworkletDir =`] [cite: packages/unplugin/src/index.ts :: `seedUnworkletDir(projectRoot);`] [cite: packages/unplugin/src/index.ts :: `const writeWorkletsWitness =`] Gitignore `.unworklet/`.

Exact generated `.unworklet/tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@unworklet/unplugin/client"],
    "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["worklets.d.ts", "../**/*.ts", "../**/*.tsx"],
  "exclude": ["../node_modules"]
}
```

(`allowImportingTsExtensions`+`noEmit` let a `.uwk.ts` specifier type-resolve — e.g. importing a
sibling subgraph; the bundler does the emit.)
[cite: packages/lang/src/seed-unworklet-dir.ts :: `export const GENERATED_TSCONFIG =`] [cite: packages/lang/src/index.ts :: `export { seedUnworkletDir, GENERATED_TSCONFIG }`]

### Gotchas

- **Do NOT add your own `include`** on the extending tsconfig. `extends` does not merge `include`;
  the generated one must own it. Your `compilerOptions` (`module`/`lib`/…) DO merge on top.
  [cite: packages/lang/src/seed-unworklet-dir.ts :: `include: ["worklets.d.ts", "../**/*.ts", "../**/*.tsx"]`]
- The `.uwk.ts` checker loads only under **workspace TS** (do the VS Code step above).
- `**/*` globs skip dot-folders — that's why `worklets.d.ts` is always listed explicitly.

### Manual escape hatch (existing tsconfig you can't restructure)

Write the three settings directly — still no `vite-env.d.ts`:

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

List `.unworklet/worklets.d.ts` **explicitly** (a `**/*` glob skips the dot-folder). If this is
your first `types` entry, also list packages you rely on (e.g. `"node"`) — `types` disables
automatic `@types` loading.
[cite: packages/unplugin/src/worklet-dts-integration.test.ts :: `test("manual escape hatch: types + plugins + include the type file, no extends, no vite-env"`]

Alt (inside a `.d.ts`): `/// <reference types="@unworklet/unplugin/client" />` pulls the same
ambient.
[cite: packages/unplugin/client.d.ts :: `/// <reference types="@unworklet/unplugin/client" />`]

---

## 2. CI / non-IDE typecheck — `unworklet-tsc`

The editor TS plugin does not run in CI, and plain `tsc` flags raw `.uwk.ts` sugar as errors.
`@unworklet/lang` ships **`unworklet-tsc`**, a drop-in `tsc` that also understands `.uwk.ts` (the
vue-tsc pattern: `@volar/typescript`'s `runTsc` driving the _same_ Volar language plugin as the
editor), so a build agrees with the editor.

### Binary + package

- Binary: **`unworklet-tsc`** → `./dist/unworklet-tsc.mjs`, shipped by **`@unworklet/lang`**
  (devDependency).
  [cite: packages/lang/package.json :: `"unworklet-tsc": "./dist/unworklet-tsc.mjs"`]

### Command

Drop it where `tsc` would go in the build script:

```jsonc
// package.json
{ "scripts": { "build": "vite build && unworklet-tsc --noEmit" } }
```

Ad-hoc: `unworklet-tsc --noEmit`.
[cite: packages/lang/README.md :: `"build": "unworklet-tsc --noEmit && vite build"`] [cite: packages/lang/src/unworklet-tsc.test.ts :: `function check(source: string)`]

### What it checks

- **Drop-in `tsc`** — every `tsc` flag passes through unchanged (tests exercise `--noEmit`). No
  tool-specific flags exist.
- **`.ts` files (including `.processor.ts`)** are checked exactly as `tsc` would.
- **`.uwk.ts` files** get their sugar type-checked instead of being flagged as raw TS — plain
  `tsc` fails on the sugar (e.g. `a * b` on two `Node`s).
  [cite: packages/lang/src/unworklet-tsc.ts :: `return { languagePlugins: [createUwkLanguagePlugin(ts)] };`]
- **Self-seeds `.unworklet/`** — before it hands anything to tsc, `unworklet-tsc` calls
  `seedUnworkletDir` on the directory of the tsconfig being checked — the `--project` /
  `-p` target, falling back to the one found from the cwd — which writes `.unworklet/tsconfig.json` (and an empty
  `worklets.d.ts` if none exists yet). Safe as the first command on a fresh clone: no prior
  `vite dev` / `vite build` needed. The seed is idempotent — a later Vite run overwrites the
  same tsconfig content and fills in `worklets.d.ts`. [cite: packages/lang/src/unworklet-tsc.ts :: `seedUnworkletDir(projectDir);`]
- Internally forces **`skipLibCheck: true`** so the injected authoring globals
  (`Node` / `event` / `process`) don't collide with `lib.dom` / `@types/node` as `Duplicate
identifier`. Your `.uwk.ts` / `.ts` stay fully checked; only `.d.ts` lib/`@types` conflicts are
  skipped.
  [cite: packages/lang/src/unworklet-tsc.ts :: `options.options.skipLibCheck = true;`]

### tsconfig requirement

Checks against your existing `tsconfig.json` — it must `include` your `.uwk.ts` files. Works with
or without the editor's `plugins` entry; the CLI injects the language plugin itself (the editor
`plugins` entry is only for the editor).
[cite: packages/lang/src/unworklet-tsc.ts :: `return { languagePlugins: [createUwkLanguagePlugin(ts)] };`]

### Verified behavior (run against the shipped `dist` bin)

- Valid `.uwk.ts` sugar → empty output, exit `0`. [cite: packages/lang/src/unworklet-tsc.test.ts :: `test("unworklet-tsc type-checks valid .uwk.ts sugar and exits 0"`]
- Real DOM + `@types/node` app with `skipLibCheck: false` → still passes (injected globals must
  not fail the build). [cite: packages/lang/src/unworklet-tsc.test.ts :: `test("unworklet-tsc passes on a real DOM + @types/node app with skipLibCheck off (the injected ambient globals must not fail the build)"`]
- Real type error (a `bool` `Node` written to an `f32` output) → exit non-zero; the error names
  `Node<"bool">` / `Node<"f32">`, mapped onto the author's `check.uwk.ts` (not a virtual file).
  [cite: packages/lang/src/unworklet-tsc.test.ts :: `test("unworklet-tsc reports a .uwk.ts type error, mapped to the source, and exits non-zero"`]

### Scope note — `?worklet`

`unworklet-tsc` registers the extra extension `[".uwk.ts"]` only. `?worklet` is a bundler import
query handled by `@unworklet/unplugin`, not this CLI. A `.processor.ts` imported with `?worklet`
is plain `.ts` and is checked as `tsc` would.
[cite: packages/lang/src/unworklet-tsc.ts :: `runTsc(tscPath, [".uwk.ts"], (ts, options) => {`]

---

See also: setup.md (packages, vite config, file conventions), dsl.md (authoring forms + node
surface), testing.md, devtools.md.
