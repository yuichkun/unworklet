// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
// `.uwk.ts` sugar equivalent of `01-stereo-gain.processor.ts`. Lowering this must
// produce the byte-identical CompiledProcessor (operator + index sugar desugar to
// the same `.at(i).write(...mul...)` chain; auto-name supplies `.named("gain")`),
// so the plugin emits the same WASM from either authoring form. Sugar is a TS
// error until lowered, hence excluded from typecheck (see tsconfig.json).
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" });

process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
    out.right[i] = input.right[i] * gain[i];
  });
});
