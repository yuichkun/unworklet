/**
 * canonical Ex 1 full の browser demo。 `?worklet` import 経 由 で vite-plugin が
 * emit す る CompiledProcessor を `createNode` に 渡 し、 AudioWorkletNode 経 由 で
 * 440 Hz (L) + 880 Hz (R) sine pair を 出 力。 meter L/R は state.publish 経 路 で
 * 30 fps で main に reflect さ れ + UI bar に 反 映。 transport / sample rate /
 * cross-origin isolated 状 況 も diagnostics panel に reflect。
 */

import { createNode } from "@unworklet/core";

import stereoGain from "./processor.ts?worklet";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const gainSlider = document.getElementById("gain") as HTMLInputElement;
const gainVal = document.getElementById("gainval") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLDivElement;
const meterLBar = document.getElementById("meterL") as HTMLDivElement;
const meterRBar = document.getElementById("meterR") as HTMLDivElement;
const meterLVal = document.getElementById("meterLval") as HTMLSpanElement;
const meterRVal = document.getElementById("meterRval") as HTMLSpanElement;
const diagTransport = document.getElementById("diag-transport") as HTMLElement;
const diagRate = document.getElementById("diag-rate") as HTMLElement;
const diagLatency = document.getElementById("diag-latency") as HTMLElement;
const diagCOI = document.getElementById("diag-coi") as HTMLElement;

const setStatus = (msg: string, isError = false): void => {
  status.textContent = msg;
  status.classList.toggle("error", isError);
};

const setMeter = (bar: HTMLDivElement, valSpan: HTMLSpanElement, v: number): void => {
  const safe = typeof v === "number" && Number.isFinite(v) ? v : 0;
  const pct = Math.min(100, Math.max(0, safe * 100));
  bar.style.width = `${pct.toFixed(1)}%`;
  valSpan.textContent = safe.toFixed(2);
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

// Cross-origin isolated は ま ず page-load 時 に reflect (= sab の 利 用 可 否 を 事 前 表 示)。
diagCOI.textContent = globalThis.crossOriginIsolated ? "true" : "false";

const start = async (): Promise<void> => {
  if (session) return;
  setStatus("instantiating AudioContext + worklet…");
  const context = new AudioContext();
  await context.resume();

  const node = await createNode(context, stereoGain);

  const oscL = new OscillatorNode(context, { frequency: 440, type: "sine" });
  const oscR = new OscillatorNode(context, { frequency: 880, type: "sine" });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  oscL.connect(merger, 0, 0);
  oscR.connect(merger, 0, 1);

  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(context.destination);

  node.params["gain"]!.value = parseFloat(gainSlider.value);

  oscL.start();
  oscR.start();

  const unsubMeterL = node.state["meterL"]!.subscribe((v) => {
    setMeter(meterLBar, meterLVal, v as number);
  });
  const unsubMeterR = node.state["meterR"]!.subscribe((v) => {
    setMeter(meterRBar, meterRVal, v as number);
  });

  node.onError((err) => {
    console.error("[stereoGain]", err);
    setStatus(`worklet error: ${JSON.stringify(err)}`, true);
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
    node.params["gain"]!.value = v;
  };

  // diagnostics 反 映
  diagTransport.textContent = node.diagnostics.transport;
  diagTransport.className =
    node.diagnostics.transport === "sab" ? "transport-sab" : "transport-postmessage";
  diagRate.textContent = `${context.sampleRate} Hz`;
  diagLatency.textContent = `${(context.baseLatency * 1000).toFixed(1)} ms`;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus("running.");
};

const stop = (): void => {
  if (!session) return;
  session.dispose();
  session = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("stopped.");
  // meter UI を 0 に reset
  setMeter(meterLBar, meterLVal, 0);
  setMeter(meterRBar, meterRVal, 0);
  diagTransport.textContent = "—";
  diagTransport.className = "";
  diagRate.textContent = "—";
  diagLatency.textContent = "—";
};

startBtn.addEventListener("click", () => {
  start().catch((err: unknown) => {
    setStatus(`start failed: ${String(err)}`, true);
    console.error(err);
  });
});

stopBtn.addEventListener("click", stop);
