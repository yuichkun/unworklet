# DevTools

A 4-panel **Vite DevTools** dock that X-rays the audio thread. Values are read
bit-exact from WASM memory. Dev-only: the plugin's `define` block sets
`__UNWORKLET_DEVTOOLS__` to `"true"` in `serve` and `"false"` in `build`
[cite: packages/unplugin/src/index.ts :: `__UNWORKLET_DEVTOOLS__: env.command === "serve" ? "true" : "false"`]; the client-side gate that
tree-shakes the dev traffic is at [cite: packages/core/src/client.ts :: `if (typeof __UNWORKLET_DEVTOOLS__ !== "undefined" && __UNWORKLET_DEVTOOLS__ === true)`]. Panels
add zero runtime weight in production.

Panels visualize any processor imported via `?worklet` (the loading path — see
setup.md), authored in `.uwk.ts` (primary, recommended form) or `.processor.ts`
(explicit core-method alternative). Both authoring forms render identically; see
dsl.md. [cite: README.md :: `## DevTools`]

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

([cite: packages/unplugin/src/index.ts :: `devtools: { setup: async (ctx) => {`] for the `devtools.setup` hook that
runs only when the `@vitejs/devtools` host is present.)

### 3. View it

Run the dev server → open the Vite DevTools overlay → pick the **unworklet** dock.
[cite: README.md :: `Run your dev server, open the Vite DevTools overlay, and pick the **unworklet** dock.`]

## The 4 panels (Vue 3 SPA, hash router)

| route          | sidebar label             | shows                                                                               |
| -------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `/audio-graph` | **Audio graph**           | the running `AudioContext` topology                                                 |
| `/live-state`  | **Live state**            | every `state` / buffer slot, live from WASM memory                                  |
| `/signals`     | **Signals & performance** | per-output mono-downmix waveform / spectrum / RMS / peak + `AudioContext` latencies |
| `/midi`        | **MIDI**                  | event log + a virtual keyboard to inject notes                                      |

`/` redirects to `/audio-graph`. [cite: packages/unplugin/devtools-ui/src/router.ts :: `redirect: "/audio-graph"`]

Use **Application page** in the sidebar to select an app tab. All four panels
show only that page's nodes; the MIDI keyboard targets that page and its selected
input. Identical node IDs in other tabs cannot receive the injection. Switching
pages releases held notes on the original page and clears the view's selection,
scalar histories, and signal frames.

Reloading or reconnecting creates a fresh, temporary page session. A disconnected
selection stays empty until you explicitly choose a live page; it does not switch
the keyboard to another tab. Page data and pending injections are removed on page
exit or when the server observes its connection closing. Background tabs are not
expired for being idle. Restoring a page from the back-forward cache starts a
fresh session; if the DevTools client was not available before navigation,
restoration restarts its bounded discovery attempts. Session cleanup sends
matching `noteOff` events for held DevTools injections through their original local input ports, even if the
DevTools connection has closed. Cleanup also sends value 0 for holding pedals
engaged by DevTools on those same ports/channels, including when the keys were
already released. This covers Sustain (CC64), Sostenuto (CC66), and Hold 2 (CC69),
using the [MIDI on/off threshold](https://midi.org/midi-1-0-control-change-messages)
of 64. Changing the MIDI target/channel or closing its view sends the same
releases for holding pedals engaged by that view. `MidiPortSurface.send()` has no delivery
acknowledgment; this cleanup uses the same bounded transport as other MIDI sends.
The 0.4 host does not automatically reopen a closed DevTools socket. Reload the
application page to reconnect; its replacement session must be selected explicitly.

Signals' waveform, spectrum, RMS and peak are **mono downmix** measurements of
an output port, not per-channel levels. Stereo channels with opposite polarity
can cancel to zero even when both channels contain audio. A signal in only one
stereo channel is attenuated by the downmix. A zero reading does not establish
silence in every channel, and the displayed peak cannot rule out clipping in
individual channels. Mono output is measured directly; same-polarity stereo
channels combine in the downmix.
[cite: packages/unplugin/src/index.ts :: `const ensureAnalysers = (awn, outputs) => {`]
[cite: packages/unplugin/devtools-ui/src/views/SignalsView.vue :: `Waveform, spectrum, RMS and peak measure each output port's mono downmix.`]

Live state renders signed buffers around a zero baseline. For `i64` buffers,
List preserves exact decimal integers; Bar chart and Waveform are labeled
approximate because their numeric projections can round values beyond 2^53.
Large buffers remain stride-downsampled, including their exact List elements.

Mouse leave/up releases only mouse-held notes. When the mouse and PC keyboard
hold the same note, it stays on until both inputs release it. Changing octaves
releases mouse ownership of keys removed from the piano; PC-held notes continue
until their physical key is released.
MIDI keys are released on their original target port and channel when routing
changes or the MIDI view closes. Panic releases held keys and sends All Notes
Off on every channel of the selected input.

## Shared-state and RPC consumers

Custom TypeScript integrations opt into the client RPC and shared-state types
with `import type {} from "@unworklet/unplugin/devtools"`. This type-only entry
augments the DevTools client's interfaces. Ordinary plugin consumers do not
need this entry. `devframe` is an explicit dependency
so the opt-in declarations resolve under strict package-manager layouts. The
plugin adds no runtime import of it, and the DevTools kit remains optional.

The built-in panels read `unworklet:page-graph`, `unworklet:page-state`,
`unworklet:page-signals`, and `unworklet:page-midi`. Each contains
`{ pages: { [pageId]: snapshot } }`; `unworklet:pages` lists live page metadata.
Page telemetry uses the matching `anonymous:unworklet:page-*-update` RPCs with
`{ pageId, data }`. The server accepts a page's updates only from its registered
connection.

The unscoped `unworklet:graph`, `unworklet:state`, `unworklet:signals`, and
`unworklet:midi` keys contain raw snapshots of their published types. Each is the
most recently received snapshot for that kind, which can come from any page.
The matching `anonymous:unworklet:*-update` RPCs accept those raw snapshots;
they do not change page-scoped state.

Trusted clients inject with `unworklet:page-midi-inject` and
`{ pageId, nodeId, port, event }`. Commands appear in `unworklet:page-midi-inject`
with their page ID and sequence number. The unscoped `unworklet:midi-inject` RPC
accepts `{ nodeId, port, event }` and publishes it to the unscoped queue with the
`DevMidiInjectCommand` shape, even when no application pages are connected. It
is consumed independently by each bridge, including retained commands when a
fresh bridge first subscribes. Each bridge advances its unscoped cursor before
looking up the local node and port, so a command whose local target is missing
at consumption time is dropped. That cursor persists across reconnects in the
same bridge instance; a fresh application page starts at zero.
These calls have no selected page and can reach multiple tabs or fresh pages;
use the explicit page-targeted RPC whenever isolation is required. The built-in
panel uses only that explicit path. Scoped commands never enter the unscoped
queue, and fresh page sessions reject commands targeting an earlier page.

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
  (`anonymous:` on the current line). A mismatched-major host silently
  rejects every push (DTK0013) and panels stay empty.
  [cite: packages/unplugin/src/devtools-pages.ts :: `export const ANONYMOUS_RPC_PREFIX = "anonymous:";`]
- **Must be a direct dep:** the panel's page bridge imports
  `@vitejs/devtools-kit/client`, which must resolve from the app — a transitive
  copy is not enough. (The `import` sits in an injected page-bridge module
  string at [cite: packages/unplugin/src/index.ts :: `import { getDevToolsClientContext } from "@vitejs/devtools-kit/client";`]; the rationale note is at
  [cite: packages/unplugin/src/index.ts :: `devtools: { setup: async (ctx) => {`] on the `devtools.setup` hook.)

## Cross-origin isolation (`crossOriginIsolation`, default `true`)

The plugin makes the dev AND preview server cross-origin isolated so
`SharedArrayBuffer` (the fast main↔worklet transport — see dsl.md) works with
zero app config. It only sets headers the app left unset; it never clobbers an
app's own COOP/COEP. Production headers stay the app server's job.

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

`credentialless` (not `require-corp`) is least-breaking AND lets the DevTools
iframe embed; `require-corp` would block it. (Default header injection is
in the `config` hook at [cite: packages/unplugin/src/index.ts :: `headers["Cross-Origin-Embedder-Policy"] = "credentialless";`]; the
DevTools iframe COEP mirror lives in `configureServer` at [cite: packages/unplugin/src/index.ts :: `res.setHeader("Cross-Origin-Embedder-Policy", coep);`].)

Opt out:

```ts
unworklet({ crossOriginIsolation: false });
```

unworklet then uses the postMessage transport in dev. (Opt-out branch:
[cite: packages/unplugin/src/index.ts :: `if (!crossOriginIsolation) return { define };`]; client-side SAB→postMessage switch:
[cite: packages/core/src/client.ts :: `const transportMode: "sab" | "postMessage" = sabAvailable ? "sab" : "postMessage";`].)

## Plugin options (full surface)

```ts
export type UnworkletPluginOptions = {
  emitAnalysisArtifacts?: boolean; // default false — opt in to emit graph/memory/diagnostics/schema-hash JSON on build (the graph DAG can reach 100s of MB for loop-heavy processors; artifacts past ~8 MB are skipped with a warning)
  crossOriginIsolation?: boolean; // default true
};
```

There is no devtools-enable option; the panel auto-docks when the
`@vitejs/devtools` host is in the config. (`UnworkletPluginOptions` type
declaration: [cite: packages/unplugin/src/index.ts :: `export type UnworkletPluginOptions =`].)

## Notes

- Cannot be deployed as a static demo — the host is a dev-time server. Clone the
  repo and start an example locally to try the panels live. [cite: README.md :: `The panels can't be deployed as a static demo: the host is a dev-time server`]
