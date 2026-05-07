// Headless smoke for the patcher: loads each example, clicks Play, waits
// for the meter to climb, asserts peak > threshold.
//
// Usage:  node --experimental-strip-types apps/patcher/scripts/smoke.ts [base-url]
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:5174";
const PEAK_THRESHOLD = 0.005;

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  // Read example list from a one-shot scrape page.
  const probePage = await browser.newPage();
  await probePage.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await probePage.waitForSelector("select.example-picker", { timeout: 30000 });
  await probePage.waitForTimeout(500);
  const options = await probePage.$$eval("select.example-picker option", (els) =>
    els.map((e) => ({ value: (e as HTMLOptionElement).value, text: e.textContent ?? "" })),
  );
  await probePage.close();
  console.log(`found ${options.length} examples`);

  let pass = 0, fail = 0;
  for (const opt of options) {
    // Fresh page per example so the AudioContext + WasmNode state is
    // never poisoned by a previous failure.
    const page = await browser.newPage();
    let pageError = "";
    page.on("pageerror", (e) => (pageError ||= e.message));
    page.on("console", (m) => {
      if (m.type() === "error") {
        const t = m.text();
        if (t.length > 800) pageError ||= t;
      }
    });

    await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("select.example-picker", { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.selectOption("select.example-picker", opt.value);
    await page.waitForTimeout(300);
    await page.locator("button.primary").first().click();
    // Wait up to 10s for status pill to read "● live" (running).
    const statusOk = await page
      .waitForFunction(
        () => {
          const s = document.querySelector(".status");
          return s?.textContent?.includes("live") || s?.textContent?.includes("error");
        },
        { timeout: 10000 },
      )
      .catch(() => null);
    const statusText = (await page.locator(".status").textContent()) ?? "";
    if (statusText.includes("error")) {
      const errText = (await page.locator(".err").textContent().catch(() => "")) ?? pageError;
      console.log(`✗  ${opt.text.padEnd(40)} ERROR: ${errText.slice(0, 200)}`);
      fail++;
      continue;
    }
    // Watch the master meter bar in App.vue.
    const peakStr = await page
      .waitForFunction(
        (thr) => {
          const bar = document.querySelector(".meter-bar") as HTMLElement | null;
          if (!bar) return null;
          const w = parseFloat(bar.style.width || "0");
          return w / 100 > thr ? String(w / 100) : null;
        },
        PEAK_THRESHOLD,
        { timeout: 8000 },
      )
      .then((h) => h.jsonValue() as Promise<string>)
      .catch(() => "0");
    const peak = Number(peakStr) || 0;
    if (peak > PEAK_THRESHOLD) {
      console.log(`✓  ${opt.text.padEnd(40)} peak=${peak.toFixed(4)}`);
      pass++;
    } else {
      console.log(`✗  ${opt.text.padEnd(40)} peak=${peak.toFixed(4)} (no audio)${pageError ? " [" + pageError.slice(0, 100) + "]" : ""}`);
      fail++;
    }
    await page.close();
  }

  await browser.close();
  console.log(`\n${pass}/${pass + fail} examples produced audio`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
