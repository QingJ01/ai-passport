// Agent Pet source backed by Magpie (https://usemagpie.ai): every poll reads
// `magpie sessions --json` (recent sessions of every agent Magpie may read, with
// titles and Magpie's own cost) and `magpie usage --csv today` (per-request
// tokens, decode time and cost), and publishes them to the local bridge over the
// existing authenticated loopback IPC. Read-only toward Magpie; no prompts,
// replies or file paths leave this process.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

export const RECENT_LIMIT = 16;
export const RUNNING_WINDOW_MS = 90_000;
const AGENTS = {
  dsh: "DeepSeek",
  codex: "Codex",
  claude: "Claude Code",
  "claude-desktop": "Claude",
  opencode: "OpenCode",
  pi: "Pi",
  gemini: "Gemini",
};

export function agentLabel(session) {
  const key = session.app || session.agent;
  return AGENTS[key] ?? AGENTS[session.agent] ?? String(session.agent ?? "").slice(0, 16);
}

// Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const int = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// Mean decode speed: output tokens over (duration - time to first token).
export function decodeRate(rows) {
  let tokens = 0,
    ms = 0;
  for (const r of rows) {
    const output = int(r.output_tokens),
      duration = int(r.duration_ms),
      ttft = int(r.ttft_ms);
    if (!output || !ttft || duration <= ttft) continue;
    tokens += output;
    ms += duration - ttft;
  }
  return ms >= 500 ? (tokens * 1000) / ms : null;
}

export function convert(amount, currency, fx) {
  if (currency === "CNY") return Number.isFinite(fx) && fx > 0 ? amount * fx : null;
  return amount;
}

// One bridge event per recent session. Magpie's figures are list-price
// estimates (it shows them as "≈"), so costs are flagged as estimates.
export function sessionEvents(sessions, rows, { sourceId, now, revision, currency = "USD", fx }) {
  const bySession = new Map();
  for (const r of rows) {
    if (!r.session) continue;
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }
  return sessions
    .filter((s) => typeof s?.id === "string" && s.id.length > 0 && s.id.length <= 96)
    .slice(0, RECENT_LIMIT)
    .map((s) => {
      const last = Date.parse(s.last);
      const requests = bySession.get(s.id) ?? [];
      const latestRequest = Math.max(0, ...requests.map((r) => Date.parse(r.time) || 0));
      const activity = Math.max(Number.isFinite(last) ? last : 0, latestRequest);
      const running = activity > 0 && now - activity < RUNNING_WINDOW_MS;
      const cost = convert(num(s.cost), currency, fx);
      return {
        source_id: sourceId,
        session_id: s.id,
        run_id: "magpie",
        revision: revision(),
        title: typeof s.title === "string" && s.title.trim() ? s.title : "未命名对话",
        entity_kind: "turn",
        execution_state: running ? "running" : "idle",
        pending_interactions: [],
        task_outcome: null,
        turn_outcome: null,
        capabilities: { open_on_host: false },
        activity_at: activity || undefined,
        metrics: {
          tokens: int(s.input) + int(s.output),
          rate: decodeRate(requests),
          cost,
          currency,
          cost_estimate: true,
          agent: agentLabel(s),
        },
      };
    });
}

export const MODEL_LIMIT = 8;
export const SPARK_MINUTES = 30;

// Output tokens per minute for the last 30 minutes, oldest first, by request time.
export function activity(rows, now, minutes = SPARK_MINUTES) {
  const buckets = new Array(minutes).fill(0);
  const end = Math.floor(now / 60000);
  for (const r of rows) {
    const at = Date.parse(r.time);
    if (!Number.isFinite(at)) continue;
    const age = end - Math.floor(at / 60000);
    if (age < 0 || age >= minutes) continue;
    buckets[minutes - 1 - age] += int(r.output_tokens);
  }
  return buckets;
}

export function todayUsage(rows, { currency = "USD", fx, now = Date.now() }) {
  let tokens = 0,
    cost = 0;
  const byModel = new Map();
  for (const r of rows) {
    const used = int(r.input_tokens) + int(r.output_tokens);
    tokens += used;
    cost += num(r.cost_usd);
    const name = (r.model || r.served_model || "unknown").slice(0, 32);
    if (!byModel.has(name)) byModel.set(name, { name, tokens: 0, cost: 0, rows: [] });
    const entry = byModel.get(name);
    entry.tokens += used;
    entry.cost += num(r.cost_usd);
    entry.rows.push(r);
  }
  const models = [...byModel.values()]
    .filter((m) => m.tokens > 0 || m.cost > 0)
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost)
    .slice(0, MODEL_LIMIT)
    .map((m) => ({
      name: m.name,
      tokens: m.tokens,
      cost: convert(m.cost, currency, fx),
      rate: decodeRate(m.rows),
    }));
  return {
    period: "today",
    tokens,
    cost: convert(cost, currency, fx),
    currency,
    cost_estimate: true,
    rate: decodeRate(rows),
    models,
    spark: activity(rows, now),
  };
}

// Send a conversation only when what the device shows changed; every
// `fullEvery` polls everything is sent again so a restarted bridge recovers.
export function changedEvents(events, memory, fullEvery = 30) {
  memory.polls = (memory.polls ?? 0) + 1;
  memory.seen ??= new Map();
  const full = memory.polls % fullEvery === 1;
  return events.filter((event) => {
    const { revision: _, ...shown } = event;
    const fingerprint = JSON.stringify(shown);
    const changed = full || memory.seen.get(event.session_id) !== fingerprint;
    memory.seen.set(event.session_id, fingerprint);
    return changed;
  });
}

function run(binary, args) {
  return new Promise((resolve, reject) =>
    execFile(binary, args, { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(new Error("magpie_cli_failed")) : resolve(stdout),
    ),
  );
}

function post(bridge, path, value) {
  const body = JSON.stringify({ source_credential: bridge.sourceToken, ...value });
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, bridge.url),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.ipcToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error("ipc_rejected")),
        );
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("ipc_timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function loadConnection(file = join(homedir(), ".config/agent-pet/magpie.json")) {
  const value = JSON.parse(await readFile(file, "utf8"));
  const url = new URL(value.bridgeUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/")
    throw new Error("bridge_requires_literal_loopback");
  for (const k of ["sourceId", "ipcToken", "sourceToken"])
    if (typeof value[k] !== "string" || !value[k]) throw new Error("invalid_connection_file");
  return { url, sourceId: value.sourceId, ipcToken: value.ipcToken, sourceToken: value.sourceToken };
}

export async function pollOnce({ binary, bridge, now = Date.now, revision, memory = {} }) {
  const [sessionsText, usageText, setting] = await Promise.all([
    run(binary, ["sessions", "--limit", String(RECENT_LIMIT), "--json"]),
    run(binary, ["usage", "--csv", "today"]),
    run(binary, ["settings", "get", "currency"]).catch(() => "usd"),
  ]);
  const currency = String(setting).trim().toLowerCase() === "cny" ? "CNY" : "USD";
  let fx;
  if (currency === "CNY") {
    try {
      fx = JSON.parse(await readFile(join(homedir(), ".cache/magpie/fxrate.json"), "utf8")).rate;
    } catch {
      fx = undefined;
    }
  }
  const sessions = JSON.parse(sessionsText);
  const rows = parseCsv(usageText);
  const events = sessionEvents(Array.isArray(sessions) ? sessions : [], rows, {
    sourceId: bridge.sourceId,
    now: now(),
    revision,
    currency,
    fx,
  });
  const changed = changedEvents(events, memory);
  for (const event of changed) await post(bridge, "/v1/events", { event });
  await post(bridge, "/v1/source/heartbeat", { connected: true, usage: todayUsage(rows, { currency, fx, now: now() }) });
  return { sessions: events.length, sent: changed.length, requests: rows.length, currency };
}

export async function main(argv = process.argv.slice(2)) {
  const binary = process.env.MAGPIE_BIN || "/Applications/magpie.app/Contents/MacOS/magpie";
  const interval = Math.max(5, Number(argv[0]) || 10) * 1000;
  const bridge = await loadConnection(process.env.AGENT_PET_MAGPIE_CONNECTION || undefined);
  let last = 0;
  const revision = () => (last = Math.max(Date.now() * 1000, last + 1));
  let stopping = false;
  const memory = {};
  let lastLine = "";
  const stop = async () => {
    stopping = true;
    try {
      await post(bridge, "/v1/source/heartbeat", { connected: false });
    } catch {
      /* the bridge marks the source stale on its own */
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (!stopping) {
    try {
      const result = await pollOnce({ binary, bridge, revision, memory });
      const line = `magpie-source: ${result.sessions} sessions, ${result.requests} requests today (${result.currency})`;
      if (line !== lastLine) console.log((lastLine = line));
    } catch (error) {
      // Only fixed error codes; never Magpie output (titles) or credentials.
      const known = ["magpie_cli_failed", "ipc_rejected", "ipc_timeout"];
      console.error(`magpie-source: ${known.includes(error.message) ? error.message : "poll_failed"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
