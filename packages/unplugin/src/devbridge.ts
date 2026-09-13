/**
 * Pure transforms for the DevTools page-script (the dev bridge). They run in the
 * browser — imported by the injected page-script via `@unworklet/unplugin/devbridge`
 * — but are plain data functions with no browser globals, so they are unit-tested
 * directly in Node (`devbridge.test.ts`). Keeping them here, rather than inline in
 * the page-script string, is what makes that coverage possible.
 */

import { decodeScalar, decodeTypedArray } from "@unworklet/core";

export type DevSlotType = "f32" | "f64" | "i32" | "i64" | "bool" | "u8";

/** One slot as `devDump()` returns it: raw little-endian bytes tagged by kind/type. */
export type RawSlot = {
  name: string;
  kind: "state" | "param" | "buffer";
  type: DevSlotType;
  data: Uint8Array;
};

export type DevStateScalar = {
  name: string;
  kind: "state" | "param";
  type: DevSlotType;
  value: number | boolean | string;
};
export type DevStateBuffer = {
  name: string;
  type: DevSlotType;
  length: number;
  data: number[];
  downsampled: boolean;
};

/**
 * Decode a node's dumped slots into JSON-safe live values: scalars carry their
 * decoded value (i64 as a decimal string — JSON has no bigint); buffers carry
 * their decoded elements, stride-downsampled to `maxBufferPoints` when larger
 * (`length` always reports the true element count). The worklet already copied
 * the bytes — downsampling here only keeps the wire light.
 */
export function splitSlots(
  slots: readonly RawSlot[],
  maxBufferPoints: number,
): { scalars: DevStateScalar[]; buffers: DevStateBuffer[] } {
  const scalars: DevStateScalar[] = [];
  const buffers: DevStateBuffer[] = [];
  for (const s of slots) {
    if (s.kind === "buffer") {
      const arr = decodeTypedArray(s.type, s.data);
      const length = arr.length;
      if (length <= maxBufferPoints) {
        buffers.push({
          name: s.name,
          type: s.type,
          length,
          data: Array.from(arr as ArrayLike<number | bigint>, Number),
          downsampled: false,
        });
      } else {
        const stride = length / maxBufferPoints;
        const src = arr as ArrayLike<number | bigint>;
        const data = Array.from({ length: maxBufferPoints }, (_, i) =>
          Number(src[Math.floor(i * stride)]),
        );
        buffers.push({ name: s.name, type: s.type, length, data, downsampled: true });
      }
    } else {
      // A scalar slot's type is always a ScalarType (u8 is buffer-only); the
      // RawSlot type can't express that, so narrow to decodeScalar's parameter.
      const v = decodeScalar(s.type as Parameters<typeof decodeScalar>[0], s.data);
      scalars.push({
        name: s.name,
        kind: s.kind,
        type: s.type,
        value: typeof v === "bigint" ? v.toString() : v,
      });
    }
  }
  return { scalars, buffers };
}

/**
 * Fold each unworklet node's internal input-proxy gain out of a captured audio
 * graph. Every unworklet node fronts each audio input with a proxy GainNode
 * (createNode wires proxyGain → AudioWorkletNode); the app never authored those,
 * so an edge INTO a proxy becomes an edge into its owner, the proxy's own
 * outgoing edge is dropped, and the proxy is omitted from the node list. The
 * result is exactly the connections the app wrote.
 *
 * `proxyOwner` maps a proxy node id to its owning unworklet node id. Generic over
 * the node shape so it stays decoupled from the DevTools graph types.
 */
export function foldProxyGraph<T extends { id: string }>(
  nodes: readonly T[],
  edges: ReadonlyArray<{ from: string; to: string }>,
  proxyOwner: Readonly<Record<string, string>>,
): { nodes: T[]; edges: Array<{ id: string; from: string; to: string }> } {
  const outNodes = nodes.filter((n) => proxyOwner[n.id] === undefined);
  const outEdges: Array<{ id: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (proxyOwner[e.from] !== undefined) continue; // drop proxy → AudioWorkletNode plumbing
    const to = proxyOwner[e.to] ?? e.to; // fold edge-into-proxy onto the owner
    // A folded `owner → owner` edge is an authored feedback connection
    // (`node.connect(node.inputs.fb)`, valid with a delay in the cycle): the only
    // self-loop that survives the proxy-plumbing filter above, so keep it — the
    // panel must report the real topology rather than hide the loop.
    const id = `${e.from}>${to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    outEdges.push({ id, from: e.from, to });
  }
  return { nodes: outNodes, edges: outEdges };
}

// ─────────────────────────────────────────────────────────────────────────
// Signals panel transforms (= the DevTools page-script taps an AnalyserNode on
// each unworklet output and turns its time/frequency frames into JSON-light
// scope data). All pure + unit-tested here, away from the page-script string.
// ─────────────────────────────────────────────────────────────────────────

export type SignalLevels = { rms: number; peak: number };

/**
 * RMS + absolute peak of a time-domain frame. Computed on the full-resolution
 * frame (before any display downsample) so the peak is never under-reported.
 */
export function frameLevels(time: ArrayLike<number>): SignalLevels {
  const n = time.length;
  if (n === 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = time[i] as number;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { rms: Math.sqrt(sumSq / n), peak };
}

/**
 * Stride-decimate a numeric frame down to at most `points` samples for the
 * wire. Frames already at/under the target pass through unchanged.
 */
export function downsampleTo(src: ArrayLike<number>, points: number): number[] {
  const n = src.length;
  if (points <= 0) return [];
  if (n <= points) return Array.from(src as ArrayLike<number>, Number);
  const stride = n / points;
  return Array.from({ length: points }, (_, i) => Number(src[Math.floor(i * stride)]));
}

/**
 * Map an AnalyserNode `getFloatFrequencyData` frame (dB magnitudes, typically
 * ~ -140..0) into 0..1 over `[minDb, maxDb]`, decimated to `points` bins.
 * Out-of-range values clamp so the heatmap LUT never indexes out of bounds.
 */
export function normalizeFreqDb(
  freqDb: ArrayLike<number>,
  points: number,
  minDb = -100,
  maxDb = -30,
): number[] {
  const n = freqDb.length;
  if (points <= 0 || n === 0) return [];
  const span = maxDb - minDb || 1;
  const take = Math.min(points, n);
  const stride = n / take;
  return Array.from({ length: take }, (_, i) => {
    const db = Number(freqDb[Math.floor(i * stride)]);
    const norm = (db - minDb) / span;
    return norm < 0 ? 0 : norm > 1 ? 1 : norm;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MIDI panel transforms (= the page-script taps `onEvent` on each out port for
// the live log, and drains a seq'd inject queue into `node.midi[port].send`).
// ─────────────────────────────────────────────────────────────────────────

/** Append `entry`, keeping at most `max` most-recent items (oldest dropped). */
export function appendBounded<T>(items: readonly T[], entry: T, max: number): T[] {
  const start = items.length >= max ? items.length - max + 1 : 0;
  const out = items.slice(start);
  out.push(entry);
  return out;
}

/**
 * Select inject commands newer than `lastSeq`, in seq order, returning them plus
 * the new high-water seq. A monotonic seq (not state coalescing) is what keeps a
 * fast burst of key presses — including the trailing noteOff — from being lost
 * when several land between two shared-state notifications.
 */
export function drainInjects<T extends { seq: number }>(
  commands: readonly T[],
  lastSeq: number,
): { fresh: T[]; lastSeq: number } {
  const fresh = commands.filter((c) => c.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  return { fresh, lastSeq: fresh.length > 0 ? fresh[fresh.length - 1]!.seq : lastSeq };
}

export type MemoryEntry = { name: string; kind: string; bytes: number };

/**
 * Declared linear-memory footprint of a node's dumped slots: each slot's byte
 * count is the real length of the bytes `devDump()` copied out of WASM memory.
 * This is the actual static layout, not an estimate.
 */
export function slotMemory(slots: readonly RawSlot[]): {
  entries: MemoryEntry[];
  totalBytes: number;
} {
  let totalBytes = 0;
  const entries = slots.map((s) => {
    const bytes = s.data.byteLength;
    totalBytes += bytes;
    return { name: s.name, kind: s.kind, bytes };
  });
  return { entries, totalBytes };
}

/**
 * Prepare a DevTools-injected MIDI event for `MidiPortSurface.send`.
 *
 * The panel serializes events over RPC, so a sysex payload arrives as a plain
 * `number[]` — but `send()` expects the main-side `MidiEvent` shape, whose
 * sysex `data` is a `Uint8Array` (a plain array throws on the SAB path and
 * mis-decodes on the postMessage path). Conversion validates first:
 * `Uint8Array.from` would silently wrap 300 → 44 and truncate 1.5 → 1, turning
 * a malformed panel payload into a DIFFERENT message. Returns `null` for a
 * payload that cannot be represented byte-for-byte; non-sysex events pass
 * through untouched.
 */
export function toSendableMidiEvent<E extends { type: string; data?: unknown }>(
  event: E,
): E | (Omit<E, "data"> & { data: Uint8Array }) | null {
  if (event.type !== "sysex") return event;
  const data = event.data;
  if (data instanceof Uint8Array) return event;
  if (!Array.isArray(data)) return null;
  for (const b of data) {
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) return null;
  }
  return { ...event, data: Uint8Array.from(data as number[]) };
}

/**
 * The MIDI log's wire shape: sysex bytes as a plain array.
 *
 * The log crosses the DevTools RPC boundary, where a `Uint8Array` serializes as
 * an indexed object rather than the `data: number[]` the `DevMidiEvent`
 * contract states — the panel would read a malformed entry. Sending still wants
 * the typed form (`toSendableMidiEvent`), so the conversion belongs at the log,
 * not at the send.
 */
export function toLoggableMidiEvent<E extends { type: string; data?: unknown }>(
  event: E,
): E | (Omit<E, "data"> & { data: number[] }) {
  if (event.type !== "sysex" || event.data === undefined) return event;
  if (Array.isArray(event.data)) return event;
  if (!ArrayBuffer.isView(event.data)) return event;
  return { ...event, data: Array.from(event.data as Uint8Array) };
}
