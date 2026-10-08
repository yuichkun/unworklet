import { renderOffline } from "../../../../../offline/src/index.ts";
import { genericIngress } from "./generic-ingress.processor.ts";
import {
  ingressBatches,
  ingressBits,
  ingressSlots,
  INGRESS_RATE,
  type IngressRecord,
} from "./generic-ingress-model.ts";

export async function renderGenericIngress(batches = ingressBatches()) {
  const runs: Awaited<ReturnType<typeof renderOffline>>[] = [];
  for (let quanta = 0; quanta <= 4; quanta++) {
    const result = await renderOffline(genericIngress, {
      sampleRate: INGRESS_RATE,
      duration: (quanta * 128) / INGRESS_RATE,
      messages: batches
        .slice(0, quanta)
        .flatMap((batch, atQuantum) =>
          batch.map((payload) => ({ name: "incoming", atQuantum, payload })),
        ),
    });
    if (result.diagnostics.scrubbedSamples !== 0)
      throw new Error("generic ingress oracle scrubbed PCM");
    runs.push(result);
  }
  const final = runs[4]!;
  return {
    pcm: ingressBits(final.outputs.main![0]!),
    ledger: final.events as IngressRecord[],
    initial: ingressSlots(runs[0]!.state),
    snapshots: runs.slice(1).map((result) => ingressSlots(result.state)),
    retained: runs
      .slice(1)
      .map(
        (result, i) =>
          result.events.filter((event) => event.name === "record").length -
          runs[i]!.events.filter((event) => event.name === "record").length,
      ),
  };
}
