import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { LIMIT, key, Publication } from "./model.mjs";
// Relay accepts only bridge-filtered snapshots. No arbitrary host RPC or actions.
export function validateRemoteFrames(frames, epoch) {
  if (!Array.isArray(frames) || frames.length < 3 || frames.length > 19)
    throw new Error("snapshot_bounds");
  const begin = frames[0],
    end = frames.at(-1),
    pages = frames.slice(1, -1);
  if (
    begin.type !== "snapshot.begin" ||
    end.type !== "snapshot.end" ||
    pages.length !== begin.payload.page_count ||
    begin.payload.task_count > 16 ||
    begin.payload.inbox_count !== 0 ||
    end.payload.snapshot_id !== begin.payload.snapshot_id
  )
    throw new Error("snapshot_shape");
  if (
    Object.keys(begin.payload).some(
      (k) =>
        !["snapshot_id", "page_count", "task_count", "inbox_count"].includes(k),
    ) ||
    Object.keys(end.payload).some((k) => k !== "snapshot_id")
  )
    throw new Error("remote_field");
  key(begin.stream_id);
  key(begin.view_epoch);
  key(begin.payload.snapshot_id);
  let count = 0;
  for (const f of frames) {
    if (
      Buffer.byteLength(JSON.stringify(f)) > LIMIT ||
      f.v !== 1 ||
      f.view_epoch !== epoch ||
      f.stream_id !== begin.stream_id ||
      f.revision !== begin.revision ||
      !Number.isInteger(f.revision) ||
      f.revision < 0 ||
      f.revision > 0xffffffff
    )
      throw new Error("snapshot_envelope");
    const roots = new Set([
      "v",
      "type",
      "stream_id",
      "view_epoch",
      "revision",
      "payload",
    ]);
    if (Object.keys(f).some((k) => !roots.has(k)))
      throw new Error("remote_field");
  }
  for (const [n, p] of pages.entries()) {
    if (
      p.type !== "snapshot.page" ||
      p.payload.page !== n ||
      p.payload.snapshot_id !== begin.payload.snapshot_id ||
      p.payload.tasks?.length > 4
    )
      throw new Error("snapshot_page");
    const allowed = new Set([
      "snapshot_id",
      "page",
      "tasks",
      "inbox",
      "usage",
      "source",
      "total_tasks",
    ]);
    if (Object.keys(p.payload).some((k) => !allowed.has(k)))
      throw new Error("remote_field");
    if (
      p.payload.inbox !== undefined &&
      (!Array.isArray(p.payload.inbox) || p.payload.inbox.length)
    )
      throw new Error("remote_inbox");
    if (
      p.payload.total_tasks !== undefined &&
      (!Number.isSafeInteger(p.payload.total_tasks) ||
        p.payload.total_tasks < 0)
    )
      throw new Error("remote_count");
    for (const t of p.payload.tasks ?? []) {
      count++;
      if (
        !/^task:[a-f0-9]{48}$/.test(t.id) ||
        !["turn", "goal", "job", "workflow"].includes(t.entity_kind) ||
        !Number.isSafeInteger(t.state_revision) ||
        t.state_revision < 0 ||
        !Number.isFinite(Date.parse(t.updated_at)) ||
        !["completed", "failed", "cancelled", null].includes(t.task_outcome) ||
        !["ended", null].includes(t.turn_outcome)
      )
        throw new Error("remote_task");
      if (!/^Task [0-9]{1,2}$/.test(t.title)) throw new Error("remote_title");
      const fields = new Set([
        "id",
        "title",
        "entity_kind",
        "execution_state",
        "state",
        "task_outcome",
        "turn_outcome",
        "pending_interactions",
        "state_revision",
        "updated_at",
        "available_actions",
      ]);
      if (
        Object.keys(t).some((k) => !fields.has(k)) ||
        !Array.isArray(t.available_actions) ||
        t.available_actions.length
      )
        throw new Error("remote_field");
      if (
        !["running", "idle", "queued", "unknown"].includes(t.execution_state) ||
        ![
          "queued",
          "running",
          "waiting_user",
          "completed",
          "failed",
          "cancelled",
          "unknown",
        ].includes(t.state)
      )
        throw new Error("remote_state");
      if ((t.pending_interactions ?? []).length > 4)
        throw new Error("remote_interactions");
      for (const x of t.pending_interactions ?? []) {
        key(x.request_id);
        if (
          Object.keys(x).some(
            (k) => !["request_id", "revision", "blocks_execution"].includes(k),
          ) ||
          !Number.isSafeInteger(x.revision) ||
          typeof x.blocks_execution !== "boolean"
        )
          throw new Error("remote_interactions");
      }
    }
    if (p.payload.usage) {
      const u = p.payload.usage;
      if (
        Object.keys(u).some(
          (k) =>
            ![
              "tokens",
              "provenance",
              "money",
              "scope",
              "daily_tokens",
            ].includes(k),
        ) ||
        (u.money !== undefined &&
          (!Array.isArray(u.money) || u.money.length)) ||
        (u.scope !== undefined && u.scope !== "loaded_sessions_lifetime") ||
        (u.daily_tokens !== undefined && u.daily_tokens !== null) ||
        (u.tokens !== null && typeof u.tokens !== "string") ||
        (u.tokens !== null && !/^(0|[1-9][0-9]{0,39})$/.test(u.tokens)) ||
        !["host-reduced-records", "unavailable", "hidden"].includes(
          u.provenance,
        )
      )
        throw new Error("remote_usage");
    }
    if (p.payload.source) {
      const s = p.payload.source;
      if (
        Object.keys(s).some(
          (k) => !["connected", "fresh", "source_updated_at"].includes(k),
        ) ||
        typeof s.connected !== "boolean" ||
        typeof s.fresh !== "boolean"
      )
        throw new Error("remote_source");
    }
  }
  if (count !== begin.payload.task_count) throw new Error("snapshot_count");
  return structuredClone(frames);
}
export function cachedFrames(cached, now = Date.now()) {
  return cached.frames.map((f) =>
    f.payload.source
      ? {
          ...f,
          payload: {
            ...f.payload,
            source: {
              ...f.payload.source,
              fresh:
                f.payload.source.fresh &&
                now - cached.source_updated_at < 45000,
            },
          },
        }
      : f,
  );
}
export function attachRelay(service, { now = Date.now } = {}) {
  const { server, store, cache } = service;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMIT,
    maxFragments: 16,
    maxBufferedChunks: 64,
    perMessageDeflate: false,
  });
  const peers = new Set();
  const cacheKey = (d) => `${d.account_id}:${d.id}`;
  const initialize = (d) => {
    d.remote_view_epoch ??= d.view_epoch;
    d.remote_mode ??= d.mode ?? "private";
  };
  const matching = (p, d) =>
    p.d?.id === d.id && p.d?.account_id === d.account_id;
  const cachedFor = (d) => {
    const c = cache.get(cacheKey(d));
    return c &&
      c.view_epoch === d.remote_view_epoch &&
      now() - c.received_at < 86400000
      ? c
      : null;
  };
  const send = (peer, message) => {
    if (
      peer.ws.bufferedAmount + Buffer.byteLength(JSON.stringify(message)) >
      65536
    ) {
      peer.ws.close(4008, "slow_consumer");
      return;
    }
    if (peer.ws.readyState === WebSocket.OPEN)
      peer.ws.send(JSON.stringify(message));
  };
  const control = (peer, type, payload) => {
    const cached = cachedFor(peer.d),
      base = cached?.frames[0];
    return {
      v: 1,
      type,
      stream_id: base?.stream_id ?? peer.control_stream,
      view_epoch: peer.d.remote_view_epoch,
      revision: base?.revision ?? 0,
      payload,
    };
  };
  const sourceHealth = (d) => {
    const cached = cachedFor(d);
    return cached
      ? cachedFrames(cached, now()).find((f) => f.payload.source)?.payload
          .source
      : { connected: false, fresh: false, source_updated_at: null };
  };
  const policy = (d) => ({
    mode: d.remote_mode,
    view_epoch: d.remote_view_epoch,
  });
  const notifySource = (d) => {
    for (const peer of peers)
      if (peer.c?.role === "source" && matching(peer, d)) {
        peer.stage = [];
        send(peer, control(peer, "view.configure", policy(d)));
      }
  };
  const changeView = (peer, epoch, mode) => {
    key(epoch);
    if (!["public", "private"].includes(mode)) throw new Error("mode");
    const d = peer.d;
    if (d.remote_mode !== mode && d.remote_view_epoch === epoch)
      throw new Error("new_epoch_required");
    const changed = d.remote_view_epoch !== epoch || d.remote_mode !== mode;
    if (changed) {
      cache.delete(cacheKey(d));
      d.remote_view_epoch = epoch;
      d.remote_mode = mode;
      store.save();
      for (const other of peers)
        if (other !== peer && other.c?.role === "device" && matching(other, d))
          other.ws.close(4001, "view_changed");
      notifySource(d);
    }
    peer.view_epoch = epoch;
    return changed;
  };
  const replay = (peer) => {
    const cached = cachedFor(peer.d);
    if (cached && peer.view_epoch === peer.d.remote_view_epoch)
      for (const f of cachedFrames(cached, now())) send(peer, f);
  };
  const onPolicy = (d) => {
    initialize(d);
    if (d.revoked || !d.remote_enabled) {
      cache.delete(cacheKey(d));
      for (const p of peers)
        if (matching(p, d)) p.ws.close(4003, "policy_changed");
      return;
    }
    cache.delete(cacheKey(d));
    for (const p of peers)
      if (p.c?.role === "device" && matching(p, d))
        p.ws.close(4001, "view_changed");
    notifySource(d);
  };
  service.policyListeners.add(onPolicy);
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/relay") return;
    if (req.headers.origin || peers.size >= 32) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const peer = {
      ws,
      c: null,
      d: null,
      stage: [],
      control_stream: randomUUID(),
    };
    peers.add(peer);
    const deadline = setTimeout(() => ws.close(4003, "auth_timeout"), 5000);
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(deadline);
      peers.delete(peer);
    });
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.v !== undefined && m.v !== 1) throw new Error("version");
        if (!peer.c) {
          if (m.type !== "auth") throw new Error("auth");
          const authorized = store.auth(m.payload.credential, [
            "source",
            "device",
          ]);
          const device = store.device(authorized, key(m.payload.device_id));
          if (!device.remote_enabled) throw new Error("remote_disabled");
          initialize(device);
          peer.d = device;
          peer.c = authorized;
          clearTimeout(deadline);
          if (peer.c.role === "device") {
            if (
              m.payload.public_mode !== undefined &&
              typeof m.payload.public_mode !== "boolean"
            )
              throw new Error("mode");
            changeView(
              peer,
              m.payload.view_epoch ?? peer.d.remote_view_epoch,
              m.payload.public_mode === undefined
                ? peer.d.remote_mode
                : m.payload.public_mode === true
                  ? "public"
                  : "private",
            );
          }
          send(
            peer,
            control(peer, "welcome", {
              capabilities: [],
              ...policy(peer.d),
              source: sourceHealth(peer.d),
              limits: { message_bytes: 4096, tasks: 16, inbox: 8 },
            }),
          );
          if (peer.c.role === "device") replay(peer);
          return;
        }
        if (
          peer.c.revoked ||
          peer.c.expires < now() ||
          peer.d.revoked ||
          !peer.d.remote_enabled
        )
          throw new Error("revoked");
        if (peer.c.role === "device") {
          if (m.type === "view.configure") {
            changeView(peer, m.payload.view_epoch, m.payload.mode);
            send(peer, control(peer, "view.ready", policy(peer.d)));
            replay(peer);
            return;
          }
          if (m.type === "resync") {
            replay(peer);
            if (!cachedFor(peer.d)) notifySource(peer.d);
            return;
          }
          if (["ack", "device.status"].includes(m.type)) return;
          throw new Error("read_only");
        }
        // Late old-policy frames are discarded; they cannot recreate a private cache.
        if (m.view_epoch !== peer.d.remote_view_epoch) return;
        if (m.type === "snapshot.begin") {
          peer.stage = [m];
          peer.started = now();
          return;
        }
        if (
          !peer.stage.length ||
          now() - peer.started > 10000 ||
          peer.stage.length >= 19
        )
          throw new Error("snapshot_timeout");
        peer.stage.push(m);
        if (m.type === "snapshot.end") {
          const frames = validateRemoteFrames(
              peer.stage,
              peer.d.remote_view_epoch,
            ),
            source = frames.find((f) => f.payload.source)?.payload.source;
          if (
            peer.d.remote_mode === "public" &&
            (frames[0].payload.task_count !== 0 ||
              frames.some((f) => f.payload.usage?.tokens != null))
          )
            throw new Error("public_projection");
          let sourceTime = Date.parse(source?.source_updated_at);
          if (
            source?.source_updated_at === null &&
            source.connected === false &&
            source.fresh === false
          )
            sourceTime = 0;
          if (!Number.isFinite(sourceTime) || sourceTime > now() + 5000)
            throw new Error("source_time");
          const cached = {
            frames,
            view_epoch: peer.d.remote_view_epoch,
            mode: peer.d.remote_mode,
            received_at: now(),
            source_updated_at: sourceTime,
          };
          cache.set(cacheKey(peer.d), cached);
          peer.stage = [];
          for (const p of peers)
            if (
              p.c?.role === "device" &&
              matching(p, peer.d) &&
              p.view_epoch === peer.d.remote_view_epoch
            )
              for (const f of cachedFrames(cached, now())) send(p, f);
        }
      } catch {
        ws.close(4003, "relay_rejected");
      }
    });
  });
  const timer = setInterval(() => {
    for (const [k, v] of cache)
      if (now() - v.received_at >= 86400000) cache.delete(k);
    for (const peer of peers) {
      if (!peer.c) continue;
      if (
        peer.c.revoked ||
        peer.c.expires < now() ||
        peer.d.revoked ||
        !peer.d.remote_enabled
      ) {
        peer.ws.close(4003, "revoked");
        continue;
      }
      if (
        peer.c.role === "device" &&
        (!peer.lastHeartbeat || now() - peer.lastHeartbeat >= 15000)
      ) {
        send(
          peer,
          control(peer, "heartbeat", { source: sourceHealth(peer.d) }),
        );
        peer.lastHeartbeat = now();
      }
    }
  }, 1000);
  timer.unref();
  return () => {
    service.policyListeners.delete(onPolicy);
    clearInterval(timer);
    for (const peer of peers) peer.ws.terminate();
    wss.close();
  };
}
export function publishRemote({ url, credential, device_id, model, ca }) {
  if (new URL(url).protocol !== "wss:") throw new Error("trusted_tls_required");
  let stopped = false,
    socket,
    timer,
    retry,
    authDeadline,
    attempt = 0;
  const connect = () => {
    let publication = null,
      publicMode = false;
    socket = new WebSocket(url, {
      ca,
      rejectUnauthorized: true,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      maxPayload: LIMIT,
      maxFragments: 16,
      maxBufferedChunks: 64,
    });
    const publish = () => {
      if (!publication || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 65536) {
        socket.close();
        return;
      }
      for (const f of publication.snapshot(
        model.projection({ remote: true, publicMode }),
      ))
        socket.send(JSON.stringify(f));
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "auth",
          payload: { credential, device_id },
        }),
      );
      authDeadline = setTimeout(
        () => socket.close(4003, "welcome_timeout"),
        5000,
      );
    });
    socket.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (!["welcome", "view.configure"].includes(m.type)) return;
        key(m.payload.view_epoch);
        if (!["public", "private"].includes(m.payload.mode))
          throw new Error("mode");
        clearTimeout(authDeadline);
        attempt = 0;
        publicMode = m.payload.mode === "public";
        publication = new Publication(m.payload.view_epoch);
        publish();
        clearInterval(timer);
        timer = setInterval(publish, 5000);
      } catch {
        socket.close(4003, "policy_invalid");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(authDeadline);
      clearInterval(timer);
      if (!stopped)
        retry = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) *
            (0.8 + Math.random() * 0.4),
        );
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(authDeadline);
    clearInterval(timer);
    socket?.close();
  };
}
