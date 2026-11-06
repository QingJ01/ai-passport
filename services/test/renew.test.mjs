import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/security.mjs";
import { renew } from "../src/renew.mjs";

const NOW = Date.parse("2026-11-06T00:00:00Z");
function fixture(daysLeft) {
  const dir = mkdtempSync(join(tmpdir(), "agent-pet-renew-"));
  const store = new Store(join(dir, "store.json"));
  const issue = (role, extra) => store.issue({ account_id: "local", role, ttl: 3600, ...extra });
  const credentials = {
    account_id: "local", source_id: "magpie", device_id: "passport-1",
    source_credential: issue("source", { source_id: "magpie" }),
    controller_credential: issue("controller", {}),
    device_credential: issue("device", { source_id: "magpie", device_id: "passport-1" }),
    adapter_token: "a".repeat(43),
  };
  for (const c of store.data.credentials) c.expires = NOW + daysLeft * 86400000;
  store.save();
  writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ store: "store.json", credentials: "credentials.json", ipc_port: 7445 }));
  return { dir, credentials };
}

test("credentials close to expiry are replaced, old ones revoked, Magpie file kept in sync", (t) => {
  const { dir, credentials: before } = fixture(3);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const magpie = join(dir, "magpie", "magpie.json");
  const result = renew({ configPath: join(dir, "config.json"), days: 10, magpiePath: magpie, now: NOW });
  assert.deepEqual(result.renewed.sort(), ["controller", "device", "source"]);
  assert.equal(result.days_left, 30);
  assert.equal(result.magpie, "written");
  const after = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
  const store = new Store(join(dir, "store.json"));
  for (const field of ["source_credential", "controller_credential", "device_credential"]) {
    assert.notEqual(after[field], before[field]);
    assert.throws(() => store.auth(before[field]), /unauthorized/, "the replaced credential is revoked");
  }
  assert.equal(store.auth(after.device_credential, ["device"]).device_id, "passport-1");
  assert.equal(store.auth(after.source_credential, ["source"]).source_id, "magpie");
  const file = JSON.parse(readFileSync(magpie, "utf8"));
  assert.deepEqual(file, { bridgeUrl: "http://127.0.0.1:7445", sourceId: "magpie", ipcToken: "a".repeat(43),
    sourceToken: after.source_credential, sessionIds: ["none"] });
  assert.equal(statSync(magpie).mode & 0o777, 0o600);
  const again = renew({ configPath: join(dir, "config.json"), days: 10, magpiePath: magpie, now: NOW });
  assert.deepEqual(again.renewed, []);
  assert.equal(again.magpie, "unchanged");
});

test("healthy credentials are left alone and report the days left", (t) => {
  const { dir, credentials: before } = fixture(25);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = renew({ configPath: join(dir, "config.json"), days: 10, now: NOW });
  assert.deepEqual(result.renewed, []);
  assert.equal(result.days_left, 25);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")), before);
});
