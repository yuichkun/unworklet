// bitcrush.uwk.ts — quantize the signal to N bits
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const bits  = param.f32({ default: 5, min: 1, max: 16 }).named();

process(() => {
  forSample((i) => {
    const steps = floor(exp(bits[i] * Math.LN2));           // 2^bits levels
    out.left[i]  = floor(input.left[i] * steps) / steps;
    out.right[i] = floor(input.right[i] * steps) / steps;
  });
});
