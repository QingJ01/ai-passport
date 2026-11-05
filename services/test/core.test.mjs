import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Model, Publication, text, LIMIT } from "../src/model.mjs";
import { Store, Enrollment, Actions } from "../src/security.mjs";
import { validateRemoteFrames } from "../src/relay.mjs";
import { createTimeServer } from "../src/time.mjs";
const pair = () =>
  generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const event = (extra = {}) => ({
  source_id: "magpie",
  session_id: "session",
  run_id: "run",
  revision: 1,
  title: "Task\u0000😀",
  execution_state: "running",
  ...extra,
});
test("sanitization, explicit outcomes, orthogonal questions and stale source", () => {
  let now = 100000;
  const m = new Model({ now: () => now });
  m.ingest(
    event({
      pending_interactions: [
        { request_id: "q", revision: 1, blocks_execution: false },
      ],
    }),
  );
  const t = [...m.tasks.values()][0];
  assert.equal(t.execution_state, "running");
  assert.equal(t.state, "waiting_user");
  assert.equal(t.task_outcome, null);
  assert(!t.title.includes("\u0000"));
  m.ingest(
    event({ revision: 2, execution_state: "idle", turn_outcome: "ended" }),
  );
  assert.equal([...m.tasks.values()][0].state, "unknown");
  assert.equal([...m.tasks.values()][0].task_outcome, null);
  assert.equal(m.ingest(event()), false);
  now += 45001;
  assert.equal(m.health().fresh, false);
  assert.equal(m.health().connected, true);
  assert(Buffer.byteLength(text("😀".repeat(100))) <= 96);
  assert(!text("😀".repeat(100)).includes("�"));
});
test("ended or superseded turns of one session stop counting as running", () => {
  const m = new Model();
  const turn = (run, revision, extra = {}) =>
    m.ingest(event({ run_id: run, revision, entity_kind: "turn", ...extra }));
  // The source still reports its agent running when turn 1 ends.
  turn("turn-1", 1, { turn_outcome: "ended" });
  turn("turn-2", 2, {
    pending_interactions: [{ request_id: "q", revision: 2, blocks_execution: true }],
  });
  turn("turn-3", 3);
  m.ingest(event({ session_id: "other", run_id: "turn-1", revision: 1, entity_kind: "turn" }));
  const byRun = (session, run) =>
    [...m.tasks.entries()].find(
      ([id]) =>
        m.identities.get(id).session_id === session &&
        m.identities.get(id).run_id === run,
    )[1];
  const first = byRun("session", "turn-1");
  assert.equal(first.execution_state, "idle");
  assert.equal(first.turn_outcome, "ended");
  assert.equal(first.task_outcome, null, "ending a turn is not goal success");
  const second = byRun("session", "turn-2");
  assert.equal(second.execution_state, "idle");
  assert.deepEqual(second.pending_interactions, []);
  assert.equal(second.state, "unknown");
  assert.equal(byRun("session", "turn-3").execution_state, "running");
  assert.equal(byRun("other", "turn-1").execution_state, "running",
    "another session is independent");
  // A stale (lower-revision) frame is rejected and demotes nothing.
  assert.equal(turn("turn-2", 2, { execution_state: "running" }), false);
  assert.equal(byRun("session", "turn-3").execution_state, "running");
  // Revisions, not run names, order updates within a session.
  turn("turn-1", 5, { execution_state: "running" });
  assert.equal(byRun("session", "turn-3").execution_state, "idle");
  assert.equal(byRun("session", "turn-1").execution_state, "running");
  assert.equal(
    m.projection().tasks.filter((t) => t.execution_state === "running").length,
    2,
  );
});

test("usage corrections and replacements upsert records without counting twice", () => {
  const m = new Model();
  assert.equal(m.usage().tokens, null);
  m.meter({ id: "a", revision: 1, tokens: "100" });
  m.meter({ id: "a", revision: 2, tokens: "70" });
  m.meter({ id: "a", revision: 1, tokens: "999" });
  assert.equal(m.usage().tokens, "70");
  m.meter({
    id: "b",
    revision: 1,
    tokens: "80",
    supersedes: "a",
    money: {
      micros: "123",
      currency: "USD",
      provenance: "estimate",
      price_table_version: "v1",
      measured_at: "2026-11-05",
    },
  });
  assert.equal(m.usage().tokens, "80");
  assert.equal(m.usage().money[0].provenance, "estimate");
  assert.throws(() => m.meter({ id: "bad", revision: 1, tokens: "-1" }));
});
test("perdevice contiguous publication and bounded atomic fallback", () => {
  const m = new Model();
  for (let i = 0; i < 30; i++)
    m.ingest(event({ session_id: `s${i}`, title: "中".repeat(100) }));
  const a = new Publication("a"),
    b = new Publication("b"),
    p = m.projection();
  const frames = a.snapshot(p);
  assert.equal(frames[0].payload.task_count, 16);
  assert.equal(p.total_tasks, 30);
  for (const f of frames) assert(Buffer.byteLength(JSON.stringify(f)) <= LIMIT);
  b.snapshot(p);
  m.ingest(event({ revision: 3, title: "updated" }));
  const next = a.update(m.projection());
  assert(next.length);
  assert.equal(b.revision, 0);
  if (next[0].type === "state.delta") assert.equal(a.revision, 1);
  assert.deepEqual(a.update(m.projection()), []);
  // An atomic top-N transaction too large for one delta gets an independent new stream.
  const old = a.stream_id;
  const huge = {
    ...p,
    tasks: p.tasks.map((t, i) => ({
      ...t,
      title: "x".repeat(96),
      state_revision: 100 + i,
    })),
  };
  const rebuilt = a.update(huge);
  assert.equal(rebuilt[0].type, "snapshot.begin");
  assert.notEqual(old, a.stream_id);
});
test("credential account/device isolation, revocation and expiry", () => {
  const s = new Store();
  const token = s.issue({ account_id: "a", role: "device", device_id: "one" }),
    other = s.issue({ account_id: "b", role: "controller" });
  s.data.devices.push({ id: "one", account_id: "a", source_id: "magpie" });
  const c = s.auth(token);
  assert.equal(s.device(c, "one").id, "one");
  assert.throws(() => s.device(s.auth(other), "one"));
  s.revoke(c, "one");
  assert.throws(() => s.auth(token));
  assert.throws(() => s.issue({ account_id: "a", role: "device", ttl: 0 }));
});
test("enrollment verifies P256 possession, signed binding, one use and account scope", () => {
  const s = new Store(),
    root = pair(),
    device = pair();
  s.issue({ account_id: "a", role: "source", source_id: "magpie" });
  const e = new Enrollment(s, root.privateKey),
    c = { account_id: "a", role: "controller" };
  const offer = e.offer(c, {
    device_id: "new",
    source_id: "magpie",
    public_key_pem: device.publicKey,
    nonce: "a".repeat(64),
  });
  assert(
    verify(
      "sha256",
      Buffer.from(offer.canonical),
      root.publicKey,
      Buffer.from(offer.signature, "base64url"),
    ),
  );
  assert.throws(() => e.consume({ ticket: offer.ticket, proof: "bad" }));
  const proof = sign(
    "sha256",
    Buffer.from(offer.ticket),
    device.privateKey,
  ).toString("base64url");
  assert(e.consume({ ticket: offer.ticket, proof }).credential);
  assert.throws(() => e.consume({ ticket: offer.ticket, proof }));
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  assert.throws(() =>
    e.offer(c, {
      device_id: "rsa",
      source_id: "magpie",
      public_key_pem: rsa.publicKey,
      nonce: "a".repeat(64),
    }),
  );
  const wrong = generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  assert.throws(() =>
    e.offer(c, {
      device_id: "curve",
      source_id: "magpie",
      public_key_pem: wrong.publicKey,
      nonce: "a".repeat(64),
    }),
  );
  assert.throws(() =>
    e.offer(
      { account_id: "b" },
      {
        device_id: "cross",
        source_id: "magpie",
        public_key_pem: device.publicKey,
        nonce: "a".repeat(64),
      },
    ),
  );
});
test("durable action intent precedes host dispatch; dedupe and unknown results", async () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "agent-pet-actions-")),
      "store.json",
    ),
    s = new Store(path),
    a = new Actions(s),
    c = { account_id: "a", device_id: "d" },
    target = { id: "t", state_revision: 1 };
  const offer = a.prepare(c, target, "open_on_host"),
    req = {
      action_id: "one",
      device_boot_id: "boot",
      target_revision: 1,
      parameters: {},
      token: offer.token,
      type: "open_on_host",
      target_id: "t",
    },
    dispatch = async () => {
      assert.equal(
        Object.values(JSON.parse(readFileSync(path))).length > 0,
        true,
      );
      assert.equal(s.data.actions["a:d:one"].status, "accepted");
      return { confirmed: false };
    };
  assert.equal((await a.execute(c, req, target, dispatch)).status, "unknown");
  assert.equal(
    (
      await a.execute(c, req, target, () => {
        throw Error("duplicate executed");
      })
    ).status,
    "unknown",
  );
  await assert.rejects(() =>
    a.execute(c, { ...req, target_id: "changed" }, target, dispatch),
  );
  s.data.actions["a:d:crash"] = { status: "accepted" };
  s.save();
  assert.equal(new Store(path).data.actions["a:d:crash"].status, "unknown");
});
test("remote allowlist omits private fields and rejects payload injection", () => {
  const m = new Model();
  m.ingest(event({ title: "private code name" }));
  const frames = new Publication("view").snapshot(
    m.projection({ remote: true }),
  );
  assert(!JSON.stringify(frames).includes("private code name"));
  assert.equal(validateRemoteFrames(frames, "view").length, frames.length);
  const bad = structuredClone(frames);
  bad[1].payload.tasks[0].raw_prompt = "secret";
  assert.throws(() => validateRemoteFrames(bad, "view"));
  assert.throws(() => validateRemoteFrames(frames, "wrong"));
});
test("signed nonce time endpoint fixed encoding and no credentials", async () => {
  const root = pair(),
    server = createTimeServer({
      bridgeId: "test",
      privateKey: root.privateKey,
      now: () => 1700000000000,
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const nonce = "a".repeat(64),
      response = await fetch(
        `http://127.0.0.1:${server.address().port}/v1/time?nonce=${nonce}`,
      ),
      b = await response.json();
    assert(
      verify(
        "sha256",
        Buffer.from(`agentpet-time-v1\ntest\n${nonce}\n1700000000`),
        root.publicKey,
        Buffer.from(b.signature, "base64"),
      ),
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${server.address().port}/v1/time?nonce=bad`,
        )
      ).status,
      400,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
