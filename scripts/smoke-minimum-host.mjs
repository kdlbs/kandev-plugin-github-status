// Run only against a disposable Kandev instance with this package installed.
// Changes notification preferences and disables/re-enables the plugin.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = process.argv[2];
assert.ok(base, "usage: node scripts/smoke-minimum-host.mjs http://127.0.0.1:PORT");
const plugin = "/api/plugins/kandev-plugin-github-status";
async function request(path, { status = 200, ...init } = {}) {
  const response = await fetch(new URL(path, base), {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, `${init.method || "GET"} ${path}: ${await response.clone().text()}`);
  return response;
}
async function json(path, init) {
  return (await request(path, init)).json();
}
const post = (body) => ({ method: "POST", ...(body === undefined ? {} : {
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) });
const health = await json("/health");
assert.equal(health.version, "v0.99.0");
const installed = (await json(plugin));
assert.equal(installed.status, "active");
assert.equal(installed.api_version, 1);
assert.equal(installed.min_kandev_version, "0.99.0");
console.log("PASS minimum host, active subprocess, API v1");

const live = await json(`${plugin}/webhooks/status`);
assert.equal(live.sourceId, "github");
assert.equal(live.snapshot.keyComponents.length, 6);
assert.equal(live.stale, false);
console.log("PASS live GitHub poll through Host webhook relay");
for (const [demo, severity] of Object.entries({ healthy: "operational", degraded: "minor",
  incident: "major", critical: "critical", maintenance: "operational", stale: "minor" })) {
  const payload = await json(`${plugin}/webhooks/status?demo=${demo}`);
  assert.equal(payload.overall, severity);
  assert.equal(payload.demo, demo);
}
await request(`${plugin}/webhooks/ack`, { status: 405 });
await request(`${plugin}/webhooks/ack`, { ...post({}), status: 400 });
assert.equal((await json(`${plugin}/webhooks/ack`, post({ sourceId: "github", transitionId: "smoke-absent" }))).acknowledged, false);
await request(`${plugin}/webhooks/settings`, { status: 405 });
await request(`${plugin}/webhooks/settings`, { ...post(), body: "{", status: 400 });
console.log("PASS all demo states, ack, method and body rejection");

const original = await json(`${plugin}/webhooks/settings`, post());
try {
  assert.equal((await json(`${plugin}/webhooks/settings`, post({ notifyOnTransition: false }))).notifyOnTransition, false);
  await json(`${plugin}/disable`, post());
  assert.equal((await json(plugin)).status, "disabled");
  await json(`${plugin}/enable`, post());
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await json(plugin)).status === "active") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await json(plugin)).status, "active");
  assert.equal((await json(`${plugin}/webhooks/settings`, post())).notifyOnTransition, false);
  console.log("PASS Host state survives subprocess disable/enable");
} finally {
  await json(`${plugin}/webhooks/settings`, post(original));
}
for (const [route, file] of [["bundle", "ui/bundle.js"], ["ui/ui/plugin.css", "ui/plugin.css"]]) {
  const served = await (await request(`${plugin}/${route}`)).text();
  const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  assert.equal(served, source);
}
console.log("PASS installed UI bundle and CSS match source");
