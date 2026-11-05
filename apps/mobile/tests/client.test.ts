import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQR,
  SetupSession,
  type PairingQR,
  type NativeProvisioner,
} from "../src/provisioning.ts";
import { Relay, freshness, serviceURL, snapshot } from "../src/relay.ts";
const q: PairingQR = {
  ver: "agentpet-v1",
  name: "PROV_test",
  transport: "ble",
  security: 1,
  pop: "x".repeat(32),
  device_id: "device-test",
  public_key_pem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  nonce: "a".repeat(64),
  service_uuid: "12345678-1234-1234-1234-123456789abc",
};
function mock(overrides: Partial<NativeProvisioner> = {}) {
  const calls: string[] = [];
  const native: NativeProvisioner = {
    connect: async () => {
      calls.push("connect");
    },
    exchange: async (_p, d) => {
      const x = JSON.parse(d);
      calls.push(x.op);
      return JSON.stringify(
        x.op === "challenge"
          ? {
              ...q,
              physical_confirmed: true,
              network_slots: ["home", "office", "travel"],
              max_network_slots: 3,
              capabilities: ["network-candidate-v1", "enrollment-v1"],
            }
          : x.op === "enroll"
            ? {
                device_id: q.device_id,
                nonce: q.nonce,
                service_signature_verified: true,
                proof: "signed-ticket",
              }
            : x.op === "finish"
              ? { finished: true }
              : x.op === "service.trust"
                ? { trusted: true }
                : x.op === "service.configure"
                  ? { accepted: true, state: "validating_path" }
                  : { ready: true },
      );
    },
    provision: async () => {
      calls.push("provision");
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    ...overrides,
  };
  return { native, calls };
}
test("QR requires secure BLE and temporary proof", () => {
  assert.deepEqual(parseQR(JSON.stringify(q)), q);
  for (const changes of [
    { security: 0 },
    { pop: "123456" },
    { nonce: "old" },
    { transport: "softap" },
    { ver: "v1" },
  ])
    assert.throws(() => parseQR(JSON.stringify({ ...q, ...changes })));
  assert.throws(() => parseQR("null"));
});
test("network replacement is explicit and old configuration untouched on rejection", async () => {
  const { native, calls } = mock();
  const setup = new SetupSession(native);
  await setup.open(q);
  await assert.rejects(setup.network("travel", "valid-passphrase"), /Choose/);
  await assert.rejects(
    setup.network("travel", "密".repeat(22), 2),
    /passphrase/,
  );
  assert.ok(!calls.includes("provision"));
  await setup.network("travel", "valid-passphrase", 2);
  assert.deepEqual(calls.slice(-2), ["network.prepare", "provision"]);
  assert.ok(
    !calls.includes("finish"),
    "Keep BLE open for first-use enrollment",
  );
  await setup.finish();
  assert.equal(calls.at(-1), "finish");
});
test("first-use Wi-Fi and account enrollment share the physical window until explicit finish", async () => {
  const { native, calls } = mock();
  const setup = new SetupSession(native);
  await setup.open(q);
  await setup.network("travel", "valid-passphrase", 2);
  assert.ok(!calls.includes("finish"));
  await setup.trust(q.public_key_pem);
  assert.equal(
    await setup.enrollment({ ticket: "unit-ticket" }),
    "signed-ticket",
  );
  await setup.configure(
    {
      endpoint: "wss://relay.example/v1/device",
      ca_pem: "test-only-ca",
      server_name: "relay.example",
      time: 1,
    },
    "test-only-device-credential",
  );
  assert.deepEqual(calls.slice(-4), [
    "service.trust",
    "enroll",
    "service.configure",
    "finish",
  ]);
});
test("single-slot firmware requires explicit replacement without assuming three slots", async () => {
  const { native, calls } = mock();
  native.exchange = async (_p, raw) => {
    const m = JSON.parse(raw);
    calls.push(m.op);
    return JSON.stringify(
      m.op === "challenge"
        ? {
            ...q,
            physical_confirmed: true,
            network_slots: ["home"],
            max_network_slots: 1,
            capabilities: ["network-candidate-v1"],
          }
        : m.op === "finish"
          ? { finished: true }
          : { ready: true },
    );
  };
  const setup = new SetupSession(native);
  await setup.open(q);
  await assert.rejects(setup.network("travel", "valid-passphrase"), /Choose/);
  assert.ok(!calls.includes("provision"));
  await setup.network("travel", "valid-passphrase", 0);
  assert.ok(calls.includes("provision"));
});
test("identity mismatch closes BLE before secrets are transmitted", async () => {
  const { native, calls } = mock({
    exchange: async () =>
      JSON.stringify({
        ...q,
        device_id: "wrong",
        physical_confirmed: true,
        network_slots: [],
        capabilities: [],
      }),
  });
  await assert.rejects(new SetupSession(native).open(q), /identity/);
  assert.equal(calls.at(-1), "disconnect");
  assert.ok(!calls.includes("provision"));
});
test("expired session refuses credentials and tickets", async () => {
  let now = 0;
  const { native, calls } = mock();
  const setup = new SetupSession(native, () => now);
  await setup.open(q);
  now = 120000;
  await assert.rejects(setup.network("home", "valid-passphrase", 0), /expired/);
  await assert.rejects(setup.enrollment({}), /expired/);
  assert.ok(!calls.includes("provision"));
});
test("enrollment refuses unverified service signature", async () => {
  const { native } = mock();
  const setup = new SetupSession(native);
  await setup.open(q);
  native.exchange = async () =>
    JSON.stringify({
      device_id: q.device_id,
      nonce: q.nonce,
      proof: "x",
      service_signature_verified: false,
    });
  await assert.rejects(setup.enrollment({}), /verify/);
});
test("remote setup fails before trust mutation on firmware without independent profiles", async () => {
  const { native, calls } = mock();
  const setup = new SetupSession(native);
  await setup.open(q);
  await assert.rejects(() => setup.trust(q.public_key_pem, "remote"), /USB/);
  assert.ok(!calls.includes("service.trust"));
});
test("profile-aware firmware receives an explicit remote target for every security mutation", async () => {
  const { native } = mock();
  const original = native.exchange;
  const seen: Record<string, unknown>[] = [];
  native.exchange = async (p, d) => {
    const input = JSON.parse(d);
    seen.push(input);
    const output = JSON.parse(await original(p, d));
    if (input.op === "challenge")
      output.capabilities.push("transport-profiles-v1");
    return JSON.stringify(output);
  };
  const setup = new SetupSession(native);
  await setup.open(q);
  await setup.trust(q.public_key_pem, "remote");
  await setup.enrollment({ ticket: "unit-ticket" }, "remote");
  await setup.configure(
    {
      endpoint: "wss://relay.example/v1/device",
      ca_pem: "unit-ca",
      server_name: "relay.example",
      time: 1,
    },
    "unit-credential",
    "remote",
  );
  for (const op of ["service.trust", "enroll", "service.configure"])
    assert.equal(seen.find((x) => x.op === op)?.transport, "remote");
});
test("legacy relay role is read from authenticated health before remote configuration", async () => {
  const relay = new Relay(
    "https://relay.example",
    "unit-controller",
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/v1/health")
            ? { service: "relay" }
            : { endpoint: null },
        ),
      ),
  );
  assert.equal((await relay.service()).transport, "remote");
});
test("service trust requires explicit HTTPS origin", () => {
  assert.equal(serviceURL("https://relay.example/"), "https://relay.example");
  for (const u of [
    "http://relay.example",
    "https://u:p@relay.example",
    "https://relay.example/path",
    "https://relay.example/?token=x",
  ])
    assert.throws(() => serviceURL(u));
});
test("source freshness never uses relay heartbeat", () => {
  const now = Date.now();
  assert.equal(freshness(new Date(now - 44999).toISOString(), now), "fresh");
  assert.equal(freshness(new Date(now - 45000).toISOString(), now), "stale");
  assert.equal(freshness(null, now), "stale");
  assert.equal(freshness(new Date(now + 60000).toISOString(), now), "stale");
});
function frames() {
  const base = { v: 1, stream_id: "s", view_epoch: "e", revision: 1 };
  return [
    {
      ...base,
      type: "snapshot.begin",
      payload: {
        snapshot_id: "snap",
        page_count: 1,
        task_count: 1,
        inbox_count: 0,
      },
    },
    {
      ...base,
      type: "snapshot.page",
      payload: {
        snapshot_id: "snap",
        page: 0,
        tasks: [{ id: "t", title: "task", state: "running" }],
        inbox: [],
        source: { source_updated_at: "2026-11-05T00:00:00Z" },
      },
    },
    { ...base, type: "snapshot.end", payload: { snapshot_id: "snap" } },
  ];
}
test("atomic snapshot validation rejects gaps and privacy mixtures", () => {
  assert.equal(snapshot({ frames: frames() }).tasks.length, 1);
  const mixed = frames();
  mixed[1].view_epoch = "old";
  assert.throws(() => snapshot(mixed), /Mixed/);
  assert.throws(() => snapshot(frames().slice(1)));
  const missing = frames();
  (missing[0].payload as any).page_count = 2;
  assert.throws(() => snapshot(missing), /page count/);
});
test("controller authorization is header-only and redirects are forbidden", async () => {
  let called = false;
  const relay = new Relay(
    "https://relay.example",
    "controller-token",
    async (url, options) => {
      called = true;
      assert.equal(url, "https://relay.example/v1/devices");
      assert.equal(
        (options!.headers as any).Authorization,
        "Bearer controller-token",
      );
      assert.equal(options!.redirect, "error");
      return new Response(JSON.stringify({ devices: [] }));
    },
  );
  assert.deepEqual(await relay.devices(), { devices: [] });
  assert.ok(called);
});
test("asynchronous device worker response is polled before accepting trust", async () => {
  const { native } = mock();
  const setup = new SetupSession(native);
  await setup.open(q);
  const ops: string[] = [];
  native.exchange = async (_path, raw) => {
    const msg = JSON.parse(raw);
    ops.push(msg.op);
    return JSON.stringify(
      msg.op === "service.trust"
        ? { pending: true, request_id: "worker" }
        : { pending: false, result: { trusted: true } },
    );
  };
  await setup.trust(q.public_key_pem);
  assert.deepEqual(ops, ["service.trust", "result"]);
});
test("actual bridge publication is readable by the mobile client", async () => {
  const { Publication, Model } = await import(
    "../../../services/src/model.mjs"
  );
  const model = new Model();
  const publication = new Publication("view-test");
  const parsed = snapshot({
    frames: publication.snapshot(model.projection({ remote: true })),
  });
  assert.equal(parsed.tasks.length, 0);
  assert.equal(parsed.usage?.tokens, null);
});
test("credential renewal explicitly requests rotation with the fresh physical nonce", async () => {
  const relay = new Relay(
    "https://relay.example",
    "test-controller",
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.operation, "rotate_credential");
      assert.equal(body.device_id, q.device_id);
      assert.equal(body.public_key_pem, q.public_key_pem);
      assert.equal(body.nonce, q.nonce);
      assert.equal(body.source_id, "existing-source");
      return new Response(JSON.stringify({ ticket: "unit-ticket" }));
    },
  );
  await relay.ticket(q, "existing-source", true);
});
test("revoked controller receives explicit failure", async () => {
  const relay = new Relay(
    "https://relay.example",
    "token",
    async () => new Response("", { status: 403 }),
  );
  await assert.rejects(relay.devices(), /revoked/);
});
