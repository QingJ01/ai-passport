import test from "node:test";
import assert from "node:assert/strict";
import { Model, Publication } from "../src/model.mjs";
import { validateRemoteFrames } from "../src/relay.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
test("wire identifiers counters inbox and stream rebuild stay firmware bounded", () => {
  const m = new Model();
  m.ingest({
    source_id: "s".repeat(96),
    session_id: "e".repeat(96),
    run_id: "r".repeat(96),
    revision: 1,
    execution_state: "running",
    pending_interactions: [
      { request_id: "q".repeat(96), revision: 1, blocks_execution: false },
    ],
  });
  const p = m.projection();
  assert(p.tasks[0].id.length <= 96);
  assert.equal(p.inbox.length, 1);
  m.meter({ id: "large", revision: 1, tokens: "9".repeat(40) });
  assert.equal(m.usage().tokens, null);
  const pub = new Publication("view"),
    before = pub.snapshot(p)[0].stream_id;
  m.ingest({
    source_id: "source",
    session_id: "session",
    run_id: "run",
    revision: 1,
    execution_state: "idle",
  });
  const after = pub.snapshot(m.projection())[0];
  assert.notEqual(after.stream_id, before);
  assert.equal(after.revision, 0);
});
test("relay rejects nested payloads hiding in allowed field names", () => {
  const m = new Model();
  m.ingest({
    source_id: "source",
    session_id: "session",
    run_id: "run",
    revision: 1,
    execution_state: "idle",
  });
  const original = new Publication("view").snapshot(
    m.projection({ remote: true }),
  );
  for (const mutate of [
    (f) => {
      f[0].payload.raw = "prompt";
    },
    (f) => {
      f[1].payload.tasks[0].available_actions = { raw: "prompt" };
    },
    (f) => {
      f.at(-2).payload.usage.money = { raw: "prompt" };
    },
    (f) => {
      f.at(-2).payload.usage.scope = "private prompt";
    },
    (f) => {
      f[1].payload.inbox = { raw: "prompt" };
    },
  ]) {
    const f = structuredClone(original);
    mutate(f);
    assert.throws(() => validateRemoteFrames(f, "view"));
  }
});
test("explicit private LAN setup issues an IP SAN and reachable metadata without printing credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-pet-san-")),
    r = spawnSync(
      process.execPath,
      ["src/setup.mjs", dir, "--lan-ip", "192.168.123.45"],
      { encoding: "utf8" },
    );
  assert.equal(r.status, 0, r.stderr);
  const certificate = new X509Certificate(
    readFileSync(join(dir, "tls-cert.pem")),
  );
  assert.equal(certificate.checkIP("192.168.123.45"), "192.168.123.45");
  const c = JSON.parse(readFileSync(join(dir, "config.json")));
  assert.equal(c.bind, "192.168.123.45");
  assert.equal(c.public_endpoint, "wss://192.168.123.45:7443/v1/device");
  assert(!r.stdout.includes("source_credential"));
  assert.notEqual(
    spawnSync(process.execPath, ["src/setup.mjs", dir, "--lan-ip", "8.8.8.8"])
      .status,
    0,
  );
});
