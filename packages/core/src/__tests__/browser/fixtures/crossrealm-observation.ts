import { decodeSnapshot } from "../../../snapshotBlob.ts";

export const CROSSREALM_SAMPLES = 128 * 4;
export type CrossRealmCase = "saw" | "stereo" | "stateful" | "native-rate";
export type CrossRealmEvent = {
  name: string;
  atSample: number;
  payload: Record<string, number | number[]>;
};

export const crossRealmInputs = (name: CrossRealmCase): Float32Array[] =>
  name === "saw" || name === "native-rate"
    ? []
    : Array.from({ length: name === "stereo" ? 2 : 1 }, (_, channel) =>
        Float32Array.from({ length: CROSSREALM_SAMPLES }, (_, i) =>
          channel === 0 ? i / 1024 : -(i + 1) / 2048,
        ),
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
