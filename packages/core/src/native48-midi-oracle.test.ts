import { test, expect } from "vite-plus/test";
import { renderNative48MidiOracle } from "./__tests__/browser/fixtures/native48-midi-oracle.ts";
import {
  assertMidiObservation,
  offsets,
  pcmBits,
  snapshotSlots,
} from "./__tests__/browser/fixtures/native48-midi-observation.ts";

test("native48 MIDI oracle independently pins every sample, packet and persistent byte", async () => {
  assertMidiObservation(await renderNative48MidiOracle());
});

for (const mutation of [
  "PCM bit",
  "implicit offset gating",
  "quantum delay",
  "missing packet",
  "reordered packet",
  "corrupt packet",
  "outgoing offset",
  "incoming offset",
  "late persistent byte",
]) {
  test(`native48 MIDI rejects ${mutation}`, async () => {
    const observed = await renderNative48MidiOracle();
    assertMidiObservation(observed);
    switch (mutation) {
      case "PCM bit":
        observed.pcm[511]! ^= 1;
        break;
      case "implicit offset gating":
        observed.pcm = pcmBits(
          Float32Array.from({ length: 512 }, (_, i) => {
            const block = Math.floor(i / 128);
            const level =
              i % 128 < offsets[block]! ? [0, 0.5, 0.25, 0][block]! : [0.5, 0.25, 0, 0.75][block]!;
            return level + (i % 128) / 1024;
          }),
        );
        break;
      case "quantum delay":
        observed.pcm = pcmBits(
          Float32Array.from(
            { length: 512 },
            (_, i) => [0, 0.5, 0.25, 0][Math.floor(i / 128)]! + (i % 128) / 1024,
          ),
        );
        break;
      case "missing packet":
        observed.packets.splice(2, 1);
        break;
      case "reordered packet":
        observed.packets.reverse();
        break;
      case "corrupt packet":
        observed.packets[3]!.payload = { type: "noteOn", channel: 9, note: 78, velocity: 96 };
        break;
      case "outgoing offset":
        observed.packets[2]!.atSample = 126;
        break;
      case "incoming offset":
        observed.snapshot[snapshotSlots(observed.snapshot).history!.offset + 19 * 4]! ^= 1;
        break;
      case "late persistent byte":
        observed.snapshot[snapshotSlots(observed.snapshot).last!.offset + 511]! ^= 1;
        break;
    }
    expect(() => assertMidiObservation(observed)).toThrow();
  });
}
