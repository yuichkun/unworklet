// Headless audio render test: drives every showcase through the actual WASM
// pipeline inside a real Chromium AudioWorklet, asserts non-silent output
// where audio is expected. Uses vite dev so /@fs paths resolve.
import { chromium } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function startServer(): Promise<{ proc: ChildProcess; baseUrl: string }> {
  const proc = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4177"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server start timeout")), 30000);
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("Local:") || buf.includes("ready in")) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:4177");
      }
    });
    proc.stderr!.on("data", (d) => {
      buf += d.toString();
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
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
      const t = msg.type();
      const text = msg.text();
      if (t === "error" || t === "warning") console.error(`[${t}]`, text);
    });
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    const results = await page.evaluate(async () => {
      const compiler = (window as any).__unworklet_compiler;
      const examples = (window as any).__unworklet_examples;
      if (!compiler || !examples) return { __error: "compiler/examples not exposed on window" };
      const SR = 48000;
      const BLOCK = 128;

      async function renderProcessor(name: string, opts: any = {}) {
        const proc = (examples as any)[name];
        if (!proc) return { name, ok: false, err: `unknown processor ${name}` };
        try {
          const result = (compiler as any).compileToWasm(proc, { sampleRate: SR });
          const offline = new OfflineAudioContext({
            numberOfChannels: 2,
            length: SR * (opts.duration ?? 0.1),
            sampleRate: SR,
          });
          const source = (compiler as any).generateWorkletModule(
            result.graph,
            result.layout,
            result.binary,
            { processorName: name },
          );
          const blob = new Blob([source], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          try {
            await offline.audioWorklet.addModule(url);
          } catch (e: any) {
            return { name, ok: false, err: "addModule failed: " + String(e?.message ?? e) };
          }
          URL.revokeObjectURL(url);
          const numIn = Math.max(1, result.graph.declarations.audioInputs.length);
          const numOut = Math.max(1, result.graph.declarations.audioOutputs.length);
          const outCh = result.graph.declarations.audioOutputs.map((o: any) => o.channels);
          while (outCh.length < numOut) outCh.push(2);
          const node = new AudioWorkletNode(offline, "uw:" + name, {
            numberOfInputs: numIn,
            numberOfOutputs: numOut,
            outputChannelCount: outCh,
          });
          let procError: string | null = null;
          let initError: string | null = null;
          (node as any).onprocessorerror = (e: any) => {
            procError = "processorerror: " + String(e?.message ?? e?.toString?.() ?? "(no message)");
          };
          const ready = await Promise.race([
            new Promise<string>((resolve) => {
              node.port.onmessage = (e: MessageEvent) => {
                const d: any = e.data;
                if (d?.type === "ready") resolve("ok");
                else if (d?.type === "init-error") {
                  initError = "init-error: " + d.message + (d.stack ? " | " + d.stack.split("\n").slice(0, 3).join(" / ") : "");
                  resolve("init-error");
                }
              };
            }),
            new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 3000)),
          ]);
          if (ready !== "ok") {
            return { name, ok: false, err: initError ?? procError ?? "ready timeout (no processor error)" };
          }
          // Connect first declared output port
          node.connect(offline.destination, 0, 0);
          // Send any input audio through input port 0
          if (opts.inputFn) {
            const buf = offline.createBuffer(2, SR * (opts.duration ?? 0.1), SR);
            const fL = buf.getChannelData(0);
            const fR = buf.getChannelData(1);
            for (let i = 0; i < buf.length; i++) {
              fL[i] = opts.inputFn(i, 0);
              fR[i] = opts.inputFn(i, 1);
            }
            const src = offline.createBufferSource();
            src.buffer = buf;
            src.connect(node, 0, 0);
            src.start();
          }
          for (const m of opts.messages ?? []) {
            node.port.postMessage({ type: "message", name: m.name, payload: m.payload });
          }
          for (const ev of opts.midi ?? []) {
            node.port.postMessage({ type: "midi", event: ev });
          }
          await new Promise((r) => setTimeout(r, 50));
          const rendered = await offline.startRendering();
          let peak = 0, hasNaN = false;
          for (let c = 0; c < rendered.numberOfChannels; c++) {
            const arr = rendered.getChannelData(c);
            for (let i = 0; i < arr.length; i++) {
              const v = arr[i];
              if (Number.isNaN(v)) hasNaN = true;
              const a = Math.abs(v);
              if (a > peak) peak = a;
            }
          }
          return { name, ok: true, peak, hasNaN };
        } catch (e: any) {
          return { name, ok: false, err: String(e?.message ?? e) };
        }
      }

      const sin = (i: number, _c: number) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
      const stereoSin = (i: number, c: number) =>
        Math.sin((2 * Math.PI * (c === 0 ? 440 : 660) * i) / SR) * 0.5;
      const note = (n: number) => ({
        type: "noteOn", channel: 0, note: n, velocity: 100, atSample: 0,
      });

      const r: any = {};
      r.stereoGain = await renderProcessor("stereoGain", { duration: 0.05, inputFn: stereoSin });
      r.threeBandEQ = await renderProcessor("threeBandEQ", { duration: 0.05, inputFn: stereoSin });
      r.lookaheadLimiter = await renderProcessor("lookaheadLimiter", { duration: 0.1, inputFn: (i: number, c: number) => stereoSin(i, c) * 2.5 });
      r.feedbackDelay = await renderProcessor("feedbackDelay", { duration: 0.1, inputFn: stereoSin });
      r.chorus = await renderProcessor("chorus", { duration: 0.1, inputFn: stereoSin });
      r.distortion = await renderProcessor("distortion", { duration: 0.05, inputFn: sin });
      r.compressor = await renderProcessor("compressor", { duration: 0.1, inputFn: stereoSin });
      r.polySynth = await renderProcessor("polySynth", { duration: 0.1, midi: [note(60)] });
      r.fmSynth = await renderProcessor("fmSynth", { duration: 0.1, midi: [note(60)] });

      const click = new Float32Array(2400);
      for (let i = 0; i < click.length; i++) {
        click[i] = Math.sin((i / click.length) * 60 * Math.PI) * Math.exp(-i / 300) * 0.6;
      }
      r.drumSampler = await renderProcessor("drumSampler", {
        duration: 0.1,
        messages: [
          { name: "uploadPad", payload: { pad: 0, samples: click } },
          { name: "triggerPad", payload: { pad: 0, velocity: 1 } },
        ],
      });
      const granSample = new Float32Array(48000);
      for (let i = 0; i < granSample.length; i++) {
        granSample[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6;
      }
      r.granularSampler = await renderProcessor("granularSampler", {
        duration: 0.2,
        midi: [note(60)],
        messages: [{ name: "uploadSample", payload: { samples: granSample } }],
      });
      const ir = new Float32Array(64);
      ir[0] = 1.0;
      r.convolutionReverb = await renderProcessor("convolutionReverb", {
        duration: 0.05,
        inputFn: sin,
        messages: [{ name: "uploadIR", payload: { irL: ir, irR: ir.slice() } }],
      });
      r.arpeggiator = await renderProcessor("arpeggiator", {
        duration: 0.2,
        midi: [note(60)],
        messages: [{ name: "loadPattern", payload: { steps: new Int32Array([0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12]) } }],
      });
      r.linearPhaseEQ = await renderProcessor("linearPhaseEQ", { duration: 0.05, inputFn: sin });
      return r;
    });

    const expectations: Record<string, { silentOk: boolean; minPeak?: number }> = {
      stereoGain: { silentOk: false, minPeak: 0.1 },
      threeBandEQ: { silentOk: false, minPeak: 0.1 },
      lookaheadLimiter: { silentOk: false, minPeak: 0.1 },
      feedbackDelay: { silentOk: false, minPeak: 0.1 },
      chorus: { silentOk: false, minPeak: 0.1 },
      distortion: { silentOk: false, minPeak: 0.05 },
      compressor: { silentOk: false, minPeak: 0.05 },
      polySynth: { silentOk: false, minPeak: 0.01 },
      fmSynth: { silentOk: false, minPeak: 0.01 },
      drumSampler: { silentOk: false, minPeak: 0.05 },
      granularSampler: { silentOk: false, minPeak: 0.01 },
      convolutionReverb: { silentOk: false, minPeak: 0.1 },
      arpeggiator: { silentOk: true },
      linearPhaseEQ: { silentOk: true },
    };

    let pass = 0, fail = 0;
    for (const [name, expected] of Object.entries(expectations)) {
      const r = (results as any)[name];
      if (!r?.ok) {
        console.log(`✗ ${name.padEnd(20)} ${r?.err ?? "missing"}`);
        fail++;
        continue;
      }
      if (r.hasNaN) {
        console.log(`✗ ${name.padEnd(20)} NaN in output`);
        fail++;
        continue;
      }
      if (expected.silentOk) {
        console.log(`✓ ${name.padEnd(20)} (silent-by-design ok) peak=${r.peak.toFixed(4)}`);
        pass++;
      } else if (r.peak >= (expected.minPeak ?? 0)) {
        console.log(`✓ ${name.padEnd(20)} peak=${r.peak.toFixed(4)}`);
        pass++;
      } else {
        console.log(`✗ ${name.padEnd(20)} peak=${r.peak.toFixed(4)} < ${expected.minPeak}`);
        fail++;
      }
    }
    await browser.close();
    console.log(`\n${pass}/${pass + fail} processors produce audio (or silent-by-design) via real WASM AudioWorklet.`);
    if (fail > 0) process.exit(1);
  } finally {
    proc.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
