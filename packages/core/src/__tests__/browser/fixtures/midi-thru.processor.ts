/**
 * Browser e2e fixture = MIDI thru processor. Each inbound noteOn / cc is
 * re-emitted unchanged on the out port (`emitIf(true, ...)` = canonical 1:1
 * projection inside a handler, `11-midi.md` §2.4). A silent audio output drives
 * `process()` so `OfflineAudioContext` pulls the node each render quantum.
 */

import { audioOutput, defineProcessor, forSample, midiInput, midiOutput } from "../../../index.ts";

export const midiThru = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const midiIn = midiInput({ name: "in" });
  const midiOut = midiOutput({ name: "out" });
  return {
    process: () => {
      midiIn.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
        midiOut.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
      });
      midiIn.onEvent("cc", ({ channel, controller, value, atSample }) => {
        midiOut.emitIf(true, { type: "cc", channel, controller, value, atSample });
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
      });
    },
  };
});
