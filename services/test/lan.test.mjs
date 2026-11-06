import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { applyNetwork, isPrivateIPv4, lanAddress, pairPayload } from "../src/lan.mjs";

test("only private IPv4 LAN addresses are used, Wi-Fi/Ethernet before VPNs", () => {
  assert(isPrivateIPv4("192.168.5.3") && isPrivateIPv4("10.0.0.2") && isPrivateIPv4("172.20.1.1"));
  assert(!isPrivateIPv4("8.8.8.8") && !isPrivateIPv4("172.32.0.1") && !isPrivateIPv4("127.0.0.1") && !isPrivateIPv4("1.2.3"));
  const ifs = {
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    utun3: [{ family: "IPv4", internal: false, address: "10.8.0.2" }],
    en0: [{ family: "IPv6", internal: false, address: "fe80::1" }, { family: "IPv4", internal: false, address: "192.168.5.3" }],
    en5: [{ family: "IPv4", internal: false, address: "203.0.113.9" }],
  };
  assert.equal(lanAddress(ifs), "192.168.5.3");
  assert.equal(lanAddress({ utun3: ifs.utun3 }), "10.8.0.2", "a VPN address is still better than nothing");
  assert.equal(lanAddress({ lo0: ifs.lo0 }), null);
});

test("LAN mode points devices at the Bonjour name and binds the current IP", () => {
  const base = { bind: "127.0.0.1", port: 7443, time_port: 7444,
    public_endpoint: "wss://127.0.0.1:7443/v1/device", time_bootstrap_url: "http://127.0.0.1:7444/v1/time" };
  const on = applyNetwork(base, { lan: true, host: "mac.local", address: "192.168.5.3" });
  assert.equal(on.changed, true);
  assert.equal(on.config.bind, "192.168.5.3");
  assert.equal(on.config.public_endpoint, "wss://mac.local:7443/v1/device");
  assert.equal(on.config.time_bootstrap_url, "http://mac.local:7444/v1/time");
  assert.equal(applyNetwork(on.config, { lan: true, host: "mac.local", address: "192.168.5.3" }).changed, false);
  const moved = applyNetwork(on.config, { lan: true, host: "mac.local", address: "192.168.5.40" });
  assert(moved.changed && moved.config.bind === "192.168.5.40" && moved.config.public_endpoint === on.config.public_endpoint,
    "a new DHCP address only rebinds; what devices store stays valid");
  const offline = applyNetwork(on.config, { lan: true, host: "mac.local", address: null });
  assert.equal(offline.config.bind, "127.0.0.1", "no LAN: loopback so USB keeps working");
  assert.deepEqual(applyNetwork(on.config, { lan: false }).config.bind, "127.0.0.1");
});

test("phone pairing payload carries the origin, token and certificate pin", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-pet-lan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const setup = spawnSync(process.execPath, ["src/setup.mjs", dir], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  const config = join(dir, "config.json");
  const payload = pairPayload(config, { host: "mac.local", address: "192.168.5.3", name: "QingJ 的 Mac" });
  const credentials = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
  const pem = readFileSync(join(dir, "tls-cert.pem"), "utf8");
  assert.deepEqual(Object.keys(payload), ["v", "origin", "origin_ip", "token", "pin", "name"]);
  assert.equal(payload.v, "agentpet-pair-v1");
  assert.equal(payload.origin, "https://mac.local:7443");
  assert.equal(payload.origin_ip, "https://192.168.5.3:7443");
  assert.equal(payload.token, credentials.controller_credential);
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.pin, createHash("sha256").update(new X509Certificate(pem).raw).digest("hex"));
  assert.match(payload.pin, /^[0-9a-f]{64}$/);
  assert(Buffer.byteLength(JSON.stringify(payload)) < 400, "fits a quick-to-scan QR");
  assert.equal(pairPayload(config, { host: "mac.local", address: null, name: "x" }).origin_ip, undefined);
});
