import { decodeSnapshot } from "../snapshotBlob.ts";

export type IngressPacket = { id: number; gain: number; flag: boolean; samples: Float32Array };
export type IngressRecord = { name: string; atSample: number; payload: Record<string, number> };
export const INGRESS_RATE = 48_000;
export const INGRESS_SAMPLES = 512;

export function ingressBatches(): IngressPacket[][] {
  let id = 0;
  return [0, 20, 2, 17].map((count) =>
    Array.from({ length: count }, () => {
      id++;
      const backing = new Float32Array([999, id / 7, -id / 11, id / 13, -999]);
      return {
        id,
        gain: ((id % 7) - 3) / 10,
        flag: id % 2 === 0,
        samples: backing.subarray(1, 1 + ((id + Math.floor((id - 1) / 16)) % 4)),
      };
    }),
  );
}

// Each ring preserves FIFO; independent SAB ring captures can arrive interleaved.
export function ingressLedger(packets: IngressRecord[]) {
  const rings: Record<string, IngressRecord[]> = { record: [], frame: [] };
  for (const packet of packets) (rings[packet.name] ??= []).push(packet);
  return rings;
}

export const ingressByRing = <T extends { ledger: IngressRecord[] }>(observation: T) => ({
  ...observation,
  ledger: ingressLedger(observation.ledger),
});

export const ingressBits = (pcm: Float32Array) => Array.from(new Uint32Array(pcm.slice().buffer));
export const ingressSlots = (blob: Uint8Array) =>
  decodeSnapshot(blob)
    .slots.map((slot) => ({ ...slot, data: Array.from(slot.data) }))
    .sort((a, b) => a.name.localeCompare(b.name));

// This model uses no compiler, ring helpers, wire codecs, or fixture DSP.
export function literalIngress() {
  const f = Math.fround;
  const history = Array<number>(512).fill(0);
  const pcm: number[] = [];
  const ledger: IngressRecord[] = [];
  const retained: number[] = [];
  const overflow: number[] = [];
  const snapshots: ReturnType<typeof ingressSlots>[] = [];
  let count = 0,
    level = 0,
    phase = 0,
    dropped = 0;
  const slot = (name: string, kind: "buffer" | "state", type: "f32" | "i32", values: number[]) => {
    const data = new Uint8Array(values.length * 4);
    const view = new DataView(data.buffer);
    values.forEach((value, i) => {
      if (type === "i32") view.setInt32(i * 4, value, true);
      else view.setFloat32(i * 4, value, true);
    });
    return { name, kind, type, data: Array.from(data) };
  };
  const snapshot = (blocks: number) => [
    slot("blocks", "state", "i32", [blocks]),
    slot("count", "state", "i32", [count]),
    slot("history", "buffer", "f32", history),
    slot("level", "state", "f32", [level]),
    slot("phase", "state", "f32", [phase]),
  ];
  const initial = snapshot(0);
  for (const [quantum, batch] of ingressBatches().entries()) {
    const queue: IngressPacket[] = [];
    for (const packet of batch) {
      if (queue.length === 16) {
        queue.shift();
        dropped++;
      }
      queue.push(packet);
    }
    retained.push(queue.length);
    overflow.push(dropped);
    for (const packet of queue) {
      const { id, flag, samples } = packet;
      const gain = f(packet.gain);
      const at = (index: number) => samples[Math.min(index, samples.length - 1)] ?? 0;
      const a = at(0),
        b = at(1),
        c = at(2),
        size = samples.length;
      level = f(f(f(level + f(gain * a)) + f(Number(flag) * f(0.125))) + f(id * f(0.001)));
      history.splice(count * 9, 9, quantum, id, gain, Number(flag), size, a, b, c, level);
      count++;
      ledger.push({
        name: "record",
        atSample: 0,
        payload: { quantum, id, gain, flag: Number(flag), size, a, b, c, level },
      });
    }
    for (let i = 0; i < 128; i++) {
      phase = f(phase + f(0.003));
      pcm.push(f(phase + f(level * f(0.01))));
    }
    ledger.push({ name: "frame", atSample: 127, payload: { quantum, count, level } });
    snapshots.push(snapshot(quantum + 1));
  }
  return {
    pcm: ingressBits(Float32Array.from(pcm)),
    ledger,
    snapshots,
    initial,
    retained,
    overflow,
  };
}
export type IngressObservation = ReturnType<typeof literalIngress>;
