// Headless: load the patcher dev server, evaluate registry, print sorted types.
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://127.0.0.1:5174";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto(BASE + "/", { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("select.example-picker"));
const types = await page.evaluate(async () => {
  const m = await import("/src/registry/index.ts");
  return Object.keys((m as any).registry).sort();
});
console.log("TOTAL:", types.length);
console.log(JSON.stringify(types, null, 2));
await browser.close();
