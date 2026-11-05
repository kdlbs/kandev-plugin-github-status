// Explicit integration check; use a disposable 0.99.0 host with the package installed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const origin = process.env.GHS_HOST_URL;
test("installed native UI on the minimum host", { skip: !origin }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.GHS_PLAYWRIGHT_MODULE || "playwright");
  assert.equal((await (await fetch(`${origin}/health`)).json()).version, "v0.99.0");
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(60000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?ghsDemo=incident`, { waitUntil: "domcontentloaded" });
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    // First-run onboarding is isolated to this disposable instance.
    await page.waitForFunction(() => document.querySelector('button[aria-label="GitHub status"]') || [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Skip"));
    if (await skip.isVisible()) await skip.click();
    const actions = page.getByRole("button", { name: "GitHub status", exact: true });
    await actions.first().click();
    await page.locator(".ghs-root").waitFor();
    assert.equal(await page.locator(".ghs-comp").count(), 6);
    assert.match(await page.locator(".ghs-root").innerText(), /4 GitHub services affected/);
    await page.getByRole("button", { name: "Refresh GitHub status", exact: true }).click();
    assert.equal(await page.locator(".ghs-comp").count(), 6);
    await page.keyboard.press("Escape");

    for (let cycle = 0; cycle < 2; cycle++) {
      const path = `${origin}/api/plugins/kandev-plugin-github-status`;
      assert.equal((await page.request.post(`${path}/disable`)).status(), 200);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="GitHub status"]'));
      assert.equal((await page.request.post(`${path}/enable`)).status(), 200);
      await page.reload({ waitUntil: "domcontentloaded" });
      await actions.first().waitFor();
      assert.equal(await actions.count(), 1);
    }
    await page.goto(`${origin}/settings/plugins/kandev-plugin-github-status`, { waitUntil: "domcontentloaded" });
    await page.locator(".ghs-settings").waitFor();
    assert.match(await page.locator(".ghs-settings").innerText(), /Show a toast when GitHub degrades or recovers/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
