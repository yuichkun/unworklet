/**
 * Phase 6 A-5 — examples/01-stereo-gain の browser entry。 `?worklet` import
 * 経由 で vite-plugin が emit する CompiledProcessor を `createNode` に 渡し、
 * AudioWorkletNode を 起動 し て 440 Hz (L) + 880 Hz (R) sine pair を 出力。
 * gain slider で `node.params.gain` を 操作 = 耳 で 動作 確認 path。
 */

import { createNode } from "@unworklet/core";
import stereoGain from "./processor.ts?worklet";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const gainSlider = document.getElementById("gain") as HTMLInputElement;
const gainVal = document.getElementById("gainval") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLDivElement;
const meterLBar = document.getElementById("meterL") as HTMLDivElement | null;
const meterRBar = document.getElementById("meterR") as HTMLDivElement | null;

const setStatus = (msg: string): void => {
  status.textContent = msg;
};

type Session = {
  context: AudioContext;
  oscL: OscillatorNode;
  oscR: OscillatorNode;
  merger: ChannelMergerNode;
  unsubMeterL: () => void;
  unsubMeterR: () => void;
  dispose(): void;
};

let session: Session | null = null;

const start = async (): Promise<void> => {
  if (session) return;
  setStatus("instantiating AudioContext + worklet…");
  const context = new AudioContext();
  await context.resume();

  const node = await createNode(context, stereoGain);

  // Build a stereo source: two oscillators merged into L/R channels.
  const oscL = new OscillatorNode(context, { frequency: 440, type: "sine" });
  const oscR = new OscillatorNode(context, { frequency: 880, type: "sine" });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  oscL.connect(merger, 0, 0);
  oscR.connect(merger, 0, 1);

  // Spec form (= docs/05-client.md §2 canonical example): the source
  // connects INTO `node.inputs.<name>` — `.inputs.<name>` is an AudioNode
  // destination that internally routes to the right worklet input port。
  merger.connect(node.inputs.main!);
  node.outputs.main!.connect(context.destination);

  node.params.gain!.value = parseFloat(gainSlider.value);

  oscL.start();
  oscR.start();

  const setMeterBar = (bar: HTMLDivElement | null, v: number): void => {
    if (!bar) return;
    const pct = Math.min(100, Math.max(0, v * 100));
    bar.style.width = `${pct.toFixed(1)}%`;
  };
  const unsubMeterL = node.state["meterL"]!.subscribe((v) => {
    setMeterBar(meterLBar, typeof v === "number" ? v : 0);
  });
  const unsubMeterR = node.state["meterR"]!.subscribe((v) => {
    setMeterBar(meterRBar, typeof v === "number" ? v : 0);
  });

  session = {
    context,
    oscL,
    oscR,
    merger,
    unsubMeterL,
    unsubMeterR,
    dispose(): void {
      unsubMeterL();
      unsubMeterR();
      oscL.stop();
      oscR.stop();
      oscL.disconnect();
      oscR.disconnect();
      merger.disconnect();
      node.dispose();
      void context.close();
    },
  };

  gainSlider.oninput = (): void => {
    const v = parseFloat(gainSlider.value);
    gainVal.textContent = v.toFixed(2);
    node.params.gain!.value = v;
  };

  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus(
    `running. sample rate = ${context.sampleRate} Hz, base latency = ${context.baseLatency.toFixed(4)} s.`,
  );
};

const stop = (): void => {
  if (!session) return;
  session.dispose();
  session = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("stopped.");
};

startBtn.addEventListener("click", () => {
  start().catch((err: unknown) => {
    setStatus(`start failed: ${String(err)}`);
    console.error(err);
  });
});

stopBtn.addEventListener("click", stop);
