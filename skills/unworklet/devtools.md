# DevTools

A 4-panel **Vite DevTools** dock that X-rays the audio thread. Values are read
bit-exact from WASM memory. Dev-only: the plugin's `define` block sets
`__UNWORKLET_DEVTOOLS__` to `"true"` in `serve` and `"false"` in `build`
(`packages/unplugin/src/index.ts` L864-873); the client-side gate that
tree-shakes the dev traffic is at `packages/core/src/client.ts:1810`. Panels
add zero runtime weight in production.

Panels visualize any processor imported via `?worklet` (the loading path — see
loading.md), authored in `.uwk.ts` (primary, recommended form) or `.processor.ts`
(explicit core-method alternative). Both authoring forms render identically; see
uwk.md. (`README.md` L341)

## Enable (3 steps)

### 1. Install the host + kit + adapters — 0.4.x line

```sh
npm install -D @vitejs/devtools@0.4 @vitejs/devtools-kit@0.4 \
  @vitejs/devtools-rolldown@0.4 @vitejs/devtools-oxc@0.4 \
  @vitejs/devtools-vitest@0.4 @vitejs/devtools-vite@0.4
```

All 6 packages on the same major (0.4). `@unworklet/unplugin` pins
`@vitejs/devtools-kit` to `^0.4.0` — the anonymous-RPC scope prefix is
coupled to the major, so a mismatched-major host silently rejects every
panel push (see "The 0.4 pin" below for why the major matters). The
0.3 line was Vite 6/7 only; 0.4 is required for Vite 8.

### 2. Add the DevTools host to `vite.config.ts` (serve-only)

```ts
// vite.config.ts
import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/unplugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    unworklet(),
    // Dev only — the DevTools host runs a long-lived server, pointless in a
    // build, and it would keep the test runner from exiting. Vitest passes
    // `command: "serve"` to plugins, so the `command === "serve"` gate is NOT
    // enough on its own — also gate on `!process.env.VITEST` or `vitest run`
    // hangs 10s at close ("close timed out after 10000ms") on every invocation.
    ...(command === "serve" && !process.env.VITEST ? [DevTools({ builtinDevTools: false })] : []),
  ],
}));
```

- `unworklet()` needs NO extra config — it auto-docks once the host is present.
  There is no devtools-enable option.
- Gate the host to `command === "serve" && !process.env.VITEST`; pass
  `builtinDevTools: false`.
- Activation fires only when the `@vitejs/devtools` host is in the config (via the
  plugin's `devtools.setup` hook).

(`packages/unplugin/src/index.ts` L1686-1696 for the `devtools.setup` hook that
runs only when the `@vitejs/devtools` host is present.)

### 3. View it

Run the dev server → open the Vite DevTools overlay → pick the **unworklet** dock.
(`README.md` L298-314)

## The 4 panels (Vue 3 SPA, hash router)

| route          | sidebar label             | shows                                                                  |
| -------------- | ------------------------- | ---------------------------------------------------------------------- |
| `/audio-graph` | **Audio graph**           | the running `AudioContext` topology                                    |
| `/live-state`  | **Live state**            | every `state` / buffer slot, live from WASM memory                     |
| `/signals`     | **Signals & performance** | per-output waveform / spectrum / RMS / peak + `AudioContext` latencies |
| `/midi`        | **MIDI**                  | event log + a virtual keyboard to inject notes                         |

`/` redirects to `/audio-graph`. (`README.md` L271-274;
`packages/unplugin/devtools-ui/src/router.ts`)

## The 0.4 pin

`@unworklet/unplugin` declares only `@vitejs/devtools-kit` as a peer — pinned
to the 0.4 major, marked optional (`packages/unplugin/package.json`):

```json
"peerDependencies": {
  "@unworklet/core": "workspace:^",
  "@vitejs/devtools-kit": "^0.4.0",
  "vite": "^6 || ^7 || ^8"
},
"peerDependenciesMeta": {
  "@vitejs/devtools-kit": { "optional": true }
}
```

- `@vitejs/devtools` (the host) install line above matches the major but is not
  an unplugin peer.
- **Why coupled to the major:** live panels push to the dev server through an
  anonymous RPC scope whose prefix is coupled to the DevTools major
  (`devframe:anonymous:` on the current line). A mismatched-major host silently
  rejects every push (DTK0013) and panels stay empty.
  (`packages/unplugin/src/index.ts` L708-719)
- **Must be a direct dep:** the panel's page bridge imports
  `@vitejs/devtools-kit/client`, which must resolve from the app — a transitive
  copy is not enough. (The `import` sits in an injected page-bridge module
  string at `packages/unplugin/src/index.ts:1098`; the rationale note is at
  `L1692` on the `devtools.setup` hook.)

## Cross-origin isolation (`crossOriginIsolation`, default `true`)

The plugin makes the dev AND preview server cross-origin isolated so
`SharedArrayBuffer` (the fast main↔worklet transport — see loading.md) works with
zero app config. It only sets headers the app left unset; it never clobbers an
app's own COOP/COEP. Production headers stay the app server's job.

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

`credentialless` (not `require-corp`) is least-breaking AND lets the DevTools
iframe embed; `require-corp` would block it. (Default header injection is
in the `config` hook at `packages/unplugin/src/index.ts:L864-893`; the
DevTools iframe COEP mirror lives in `configureServer` at `L946-967`.)

Opt out:

```ts
unworklet({ crossOriginIsolation: false });
```

unworklet then uses the postMessage transport in dev. (Opt-out branch:
`packages/unplugin/src/index.ts:874`; client-side SAB→postMessage switch:
`packages/core/src/client.ts:387`.)

## Plugin options (full surface)

```ts
export type UnworkletPluginOptions = {
  emitAnalysisArtifacts?: boolean; // default true
  crossOriginIsolation?: boolean; // default true
};
```

There is no devtools-enable option; the panel auto-docks when the
`@vitejs/devtools` host is in the config. (`UnworkletPluginOptions` type
declaration: `packages/unplugin/src/index.ts:392-409`.)

## Notes

- Cannot be deployed as a static demo — the host is a dev-time server. Clone the
  repo and start an example locally to try the panels live. (`README.md` L333-334)
