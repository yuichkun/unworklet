import type { MidiObservation } from "./fixtures/native48-midi-observation.ts";
declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    renderNative48MidiOracle: () => Promise<MidiObservation>;
  }
}
