import { audioOutput, defineProcessor, f32, forSample, state } from "../../../index.ts";
export const lifetime = defineProcessor(() => {
  const out = audioOutput({ name: "main", channels: 1 });
  const count = state.i32(0).expose({ name: "count", publish: { rateFps: 1000 } });
  return {
    process() {
      count.write(count.read().add(1));
      forSample((i) => out.ch(0).at(i).write(f32(count.read())));
    },
  };
});
