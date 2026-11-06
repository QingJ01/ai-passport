import { randomUUID, createHash } from "node:crypto";
export const LIMIT = 4096;
export const id = () => randomUUID();
export function text(value, bytes = 96) {
  let out = "";
  for (const ch of String(value ?? "").replace(
    /[\u0000-\u001f\u007f-\u009f]/gu,
    " ",
  )) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}
export function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,96}$/.test(value))
    throw new Error("invalid_identity");
  return value;
}
// Display metrics a source may attach to a conversation or report for a period.
// Numbers are formatted here so the device only validates and draws strings.
const CURRENCY = { USD: "$", CNY: "￥" };
export function money(amount, currency) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9)
    return null;
  const symbol = CURRENCY[currency];
  if (!symbol) return null;
  if (amount > 0 && amount < 0.01) return "<" + symbol + "0.01";
  return symbol + amount.toFixed(amount >= 1000 ? 0 : amount >= 100 ? 1 : 2);
}
export function speed(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e6)
    return null;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}
export function metrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let tokens = null;
  try {
    tokens = value.tokens == null ? null : counter(value.tokens);
  } catch {
    return null;
  }
  const result = {
    tokens: tokens && tokens.length <= 23 ? tokens : null,
    rate: speed(value.rate),
    cost: money(value.cost, value.currency),
    cost_estimate: value.cost_estimate === true,
    agent:
      typeof value.agent === "string" && value.agent.trim()
        ? text(value.agent, 16)
        : null,
  };
  return Object.values(result).some((v) => v !== null && v !== false)
    ? result
    : null;
}
export function counter(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value))
    return value;
  throw new Error("invalid_counter");
}
export function frame(type, stream, revision, payload) {
  const value = {
    v: 1,
    type,
    stream_id: stream.stream_id,
    view_epoch: stream.view_epoch,
    revision,
    payload,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT)
    throw new Error("frame_limit");
  return value;
}
export class Model {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.tasks = new Map();
    this.identities = new Map();
    this.records = new Map();
    this.lastSeen = 0;
    this.connected = false;
    this.sourceUsage = null;
  }
  ingest(e) {
    key(e.source_id);
    key(e.session_id);
    key(e.run_id);
    const taskId =
      "task:" + digest([e.source_id, e.session_id, e.run_id]).slice(0, 48);
    if (e.run_id !== "session-observed")
      for (const [tid, identity] of this.identities)
        if (
          identity.source_id === e.source_id &&
          identity.session_id === e.session_id &&
          identity.run_id === "session-observed"
        ) {
          this.tasks.delete(tid);
          this.identities.delete(tid);
        }
    this.identities.set(taskId, {
      source_id: e.source_id,
      session_id: e.session_id,
      run_id: e.run_id,
    });
    const previous = this.tasks.get(taskId);
    if (previous && e.revision <= previous.state_revision) return false;
    if (!Number.isSafeInteger(e.revision) || e.revision < 0)
      throw new Error("invalid_revision");
    const kind = ["goal", "turn", "job", "workflow"].includes(e.entity_kind)
      ? e.entity_kind
      : "turn";
    const turnEnded = e.turn_outcome === "ended";
    let execution = ["running", "idle", "queued", "unknown"].includes(
      e.execution_state,
    )
      ? e.execution_state
      : "unknown";
    // A source may report its agent as running at the instant a turn ends. The
    // turn itself is no longer executing; that is not evidence of success.
    if (kind === "turn" && turnEnded && execution === "running")
      execution = "idle";
    const interactions = (e.pending_interactions ?? [])
      .slice(0, 4)
      .map((x) => ({
        request_id: key(x.request_id),
        revision: Number.isSafeInteger(x.revision) ? x.revision : 0,
        blocks_execution: x.blocks_execution === true,
      }));
    const outcome = ["completed", "failed", "cancelled"].includes(
      e.task_outcome,
    )
      ? e.task_outcome
      : null;
    const task = {
      id: taskId,
      title: text(e.title || "Agent task"),
      entity_kind: kind,
      execution_state: execution,
      state: interactions.length
        ? "waiting_user"
        : (outcome ?? (execution === "idle" ? "unknown" : execution)),
      task_outcome: outcome,
      turn_outcome: turnEnded ? "ended" : null,
      pending_interactions: interactions,
      state_revision: e.revision,
      // A source may report when the conversation was last active; never future.
      updated_at: new Date(
        Number.isSafeInteger(e.activity_at) &&
        e.activity_at > 0 &&
        e.activity_at <= this.now()
          ? e.activity_at
          : this.now(),
      ).toISOString(),
      available_actions:
        e.capabilities?.open_on_host === true ? ["open_on_host"] : [],
    };
    const shown = metrics(e.metrics);
    if (shown) task.metrics = shown;
    if (!this.tasks.has(taskId) && this.tasks.size >= 4096)
      throw new Error("task_capacity");
    this.tasks.set(taskId, task);
    // Turns of one session are sequential. Once a newer turn is reported, an
    // older turn that never received its final update cannot still be running
    // or waiting. Its outcome stays unreported. A late event for an older turn
    // has a lower revision and never demotes a newer one.
    if (kind === "turn")
      for (const [tid, identity] of this.identities) {
        const older = this.tasks.get(tid);
        if (
          tid === taskId ||
          !older ||
          older.entity_kind !== "turn" ||
          identity.source_id !== e.source_id ||
          identity.session_id !== e.session_id ||
          older.state_revision >= e.revision ||
          (older.execution_state !== "running" &&
            older.execution_state !== "queued" &&
            !older.pending_interactions.length)
        )
          continue;
        this.tasks.set(tid, {
          ...older,
          execution_state: "idle",
          pending_interactions: [],
          state: older.task_outcome ?? "unknown",
        });
      }
    this.lastSeen = this.now();
    this.connected = true;
    return true;
  }
  meter(record) {
    const identity = key(record.id),
      rev = record.revision;
    if (!Number.isSafeInteger(rev) || rev < 0)
      throw new Error("invalid_revision");
    if ((this.records.get(identity)?.revision ?? -1) >= rev) return;
    // Upsert complete host-reduced records, never streamed token deltas.
    const tokens = counter(record.tokens);
    const money =
      record.money == null
        ? null
        : {
            micros: counter(record.money.micros),
            currency: key(record.money.currency),
            provenance:
              record.money.provenance === "actual" ? "actual" : "estimate",
            price_table_version: text(record.money.price_table_version, 64),
            measured_at: text(record.money.measured_at, 40),
          };
    if (!this.records.has(identity) && this.records.size >= 10000)
      throw new Error("meter_capacity");
    this.records.set(identity, {
      id: identity,
      revision: rev,
      tokens,
      money,
      supersedes: record.supersedes ? key(record.supersedes) : null,
    });
  }
  // Period totals reported by the source itself (e.g. Magpie's "today").
  setSourceUsage(value) {
    if (value == null) {
      this.sourceUsage = null;
      return;
    }
    const period = value?.period === "today" ? "today" : null;
    if (!period || !metrics(value)) throw new Error("source_usage");
    // Keep the raw validated numbers so a restart can re-validate them.
    const models = Array.isArray(value.models)
      ? value.models
          .slice(0, 8)
          .filter((x) => x && typeof x.name === "string" && x.name.trim())
          .map((x) => ({
            name: x.name,
            tokens: x.tokens,
            cost: x.cost ?? null,
            rate: x.rate ?? null,
          }))
      : [];
    this.sourceUsage = {
      period,
      tokens: value.tokens,
      rate: value.rate ?? null,
      cost: value.cost ?? null,
      currency: value.currency ?? null,
      cost_estimate: value.cost_estimate === true,
      models,
      spark: Array.isArray(value.spark)
        ? value.spark
            .slice(-30)
            .map((v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0))
        : [],
    };
  }
  usage() {
    const source = this.sourceUsage && metrics(this.sourceUsage);
    if (source) {
      const u = { ...source, period: this.sourceUsage.period };
      const currency = this.sourceUsage.currency;
      const models = (this.sourceUsage.models ?? [])
        .map((x) => {
          const shown = metrics({ ...x, currency });
          return shown && { name: text(x.name, 32), tokens: shown.tokens, cost: shown.cost, rate: shown.rate };
        })
        .filter(Boolean);
      return {
        models,
        spark: this.sourceUsage.spark ?? [],
        scope: u.period,
        daily_tokens: u.period === "today" ? u.tokens : null,
        tokens: u.tokens,
        provenance: "magpie-today",
        money: [],
        cost: u.cost,
        cost_estimate: u.cost_estimate,
        rate: u.rate,
      };
    }
    const superseded = new Set(
      [...this.records.values()].map((x) => x.supersedes).filter(Boolean),
    );
    const records = [...this.records.values()].filter(
      (x) => !superseded.has(x.id),
    );
    const total = records.length
      ? records.reduce((n, r) => n + BigInt(r.tokens), 0n).toString()
      : null;
    return {
      scope: "loaded_sessions_lifetime",
      daily_tokens: null,
      tokens: total && total.length <= 23 ? total : null,
      provenance: records.length ? "host-reduced-records" : "unavailable",
      money: records
        .map((r) => r.money)
        .filter(Boolean)
        .slice(0, 4),
    };
  }
  health() {
    return {
      connected: this.connected,
      fresh: this.connected && this.now() - this.lastSeen < 45000,
      source_updated_at: this.lastSeen
        ? new Date(this.lastSeen).toISOString()
        : null,
    };
  }
  // One entry per conversation: the latest run of each source session. Past
  // turns stay in the model for actions and history but would otherwise fill
  // the device's 16 slots with a single busy conversation.
  conversations() {
    const latest = new Map();
    for (const task of this.tasks.values()) {
      const identity = this.identities.get(task.id);
      const key = identity
        ? `${identity.source_id}\u0000${identity.session_id}`
        : task.id;
      const current = latest.get(key);
      // Prefer the record that carries usage metrics (a richer source for the
      // same conversation), then the newest revision.
      const better =
        !current ||
        (!!task.metrics !== !!current.metrics
          ? !!task.metrics
          : task.state_revision > current.state_revision);
      if (better) latest.set(key, task);
    }
    return [...latest.values()];
  }
  projection({ remote = false, publicMode = false } = {}) {
    const all = this.conversations().sort(
      (a, b) =>
        b.pending_interactions.length - a.pending_interactions.length ||
        Number(b.execution_state === "running") -
          Number(a.execution_state === "running") ||
        b.updated_at.localeCompare(a.updated_at),
    );
    return {
      tasks: publicMode
        ? []
        : all
            .slice(0, 16)
            .map((t, i) =>
              remote
                ? (({ metrics: _, ...rest }) => ({
                    ...rest,
                    title: `Task ${i + 1}`,
                    available_actions: [],
                  }))(t)
                : t,
            ),
      inbox:
        publicMode || remote
          ? []
          : all
              .flatMap((t) =>
                t.pending_interactions.map((q) => ({
                  id: q.request_id,
                  title: "Input requested",
                  task_id: t.id,
                })),
              )
              .slice(0, 8),
      usage: publicMode
        ? { tokens: null, provenance: "hidden" }
        : remote
          ? (({ cost: _c, cost_estimate: _e, rate: _r, models: _m, spark: _s, ...u }) => ({ ...u, money: [] }))(
              this.usage(),
            )
          : this.usage(),
      source: this.health(),
      total_tasks: publicMode ? 0 : all.length,
    };
  }
}
export class Publication {
  constructor(view_epoch = id()) {
    this.stream_id = id();
    this.view_epoch = key(view_epoch);
    this.revision = 0;
    this.current = null;
  }
  snapshot(projection) {
    if (
      this.current &&
      JSON.stringify(this.current) !== JSON.stringify(projection)
    ) {
      this.stream_id = id();
      this.revision = 0;
    }
    this.current = structuredClone(projection);
    const snapshot_id = id(),
      pages = [];
    // One task per page leaves ample headroom for multibyte escaped strings.
    for (let i = 0; i < projection.tasks.length; i++)
      pages.push({ tasks: [projection.tasks[i]], inbox: [] });
    pages.push({
      tasks: [],
      inbox: projection.inbox,
      usage: projection.usage,
      source: projection.source,
      total_tasks: projection.total_tasks,
    });
    return [
      frame("snapshot.begin", this, this.revision, {
        snapshot_id,
        page_count: pages.length,
        task_count: projection.tasks.length,
        inbox_count: projection.inbox.length,
      }),
      ...pages.map((p, page) =>
        frame("snapshot.page", this, this.revision, {
          snapshot_id,
          page,
          ...p,
        }),
      ),
      frame("snapshot.end", this, this.revision, { snapshot_id }),
    ];
  }
  update(next) {
    if (!this.current) return this.snapshot(next);
    if (
      JSON.stringify(this.current.inbox) !== JSON.stringify(next.inbox) ||
      this.current.total_tasks !== next.total_tasks
    ) {
      this.stream_id = id();
      this.revision = 0;
      return this.snapshot(next);
    }
    const old = new Map(this.current.tasks.map((t) => [t.id, t])),
      fresh = new Map(next.tasks.map((t) => [t.id, t]));
    const ops = [];
    for (const [identity] of old)
      if (!fresh.has(identity)) ops.push({ op: "task.remove", id: identity });
    for (const [identity, t] of fresh)
      if (JSON.stringify(old.get(identity)) !== JSON.stringify(t))
        ops.push({ op: "task.upsert", task: t });
    if (JSON.stringify(next.usage) !== JSON.stringify(this.current.usage))
      ops.push({ op: "usage.replace", usage: next.usage });
    if (!ops.length) return [];
    try {
      if (this.revision >= 0xffffffff) throw new Error("epoch");
      const f = frame("state.delta", this, this.revision + 1, { ops });
      this.revision++;
      this.current = structuredClone(next);
      return [f];
    } catch {
      this.stream_id = id();
      this.revision = 0;
      return this.snapshot(next);
    }
  }
  heartbeat(source) {
    return frame("heartbeat", this, this.revision, { source });
  }
}
export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
