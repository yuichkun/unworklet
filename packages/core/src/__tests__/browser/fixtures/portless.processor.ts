import { defineProcessor, event } from "../../../index.ts";
export const portless = defineProcessor(() => {
  const input = event.midi({ from: "main", name: "input" });
  const output = event.midi({ to: "main", name: "output" });
  return {
    process() {
      input.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
        output.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
      });
    },
  };
});
