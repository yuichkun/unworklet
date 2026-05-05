// End-to-end smoke test: spin up the preview server, open the playground in a
// real Chromium, navigate through every showcase, and verify the AudioWorklet
// loads without errors. Used both during development and to catch regressions.
import { chromium, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function startServer(): Promise<{ proc: ChildProcess; baseUrl: string }> {
  const proc = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4173"], {
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
        resolve("http://127.0.0.1:4173");
      }
    });
    proc.on("exit", (c) => reject(new Error(`vite exited with code ${c}`)));
  });
  return { proc, baseUrl };
}

async function visitRoute(page: Page, baseUrl: string, hash: string) {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const onError = (err: Error) => errors.push(err.message);
  const onConsole = (msg: any) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  page.on("pageerror", onError);
  page.on("console", onConsole);

  await page.goto(`${baseUrl}/#${hash}`, { waitUntil: "load", timeout: 10000 });
  await page.waitForTimeout(800);
  try {
    const btn = page.locator("text=Unlock audio");
    if (await btn.count()) await btn.click();
  } catch {}
  await page.waitForTimeout(500);

  page.off("pageerror", onError);
  page.off("console", onConsole);
  return { errors, consoleErrors };
}

async function main() {
  console.log("Starting preview server...");
  const { proc, baseUrl } = await startServer();
  try {
    console.log(`Server up at ${baseUrl}`);
    const browser = await chromium.launch({
      executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext();
    await context.grantPermissions(["microphone"]);
    const page = await context.newPage();

    const routes = [
      ["/", "Home"],
      ["/01-gain", "Stereo Gain"],
      ["/02-eq", "3-Band EQ"],
      ["/03-lineareq", "Linear-Phase EQ"],
      ["/04-limiter", "Lookahead Limiter"],
      ["/05-granular", "Granular Sampler"],
      ["/06-arp", "Arpeggiator"],
      ["/07-reverb", "Convolution Reverb"],
      ["/08-poly", "PolySynth"],
      ["/09-delay", "Feedback Delay"],
      ["/10-chorus", "Chorus"],
      ["/11-dist", "Distortion"],
      ["/12-drum", "Drum Sampler"],
      ["/13-comp", "Compressor"],
      ["/14-fm", "FM Synth"],
    ];

    let totalErrors = 0;
    for (const [hash, title] of routes) {
      const { errors, consoleErrors } = await visitRoute(page, baseUrl, hash);
      const filtered = consoleErrors.filter(
        (e) =>
          !e.includes("Web MIDI") &&
          !e.includes("MIDI denied") &&
          !e.includes("getUserMedia") &&
          !e.includes("connectFromWebMIDI") &&
          !e.includes("Permission to use Web MIDI"),
      );
      if (errors.length > 0 || filtered.length > 0) {
        console.error(`✗ ${title}`);
        for (const e of errors) console.error(`  pageerror: ${e}`);
        for (const e of filtered) console.error(`  console: ${e}`);
        totalErrors += errors.length + filtered.length;
      } else {
        console.log(`✓ ${title}`);
      }
    }

    await browser.close();
    if (totalErrors > 0) {
      console.error(`Total errors: ${totalErrors}`);
      process.exit(1);
    }
    console.log("All routes loaded cleanly.");
  } finally {
    proc.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
