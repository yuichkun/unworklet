# DevTools

A 4-panel **Vite DevTools** dock that X-rays the audio thread. Values are read
bit-exact from WASM memory. Dev-only: in a production build the plugin compiles to
nothing, so the panels add zero runtime weight. (`README.md` L264-269;
`packages/unplugin/src/index.ts` L656-666)

Panels visualize any processor imported via `?worklet` (the loading path — see
loading.md), authored in `.uwk.ts` (primary, recommended form) or `.processor.ts`
(explicit core-method alternative). Both authoring forms render identically; see
uwk.md. (`README.md` L341)

## Enable (3 steps)

### 1. Install the host + kit — BOTH pinned to exactly `0.3.3`

```sh
npm install -D @vitejs/devtools@0.3.3 @vitejs/devtools-kit@0.3.3
```

Exact `0.3.3`, not a range (see "The exact 0.3.3 pin" below for why).
(`README.md` L294-296)

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
    // build, and it would keep the test runner from exiting.
    ...(command === "serve" ? [DevTools({ builtinDevTools: false })] : []),
  ],
}));
```

- `unworklet()` needs NO extra config — it auto-docks once the host is present.
  There is no devtools-enable option.
- Gate the host to `command === "serve"`; pass `builtinDevTools: false`.
- Activation fires only when the `@vitejs/devtools` host is in the config (via the
  plugin's `devtools.setup` hook).

(`README.md` L298-314; `packages/unplugin/src/index.ts` L1821-1830)

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

## The exact `0.3.3` pin

`@unworklet/unplugin` declares only `@vitejs/devtools-kit` as a peer — pinned
exact, marked optional (`packages/unplugin/package.json` L81-90):

```json
"peerDependencies": {
  "@unworklet/core": "workspace:^",
  "@vitejs/devtools-kit": "0.3.3",
  "vite": "^6 || ^7 || ^8"
},
"peerDependenciesMeta": {
  "@vitejs/devtools-kit": { "optional": true }
}
```

- `@vitejs/devtools` (the host) `0.3.3` is the install-side pin only (the install
  line above); it is NOT an unplugin peer.
- **Why exact:** live panels push to the dev server through an anonymous RPC scope
  whose prefix is coupled to the DevTools major (`devframe:anonymous:` in 0.3). A
  mismatched host silently rejects every push (DTK0013) and panels stay empty.
  (`packages/unplugin/src/index.ts` L708-719)
- **Must be a direct dep:** the panel's page bridge imports
  `@vitejs/devtools-kit/client`, which must resolve from the app — a transitive
  copy is not enough. (`README.md` L322-324; `packages/unplugin/src/index.ts` L1233)

## Cross-origin isolation (`crossOriginIsolation`, default `true`)

The plugin makes the dev AND preview server cross-origin isolated so
`SharedArrayBuffer` (the fast main↔worklet transport — see loading.md) works with
zero app config. It only sets headers the app left unset; it never clobbers an
app's own COOP/COEP. Production headers stay the app server's job.

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

`credentialless` (not `require-corp`) is least-breaking AND lets the DevTools
iframe embed; `require-corp` would block it. (`packages/unplugin/src/index.ts`
L470-487, L999-1029; `README.md` L325-331)

Opt out:

```ts
unworklet({ crossOriginIsolation: false });
```

unworklet then uses the postMessage transport in dev. (`README.md` L329-331;
`packages/unplugin/src/index.ts` L477-486)

## Plugin options (full surface)

```ts
export type UnworkletPluginOptions = {
  emitAnalysisArtifacts?: boolean; // default true
  crossOriginIsolation?: boolean; // default true
};
```

There is no devtools-enable option; the panel auto-docks when the
`@vitejs/devtools` host is in the config. (`packages/unplugin/src/index.ts`
L470-487)

## Notes

- Cannot be deployed as a static demo — the host is a dev-time server. Clone the
  repo and start an example locally to try the panels live. (`README.md` L333-334)
