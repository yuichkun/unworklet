import { expect, test } from "vite-plus/test";
import {
  literalIngress,
  ingressBatches,
  ingressLedger,
  ingressByRing,
} from "./browser/fixtures/generic-ingress-model.ts";
import { renderGenericIngress } from "./browser/fixtures/generic-ingress-offline.ts";

test("generic ingress: four 48kHz quanta match a literal FIFO/f32 oracle", async () => {
  const expected = literalIngress();
  expect(expected.retained).toEqual([0, 16, 2, 16]);
  expect(expected.ledger).toHaveLength(38);
  expect(new Set(expected.pcm).size).toBeGreaterThan(128);
  const { overflow, ...offlineExpected } = expected;
  expect(overflow).toEqual([0, 4, 4, 5]);
  expect(ingressByRing(await renderGenericIngress())).toEqual(ingressByRing(offlineExpected));
});

for (const fault of ["reverse", "byteOffset", "stale"] as const) {
  test(`generic ingress oracle rejects ${fault} input corruption`, async () => {
    const batches = ingressBatches();
    for (const batch of batches) {
      if (fault === "reverse") batch.reverse();
      if (fault === "byteOffset")
        for (const packet of batch)
          packet.samples = new Float32Array(packet.samples.buffer, 0, packet.samples.length);
      if (fault === "stale") for (let i = 1; i < batch.length; i++) batch[i] = batch[0]!;
    }
    const baseline = await renderGenericIngress();
    expect(ingressByRing(await renderGenericIngress(batches))).not.toEqual(ingressByRing(baseline));
  });
}

test("generic ingress comparison rejects intermediate loss, ledger order/fields, PCM bits and late snapshot bytes", async () => {
  const expected = await renderGenericIngress();
  const faults = [
    (r: typeof expected) => {
      r.ledger.splice(5, 1);
    },
    (r: typeof expected) => {
      r.ledger.reverse();
    },
    (r: typeof expected) => {
      r.ledger[5]!.payload.quantum++;
    },
    (r: typeof expected) => {
      r.ledger[5]!.atSample++;
    },
    (r: typeof expected) => {
      r.ledger[5]!.payload.gain += 0.125;
    },
    (r: typeof expected) => {
      r.pcm[511]! ^= 1;
    },
    (r: typeof expected) => {
      r.snapshots[3]!.find((s) => s.name === "history")!.data[2047]! ^= 1;
    },
    (r: typeof expected) => {
      r.snapshots[1]!.find((s) => s.name === "count")!.data[0]++;
    },
  ];
  for (const fault of faults) {
    const actual = structuredClone(expected);
    fault(actual);
    expect(() => expect(ingressByRing(actual)).toEqual(ingressByRing(expected))).toThrow();
  }
});

test("generic ingress ledger permits cross-ring interleaving while preserving each ring FIFO", () => {
  const source = literalIngress().ledger;
  const expected = ingressLedger(source);
  const records = source.filter((packet) => packet.name === "record");
  const frames = source.filter((packet) => packet.name === "frame");
  const frameFirst = [0, 1, 2, 3].flatMap((quantum) => [
    ...frames.filter((packet) => packet.payload.quantum === quantum),
    ...records.filter((packet) => packet.payload.quantum === quantum),
  ]);
  expect(frameFirst).not.toEqual(source);
  expect(ingressLedger(frameFirst)).toEqual(expected);
  expect(ingressLedger([...frames, ...records])).toEqual(expected);
  expect(ingressLedger([...records, ...frames])).toEqual(expected);

  const faults = [
    (packets: typeof records) => {
      [packets[4], packets[5]] = [packets[5]!, packets[4]!];
    },
    (packets: typeof records) => {
      packets.splice(5, 1);
    },
    (packets: typeof records) => {
      packets[5]!.payload.quantum++;
    },
    (packets: typeof records) => {
      packets[5]!.atSample++;
    },
  ];
  for (const fault of faults) {
    const changed = structuredClone(records);
    fault(changed);
    expect(() => expect(ingressLedger([...frames, ...changed])).toEqual(expected)).toThrow();
  }
});

test("generic ingress corpus reuses nonempty slots for empty views across capacity boundaries", () => {
  const batches = ingressBatches();
  const witnesses = (packets: ReturnType<typeof ingressBatches>[number]) => {
    const previous = new Map<number, (typeof packets)[number]>();
    const result: number[][] = [];
    packets.forEach((packet, index) => {
      const slot = index % 16;
      const before = previous.get(slot);
      if (before && before.samples.length > 0 && packet.samples.length === 0)
        result.push([slot, before.id, before.samples.length, packet.id, packet.samples.length]);
      previous.set(slot, packet);
    });
    return result;
  };
  expect(witnesses(batches.flat())).toContainEqual([2, 3, 3, 19, 0]);
  expect(witnesses(batches.flatMap((batch) => batch.slice(-16)))).toContainEqual([5, 10, 2, 27, 0]);
});
