// Lazy AudioContext + global helpers + a "mic" / "loop" / "osc" source manager.

import { ref, shallowRef } from "vue";

const ctxRef = shallowRef<AudioContext | null>(null);
const stateRef = ref<"suspended" | "running" | "closed">("suspended");

export function audioContext(): AudioContext {
  if (!ctxRef.value) {
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    ctxRef.value = ctx;
    stateRef.value = ctx.state;
    ctx.addEventListener("statechange", () => {
      stateRef.value = ctx.state as any;
    });
  }
  return ctxRef.value;
}

export async function ensureRunning(): Promise<void> {
  const ctx = audioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}

export function audioState() {
  return stateRef;
}

// A simple shared microphone source — at most one MediaStreamSource per session.
let micNode: MediaStreamAudioSourceNode | null = null;
let micStream: MediaStream | null = null;

export async function getMicrophone(): Promise<MediaStreamAudioSourceNode> {
  if (micNode) return micNode;
  const ctx = audioContext();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    },
    video: false,
  });
  micNode = ctx.createMediaStreamSource(micStream);
  return micNode;
}

export function disconnectMicrophone(): void {
  if (micNode) {
    try {
      micNode.disconnect();
    } catch {}
    micNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

// File-source helper: load a file, decode, return a buffer source factory
export async function loadAudioFile(file: File | Blob): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer();
  return await audioContext().decodeAudioData(buf);
}

// MIDI access cache
let midiAccess: any = null;
export async function getMidiAccess(): Promise<any> {
  if (midiAccess) return midiAccess;
  try {
    midiAccess = await (navigator as any).requestMIDIAccess({ sysex: false });
    return midiAccess;
  } catch (e) {
    console.warn("MIDI access denied or unsupported", e);
    throw e;
  }
}
