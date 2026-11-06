import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activity,
  agentLabel,
  changedEvents,
  decodeRate,
  parseCsv,
  pollOnce,
  sessionEvents,
  todayUsage,
} from "../src/magpie-source.mjs";
import { Model } from "../src/model.mjs";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const HEADER =
  "time,agent,model,input_tokens,output_tokens,cost_usd,duration_ms,ttft_ms,status,session";
const CSV = [
  HEADER,
  "2026-11-05T09:59:30Z,dsh,deepseek-flash,1000,400,0.10,12000,2000,200,live",
  "2026-11-05T09:30:00Z,dsh,deepseek-flash,500,100,0.05,7000,2000,200,live",
  '2026-11-05T08:00:00Z,codex,gpt-6.1-sol,"2,0",50,0.01,0,,0,old',
  "2026-11-05T08:00:00Z,codex,gpt-6.1-sol,300,200,0.02,5000,1000,200,old",
].join("\r\n");
const SESSIONS = [
  { id: "live", agent: "dsh", title: "设计评审", last: "2026-11-05T09:59:00.000Z", input: 1500, output: 500, cost: 0.15 },
  { id: "old", agent: "codex", title: "", last: "2026-11-05T08:00:00.000Z", input: 300, output: 200, cost: 0.02 },
  { id: "claude", agent: "claude", app: "claude-desktop", title: "x", last: "bad", input: 0, output: 0, cost: 0 },
];

test("CSV reader keeps quoted commas and skips ragged rows", () => {
  const rows = parseCsv('a,b\r\n"x,1","say ""hi"""\r\nragged\r\n3,4');
  assert.deepEqual(rows, [{ a: "x,1", b: 'say "hi"' }, { a: "3", b: "4" }]);
  assert.deepEqual(parseCsv(""), []);
});

test("decode speed excludes time to first token and unusable rows", () => {
  const rows = parseCsv(CSV);
  // live: (400+100) tokens over (10000+5000) ms
  assert.equal(decodeRate(rows.filter((r) => r.session === "live")), 500 / 15);
  assert.equal(decodeRate([]), null);
  assert.equal(agentLabel({ agent: "claude", app: "claude-desktop" }), "Claude");
  assert.equal(agentLabel({ agent: "dsh" }), "DeepSeek");
});

test("sessions become conversations with titles, running state and metrics", () => {
  let n = 0;
  const events = sessionEvents(SESSIONS, parseCsv(CSV), {
    sourceId: "magpie",
    now: NOW,
    revision: () => ++n,
  });
  assert.equal(events.length, 3);
  const [live, old, claude] = events;
  assert.equal(live.title, "设计评审");
  assert.equal(live.execution_state, "running", "a request 30 s ago is live work");
  assert.equal(live.activity_at, Date.parse("2026-11-05T09:59:30Z"));
  assert.deepEqual(live.metrics, {
    tokens: 2000, rate: 500 / 15, cost: 0.15, currency: "USD", cost_estimate: true, agent: "DeepSeek",
  });
  assert.equal(old.title, "未命名对话");
  assert.equal(old.execution_state, "idle");
  assert.equal(claude.activity_at, undefined);
  const cny = sessionEvents(SESSIONS, [], { sourceId: "magpie", now: NOW, revision: () => ++n, currency: "CNY", fx: 7 });
  assert.equal(cny[0].metrics.cost, 1.05);
  assert.equal(cny[0].metrics.currency, "CNY");
  assert.equal(sessionEvents(SESSIONS, [], { sourceId: "m", now: NOW, revision: () => 1, currency: "CNY" })[0].metrics.cost, null);
});

test("Magpie events project to device metrics and today's usage", () => {
  const model = new Model({ now: () => NOW });
  let n = 0;
  for (const e of sessionEvents(SESSIONS, parseCsv(CSV), { sourceId: "magpie", now: NOW, revision: () => ++n }))
    model.ingest(e);
  model.setSourceUsage(todayUsage(parseCsv(CSV), { currency: "USD" }));
  const p = model.projection();
  assert.equal(p.tasks[0].title, "设计评审", "running conversation first");
  assert.deepEqual(p.tasks[0].metrics, { tokens: "2000", rate: "33.3", cost: "$0.15", cost_estimate: true, agent: "DeepSeek" });
  assert.equal(p.usage.tokens, "2550");
  assert.equal(p.usage.cost, "$0.18");
  assert.equal(p.usage.provenance, "magpie-today");
  assert.deepEqual(p.usage.models, [
    { name: "deepseek-flash", tokens: "2000", cost: "$0.15", rate: "33.3" },
    { name: "gpt-6.1-sol", tokens: "550", cost: "$0.03", rate: "50.0" },
  ]);
  assert.equal(model.projection({ remote: true }).usage.models, undefined);
});

test("only changed conversations are re-sent, with a periodic full refresh", () => {
  const memory = {};
  const a = { session_id: "a", revision: 1, title: "x" };
  const b = { session_id: "b", revision: 1, title: "y" };
  assert.equal(changedEvents([a, b], memory, 3).length, 2);
  assert.equal(changedEvents([{ ...a, revision: 2 }, { ...b, revision: 2, title: "z" }], memory, 3).length, 1);
  assert.equal(changedEvents([{ ...a, revision: 3 }, { ...b, revision: 3, title: "z" }], memory, 3).length, 0);
  assert.equal(changedEvents([{ ...a, revision: 4 }, { ...b, revision: 4, title: "z" }], memory, 3).length, 2);
});

test("one poll reads the Magpie CLI and posts events then a heartbeat", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(SESSIONS));
  writeFileSync(join(dir, "usage.csv"), CSV);
  const fake = join(dir, "magpie");
  writeFileSync(
    fake,
    `#!/bin/sh\ncase "$1" in\n sessions) cat "${dir}/sessions.json";;\n usage) cat "${dir}/usage.csv";;\n settings) echo usd;;\n *) exit 2;;\nesac\n`,
  );
  chmodSync(fake, 0o755);
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const bridge = {
    url: new URL(`http://127.0.0.1:${server.address().port}/`),
    sourceId: "magpie",
    ipcToken: "i".repeat(40),
    sourceToken: "s".repeat(40),
  };
  let n = 0;
  const result = await pollOnce({ binary: fake, bridge, now: () => NOW, revision: () => ++n });
  assert.deepEqual(result, { sessions: 3, sent: 3, requests: 4, currency: "USD" });
  assert.deepEqual(received.map((r) => r.path), ["/v1/events", "/v1/events", "/v1/events", "/v1/source/heartbeat"]);
  assert(received.every((r) => r.auth === `Bearer ${"i".repeat(40)}` && r.body.source_credential === "s".repeat(40)));
  assert.equal(received[3].body.usage.period, "today");
  assert.equal(received[3].body.connected, true);
});

test("activity buckets output tokens per minute, oldest first", () => {
  const rows = parseCsv(CSV);
  const spark = activity(rows, NOW);
  assert.equal(spark.length, 30);
  assert.equal(spark[29], 0, "nothing yet in the current minute (10:00)");
  assert.equal(spark[28], 400, "09:59:30 lands in the previous minute");
  assert.equal(spark.reduce((a, b) => a + b, 0), 400, "09:30 and 08:00 are outside the 30-minute window");
  const model = new Model({ now: () => NOW });
  model.setSourceUsage(todayUsage(rows, { currency: "USD", now: NOW }));
  assert.equal(model.projection().usage.spark.length, 30);
  assert.equal(model.projection({ remote: true }).usage.spark, undefined);
});
