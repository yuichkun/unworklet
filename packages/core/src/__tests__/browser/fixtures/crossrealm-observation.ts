import { decodeSnapshot } from "../../../snapshotBlob.ts";

export const CROSSREALM_SAMPLES = 128 * 4;
export type CrossRealmCase = "saw" | "stereo" | "automated-stereo" | "stateful";
export type CrossRealmEvent = {
  name: string;
  atSample: number;
  payload: Record<string, number | number[]>;
};

export const crossRealmInputs = (name: CrossRealmCase): Float32Array[] =>
  name === "saw"
    ? []
    : Array.from(
        { length: name === "stereo" || name === "automated-stereo" ? 2 : 1 },
        (_, channel) =>
          Float32Array.from({ length: CROSSREALM_SAMPLES }, (_, i) =>
            channel === 0 ? i / 1024 : -(i + 1) / 2048,
          ),
      );

export const crossRealmGainSteps = [
  { sample: 0, value: 0.5 },
  { sample: 64, value: 0.25 },
  { sample: 128, value: 1 },
  { sample: 255, value: 0 },
  { sample: 384, value: 2 },
] as const;

export const crossRealmGainSamples = (): number[] => {
  const samples = Array<number>(CROSSREALM_SAMPLES).fill(0);
  for (const [index, step] of crossRealmGainSteps.entries())
    samples.fill(step.value, step.sample, crossRealmGainSteps[index + 1]?.sample);
  return samples;
};

export const corruptCrossRealmAutomation = (channels: Float32Array[]): Float32Array[][] =>
  [65, 128].map((end) =>
    channels.map((channel) => {
      const changed = new Float32Array(channel);
      // Hold the first gain past sample 64 by one sample or the rest of the quantum.
      for (let i = 64; i < end; i++) changed[i]! *= 2;
      return changed;
    }),
  );

export function observeCrossRealm(
  channels: Float32Array[],
  events: CrossRealmEvent[],
  state: Uint8Array,
) {
  const decoded = decodeSnapshot(state);
  return {
    pcm: channels.map((channel) => Array.from(new Uint32Array(new Float32Array(channel).buffer))),
    events,
    snapshot: {
      ...decoded,
      // Slot order is not part of the state contract; every byte, including the
      // tail beyond inspectSnapshot's 64-element preview, is compared.
      slots: decoded.slots
        .map((slot) => ({ ...slot, data: Array.from(slot.data) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    },
  };
}
export type CrossRealmObservation = ReturnType<typeof observeCrossRealm>;
