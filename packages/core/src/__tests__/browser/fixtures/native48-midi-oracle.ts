import { renderOffline } from "../../../../../offline/src/index.ts";
import { native48Midi } from "./native48-midi.processor.ts";
import { inputs, pcmBits, type MidiObservation } from "./native48-midi-observation.ts";

export async function renderNative48MidiOracle(): Promise<MidiObservation> {
  const result = await renderOffline(native48Midi, {
    sampleRate: 48000,
    duration: 512 / 48000,
    events: inputs.map((payload, i) => ({
      name: "commands",
      payload,
      atSample: [17, 192, 383, 385][i]!,
    })),
  });
  if (result.diagnostics.scrubbedSamples !== 0) throw new Error("scrubbed MIDI PCM");
  return {
    pcm: pcmBits(result.outputs.main![0]!),
    packets: result.events,
    snapshot: Array.from(result.state),
  };
}
