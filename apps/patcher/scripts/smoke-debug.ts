// Debug smoke: runs a single example with full error capture.
// Usage:  node --experimental-strip-types apps/patcher/scripts/smoke-debug.ts <file-name>

import { chromium } from "playwright";
const FILE = process.argv[2] ?? "09-osc-tour.json";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push("[pageerror] " + e.message + "\nStack:\n" + (e.stack ?? "(no stack)")));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    errors.push("[console " + m.type() + "] " + m.text());
  }
});

await page.goto("http://127.0.0.1:5174/", { waitUntil: "load" });
await page.waitForSelector("select.example-picker");
await page.waitForTimeout(400);
await page.selectOption("select.example-picker", FILE);
await page.waitForTimeout(300);
await page.locator("button.primary").first().click();
// Match smoke.ts wait loop for "live" or "error".
await page.waitForFunction(() => {
  const s = document.querySelector(".status");
  return s?.textContent?.includes("live") || s?.textContent?.includes("error");
}, { timeout: 10000 }).catch(() => null);
await page.waitForTimeout(8000);
const status = await page.locator(".status").textContent();
const errBox = await page.locator(".err").textContent().catch(() => "");
const meterWidth = await page.evaluate(() => {
  const bar = document.querySelector(".meter-bar") as HTMLElement | null;
  return bar?.style.width ?? "?";
});
console.log("status:", status);
console.log("err:", errBox);
console.log("meter width:", meterWidth);
console.log("collected errors:");
for (const e of errors) console.log("  ", e.slice(0, 600));
await browser.close();
