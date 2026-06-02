// Minimal PoC harness for the runtime-compile pipeline. The pipeline (compile +
// addModule + createNode) is silent — no audio source is connected, so verifying
// it makes no sound. Playback is wired behind an explicit user gesture.
import { createNode } from "@unworklet/core";
import type { UnworkletNode } from "@unworklet/core";

import { compileSource } from "./runtimeCompile.ts";

const DISTORTION = `// distortion.uwk.ts
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();

process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});`;

const logEl = document.getElementById("log") as HTMLPreElement;
const log = (m: string): void => {
  logEl.textContent += `${m}\n`;
};

let ctx: AudioContext | null = null;
let node: UnworkletNode<unknown> | null = null;

// Compile + create the node WITHOUT connecting it to the destination — proves the
// whole runtime pipeline silently. Exposed on window so it can be driven from the
// console / devtools without any audio output.
async function compileAndCreate(): Promise<void> {
  log("lowering + compiling distortion.uwk.ts in the browser…");
  const proc = await compileSource(DISTORTION);
  log(
    `compiled: processorName=${proc.worklet.processorName} moduleUrl=${proc.worklet.moduleUrl ? "ok" : "MISSING"} wasmUrl=${proc.worklet.wasmUrl ? "ok" : "MISSING"}`,
  );
  ctx = new AudioContext();
  await ctx.resume(); // suspended-context handshake; nothing is connected, so silent
  node = await createNode(ctx, proc);
  log(`createNode OK — addModule succeeded. outputs=[${Object.keys(node.outputs).join(", ")}]`);
  log("PoC PASS: editor source → lower → compile → Blob worklet → live node, in the browser.");
}

(globalThis as unknown as { __poc: { run: () => Promise<void> } }).__poc = {
  run: compileAndCreate,
};

document.getElementById("run")?.addEventListener("click", () => {
  compileAndCreate().catch((err: unknown) => log(`FAIL: ${String(err)}`));
});

log("ready — click 'Compile + create node (silent)' or call __poc.run() in the console.");
