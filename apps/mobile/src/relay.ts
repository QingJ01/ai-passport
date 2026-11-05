import { utf8Bytes } from "./provisioning.ts";
export interface Service {
  transport?: "local" | "remote";
  endpoint: string | null;
  ca_pem: string;
  server_name: string;
  time: number;
  enrollment_public_key_pem: string;
  time_bootstrap_url?: string | null;
  time_issuer?: string;
  key_id: string;
}
export interface Device {
  id: string;
  source_id: string;
  remote_enabled: boolean;
}
export interface Source {
  id: string;
  connected: boolean;
  source_updated_at: string | null;
}
export interface Task {
  id: string;
  title?: string;
  state: string;
  entity_kind?: string;
  execution_state?: string;
}
export interface View {
  tasks: Task[];
  usage: Record<string, unknown> | null;
  source_updated_at: string | null;
  stream_id: string;
  view_epoch: string;
  revision: number;
}
export function serviceURL(input: string) {
  const u = new URL(input);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.href.includes("@") ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    throw Error(
      "Enter a trusted HTTPS service origin, with no path or credentials",
    );
  return u.origin;
}
export function freshness(updated: string | null, now = Date.now()) {
  const age = updated ? now - Date.parse(updated) : NaN;
  return Number.isFinite(age) && age >= -5000 && age < 45000
    ? "fresh"
    : "stale";
}
export class Relay {
  readonly origin: string;
  constructor(
    origin: string,
    private token: string,
    private request: typeof fetch,
  ) {
    this.origin = serviceURL(origin);
    if (!token.trim()) throw Error("Controller token required");
  }
  async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await this.request(this.origin + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      if (!r.ok)
        throw Error(
          r.status === 401 || r.status === 403
            ? "Session expired or access revoked"
            : `Relay request failed (${r.status})`,
        );
      if (r.status === 204) return undefined as T;
      const text = await r.text();
      if (text.length > 262144) throw Error("Relay response too large");
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }
  devices() {
    return this.call<{ devices: Device[] }>("/v1/devices");
  }
  sources() {
    return this.call<{ sources: Source[] }>("/v1/sources");
  }
  health() {
    return this.call<Record<string, unknown>>("/v1/health");
  }
  async service(): Promise<Service> {
    const meta = await this.call<Service>("/v1/service");
    let transport = meta.transport;
    if (transport === undefined) {
      const health = await this.health();
      transport =
        health.service === "bridge"
          ? "local"
          : health.service === "relay"
            ? "remote"
            : undefined;
    }
    if (transport !== "local" && transport !== "remote")
      throw Error(
        "Service role unavailable. Ask your administrator to update the service.",
      );
    return { ...meta, transport };
  }
  state(id: string) {
    return this.call<unknown>(
      "/v1/devices/" + encodeURIComponent(id) + "/state",
    );
  }
  ticket(
    q: { device_id: string; public_key_pem: string; nonce: string },
    source_id: string,
    rotate = false,
  ) {
    return this.call<{
      ticket: string;
      payload: unknown;
      signature: string;
      key_id: string;
      expires_at: number;
      canonical: string;
    }>("/v1/enrollment/tickets", "POST", {
      device_id: q.device_id,
      public_key_pem: q.public_key_pem,
      nonce: q.nonce,
      source_id,
      operation: rotate ? "rotate_credential" : undefined,
    });
  }
  consume(ticket: string, proof: string) {
    return this.call<{ device_id: string; credential: string }>(
      "/v1/enrollment/consume",
      "POST",
      { ticket, proof },
    );
  }
  revoke(id: string) {
    return this.call("/v1/devices/" + encodeURIComponent(id), "DELETE");
  }
  remote(id: string, enabled: boolean) {
    return this.call(
      "/v1/devices/" + encodeURIComponent(id) + "/remote",
      "POST",
      { enabled },
    );
  }
  privacy(id: string, view_epoch: string) {
    return this.call(
      "/v1/devices/" + encodeURIComponent(id) + "/privacy",
      "POST",
      { mode: "public", view_epoch },
    );
  }
}
// Validate a complete snapshot before publishing. No deltas or mixed streams are accepted here.
export function snapshot(raw: unknown): View {
  const frames = Array.isArray(raw)
    ? raw
    : (raw as { frames?: unknown[] })?.frames;
  if (!frames || frames.length < 2 || frames.length > 64)
    throw Error("Complete snapshot required");
  const first = frames[0] as any,
    last = frames.at(-1) as any;
  if (
    first.type !== "snapshot.begin" ||
    last.type !== "snapshot.end" ||
    !first.stream_id ||
    !first.view_epoch ||
    !Number.isSafeInteger(first.revision)
  )
    throw Error("Invalid snapshot boundaries");
  const meta = first.payload;
  if (
    !meta ||
    typeof meta.snapshot_id !== "string" ||
    !Number.isInteger(meta.page_count) ||
    meta.page_count < 1 ||
    meta.page_count > 32 ||
    frames.length !== meta.page_count + 2 ||
    last.payload?.snapshot_id !== meta.snapshot_id
  )
    throw Error("Snapshot page count or identity mismatch");
  const tasks: Task[] = [];
  let usage: Record<string, unknown> | null = null;
  let updated: string | null = null;
  let inboxCount = 0;
  for (const [index, f] of (frames as any[]).entries()) {
    if (
      f.v !== 1 ||
      utf8Bytes(JSON.stringify(f)) > 4096 ||
      f.stream_id !== first.stream_id ||
      f.view_epoch !== first.view_epoch ||
      f.revision !== first.revision
    )
      throw Error("Mixed or oversized snapshot view");
    if (index > 0 && index < frames.length - 1) {
      if (
        f.type !== "snapshot.page" ||
        f.payload?.snapshot_id !== meta.snapshot_id ||
        f.payload.page !== index - 1 ||
        !Array.isArray(f.payload.tasks) ||
        f.payload.tasks.length > 4 ||
        !Array.isArray(f.payload.inbox)
      )
        throw Error("Missing or invalid snapshot page");
      tasks.push(...f.payload.tasks);
      inboxCount += f.payload.inbox.length;
      if (f.payload.usage) usage = f.payload.usage;
      if (f.payload.source)
        updated = f.payload.source.source_updated_at ?? null;
    }
  }
  if (
    tasks.length !== meta.task_count ||
    inboxCount !== meta.inbox_count ||
    inboxCount > 8 ||
    tasks.length > 16 ||
    new Set(tasks.map((t) => t.id)).size !== tasks.length ||
    tasks.some(
      (t) =>
        typeof t.id !== "string" ||
        typeof t.state !== "string" ||
        (t.title !== undefined && typeof t.title !== "string"),
    )
  )
    throw Error("Invalid task summaries");
  return {
    tasks,
    usage,
    source_updated_at: updated,
    stream_id: first.stream_id,
    view_epoch: first.view_epoch,
    revision: first.revision,
  };
}
