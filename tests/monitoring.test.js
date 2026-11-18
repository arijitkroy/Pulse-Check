import test from "node:test";
import assert from "node:assert/strict";
import { monitorSchema } from "../src/lib/validation/monitor.js";
import { isBlockedAddress } from "../src/lib/monitoring/ssrf.js";
import { runCheck } from "../src/lib/monitoring/check.js";

test("monitor validation accepts supported intervals", () => {
  const parsed = monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    intervalSeconds: 300,
  });
  assert.equal(parsed.success, true);
});

test("monitor validation rejects sub-minute and unsupported intervals", () => {
  for (const intervalSeconds of [30, 90, 120, 900]) {
    const parsed = monitorSchema.safeParse({
      name: "API",
      url: "https://example.com/health",
      intervalSeconds,
    });
    assert.equal(parsed.success, false);
  }
});

test("SSRF address screening blocks private and special-use addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.1.2",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
});

test("SSRF address screening permits public addresses", () => {
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("monitor execution refuses a loopback destination before connecting", async () => {
  const result = await runCheck({
    url: "http://127.0.0.1:8080/",
    method: "GET",
    timeoutMs: 1000,
    expectedStatusCodes: [200],
  });
  assert.equal(result.success, false);
  assert.match(result.error, /non-public address/);
});
