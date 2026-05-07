# @unworklet/worklet

Browser-side helpers. WASM transport, real AudioWorklet.

## createWasmNode

```ts
import { createWasmNode } from "@unworklet/worklet";

const node = await createWasmNode(audioContext, processor, processorName, options?);
```

What it does:

1. Compiles the processor to WASM (cached on `(processor, sampleRate)`).
2. Generates the per-processor AudioWorklet module JS.
3. Wraps the source in a Blob URL + calls `audioContext.audioWorklet.addModule(...)`.
4. Constructs an `AudioWorkletNode` with the right input/output port shape.
5. Waits for the worklet's `ready` message; surfaces SAB transport when shared memory is available.
6. Returns a `WasmUnworkletNode` with the same surface as the JS-engine `UnworkletNode`, plus `node.node` (the underlying `AudioWorkletNode`).

## WasmUnworkletNode

```ts
{
  node: AudioWorkletNode;
  inputs: Record<string, { connect, disconnect, node, index }>;
  outputs: Record<string, { connect, disconnect, node, index }>;
  params: Record<string, AudioParam>;            // real AudioParams
  state: Record<string, { value, subscribe }>;   // SAB-driven where available
  events: Record<string, { on, diagnostics }>;
  messages: Record<string, ((payload) => void) & { diagnostics }>;
  midi: { send, onEvent, connectFromWebMIDI };
  diagnostics: { transport: 'sab' | 'postMessage'; overflows() };
  lifecycle: { state, onChange };
  snapshot(opts?): Promise<Uint8Array>;
  restore(blob): Promise<{ restored, skipped, missing, error? }>;  // host-walks migrations
  inspect(blob): { version, schemaHash, format, stateBytes?, bufferCount? };
  dispose(): void;
}
```

## engineSnapshotToWasm

Convert a JS-engine UWS1 snapshot blob to the WASM UWSN format the worklet's `_handleRestore` consumes. Used internally by `node.restore` to ferry migrated state from a host-side `Engine` into the worklet.

```ts
import { engineSnapshotToWasm } from "@unworklet/worklet";

const wasmBlob = await engineSnapshotToWasm(processor, uws1Blob, layout);
// post to worklet via node.port.postMessage({ type: 'restore', id, blob: wasmBlob });
```

## Lifecycle

`creating → ready → running → disposed` (or `errored` from any state, terminal).

- `creating`: AudioWorkletNode constructed but worklet ctor hasn't yet posted `ready`.
- `ready`: layout known; safe to send messages, drive params.
- `running`: at least one process() block has executed.
- `disposed`: `node.dispose()` called.
- `errored`: WASM trap, init error, or unhandled processor error.
