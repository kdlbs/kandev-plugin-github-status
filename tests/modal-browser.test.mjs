import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, extname, sep } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GHS_PLAYWRIGHT_MODULE || "playwright");
const root = resolve(new URL("..", import.meta.url).pathname);
let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const path = resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(path)] || "application/octet-stream",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function open(page, state = "incident", extra = "") {
  await page.goto(
    `${origin}/docs/harness/index.html?state=${state}&theme=dark&view=modal${extra}`,
  );
  await page.locator(".ghs-root .ghs-refresh").waitFor();
}

test("real modal preserves the briefing hierarchy and desktop Refresh geometry", async () => {
  const page = await browser.newPage({ viewport: { width: 998, height: 900 } });
  try {
    await open(page);
    const button = page.getByRole("button", {
      name: "Refresh GitHub status",
      exact: true,
    });
    const box = await button.boundingBox();
    assert.ok(
      Math.abs(box.height - 28) <= 1,
      `desktop Refresh should be 28px, was ${box.height}px`,
    );
    assert.match(await button.textContent(), /Refresh/);
    assert.equal(await button.locator("svg").count(), 1);
    assert.deepEqual(
      await page
        .locator("[data-service-group]")
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.serviceGroup)),
      ["affected", "healthy"],
    );
    assert.equal(
      await page.locator('[data-service-group="affected"] details').count(),
      4,
    );
    assert.equal(
      await page.locator('[data-service-group="healthy"] details').count(),
      2,
    );
    await page.locator("summary").filter({ hasText: "Git Operations" }).click();
    assert.equal(await page.locator("details[open]").count(), 1);
    assert.match(
      await page.locator("details[open] p").textContent(),
      /git clones/,
    );
    const body = await page.locator(".ghs-inc-body").evaluate((el) => ({
      max: getComputedStyle(el).maxHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    assert.equal(body.max, "none");
    assert.equal(body.overflow, "visible");
    const outlines = await page
      .locator('[data-service-group="affected"] details')
      .evaluateAll((nodes) =>
        nodes.map((el) => {
          const s = getComputedStyle(el);
          return [
            s.borderLeftWidth,
            s.borderRightWidth,
            s.borderTopColor,
            s.borderLeftColor,
            s.boxShadow,
          ];
        }),
      );
    assert.ok(
      outlines.every(
        (o) =>
          o[0] === "1px" && o[1] === "1px" && o[2] === o[3] && o[4] === "none",
      ),
    );
  } finally {
    await page.close();
  }
});

test("phone, breakpoint and coarse-pointer controls stay reachable without page overflow", async (t) => {
  for (const [width, touch, height] of [
    [393, false, 851],
    [393, true, 851],
    [767, false, 900],
    [768, false, 900],
    [820, true, 900],
  ])
    await t.test(`${width}px touch=${touch}`, async () => {
      const page = await browser.newPage({
        viewport: { width, height },
        hasTouch: touch,
      });
      try {
        await open(page);
        const button = page.getByRole("button", {
          name: "Refresh GitHub status",
          exact: true,
        });
        const box = await button.boundingBox();
        assert.ok(
          width < 768 || touch
            ? box.height >= 44
            : Math.abs(box.height - 28) <= 1,
          `Refresh height ${box.height}`,
        );
        if (width < 768 || touch) {
          const summary = await page
            .locator("summary")
            .filter({ hasText: "Git Operations" })
            .boundingBox();
          assert.ok(summary.height >= 44);
        }
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page
          .locator("summary")
          .filter({ hasText: "Git Operations" })
          .focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("details[open]").count(), 1);
        await page.locator(".ghs-foot-link").scrollIntoViewIfNeeded();
        const foot = await page.locator(".ghs-foot-link").boundingBox();
        assert.ok(foot.y >= 0 && foot.y + foot.height <= height);
      } finally {
        await page.close();
      }
    });
});

test("Refresh busy and failure paths retain provider age and current briefing", async () => {
  const page = await browser.newPage({ viewport: { width: 998, height: 900 } });
  try {
    await page.route("**/demo.json", async (route) => {
      const response = await route.fetch();
      const fixtures = await response.json();
      fixtures.incident.fetchedAt = new Date(Date.now() - 120000).toISOString();
      await route.fulfill({ response, json: fixtures });
    });
    await open(page, "incident", "&refresh=failed");
    const button = page.getByRole("button", {
      name: "Refresh GitHub status",
      exact: true,
    });
    const age = await page.locator(".ghs-checked").textContent();
    assert.match(age, /Checked 2m ago/);
    await button.click();
    await page.waitForFunction(
      () => document.querySelector(".ghs-refresh").disabled,
    );
    assert.match(await button.textContent(), /Refreshing/);
    await page.waitForFunction(() =>
      document.querySelector(".ghs-recheck-error"),
    );
    assert.match(
      await page.locator(".ghs-recheck-error").textContent(),
      /Could not recheck/,
    );
    assert.equal(await page.locator(".ghs-checked").textContent(), age);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.locator(".ghs-comp").count(), 6);
  } finally {
    await page.close();
  }
});

test("healthy, stale, maintenance and translated long content preserve the status briefing", async (t) => {
  for (const state of ["healthy", "stale", "maintenance", "critical"])
    await t.test(state, async () => {
      const page = await browser.newPage({
        viewport: { width: 393, height: 851 },
        hasTouch: true,
      });
      try {
        await open(page, state);
        assert.equal(await page.locator(".ghs-comp").count(), 6);
        if (state === "stale")
          assert.match(
            await page.locator(".ghs-notice").textContent(),
            /last known/,
          );
        if (state === "maintenance")
          assert.ok((await page.locator(".ghs-history").count()) > 0);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      } finally {
        await page.close();
      }
    });
  await t.test("Portuguese", async () => {
    const page = await browser.newPage({
      viewport: { width: 393, height: 851 },
    });
    try {
      await open(page, "incident", "&locale=pt-pt");
      assert.match(
        await page.locator(".ghs-refresh").textContent(),
        /Atualizar/,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    } finally {
      await page.close();
    }
  });
});
