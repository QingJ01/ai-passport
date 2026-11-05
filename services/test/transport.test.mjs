import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { generateKeyPairSync, sign } from "node:crypto";
import { WebSocket } from "ws";
import { createService } from "../src/server.mjs";
import { Store } from "../src/security.mjs";
import { attachRelay, publishRemote } from "../src/relay.mjs";
import { Publication } from "../src/model.mjs";
import { normalizedTurn } from "../magpie-plugin/src/projection.mjs";
const dir = mkdtempSync(join(tmpdir(), "agent-pet-tls-"));
const setup = spawnSync(process.execPath, ["src/setup.mjs", dir], {
  encoding: "utf8",
});
assert.equal(setup.status, 0, setup.stderr);
const file = (name) => readFileSync(join(dir, name), "utf8");
const creds = JSON.parse(file("credentials.json"));
async function service(mode = "bridge") {
  const store = new Store();
  store.data = JSON.parse(file("store.json"));
  const s = createService({
    mode,
    tls: { key: file("tls-key.pem"), cert: file("tls-cert.pem") },
    store,
    signingKey: file("signing-key.pem"),
    adapterToken: creds.adapter_token,
  });
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  await new Promise((r) => s.ipc.listen(0, "127.0.0.1", r));
  return s;
}
function request(
  s,
  path,
  token,
  method = "GET",
  body,
  ca = file("tls-cert.pem"),
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: s.server.address().port,
        path,
        method,
        ca,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(raw) }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const until = (condition, ms = 3000) =>
  new Promise((resolve, reject) => {
    const start = Date.now(),
      t = setInterval(() => {
        if (condition()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - start > ms) {
          clearInterval(t);
          reject(Error("test_timeout"));
        }
      }, 10);
  });
const connect = (s, path = "/v1/device") =>
  new WebSocket(`wss://127.0.0.1:${s.server.address().port}${path}`, {
    ca: file("tls-cert.pem"),
    rejectUnauthorized: true,
    perMessageDeflate: false,
  });
const opened = (ws) =>
  new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
test("real TLS rejects untrusted roots; scoped HTTPS and frozen fallback work", async () => {
  const s = await service();
  try {
    // Explicit unrelated system roots ensure trust fails.
    await assert.rejects(() =>
      request(
        s,
        "/v1/devices",
        creds.controller_credential,
        "GET",
        undefined,
        [],
      ),
    );
    assert.equal((await request(s, "/v1/devices", "bad")).status, 403);
    const list = await request(s, "/v1/devices", creds.controller_credential);
    assert.equal(list.body.devices.length, 1);
    const metadata = await request(
      s,
      "/v1/service",
      creds.controller_credential,
    );
    assert(metadata.body.enrollment_public_key_pem.includes("PUBLIC KEY"));
    assert.equal(metadata.body.transport, "local");
    const a = await request(s, "/v1/state?frame=0", creds.device_credential),
      b = await request(s, "/v1/state?frame=1", creds.device_credential);
    assert.equal(a.body.stream_id, b.body.stream_id);
    assert.equal(a.body.type, "snapshot.begin");
  } finally {
    await s.close();
  }
});
test("actual Magpie producer passes IPC and owner diagnostics distinguish event rejection from heartbeat", async () => {
  const s = await service();
  try {
    const event = normalizedTurn({
      sourceId: "magpie",
      session: {
        id: "sanitized-session",
        header: { isSeeded: false },
        inheritedEventCount: 0,
      },
      lifecycle: { turn: 1, startSeq: 1, ended: false },
      snapshot: {
        asOfSeq: 4,
        values: {
          tokenUsage: {
            uncachedInputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 5,
          },
        },
      },
      agent: { status: "running" },
      live: new Map(),
      revision: Date.now() * 1000,
    });
    const post = (path, body) =>
      fetch(`http://127.0.0.1:${s.ipc.address().port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creds.adapter_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source_credential: creds.source_credential,
          ...body,
        }),
      });
    assert.equal((await post("/v1/events", { event })).status, 200);
    assert.equal(
      (
        await post("/v1/events", {
          event: { ...event, session_id: "invalid/session" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/v1/source/heartbeat", { connected: true })).status,
      200,
    );
    const state = await request(s, "/v1/state", creds.device_credential);
    assert.equal(state.body.frames[0].payload.task_count, 1);
    assert.equal(
      state.body.frames.find((f) => f.payload.usage).payload.usage.tokens,
      "24",
    );
    const counts = (
      await request(s, "/v1/diagnostics", creds.controller_credential)
    ).body.adapter;
    assert.deepEqual(counts.events, { received: 2, accepted: 1, rejected: 1 });
    assert.deepEqual(counts.heartbeats, {
      received: 1,
      accepted: 1,
      rejected: 0,
    });
    assert.deepEqual(counts.rejection_categories, { invalid_identity: 1 });
    assert(!JSON.stringify(counts).includes("sanitized-session"));
    const foreign = s.store.issue({ account_id: "other", role: "controller" });
    assert.equal(
      (await request(s, "/v1/diagnostics", foreign)).body.adapter.events
        .received,
      0,
    );
  } finally {
    await s.close();
  }
});
test("controller health reports ingested authorized sources without a synthetic default", async () => {
  const s = await service();
  try {
    const posted = await fetch(
      `http://127.0.0.1:${s.ipc.address().port}/v1/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${creds.adapter_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source_credential: creds.source_credential,
          event: {
            source_id: "magpie",
            session_id: "health-session",
            run_id: "run",
            revision: 1,
            execution_state: "running",
          },
        }),
      },
    );
    assert.equal(posted.status, 200);
    const controller = await request(
      s,
      "/v1/health",
      creds.controller_credential,
    );
    const device = await request(s, "/v1/health", creds.device_credential);
    assert.equal(controller.body.source.connected, true);
    assert.equal(controller.body.source.fresh, true);
    assert.equal(controller.body.source_id, "magpie");
    assert.equal(controller.body.source_scope, "single_source");
    assert.deepEqual(controller.body.source, device.body.source);
    s.store.issue({ account_id: "local", role: "source", source_id: "magpie" });
    s.store.issue({ account_id: "local", role: "source", source_id: "second" });
    const foreign = s.store.issue({
      account_id: "foreign",
      role: "controller",
    });
    s.store.issue({
      account_id: "foreign",
      role: "source",
      source_id: "private-source",
    });
    const aggregate = await request(
      s,
      "/v1/health",
      creds.controller_credential,
    );
    assert.equal(aggregate.body.source_scope, "any_authorized_source");
    assert.equal(aggregate.body.source.fresh, true);
    assert.equal(aggregate.body.sources.length, 2);
    assert(!JSON.stringify(aggregate.body).includes("private-source"));
    const isolated = await request(s, "/v1/health", foreign);
    assert.equal(isolated.body.source.fresh, false);
    assert.deepEqual(
      isolated.body.sources.map((x) => x.id),
      ["private-source"],
    );
    assert.equal(s.models.has("local:default"), false);
  } finally {
    await s.close();
  }
});
test("HTTP credential rotation immediately closes old authenticated device connections", async () => {
  const s = await service();
  let ws;
  try {
    const device = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const ticket = async (operation, nonce) => {
      const r = await request(
        s,
        "/v1/enrollment/tickets",
        creds.controller_credential,
        "POST",
        {
          operation,
          device_id: "rotation-device",
          source_id: "magpie",
          public_key_pem: device.publicKey,
          nonce,
        },
      );
      assert.equal(r.status, 200);
      return r.body;
    };
    const consume = async (offer) => {
      const proof = sign(
        "sha256",
        Buffer.from(offer.ticket),
        device.privateKey,
      ).toString("base64url");
      return request(s, "/v1/enrollment/consume", undefined, "POST", {
        ticket: offer.ticket,
        proof,
      });
    };
    const initial = await consume(await ticket("enroll", "a".repeat(64)));
    assert.equal(initial.status, 200);
    ws = connect(s);
    const frames = [];
    ws.on("message", (b) => frames.push(JSON.parse(b)));
    await opened(ws);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        payload: {
          device_id: "rotation-device",
          view_epoch: "rotation-view",
          versions: [1],
        },
      }),
    );
    ws.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        payload: { credential: initial.body.credential },
      }),
    );
    await until(() => frames.some((f) => f.type === "snapshot.end"));
    const closed = new Promise((r) => ws.once("close", r));
    const rotated = await consume(
      await ticket("rotate_credential", "b".repeat(64)),
    );
    assert.equal(rotated.status, 200);
    await closed;
    assert.equal(
      (await request(s, "/v1/state", initial.body.credential)).status,
      403,
    );
    assert.equal(
      (await request(s, "/v1/state", rotated.body.credential)).status,
      200,
    );
    assert.equal(
      s.store.data.devices.find((d) => d.id === "rotation-device")
        .remote_enabled,
      false,
    );
  } finally {
    ws?.terminate();
    await s.close();
  }
});
test("authenticated IPC -> real WSS snapshot, orthogonal state and immediate revoke", async () => {
  const s = await service();
  let ws;
  try {
    const ipc = `http://127.0.0.1:${s.ipc.address().port}/v1/events`;
    const body = {
      source_credential: creds.source_credential,
      event: {
        source_id: "magpie",
        session_id: "session",
        run_id: "run",
        revision: 1,
        title: "test",
        execution_state: "running",
        pending_interactions: [
          { request_id: "q", revision: 1, blocks_execution: false },
        ],
      },
    };
    assert.equal(
      (
        await fetch(ipc, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${creds.adapter_token}`,
          },
          body: JSON.stringify(body),
        })
      ).status,
      200,
    );
    ws = connect(s);
    const frames = [];
    ws.on("message", (b) => frames.push(JSON.parse(b)));
    await opened(ws);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        payload: {
          device_id: "passport-1",
          view_epoch: "view-test",
          versions: [1],
        },
      }),
    );
    ws.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        payload: { credential: creds.device_credential },
      }),
    );
    await until(() => frames.some((f) => f.type === "snapshot.end"));
    const task = frames.find(
      (f) => f.type === "snapshot.page" && f.payload.tasks.length,
    ).payload.tasks[0];
    assert.equal(task.execution_state, "running");
    assert.equal(task.state, "waiting_user");
    const closed = new Promise((r) => ws.once("close", r));
    assert.equal(
      (
        await request(
          s,
          "/v1/devices/passport-1",
          creds.controller_credential,
          "DELETE",
        )
      ).status,
      200,
    );
    await closed;
    assert.equal(
      (await request(s, "/v1/state", creds.device_credential)).status,
      403,
    );
  } finally {
    ws?.terminate();
    await s.close();
  }
});
test("relay negotiates boot epochs and fresh public projections with the real source publisher", async () => {
  const s = await service("relay"),
    d = s.store.data.devices[0];
  d.remote_enabled = true;
  const lanEpoch = d.view_epoch;
  const stopRelay = attachRelay(s);
  let stopSource, device, second;
  try {
    const model = s.modelFor("local", "magpie");
    model.ingest({
      source_id: "magpie",
      session_id: "session",
      run_id: "run",
      revision: 1,
      title: "private project",
      execution_state: "running",
    });
    stopSource = publishRemote({
      url: `wss://127.0.0.1:${s.server.address().port}/v1/relay`,
      credential: creds.source_credential,
      device_id: "passport-1",
      model,
      ca: file("tls-cert.pem"),
    });
    await until(() => s.cache.size === 1);
    const initial = s.cache.values().next().value;
    device = connect(s, "/v1/relay");
    const frames = [];
    device.on("message", (b) => frames.push(JSON.parse(b)));
    await opened(device);
    device.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        payload: {
          credential: creds.device_credential,
          device_id: "passport-1",
          view_epoch: "boot-private",
          public_mode: false,
        },
      }),
    );
    await until(() =>
      frames.some(
        (f) => f.type === "snapshot.end" && f.view_epoch === "boot-private",
      ),
    );
    assert(
      frames.some(
        (f) => f.type === "welcome" && f.view_epoch === "boot-private",
      ),
    );
    assert(
      !frames.some(
        (f) =>
          f.type.startsWith("snapshot.") && f.view_epoch === initial.view_epoch,
      ),
    );
    assert.equal(d.view_epoch, lanEpoch);
    assert.equal(d.mode, "private");
    const privateCache = s.cache.values().next().value;
    assert.equal(privateCache.frames[0].payload.task_count, 1);
    device.send(
      JSON.stringify({
        v: 1,
        type: "view.configure",
        payload: { mode: "public", view_epoch: "boot-public" },
      }),
    );
    await until(() =>
      frames.some(
        (f) => f.type === "snapshot.end" && f.view_epoch === "boot-public",
      ),
    );
    const publicCache = s.cache.values().next().value;
    assert.equal(publicCache.frames[0].payload.task_count, 0);
    assert.equal(
      publicCache.frames.find((f) => f.payload.usage).payload.usage.tokens,
      null,
    );
    assert.notEqual(
      publicCache.frames[0].stream_id,
      privateCache.frames[0].stream_id,
    );
    assert(
      frames.some(
        (f) => f.type === "view.ready" && f.view_epoch === "boot-public",
      ),
    );
    assert.equal(d.mode, "private");
    stopSource();
    stopSource = null;
    second = connect(s, "/v1/relay");
    const boot = [];
    second.on("message", (b) => boot.push(JSON.parse(b)));
    await opened(second);
    second.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        payload: {
          credential: creds.device_credential,
          device_id: "passport-1",
          view_epoch: "cold-public",
          public_mode: true,
        },
      }),
    );
    await until(() => boot.some((f) => f.type === "welcome"));
    assert.equal(s.cache.size, 0);
    assert.equal(
      boot.find((f) => f.type === "welcome").payload.source.fresh,
      false,
    );
    assert(!boot.some((f) => f.type.startsWith("snapshot.")));
    assert.equal(d.remote_view_epoch, "cold-public");
  } finally {
    stopSource?.();
    device?.terminate();
    second?.terminate();
    stopRelay();
    await s.close();
  }
});
test("relay publishes complete minimal snapshot, source age and TTL without public data", async () => {
  const s = await service("relay");
  s.store.data.devices[0].remote_enabled = true;
  s.store.data.devices[0].view_epoch = "remote-view";
  const stop = attachRelay(s);
  let source, device;
  try {
    assert.equal(
      (await request(s, "/v1/service", creds.controller_credential)).body
        .transport,
      "remote",
    );
    source = connect(s, "/v1/relay");
    await opened(source);
    source.send(
      JSON.stringify({
        type: "auth",
        payload: {
          credential: creds.source_credential,
          device_id: "passport-1",
        },
      }),
    );
    const model = s.modelFor("local", "magpie");
    model.ingest({
      source_id: "magpie",
      session_id: "s",
      run_id: "r",
      revision: 1,
      title: "private project",
      execution_state: "running",
    });
    const frames = new Publication("remote-view").snapshot(
      model.projection({ remote: true }),
    );
    for (const f of frames) source.send(JSON.stringify(f));
    await until(() => s.cache.size === 1);
    const state = await request(
      s,
      "/v1/devices/passport-1/state",
      creds.controller_credential,
    );
    assert.equal(state.status, 200);
    assert(!JSON.stringify(state.body).includes("private project"));
    assert.equal(state.body.source_fresh, true);
    assert.equal(
      (await request(s, "/v1/health", creds.controller_credential)).body.source
        .fresh,
      true,
    );
    const cache = s.cache.values().next().value;
    cache.source_updated_at = Date.now() - 46000;
    assert.equal(
      (
        await request(
          s,
          "/v1/devices/passport-1/state",
          creds.controller_credential,
        )
      ).body.source_fresh,
      false,
    );
    assert.equal(
      (await request(s, "/v1/health", creds.controller_credential)).body.source
        .fresh,
      false,
    );
    device = connect(s, "/v1/relay");
    const received = [];
    device.on("message", (raw) => received.push(JSON.parse(raw)));
    await opened(device);
    device.send(
      JSON.stringify({
        type: "auth",
        payload: {
          credential: creds.device_credential,
          device_id: "passport-1",
        },
      }),
    );
    await until(() => received.some((f) => f.type === "snapshot.end"));
    cache.received_at = Date.now() - 86400001;
    assert.equal(
      (
        await request(
          s,
          "/v1/devices/passport-1/state",
          creds.controller_credential,
        )
      ).status,
      503,
    );
  } finally {
    source?.terminate();
    device?.terminate();
    stop();
    await s.close();
  }
});
