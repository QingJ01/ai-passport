import test from "node:test";
import assert from "node:assert/strict";
import { ago, compact, effectiveState, taskState } from "../src/format.ts";

test("token counts read like the device: K, M, B, truncated", () => {
  assert.equal(compact("52340"), "52.3K");
  assert.equal(compact(12300000), "12.3M");
  assert.equal(compact("1999"), "1.9K");
  assert.equal(compact(2_000_000_000), "2B");
  assert.equal(compact(999), "999");
  assert.equal(compact("abc"), null);
  assert.equal(compact(undefined), null);
  assert.equal(compact(-1), null);
});

test("sync times are relative and in Chinese", () => {
  const now = Date.parse("2026-11-06T10:00:00Z");
  assert.equal(ago("2026-11-06T09:59:58Z", now), "刚刚");
  assert.equal(ago("2026-11-06T09:59:48Z", now), "12 秒前");
  assert.equal(ago("2026-11-06T09:57:00Z", now), "3 分钟前");
  assert.equal(ago("2026-11-06T08:00:00Z", now), "2 小时前");
  assert.match(ago("2026-11-01T08:00:00Z", now)!, /^11 月 \d+ 日$/);
  assert.equal(ago(null, now), null);
  assert.equal(ago("not a date", now), null);
});

test("task states get a Chinese label and a colour tone", () => {
  assert.deepEqual(taskState("running"), ["进行中", "good"]);
  assert.deepEqual(taskState("waiting_user"), ["等你处理", "warn"]);
  assert.deepEqual(taskState("failed"), ["失败", "bad"]);
  assert.deepEqual(taskState("something_new"), ["something_new", "idle"]);
  assert.deepEqual(taskState(undefined), ["未知", "idle"]);
});

test("outcomes and questions beat the execution state", () => {
  assert.equal(
    effectiveState({ state: "completed", execution_state: "idle" }),
    "completed",
  );
  assert.equal(
    effectiveState({ state: "waiting_user", execution_state: "running" }),
    "waiting_user",
  );
  assert.equal(
    effectiveState({ state: "active", execution_state: "running" }),
    "running",
  );
  assert.equal(effectiveState({ state: "queued" }), "queued");
});
