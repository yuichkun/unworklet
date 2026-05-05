// Audio render verification: spin up the playground, drive each showcase
// through a hidden OfflineAudioContext (or a regular AudioContext recording
// via ScriptProcessor), and confirm audio actually flows from the worklet.
import { chromium } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function startServer(): Promise<{ proc: ChildProcess; baseUrl: string }> {
  const proc = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4174"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server start timeout")), 15000);
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("Local:")) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:4174");
      }
    });
    proc.on("exit", (c) => reject(new Error(`vite exited with code ${c}`)));
  });
  return { proc, baseUrl };
}

async function main() {
  const { proc, baseUrl } = await startServer();
  try {
    const browser = await chromium.launch({
      executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
      args: [
        "--no-sandbox",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });

    // Run each test scenario, returning peak / rms / hasNaN
    const results = await page.evaluate(async () => {
      const tests = [];
      const out = {};

      const renderOffline = async (processorName, opts) => {
        const sr = 48000;
        const dur = opts.duration || 0.2;
        const offline = new OfflineAudioContext({
          numberOfChannels: 2,
          length: Math.ceil(sr * dur),
          sampleRate: sr,
        });
        await offline.audioWorklet.addModule("/unworklet-worklet.js");
        const node = new AudioWorkletNode(offline, "uw:" + processorName, {
          numberOfInputs: 4,
          numberOfOutputs: 4,
          outputChannelCount: [2, 2, 2, 2],
        });
        const ready = new Promise((resolve) => {
          node.port.onmessage = (e) => { if (e.data?.type === "ready") resolve(e.data); };
        });
        const meta = await ready;
        // Connect input source
        if (opts.input) {
          const buf = offline.createBuffer(2, sr * dur, sr);
          const fL = buf.getChannelData(0);
          const fR = buf.getChannelData(1);
          for (let i = 0; i < buf.length; i++) {
            fL[i] = opts.input(i, 0);
            fR[i] = opts.input(i, 1);
          }
          const src = offline.createBufferSource();
          src.buffer = buf;
          // Find input port index by name
          const inIdx = (meta.ioShape.inputs || []).findIndex((p) => p.name === (opts.inputName || "main"));
          src.connect(node, 0, Math.max(0, inIdx));
          src.start();
        }
        // Connect output port
        const outName = opts.outputName || "main";
        const outIdx = (meta.ioShape.outputs || []).findIndex((p) => p.name === outName);
        node.connect(offline.destination, Math.max(0, outIdx), 0);

        // Send messages
        for (const m of opts.messages || []) {
          node.port.postMessage({ type: "message", name: m.name, payload: m.payload });
        }
        // Send MIDI
        for (const ev of opts.midi || []) {
          node.port.postMessage({ type: "midi", event: ev });
        }

        // Give MessagePort a tick to deliver before rendering
        await new Promise((r) => setTimeout(r, 50));

        const rendered = await offline.startRendering();
        let peak = 0, rms = 0, n = 0, hasNaN = false;
        for (let c = 0; c < rendered.numberOfChannels; c++) {
          const arr = rendered.getChannelData(c);
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (Number.isNaN(v)) hasNaN = true;
            const a = Math.abs(v);
            if (a > peak) peak = a;
            rms += v * v;
            n++;
          }
        }
        return { peak, rms: Math.sqrt(rms / Math.max(1, n)), hasNaN, samples: rendered.length };
      };

      // Test scenarios
      const sin = (i, _c) => Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
      const stereoIn = (i, c) => Math.sin((2 * Math.PI * (c === 0 ? 440 : 660) * i) / 48000) * 0.5;
      const noisy = (i, _c) => Math.sin((2 * Math.PI * 200 * i) / 48000) * 1.4;

      out.stereoGain = await renderOffline("stereoGain", { duration: 0.1, input: stereoIn });
      out.threeBandEQ = await renderOffline("threeBandEQ", { duration: 0.1, input: stereoIn });
      out.lookaheadLimiter = await renderOffline("lookaheadLimiter", { duration: 0.2, input: noisy });
      out.feedbackDelay = await renderOffline("feedbackDelay", { duration: 0.2, input: stereoIn });
      out.chorus = await renderOffline("chorus", { duration: 0.2, input: stereoIn });
      out.distortion = await renderOffline("distortion", { duration: 0.1, input: sin });
      out.compressor = await renderOffline("compressor", { duration: 0.2, input: noisy });

      // Synths via MIDI
      const note = { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 };
      out.polySynth = await renderOffline("polySynth", {
        duration: 0.2,
        midi: [note],
        inputName: "sidechain",
      });
      out.fmSynth = await renderOffline("fmSynth", { duration: 0.2, midi: [note] });

      // Drum sampler with synth kit
      const click = new Float32Array(2400);
      for (let i = 0; i < click.length; i++)
        click[i] = Math.sin((i / click.length) * 60 * Math.PI) * Math.exp(-i / 300) * 0.6;
      out.drumSampler = await renderOffline("drumSampler", {
        duration: 0.2,
        messages: [
          { name: "uploadPad", payload: { pad: 0, samples: click } },
          { name: "triggerPad", payload: { pad: 0, velocity: 1 } },
        ],
      });

      // Granular sampler
      const sample = new Float32Array(48000);
      for (let i = 0; i < sample.length; i++)
        sample[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
      out.granularSampler = await renderOffline("granularSampler", {
        duration: 0.2,
        messages: [{ name: "uploadSample", payload: { samples: sample } }],
        midi: [note],
      });

      // Convolution reverb (delta IR)
      const ir = new Float32Array(64);
      ir[0] = 1.0;
      out.convolutionReverb = await renderOffline("convolutionReverb", {
        duration: 0.05,
        input: sin,
        messages: [{ name: "uploadIR", payload: { irL: ir, irR: ir.slice() } }],
      });

      // Arpeggiator (no audio expected, but should not crash)
      out.arpeggiator = await renderOffline("arpeggiator", {
        duration: 0.3,
        midi: [note],
        messages: [
          {
            name: "loadPattern",
            payload: { steps: new Int32Array([0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12]) },
          },
        ],
      });

      // Linear phase EQ — silent without IR is expected
      out.linearPhaseEQ = await renderOffline("linearPhaseEQ", { duration: 0.05, input: sin });

      return out;
    });

    let failures = 0;
    const expectations = {
      stereoGain: { peak: 0.3, allowSilence: false },
      threeBandEQ: { peak: 0.3, allowSilence: false },
      lookaheadLimiter: { peak: 0.1, allowSilence: false },
      feedbackDelay: { peak: 0.05, allowSilence: false },
      chorus: { peak: 0.1, allowSilence: false },
      distortion: { peak: 0.1, allowSilence: false },
      compressor: { peak: 0.1, allowSilence: false },
      polySynth: { peak: 0.05, allowSilence: false },
      fmSynth: { peak: 0.05, allowSilence: false },
      drumSampler: { peak: 0.05, allowSilence: false },
      granularSampler: { peak: 0.0001, allowSilence: false },
      convolutionReverb: { peak: 0.1, allowSilence: false },
      arpeggiator: { peak: -1, allowSilence: true }, // pure-MIDI
      linearPhaseEQ: { peak: -1, allowSilence: true }, // no IR
    };

    for (const [name, expected] of Object.entries(expectations)) {
      const r = (results as any)[name];
      const ok =
        r &&
        !r.hasNaN &&
        (expected.allowSilence ? true : r.peak >= expected.peak);
      const status = ok ? "✓" : "✗";
      console.log(
        `${status} ${name.padEnd(20)} peak=${r?.peak?.toFixed(4)} rms=${r?.rms?.toFixed(4)} ${r?.hasNaN ? "NaN!" : ""}`
      );
      if (!ok) failures++;
    }

    await browser.close();
    if (failures > 0) {
      console.error(`\n${failures} audio render failures.`);
      process.exit(1);
    }
    console.log("\nAll showcases produced audio (or silent-by-design).");
  } finally {
    proc.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
