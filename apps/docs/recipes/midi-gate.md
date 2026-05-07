<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, state, midiInput, forSample,
  add, sub, mul, sin, exp, div, gt, eq, select, flushDenormals,
} from "@unworklet/core";

export const midiGate = defineProcessor((ctx) => {
  const _in = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });

  const attackMs = param({ name: "attackMs", default: 5, min: 0.1, max: 500, automationRate: "k-rate" });
  const releaseMs = param({ name: "releaseMs", default: 200, min: 1, max: 2000, automationRate: "k-rate" });

  const midi = midiInput({ name: "midi" });
  const note = state.i32(60, { name: "note" });
  const gate = state.bool(false, { name: "gate" });
  const vel = state.f32(0, { name: "vel" });
  const phase = state.f32(0, { name: "phase" });
  const env = state.f32(0, { name: "env", publish: { rateFps: 30 } });

  return {
    process: () => {
      midi.onEvent("noteOn", ({ note: n, velocity }) => {
        note.store(n);
        vel.store(mul(velocity, 1 / 127));
        gate.store(true);
      });
      midi.onEvent("noteOff", ({ note: n }) => {
        // Only release if the released note matches the held one.
        gate.store(select(eq(note.load(), n), false, gate.load()));
      });

      const aCoef = sub(1, exp(div(-1, mul(mul(attackMs.at(0), 0.001), ctx.sampleRate))));
      const rCoef = sub(1, exp(div(-1, mul(mul(releaseMs.at(0), 0.001), ctx.sampleRate))));

      forSample((i) => {
        const target = select(gate.load(), vel.load(), 0);
        const c = select(gate.load(), aCoef, rCoef);
        const e = flushDenormals(add(env.load(), mul(c, sub(target, env.load()))));
        env.store(e);

        // Sine oscillator at the held MIDI note frequency.
        const hz = mul(440, exp(mul(sub(note.load(), 69), Math.LN2 / 12)));
        const inc = div(hz, ctx.sampleRate);
        const p = add(phase.load(), inc);
        phase.store(select(gt(p, 1), sub(p, 1), p));

        out.set(0, i, mul(sin(mul(p, 2 * Math.PI)), e));
      });
    },
  };
});
`;
</script>

# MIDI to gate trigger

Convert MIDI noteOn/noteOff into a gate signal that drives an envelope, then audio.

<TryIt label="midi → gate → audio" size="tall" source="silent" :code="tryItCode0" />

Connect Web MIDI from the host:

```ts
const node = await createWasmNode(ctx, midiGate, "midiGate");
const access = await navigator.requestMIDIAccess();
for (const input of access.inputs.values()) {
  node.midi.connectFromWebMIDI(input);
}
```

## Why `state.bool(false)` for gate

Booleans are stored as i32 (1 = true, 0 = false) in linear memory. The `select(...)` lowering on a bool is a single branchless WASM instruction. No JIT deopt risk on the audio thread.
