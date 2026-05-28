import { expect, test } from "@playwright/test";

test("dev server経由でstart→audio→meterUI反映", async ({ page }) => {
  const consoleLogs: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "(?)"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  await page.goto("/");

  // page load 時の cross-origin isolated 状態を確認
  await expect(page.locator("#diag-coi")).not.toHaveText("—", { timeout: 5000 });
  const coi = await page.locator("#diag-coi").textContent();
  console.log(`[test] crossOriginIsolated = ${coi}`);

  // start ボタンをclick = AudioContext + worklet 立ち上げ
  await page.click("#start");

  // status = "running." に到達するのを待つ (= worklet ready handshake 完了)
  await expect(page.locator("#status")).toHaveText("running.", { timeout: 10_000 });

  // transport 種別を確認 (sab or postMessage)
  const transport = await page.locator("#diag-transport").textContent();
  console.log(`[test] transport = ${transport}`);

  // 音響が走る + meter publish が main に届くまで wait
  // 30fps publish + rAF driver, 余裕を見て 1.5s
  await page.waitForTimeout(1500);

  // meter UI bar の width style を観測
  const meterLWidth = await page.locator("#meterL").evaluate((el) => el.style.width);
  const meterRWidth = await page.locator("#meterR").evaluate((el) => el.style.width);
  const meterLVal = await page.locator("#meterLval").textContent();
  const meterRVal = await page.locator("#meterRval").textContent();

  console.log(`[test] meterL.width=${meterLWidth}, meterR.width=${meterRWidth}`);
  console.log(`[test] meterLval=${meterLVal}, meterRval=${meterRVal}`);
  console.log(`[test] console messages:`);
  for (const log of consoleLogs) console.log(`  ${log}`);
  if (pageErrors.length > 0) {
    console.log(`[test] page errors:`);
    for (const err of pageErrors) console.log(`  ${err}`);
  }
  if (failedRequests.length > 0) {
    console.log(`[test] failed requests:`);
    for (const req of failedRequests) console.log(`  ${req}`);
  }

  const pctL = parseFloat(meterLWidth);
  const pctR = parseFloat(meterRWidth);
  expect(pctL).toBeGreaterThan(0);
  expect(pctR).toBeGreaterThan(0);
});
