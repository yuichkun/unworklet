// Verifies that <TryIt> picks up edits to the source between Runs.
// Without this, the AudioWorklet caches the first registered processor
// and subsequent Runs silently use the stale code.
//
// Steps:
//   1. Load /guide/getting-started, click Run, capture peak P1.
//   2. Replace `gain.at(i)` with `0` in the editor (silence the output).
//   3. Click Run again, wait, capture peak P2.
//   4. Assert P2 < 0.01 (output is now silent because we multiplied by 0).
import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://127.0.0.1:4181/guide/getting-started.html";

async function readPeak(page: any): Promise<number> {
  const t = await page.locator(".tryit .meter .num").first().textContent();
  const m = (t ?? "").match(/[\d.]+/);
  return m ? Number(m[0]) : 0;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text()); });

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".editor .monaco-editor").length > 0, { timeout: 30000 });

  // Run 1
  await page.locator("button.run").first().click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".tryit .meter .num");
      const m = el?.textContent?.match(/[\d.]+/);
      return m && Number(m[0]) > 0.01;
    },
    { timeout: 15000 },
  );
  const p1 = await readPeak(page);
  console.log("Run 1 peak:", p1.toFixed(4));

  // Edit via simulated keyboard. Click into the editor, select all, type
  // the new content. This is the most realistic interaction (matches what
  // a user actually does).
  await page.locator(".editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  const SILENT = `import {
  defineProcessor, audioInput, audioOutput, param, forSample,
} from "@unworklet/core";

export const helloGain = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param({ name: "gain", default: 0.5, min: 0, max: 1, automationRate: "a-rate" });

  return {
    process: () => {
      forSample((i) => {
        // Multiply by zero — output must be silent if the new code is
        // actually picked up by Run.
        out.left.set(i,  main.left.at(i).mul(0));
        out.right.set(i, main.right.at(i).mul(0));
      });
    },
  };
});`;
  await page.keyboard.insertText(SILENT);

  // Verify editor content actually updated
  const newSrc = await page.evaluate(() => {
    const ed = document.querySelector(".editor textarea") as HTMLTextAreaElement | null;
    return ed?.value?.slice(0, 80);
  });
  console.log("editor head after edit:", newSrc?.slice(0, 80));

  // Run 2
  await page.locator("button.stop").first().click();
  await page.waitForTimeout(300);
  await page.locator("button.run").first().click();
  // Wait for status to reach "running" or "error".
  const finalStatus = await page.waitForFunction(
    () => {
      const t = document.querySelector(".tryit .status")?.textContent;
      return t?.includes("running") || t?.includes("error") ? t : null;
    },
    { timeout: 15000 },
  ).then((h) => h.jsonValue() as Promise<string>).catch(() => null);
  console.log("Run 2 status:", finalStatus);
  if (finalStatus?.includes("error")) {
    const err = await page.locator(".tryit .err").first().textContent();
    console.log("err:", err);
  }
  await page.waitForTimeout(3000);
  const p2 = (await page.locator(".tryit .meter .num").count())
    ? await readPeak(page)
    : 0;
  console.log("Run 2 peak:", p2.toFixed(4));

  await browser.close();

  // Verdict
  if (p1 < 0.01) {
    console.error("✗ Run 1 didn't produce audio");
    process.exit(1);
  }
  if (p2 > 0.05) {
    console.error(`✗ Run 2 still produces audio (peak ${p2.toFixed(4)}) — new code wasn't applied`);
    process.exit(1);
  }
  console.log("✓ edit-then-rerun applies the new code");
}
main().catch((e) => { console.error(e); process.exit(1); });
