import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const plugin = "/api/plugins/kandev-plugin-github-status";
const demos = JSON.parse(await readFile(new URL("../docs/harness/demo.json", import.meta.url)));

async function runSmoke(options = {}) {
  let active = true, notify = true, liveRequests = 0, enableRequests = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const reply = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") return reply({ version: "v0.99.0" });
    if (path === plugin) return reply({ status: active ? "active" : "disabled", api_version: 1, min_kandev_version: "0.99.0" });
    if (path === `${plugin}/webhooks/status`) {
      const demo = url.searchParams.get("demo");
      if (!demo) liveRequests++;
      const body = structuredClone(demos[demo || "healthy"]);
      body.demo = demo;
      if (!demo && liveRequests <= (options.startupNulls || 0)) body.snapshot = null;
      return reply(body);
    }
    if (path === `${plugin}/disable`) {
      active = false;
      return reply({ error: "primary disable failure" }, options.failDisable ? 500 : 200);
    }
    if (path === `${plugin}/enable`) {
      enableRequests++;
      if (enableRequests <= (options.failEnables || 0)) return reply({ error: "cleanup enable failure" }, 500);
      active = true;
      return reply({ enabled: true });
    }
    if (path === `${plugin}/webhooks/settings` || path === `${plugin}/webhooks/ack`) {
      if (req.method !== "POST") return reply({}, 405);
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reply({}, 400); }
      if (path.endsWith("/ack")) return reply({ acknowledged: false }, body.sourceId ? 200 : 400);
      if (!active) return reply({ error: "settings unavailable while disabled" }, 503);
      if (body.notifyOnTransition !== undefined) notify = body.notifyOnTransition;
      return reply({ notifyOnTransition: notify });
    }
    const file = path.endsWith("/bundle") ? "bundle.js" : "plugin.css";
    res.end(await readFile(new URL(`../ui/${file}`, import.meta.url)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, [new URL("../scripts/smoke-minimum-host.mjs", import.meta.url).pathname,
      `http://127.0.0.1:${server.address().port}`]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { code, output, active, notify, liveRequests, enableRequests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("smoke waits for the first asynchronous provider snapshot", async () => {
  const result = await runSmoke({ startupNulls: 2 });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.liveRequests, 3);
  assert.equal(result.active, true);
  assert.equal(result.notify, true);
});

test("smoke re-enables and restores preferences after a lifecycle failure", async () => {
  const result = await runSmoke({ failDisable: true });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /primary disable failure/);
  assert.equal(result.active, true);
  assert.equal(result.notify, true);
});

test("cleanup errors do not replace the original smoke failure", async () => {
  const result = await runSmoke({ failDisable: true, failEnables: 1 });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /primary disable failure/);
  assert.match(result.output, /cleanup enable failure/);
});
