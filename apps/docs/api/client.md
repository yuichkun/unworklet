# @unworklet/client

JS-engine path. Same surface as the WASM path; runs in Node + offline.

## createNode

```ts
import { createNode } from "@unworklet/client";

const node = await createNode(audioContext: any | null, processor, options?);
```

The `audioContext` argument is reserved for symmetry with the WASM helper but ignored on the JS path (pass `null` in tests).

Options:

```ts
{
  sampleRate?: number;        // default 48000
  blockSize?: number;         // default 128
  initial?: Record<string, number>;  // initial param values
}
```

## UnworkletNode surface

```ts
{
  node: AudioWorkletNode | null;  // null on JS path
  inputs: Record<string, FakeAudioConnect>;
  outputs: Record<string, FakeAudioConnect>;
  params: Record<string, FakeAudioParam>;
  state: Record<string, StatePublisher>;
  events: Record<string, EventSubscription>;
  messages: Record<string, MessageSender>;
  midi: MidiAPI;
  diagnostics: { transport: 'sab' | 'postMessage' | 'js' };
  lifecycle: { state: LifecycleState; onChange(h): () => void };
  snapshot(opts?): Promise<Uint8Array>;
  restore(blob): Promise<{ restored: number; skipped: string[]; missing: string[] }>;
  inspect(blob): { version, schemaHash, profile?, slots, format };
  dispose(): void;
  onError(h: (err: Error) => void): void;
  __engine: Engine;            // direct access for tests
}
```

## renderOffline

```ts
import { renderOffline } from "@unworklet/client";

const result = await renderOffline(processor, {
  sampleRate: 48000,
  duration: 2,
  input: { main: [leftCh, rightCh] },
  params: { gain: 0.5 },
  paramAutomation: { cutoff: (t) => 0.3 + 0.2 * Math.sin(2 * Math.PI * 0.5 * t) },
  messages: [{ at: 0.5, name: "uploadIR", payload: { irL, irR } }],
  midiEvents: [{ at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } }],
});
// result: { output, events, midiOut, peak, rms, hasNaN }
```

## inspect

Standalone inspector — no engine required.

```ts
import { inspect } from "@unworklet/client";

const meta = inspect(blob);
// { version, schemaHash, profile, slots, format: 'engine' | 'wasm' }
```

Auto-detects UWS1 (engine) and UWSN (worklet) snapshot formats.
