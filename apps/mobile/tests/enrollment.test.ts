import test from "node:test";
import assert from "node:assert/strict";
import { enroll } from "../src/enrollment.ts";
import type { PairingQR } from "../src/provisioning.ts";
import type { Device, Service } from "../src/relay.ts";
const qr: PairingQR = {
  ver: "agentpet-v1",
  name: "PROV_TEST",
  transport: "ble",
  security: 1,
  pop: "x".repeat(32),
  device_id: "device-test",
  public_key_pem: "unit-public-key",
  nonce: "b".repeat(64),
  service_uuid: "12345678-1234-1234-1234-123456789abc",
};
function harness(
  transport: "local" | "remote",
  devices: Device[] = [],
  endpoint: string | null = "wss://service.example/v1/device",
) {
  const calls: string[] = [];
  const meta: Service = {
    transport,
    endpoint,
    ca_pem: "unit-ca",
    server_name: "service.example",
    time: 1,
    enrollment_public_key_pem: "unit-service-key",
    key_id: "unit-key",
  };
  const relay = {
    devices: async () => {
      calls.push("devices");
      return { devices };
    },
    service: async () => {
      calls.push("service");
      return meta;
    },
    ticket: async (q: PairingQR, source: string, rotate = false) => {
      assert.equal(q.nonce, qr.nonce);
      assert.equal(source, "source");
      calls.push(rotate ? "rotate" : "ticket");
      return {
        ticket: "unit-ticket",
        payload: {},
        canonical: "unit-canonical",
        signature: "unit-signature",
        key_id: "unit-key",
        expires_at: 1,
      };
    },
    consume: async (ticket: string, proof: string) => {
      assert.equal(ticket, "unit-ticket");
      assert.equal(proof, "unit-proof");
      calls.push("consume");
      return { device_id: qr.device_id, credential: "unit-device-credential" };
    },
    remote: async (id: string, enabled: boolean) => {
      assert.equal(id, qr.device_id);
      assert.equal(enabled, true);
      calls.push("enable-remote");
      return {};
    },
  };
  const session = {
    trust: async (_pem: string, profile?: "local" | "remote") => {
      assert.equal(profile, transport);
      calls.push("trust:" + profile);
    },
    enrollment: async (_ticket: unknown, profile?: "local" | "remote") => {
      assert.equal(profile, transport);
      calls.push("proof:" + profile);
      return "unit-proof";
    },
    configure: async (
      _service: unknown,
      credential: string,
      profile?: "local" | "remote",
    ) => {
      assert.equal(credential, "unit-device-credential");
      assert.equal(profile, transport);
      calls.push("configure:" + profile);
    },
    finish: async () => {
      calls.push("finish");
    },
  };
  return { relay, session, qr, sourceId: "source", calls };
}
test("ownership-only pairing does not enable or configure a remote transport", async () => {
  const h = harness("remote", [], null);
  const result = await enroll({ ...h, choice: "pair-only" });
  assert.equal(result.configured, false);
  assert.deepEqual(h.calls, [
    "devices",
    "service",
    "trust:remote",
    "ticket",
    "proof:remote",
    "consume",
    "finish",
  ]);
});
test("ownership-only pairing of an already-owned active device is idempotent and never rotates its credential", async () => {
  const h = harness("remote", [
    { id: qr.device_id, source_id: "source", remote_enabled: true },
  ]);
  const result = await enroll({ ...h, choice: "pair-only" });
  assert.equal(result.alreadyPaired, true);
  assert.deepEqual(h.calls, ["devices", "service"]);
});
test("failed explicit reconfiguration reports that the renewed credential needs fresh setup", async () => {
  const h = harness("remote", [
    { id: qr.device_id, source_id: "source", remote_enabled: true },
  ]);
  h.session.configure = async () => {
    throw Error("BLE setup expired");
  };
  await assert.rejects(
    () => enroll({ ...h, choice: "remote" }),
    /credential was renewed.*Reopen device setup/,
  );
  assert.equal(h.calls.filter((x) => x === "rotate").length, 1);
});
test("local bridge setup never grants cloud sharing permission", async () => {
  const h = harness("local");
  const result = await enroll({ ...h, choice: "local" });
  assert.equal(result.transport, "local");
  assert.equal(result.configured, true);
  assert.ok(!h.calls.includes("enable-remote"));
  assert.equal(h.calls.at(-1), "configure:local");
});
test("explicit remote setup enables policy only after proof consumption and before configuration", async () => {
  const h = harness("remote");
  await enroll({ ...h, choice: "remote" });
  assert.deepEqual(h.calls.slice(-3), [
    "consume",
    "enable-remote",
    "configure:remote",
  ]);
});
test("a service role change cannot turn a local setup choice into remote sharing", async () => {
  const h = harness("remote");
  await assert.rejects(() => enroll({ ...h, choice: "local" }), /role changed/);
  assert.deepEqual(h.calls, ["devices", "service"]);
});
test("later remote configuration rotates the credential with a fresh physical challenge", async () => {
  const h = harness("remote", [
    { id: qr.device_id, source_id: "source", remote_enabled: false },
  ]);
  await enroll({ ...h, choice: "remote" });
  assert.ok(h.calls.includes("rotate"));
  assert.ok(!h.calls.includes("ticket"));
});
test("a paired device cannot silently move to a different source", async () => {
  const h = harness("local", [
    { id: qr.device_id, source_id: "other-source", remote_enabled: false },
  ]);
  await assert.rejects(
    () => enroll({ ...h, choice: "local" }),
    /already assigned/,
  );
  assert.deepEqual(h.calls, ["devices"]);
});
