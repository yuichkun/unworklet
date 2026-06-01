/**
 * UW-1 pocket rack — UI layer (P7).
 *
 * Pure-DOM interaction for the Teenage-Engineering-style panel in `index.html`:
 * draggable knobs, an on-screen keyboard (mouse + computer keys), and transport.
 * Drives the audio engine in `./audio.ts` — `play` ramps the noise bed, the
 * keyboard plays the synth lead, and the `vol` / `tone` knobs shape the master.
 */

import * as audio from "./audio.ts";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number): string => `${NOTE_NAMES[n % 12]!}${Math.floor(n / 12) - 1}`;
const noteHz = (n: number): number => 440 * 2 ** ((n - 69) / 12);

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

// ── display ──────────────────────────────────────────────────────────────
const dispNote = $("#dispNote");
const dispHz = $("#dispHz");
const dispStatus = $("#dispStatus");
const dispMeter = $<HTMLElement>("#dispMeter");

let running = false;
const setStatus = (s: string): void => {
  dispStatus.textContent = s;
};

// ── knobs ────────────────────────────────────────────────────────────────
const setKnob = (dial: HTMLElement, value: number): void => {
  const v = Math.min(1, Math.max(0, value));
  dial.dataset.value = v.toFixed(3);
  dial.style.setProperty("--rot", `${-135 + v * 270}deg`);
  const valEl = dial.parentElement?.querySelector<HTMLElement>(".kval");
  if (valEl) valEl.textContent = v.toFixed(2);
  // Wired knobs drive the master post-chain; the effect knobs (drive/delay/fbk/
  // crush) await processor params and are visual for now.
  if (dial.dataset.param === "vol") audio.setVol(v);
  else if (dial.dataset.param === "tone") audio.setTone(v);
};

document.querySelectorAll<HTMLElement>(".dial").forEach((dial) => {
  setKnob(dial, Number(dial.dataset.value ?? "0.5"));
  dial.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dial.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startVal = Number(dial.dataset.value ?? "0.5");
    const onMove = (ev: PointerEvent): void => {
      setKnob(dial, startVal + (startY - ev.clientY) / 200); // drag up → increase
    };
    const onUp = (): void => {
      dial.removeEventListener("pointermove", onMove);
      dial.removeEventListener("pointerup", onUp);
    };
    dial.addEventListener("pointermove", onMove);
    dial.addEventListener("pointerup", onUp);
  });
});

// ── nodes / transport LEDs ───────────────────────────────────────────────
const setNodesLive = (live: boolean): void => {
  document.querySelectorAll<HTMLElement>(".node").forEach((n, i) => {
    if (live) window.setTimeout(() => n.classList.add("live"), i * 90);
    else n.classList.remove("live");
  });
};

const pulseNode = (node: string): void => {
  const led = document.querySelector<HTMLElement>(`.node[data-node="${node}"]`);
  if (!led) return;
  led.classList.add("live");
  if (!running) window.setTimeout(() => led.classList.remove("live"), 140);
};

// ── keyboard ─────────────────────────────────────────────────────────────
type KeyDef = { note: number; label: string; hint: string; black: boolean };
const KEYS: KeyDef[] = [
  { note: 60, label: "C", hint: "a", black: false },
  { note: 61, label: "", hint: "w", black: true },
  { note: 62, label: "D", hint: "s", black: false },
  { note: 63, label: "", hint: "e", black: true },
  { note: 64, label: "E", hint: "d", black: false },
  { note: 65, label: "F", hint: "f", black: false },
  { note: 66, label: "", hint: "t", black: true },
  { note: 67, label: "G", hint: "g", black: false },
  { note: 68, label: "", hint: "y", black: true },
  { note: 69, label: "A", hint: "h", black: false },
  { note: 70, label: "", hint: "u", black: true },
  { note: 71, label: "B", hint: "j", black: false },
  { note: 72, label: "C", hint: "k", black: false },
];

const keyEls = new Map<number, HTMLButtonElement>();
const held = new Set<number>();

const keysRoot = $("#keys");
for (const k of KEYS) {
  const btn = document.createElement("button");
  btn.className = `key${k.black ? " black" : ""}`;
  btn.dataset.note = String(k.note);
  btn.innerHTML = `${k.label ? `<span class="lbl">${k.label}</span>` : ""}<span class="hint">${k.hint}</span>`;
  keysRoot.appendChild(btn);
  keyEls.set(k.note, btn);
}

const noteOn = (note: number): void => {
  if (held.has(note)) return;
  held.add(note);
  keyEls.get(note)?.classList.add("down");
  dispNote.textContent = noteName(note);
  dispHz.textContent = `${Math.round(noteHz(note))} hz`;
  pulseNode("synth");
  dispMeter.style.width = "62%";
  void audio.noteOn(note);
};

const noteOff = (note: number): void => {
  if (!held.has(note)) return;
  held.delete(note);
  keyEls.get(note)?.classList.remove("down");
  if (held.size === 0) {
    dispNote.textContent = "—";
    dispMeter.style.width = "6%";
  }
  audio.noteOff(note);
};

// pointer (click / touch) on keys
keysRoot.addEventListener("pointerdown", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".key");
  if (!btn) return;
  e.preventDefault();
  noteOn(Number(btn.dataset.note));
});
window.addEventListener("pointerup", () => {
  // snapshot: noteOff() mutates `held` while we iterate
  for (const n of Array.from(held)) noteOff(n);
});

// computer keyboard
const KEYMAP = new Map(KEYS.map((k) => [k.hint, k.note]));
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const note = KEYMAP.get(e.key);
  if (note !== undefined) noteOn(note);
});
window.addEventListener("keyup", (e) => {
  const note = KEYMAP.get(e.key);
  if (note !== undefined) noteOff(note);
});

// ── transport ────────────────────────────────────────────────────────────
const playBtn = $<HTMLButtonElement>("#play");
const stopBtn = $<HTMLButtonElement>("#stop");
const power = $("#power");

const setRunning = (on: boolean): void => {
  running = on;
  playBtn.classList.toggle("on", on);
  power.classList.toggle("on", on);
  setNodesLive(on);
  setStatus(on ? "running · play the keys" : "stopped");
  dispMeter.style.width = on ? "18%" : "6%";
};

playBtn.addEventListener("click", () => {
  void audio.startBed();
  setRunning(true);
});
stopBtn.addEventListener("click", () => {
  audio.stopBed();
  setRunning(false);
});

setStatus("idle · press play");
