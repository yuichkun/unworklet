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
[cite: packages/unplugin/README.md L28-31; README.md L52-55; types `node.params.<name>` with 0
diagnostics — packages/unplugin/src/worklet-dts-integration.test.ts L102-115]

VS Code: run **"TypeScript: Select TypeScript Version → Use Workspace Version"** — the `.uwk.ts`
checker plugin loads only under workspace TS.
[cite: README.md L64-67]

### What you get

```ts
import { createNode } from "@unworklet/core";
import distortion from "./distortion.uwk.ts?worklet"; // resolves to a typed CompiledProcessor
const node = await createNode(ctx, distortion);
node.params.drive.value = 8; // node.params.<name> completes + types (AudioParam)
```

The typed node surface is `params` / `state` / `events` / `midi` / `inputs` / `outputs`
(per-processor). Full surface + `createNode`: see dsl.md.
[cite: README.md L113-129]

### How it resolves (two layers of types)

- **`@unworklet/unplugin/client`** — ambient `declare module "*?worklet"` → default
  `CompiledProcessor<unknown>`. Resolves the import; the per-processor witness is erased to
  `unknown` at this boundary.
  [cite: packages/unplugin/client.d.ts L11-21; export `./client` → client.d.ts —
  packages/unplugin/package.json L38-40]
- **`.unworklet/worklets.d.ts`** (plugin-written) — one `declare module "*/<basename>?worklet"`
  per processor, carrying its concrete `params`/`state`/`events`/`midi`/`inputs`/`outputs`. This
  is what makes `node.params.drive` resolve to the real param.
  [cite: packages/unplugin/src/worklet-dts.ts L20-83]
- **`@unworklet/lang/typescript-plugin`** — the editor TS plugin that type-checks `.uwk.ts` sugar.
  [cite: packages/lang/package.json L39-42]

### What the plugin writes — the `.unworklet/` dir (generated; gitignore it)

Seeded **synchronously** the moment Vite config resolves, so the `extends` target exists before
the build reads tsconfig (an async write loses the race → "Tsconfig not found"):

- **`.unworklet/tsconfig.json`** — fixed content (below); never changes as you add processors.
- **`.unworklet/worklets.d.ts`** — (re)written as each `?worklet` import compiles; only regrows
  with new processors; written only on content change (no dev-watch loop).
  [cite: packages/unplugin/src/index.ts `seedUnworkletDir` L856-878, `writeWorkletsWitness`
  L921-952; gitignore it — README.md L57-60]

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
[cite: packages/unplugin/src/index.ts `GENERATED_TSCONFIG` L838-854]

### Gotchas

- **Do NOT add your own `include`** on the extending tsconfig. `extends` does not merge `include`;
  the generated one must own it. Your `compilerOptions` (`module`/`lib`/…) DO merge on top.
  [cite: packages/unplugin/src/index.ts L823-854; README.md L57-62]
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
[cite: README.md L69-91; proven — packages/unplugin/src/worklet-dts-integration.test.ts L117-133]

Alt (inside a `.d.ts`): `/// <reference types="@unworklet/unplugin/client" />` pulls the same
ambient.
[cite: packages/unplugin/client.d.ts L5]

---

## 2. CI / non-IDE typecheck — `unworklet-tsc`

The editor TS plugin does not run in CI, and plain `tsc` flags raw `.uwk.ts` sugar as errors.
`@unworklet/lang` ships **`unworklet-tsc`**, a drop-in `tsc` that also understands `.uwk.ts` (the
vue-tsc pattern: `@volar/typescript`'s `runTsc` driving the _same_ Volar language plugin as the
editor), so a build agrees with the editor.

### Binary + package

- Binary: **`unworklet-tsc`** → `./dist/unworklet-tsc.mjs`, shipped by **`@unworklet/lang`**
  (devDependency).
  [cite: packages/lang/package.json L21-23]

### Command

Drop it where `tsc` would go in the build script:

```jsonc
// package.json
{ "scripts": { "build": "unworklet-tsc --noEmit && vite build" } }
```

Ad-hoc: `unworklet-tsc --noEmit`.
[cite: packages/lang/README.md L134-141, L148-150; test runs the shipped bin
`node dist/unworklet-tsc.mjs --noEmit` — packages/lang/src/unworklet-tsc.test.ts L93, L152]

### What it checks

- **Drop-in `tsc`** — every `tsc` flag passes through unchanged (tests exercise `--noEmit`). No
  tool-specific flags exist.
- **`.ts` files (including `.processor.ts`)** are checked exactly as `tsc` would.
- **`.uwk.ts` files** get their sugar type-checked instead of being flagged as raw TS — plain
  `tsc` fails on the sugar (e.g. `a * b` on two `Node`s).
  [cite: packages/lang/src/unworklet-tsc.ts L1-29]
- **Self-seeds `.unworklet/`** — before it hands anything to tsc, `unworklet-tsc` calls
  `seedUnworkletDir(process.cwd())` which writes `.unworklet/tsconfig.json` (and an empty
  `worklets.d.ts` if none exists yet). Safe as the first command on a fresh clone: no prior
  `vite dev` / `vite build` needed. The seed is idempotent — a later Vite run overwrites the
  same tsconfig content and fills in `worklets.d.ts`. [cite: packages/lang/src/unworklet-tsc.ts L25]
- Internally forces **`skipLibCheck: true`** so the injected authoring globals
  (`Node` / `event` / `process`) don't collide with `lib.dom` / `@types/node` as `Duplicate
identifier`. Your `.uwk.ts` / `.ts` stay fully checked; only `.d.ts` lib/`@types` conflicts are
  skipped.
  [cite: packages/lang/src/unworklet-tsc.ts L44]

### tsconfig requirement

Checks against your existing `tsconfig.json` — it must `include` your `.uwk.ts` files. Works with
or without the editor's `plugins` entry; the CLI injects the language plugin itself (the editor
`plugins` entry is only for the editor).
[cite: packages/lang/README.md L143-146; test tsconfig carries no `plugins` —
packages/lang/src/unworklet-tsc.test.ts L79, L133]

### Verified behavior (run against the shipped `dist` bin)

- Valid `.uwk.ts` sugar → empty output, exit `0`. [L97-109]
- Real DOM + `@types/node` app with `skipLibCheck: false` → still passes (injected globals must
  not fail the build). [L111-156]
- Real type error (a `bool` `Node` written to an `f32` output) → exit non-zero; the error names
  `Node<"bool">` / `Node<"f32">`, mapped onto the author's `check.uwk.ts` (not a virtual file).
  [L158-172]
  [cite: packages/lang/src/unworklet-tsc.test.ts]

### Scope note — `?worklet`

`unworklet-tsc` registers the extra extension `[".uwk.ts"]` only. `?worklet` is a bundler import
query handled by `@unworklet/unplugin`, not this CLI. A `.processor.ts` imported with `?worklet`
is plain `.ts` and is checked as `tsc` would.
[cite: packages/lang/src/unworklet-tsc.ts L29; packages/lang/README.md L257]

---

See also: setup.md (packages, vite config, file conventions), dsl.md (authoring forms + node
surface), testing.md, devtools.md.
