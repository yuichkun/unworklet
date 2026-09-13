import { createNode } from "../../packages/core/src/index.ts";
import processor from "./soak.processor.ts?worklet";
import { createSequence, observeSequence } from "./integrity.mjs";

const expectedTransport = new URL(location.href).searchParams.get("transport");
const streams = Object.fromEntries(
  ["scalar", "typed", "midi", "sysex", "midiEcho", "sysexEcho"].map((name) => [
    name,
    createSequence(),
  ]),
);
const errors = { total: 0, first: [] };
const notices = { sabUnavailable: 0 };
const published = { count: 0, last: 0, reversed: 0 };
const transitions = { hidden: 0, visible: 0 };
const visibility = { hidden: 0, visible: 0 };
let visibilityState = document.visibilityState;
let visibilityAt = performance.now();
let context;
let node;
let startedAt = 0;
let initialAudioTime = 0;
let sender;
let sent = 0;
let stopped = false;
const unsubscribe = [];

function recordError(error) {
  errors.total++;
  if (errors.first.length < 16) errors.first.push(String(error?.stack ?? error?.message ?? error));
}
window.addEventListener("error", (event) => recordError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => recordError(event.reason));

function onVisibility() {
  const now = performance.now();
  if (startedAt) visibility[visibilityState] += (now - visibilityAt) / 1000;
  visibilityState = document.visibilityState;
  visibilityAt = now;
  transitions[visibilityState]++;
}
document.addEventListener("visibilitychange", onVisibility);

function sysexPacket(counter) {
  const low = counter % 128;
  const middle = Math.floor(counter / 128) % 128;
  const high = Math.floor(counter / 16384) % 128;
  return new Uint8Array([0xf0, 0x7d, low, middle, high, 127 - low, 127 - middle, 127 - high, 0xf7]);
}

function receiveSysex(name, data) {
  const counter = data[2] + data[3] * 128 + data[4] * 16384;
  const valid =
    data instanceof Uint8Array &&
    data.length === 9 &&
    data[0] === 0xf0 &&
    data[1] === 0x7d &&
    data[8] === 0xf7 &&
    data[2] + data[5] === 127 &&
    data[3] + data[6] === 127 &&
    data[4] + data[7] === 127;
  observeSequence(streams[name], counter, valid);
}

function receiveNote(name, event) {
  observeSequence(
    streams[name],
    event.channel * 128 + event.note,
    event.note + event.velocity === 127,
    2048,
  );
}

function sendMidi() {
  sent++;
  node.midi.midiIn.send({
    type: "noteOn",
    channel: Math.floor(sent / 128) % 16,
    note: sent % 128,
    velocity: 127 - (sent % 128),
  });
  node.midi.midiIn.send({ type: "sysex", data: sysexPacket(sent) });
}

async function start() {
  if (context) return;
  try {
    context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    await context.resume();
    node = await createNode(context, processor);
    if (node.diagnostics.transport !== expectedTransport) throw new Error("unexpected transport");
    unsubscribe.push(
      node.onError((error) => {
        if (error.code === "sab-unavailable" && expectedTransport === "postMessage") {
          notices.sabUnavailable++;
        } else {
          recordError(JSON.stringify(error));
        }
      }),
    );
    const processorError = () => recordError("AudioWorkletNode processorerror");
    node.node.addEventListener("processorerror", processorError);
    unsubscribe.push(() => node.node.removeEventListener("processorerror", processorError));
    unsubscribe.push(
      node.events.scalar.on((payload) => {
        observeSequence(
          streams.scalar,
          payload.sequence,
          payload.sequence + payload.complement === 1_000_000 &&
            payload.atSample >= 0 &&
            payload.atSample < 128,
        );
      }),
    );
    unsubscribe.push(
      node.events.typed.on((payload) => {
        const samples = payload.samples;
        observeSequence(
          streams.typed,
          payload.sequence,
          samples instanceof Float32Array &&
            samples.length === 4 &&
            samples[0] === payload.sequence &&
            samples[1] === 1_000_000 - payload.sequence &&
            samples[2] === payload.sequence * 2 + 3 &&
            samples[3] === -payload.sequence * 2 - 3,
        );
      }),
    );
    unsubscribe.push(node.midi.midi.onEvent("noteOn", (event) => receiveNote("midi", event)));
    unsubscribe.push(node.midi.midi.onEvent("sysex", (event) => receiveSysex("sysex", event.data)));
    unsubscribe.push(
      node.midi.midiEcho.onEvent("noteOn", (event) => receiveNote("midiEcho", event)),
    );
    unsubscribe.push(
      node.midi.midiEcho.onEvent("sysex", (event) => receiveSysex("sysexEcho", event.data)),
    );
    unsubscribe.push(
      node.state.quanta.subscribe((value) => {
        published.count++;
        if (value < published.last) published.reversed++;
        published.last = value;
      }),
    );
    startedAt = performance.now();
    visibilityAt = startedAt;
    visibilityState = document.visibilityState;
    initialAudioTime = context.currentTime;
    node.outputs.main.connect(context.destination);
    sendMidi();
    sender = setInterval(sendMidi, 250);
    window.soak.ready = true;
    document.querySelector("#status").textContent =
      `Running ${expectedTransport} at ${context.sampleRate} Hz`;
  } catch (error) {
    recordError(error);
    window.soak.failed = true;
  }
}

function snapshot() {
  const durations = { ...visibility };
  if (startedAt && !stopped)
    durations[visibilityState] += (performance.now() - visibilityAt) / 1000;
  return {
    transport: node?.diagnostics.transport,
    crossOriginIsolated,
    sharedArrayBufferAvailable: typeof SharedArrayBuffer === "function",
    sampleRate: context?.sampleRate,
    contextState: context?.state,
    elapsedSeconds: startedAt ? (performance.now() - startedAt) / 1000 : 0,
    audioSeconds: context ? context.currentTime - initialAudioTime : 0,
    currentTime: context?.currentTime,
    outputTimestamp: context?.getOutputTimestamp(),
    quanta: Math.max(published.last, node?.state.quanta.value ?? 0),
    hiddenSeconds: durations.hidden,
    visibleSeconds: durations.visible,
    visibilityState: document.visibilityState,
    transitions: { ...transitions },
    published: { ...published },
    notices: { ...notices },
    streams: structuredClone(streams),
    sentMidiPairs: sent,
    overflow: node
      ? {
          scalar: node.events.scalar.diagnostics.overflowCount(),
          typed: node.events.typed.diagnostics.overflowCount(),
          midi: node.midi.midi.diagnostics.overflowCount(),
          midiIn: node.midi.midiIn.diagnostics.overflowCount(),
          midiEcho: node.midi.midiEcho.diagnostics.overflowCount(),
        }
      : {},
    errors: structuredClone(errors),
  };
}

async function stop() {
  clearInterval(sender);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await context.suspend();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const receipt = snapshot();
  stopped = true;
  document.removeEventListener("visibilitychange", onVisibility);
  for (const off of unsubscribe) off();
  node.dispose();
  await context.close();
  document.querySelector("#status").textContent = "Stopped";
  return receipt;
}

window.soak = { ready: false, failed: false, snapshot, stop };
document.querySelector("#start").addEventListener("click", () => {
  void start();
});
document.querySelector("#status").textContent = `Ready for ${expectedTransport}`;
