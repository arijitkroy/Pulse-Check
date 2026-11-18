import test from "node:test";
import assert from "node:assert/strict";
import app from "../server/app.js";

test("Express serves static pages and health endpoint", async (context) => {
  const server = app.listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const [home, health] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/api/health`),
  ]);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /PulseCheck/);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "pulsecheck-node");
  const rewrittenHealth = await fetch(`${origin}/api/index/api/health`);
  assert.equal(rewrittenHealth.status, 200);
});

test("Express protects private endpoints and cron routes", async (context) => {
  const server = app.listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${origin}/api/monitors`)).status, 401);
  assert.equal((await fetch(`${origin}/api/cron/monitor`)).status, 401);
});
