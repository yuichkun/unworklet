import { commands } from "vite-plus/test/browser";
import { expect } from "vite-plus/test";
import { createNode } from "../../../index.ts";
import genericIngress from "./generic-ingress.processor.ts?worklet";
import { createIngressLifecycle } from "../../generic-ingress-lifecycle.ts";
import {
  ingressBatches,
  ingressLedger,
  ingressByRing,
  ingressBits,
  ingressSlots,
  literalIngress,
  INGRESS_RATE,
  INGRESS_SAMPLES,
  type IngressRecord,
} from "./generic-ingress-model.ts";

export async function checkGenericIngress(expectedTransport: "sab" | "postMessage") {
  const oracle = await commands.renderGenericIngress();
  const { overflow: expectedOverflow, ...literal } = literalIngress();
  expect(ingressByRing(oracle)).toEqual(ingressByRing(literal));
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: INGRESS_SAMPLES,
    sampleRate: INGRESS_RATE,
  });
  const node = await createNode(ctx, genericIngress);
  const off: (() => void)[] = [];
  const boundaries: Promise<void>[] = [];
  let lifecycle: ReturnType<typeof createIngressLifecycle> | undefined;
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    lifecycle?.fail(failure);
  };
  try {
    const ledger: IngressRecord[] = [];
    let wake = () => {};
    for (const name of ["record", "frame"]) {
      off.push(
        node.events[name]!.on((raw) => {
          try {
            const { atSample, ...payload } = raw as Record<string, number>;
            ledger.push({ name, atSample: atSample!, payload: { ...payload } });
            wake();
          } catch (error) {
            fail(error);
          }
        }),
      );
    }
    off.push(
      node.onError((error) => {
        if (error.code !== "sab-unavailable")
          fail(new Error(`generic ingress worklet: ${JSON.stringify(error)}`));
      }),
    );
    node.outputs.main!.connect(ctx.destination);
    for (const sample of [0, 128, 256, 384]) {
      const boundary = ctx.suspend(sample / INGRESS_RATE);
      void boundary.catch(fail);
      boundaries.push(boundary);
    }
    // Deferring the call installs render rejection handling before native work starts.
    const rendering = Promise.resolve().then(() => ctx.startRendering());
    void rendering.catch(fail);
    const life = createIngressLifecycle({ context: ctx, boundaries, rendering });
    lifecycle = life;
    if (failure !== undefined) life.fail(failure);
    const snapshots: ReturnType<typeof ingressSlots>[] = [];
    const overflow: number[] = [];
    let initial: ReturnType<typeof ingressSlots> = [];
    const waitLedger = (length: number) =>
      life.wait(
        new Promise<void>((resolve) => {
          wake = () => {
            if (ledger.length >= length) resolve();
          };
          wake();
        }),
        "emitted ledger",
      );
    expect(ctx.sampleRate).toBe(48_000);
    expect(globalThis.crossOriginIsolated).toBe(expectedTransport === "sab");
    expect(node.diagnostics.transport).toBe(expectedTransport);
    for (const [quantum, batch] of ingressBatches().entries()) {
      await life.boundary(quantum);
      const before = ingressSlots(await life.wait(node.snapshot(), "pre-admission snapshot"));
      expect(before).toEqual(quantum === 0 ? literal.initial : literal.snapshots[quantum - 1]);
      if (quantum === 0) initial = before;
      else {
        snapshots.push(before);
        overflow.push(node.events.incoming!.diagnostics.overflowCount());
      }
      const prefix = literal.ledger.filter((record) => record.payload.quantum! < quantum);
      await waitLedger(prefix.length);
      expect(ingressLedger(ledger)).toEqual(ingressLedger(prefix));
      for (const packet of batch) node.events.incoming!.emit(packet);
      // Same-port reply proves fallback admission while the native renderer is
      // stopped. Neither this barrier nor the test promises realtime latency.
      const admitted = ingressSlots(await life.wait(node.snapshot(), "admission barrier"));
      expect(admitted).toEqual(before);
      expect(ingressLedger(ledger)).toEqual(ingressLedger(prefix));
      await life.resume();
    }
    const rendered = await life.wait(rendering, "render completion");
    snapshots.push(ingressSlots(await life.wait(node.snapshot(), "final snapshot")));
    overflow.push(node.events.incoming!.diagnostics.overflowCount());
    await waitLedger(literal.ledger.length);
    expect(overflow).toEqual(expectedOverflow);
    expect(node.events.record!.diagnostics.overflowCount()).toBe(0);
    expect(node.events.frame!.diagnostics.overflowCount()).toBe(0);
    const observed = {
      pcm: ingressBits(rendered.getChannelData(0)),
      ledger,
      snapshots,
      initial,
      retained: [0, 1, 2, 3].map(
        (quantum) =>
          ledger.filter((record) => record.name === "record" && record.payload.quantum === quantum)
            .length,
      ),
    };
    expect(ingressByRing(observed)).toEqual(ingressByRing(oracle));
    expect(ingressByRing(observed)).toEqual(ingressByRing(literal));
  } catch (error) {
    fail(error);
  } finally {
    if (lifecycle === undefined) {
      // A partial scheduling failure still leaves native suspensions to release.
      const rendering =
        boundaries.length > 0
          ? Promise.resolve().then(() => ctx.startRendering())
          : Promise.resolve();
      lifecycle = createIngressLifecycle({ context: ctx, boundaries, rendering });
    }
    if (failure !== undefined) lifecycle.fail(failure);
    await lifecycle.cleanup([...off, () => node.dispose()]);
  }
}
