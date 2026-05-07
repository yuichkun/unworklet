// Headless smoke for the docs <TryIt> blocks. Spins through every page
// that has a Run button, hits Run, asserts:
//   - status pill shows "running"
//   - no error pane
//   - meter peak goes above 0 within a window
//
// Usage:
//   node --experimental-strip-types apps/docs/scripts/smoke.ts [base-url]
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:4181";

const PAGES = [
  "/", // landing — has the hello TryIt
  "/guide/getting-started.html",
  "/guide/your-first-processor.html",
  "/guide/audio-io.html",
  "/guide/state-and-buffers.html",
  "/guide/parameters.html",
  "/guide/messages-events.html",
  "/guide/sub-rate.html",
  "/guide/subgraphs.html",
  "/guide/denormals.html",
  "/guide/snapshots.html",
  "/guide/migrations.html",
  "/guide/static-analysis.html",
  "/recipes/one-pole-filter.html",
  "/recipes/soft-clip.html",
  "/recipes/ping-pong-delay.html",
  "/recipes/envelope-follower.html",
  "/recipes/stereo-widener.html",
];
// MIDI / SIMD / midi-gate use silent inputs by design — peak may stay 0.
const SILENT_OK = new Set([
  "/guide/midi.html",
  "/guide/simd.html",
  "/recipes/midi-gate.html",
]);

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  let pass = 0, fail = 0;
  for (const path of [...PAGES, ...SILENT_OK]) {
    const page = await browser.newPage();
    let pageError = "";
    page.on("pageerror", (e) => (pageError ||= e.message));
    try {
      await page.goto(BASE + path, { waitUntil: "load", timeout: 30000 });
      // Wait for at least one Monaco editor to mount.
      await page.waitForFunction(
        () => document.querySelectorAll(".editor .monaco-editor").length > 0,
        { timeout: 30000 },
      );
      const buttons = await page.locator("button.run").count();
      if (buttons === 0) {
        console.log(`-  ${path.padEnd(40)} (no Run buttons)`);
        await page.close();
        continue;
      }
      // Click the first Run.
      await page.locator("button.run").first().click();
      // Wait up to 15s for status to leave "compiling..." / "idle".
      const statusOk = await page.waitForFunction(
        () => {
          const s = document.querySelector(".tryit .status");
          return s?.textContent?.includes("running") || s?.textContent?.includes("error");
        },
        { timeout: 15000 },
      ).catch(() => null);
      const status = await page.locator(".tryit .status").first().textContent();
      const errMsg = (await page.locator(".tryit .err").count())
        ? (await page.locator(".tryit .err").first().textContent()) ?? ""
        : "";
      if (!status?.includes("running")) {
        console.log(`✗  ${path.padEnd(40)} status=${status?.trim()} err=${errMsg.slice(0, 80)}`);
        fail++;
        await page.close();
        continue;
      }
      // Wait up to 6s for peak to climb above noise floor.
      const peakStr = await page.waitForFunction(
        () => {
          const el = document.querySelector(".tryit .meter .num");
          if (!el) return null;
          const m = (el.textContent ?? "").match(/[\d.]+/);
          if (!m) return null;
          const v = Number(m[0]);
          return v > 0.001 ? String(v) : null;
        },
        { timeout: 6000 },
      ).then((h) => h.jsonValue() as Promise<string>).catch(() => "0");
      const peak = Number(peakStr) || 0;
      const isSilentOk = SILENT_OK.has(path);
      const goodPeak = peak > 0.001 || isSilentOk;
      if (goodPeak) {
        console.log(`✓  ${path.padEnd(40)} peak=${peak.toFixed(4)}${isSilentOk ? "  (silent ok)" : ""}`);
        pass++;
      } else {
        console.log(`✗  ${path.padEnd(40)} peak=${peak.toFixed(4)} (expected > 0)`);
        fail++;
      }
    } catch (e: any) {
      console.log(`✗  ${path.padEnd(40)} ${e?.message?.split("\n")[0] ?? e}`);
      fail++;
    }
    await page.close();
  }
  await browser.close();
  console.log(`\n${pass}/${pass + fail} TryIt blocks produce audio (or silent-by-design)`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
