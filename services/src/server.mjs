import https from "node:https";
import http from "node:http";
import { createPublicKey } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Model, Publication, LIMIT, id, key, frame, digest } from "./model.mjs";
import { Store, Enrollment, Actions } from "./security.mjs";
import { cachedFrames } from "./relay.mjs";

export function readJson(req, max = 16384) {
  return new Promise((resolve, reject) => {
    let bytes = 0,
      parts = [];
    req.on("data", (p) => {
      bytes += p.length;
      if (bytes > max) {
        reject(new Error("body_limit"));
        req.destroy();
      } else parts.push(p);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(new Error("json"));
      }
    });
    req.on("error", reject);
  });
}
const bearer = (req) =>
  (req.headers.authorization ?? "").replace(/^Bearer /, "");
const reply = (res, status, data) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
export function createService({
  tls,
  store = new Store(),
  mode = "bridge",
  signingKey,
  adapterToken = null,
  publicEndpoint = null,
  serverName = "agentpet.local",
  timeBootstrapUrl = null,
  issuer = "agentpet-local",
  now = Date.now,
} = {}) {
  if (!tls?.key || !tls?.cert) throw new Error("tls_required");
  const policyListeners = new Set(),
    diagnosticAccounts = new Map(),
    fallback = new Map(),
    commands = new Map(),
    capabilities = new Map(),
    models = new Map(),
    clients = new Set(),
    cache = new Map(),
    enrollment = new Enrollment(store, signingKey, { now }),
    actions = new Actions(store, { now });
  const diagnosticsFor = (account) => {
    if (!diagnosticAccounts.has(account))
      diagnosticAccounts.set(account, {
        events: { received: 0, accepted: 0, rejected: 0 },
        heartbeats: { received: 0, accepted: 0, rejected: 0 },
        rejection_categories: {},
      });
    return diagnosticAccounts.get(account);
  };
  const increment = (object, field) => {
    object[field] = Math.min(Number.MAX_SAFE_INTEGER, (object[field] ?? 0) + 1);
  };
  const modelFor = (account, source) => {
    const k = account + ":" + source;
    if (!models.has(k)) {
      const model = new Model({ now });
      const saved = store.data.normalized?.[k];
      if (saved) {
        model.tasks = new Map(saved.tasks);
        model.identities = new Map(saved.identities ?? []);
        model.records = new Map(saved.records);
        model.lastSeen = saved.lastSeen;
        try {
          model.setSourceUsage(saved.sourceUsage ?? null);
        } catch {
          model.sourceUsage = null;
        }
        model.connected = false;
      }
      models.set(k, model);
    }
    return models.get(k);
  };
  const scopedSources = (credential) => {
    let ids;
    if (credential.role === "controller")
      ids = [
        ...new Set(
          store.data.credentials
            .filter(
              (x) =>
                x.account_id === credential.account_id &&
                x.role === "source" &&
                !x.revoked &&
                x.expires > now(),
            )
            .map((x) => x.source_id),
        ),
      ];
    else if (credential.role === "device")
      ids = [store.device(credential, credential.device_id).source_id];
    else ids = credential.source_id ? [credential.source_id] : [];
    return ids.map((source_id) => {
      if (mode !== "relay")
        return {
          id: source_id,
          ...modelFor(credential.account_id, source_id).health(),
        };
      const health = store.data.devices
        .filter(
          (d) =>
            d.account_id === credential.account_id &&
            d.source_id === source_id &&
            !d.revoked &&
            d.remote_enabled &&
            (credential.role !== "device" || d.id === credential.device_id),
        )
        .flatMap((d) => {
          const cached = cache.get(`${d.account_id}:${d.id}`);
          if (
            !cached ||
            cached.view_epoch !== (d.remote_view_epoch ?? d.view_epoch) ||
            now() - cached.received_at >= 86400000
          )
            return [];
          return cachedFrames(cached, now()).flatMap((f) =>
            f.payload.source ? [f.payload.source] : [],
          );
        });
      const timestamps = health
        .map((s) => s.source_updated_at)
        .filter(Boolean)
        .sort();
      return {
        id: source_id,
        connected: health.some((s) => s.connected),
        fresh: health.some((s) => s.fresh),
        source_updated_at: timestamps.at(-1) ?? null,
      };
    });
  };
  const persistModel = (account, source, model) => {
    store.data.normalized ??= {};
    store.data.normalized[account + ":" + source] = {
      tasks: [...model.tasks],
      identities: [...model.identities],
      records: [...model.records],
      lastSeen: model.lastSeen,
      sourceUsage: model.sourceUsage,
    };
    store.save();
  };
  const clean = () => {
    for (const [k, v] of cache)
      if (now() - v.received_at >= 86400000) cache.delete(k);
    for (const [k, v] of Object.entries(store.data.actions))
      if (now() - v.created_at > 7 * 86400000) delete store.data.actions[k];
  };
  let requestWindow = now(),
    requestCount = 0;
  const server = https.createServer(
    { ...tls, minVersion: "TLSv1.2" },
    async (req, res) => {
      try {
        if (now() - requestWindow >= 1000) {
          requestWindow = now();
          requestCount = 0;
        }
        if (++requestCount > 100)
          return reply(res, 429, { error: "rate_limit" });
        if (req.headers.origin) throw new Error("origin_denied");
        const url = new URL(req.url, "https://service.invalid");
        if (
          url.pathname === "/v1/enrollment/consume" &&
          req.method === "POST"
        ) {
          const result = enrollment.consume(await readJson(req, 4096));
          const device = store.data.devices.find(
            (d) => d.id === result.device_id,
          );
          for (const notify of policyListeners) notify(device);
          for (const client of clients)
            if (client.auth?.revoked)
              client.ws.close(4003, "credential_rotated");
          return reply(res, 200, result);
        }
        const c = store.auth(bearer(req));
        if (
          url.pathname === "/v1/diagnostics" &&
          req.method === "GET" &&
          c.role === "controller"
        )
          return reply(res, 200, { adapter: diagnosticsFor(c.account_id) });
        if (
          url.pathname === "/v1/service" &&
          req.method === "GET" &&
          c.role === "controller"
        )
          return reply(res, 200, {
            enrollment_public_key_pem: createPublicKey(signingKey).export({
              type: "spki",
              format: "pem",
            }),
            public_key_pem: createPublicKey(signingKey).export({
              type: "spki",
              format: "pem",
            }),
            key_id: "enrollment-p256-v1",
            transport: mode === "relay" ? "remote" : "local",
            server_name: serverName,
            ca_pem: String(tls.cert),
            endpoint: publicEndpoint,
            time_bootstrap_url: timeBootstrapUrl,
            time_issuer: issuer,
            issuer,
            time: Math.floor(now() / 1000),
          });
        if (
          url.pathname === "/v1/devices" &&
          req.method === "GET" &&
          c.role === "controller"
        )
          return reply(res, 200, {
            devices: store.data.devices
              .filter((d) => d.account_id === c.account_id && !d.revoked)
              .map((d) => ({
                id: d.id,
                source_id: d.source_id,
                remote_enabled: d.remote_enabled,
                view_epoch:
                  mode === "relay"
                    ? (d.remote_view_epoch ?? d.view_epoch)
                    : d.view_epoch,
                mode: mode === "relay" ? (d.remote_mode ?? d.mode) : d.mode,
              })),
          });
        if (
          url.pathname === "/v1/sources" &&
          req.method === "GET" &&
          c.role === "controller"
        )
          return reply(res, 200, {
            sources: scopedSources(c),
          });
        if (
          url.pathname === "/v1/enrollment/tickets" &&
          req.method === "POST" &&
          c.role === "controller"
        )
          return reply(
            res,
            200,
            enrollment.offer(c, await readJson(req, 4096)),
          );
        if (url.pathname === "/v1/health" && req.method === "GET") {
          const sources = scopedSources(c);
          const timestamps = sources
            .map((s) => s.source_updated_at)
            .filter(Boolean)
            .sort();
          return reply(res, 200, {
            service: mode,
            source_scope:
              sources.length === 1 ? "single_source" : "any_authorized_source",
            source_id: sources.length === 1 ? sources[0].id : null,
            source: {
              connected: sources.some((s) => s.connected),
              fresh: sources.some((s) => s.fresh),
              source_updated_at: timestamps.at(-1) ?? null,
            },
            sources,
          });
        }
        const match =
          /^\/v1\/devices\/([^/]+)(?:\/(state|privacy|remote))?$/.exec(
            url.pathname,
          );
        const deviceId = match?.[1] ?? c.device_id;
        if ((match || url.pathname === "/v1/state") && deviceId) {
          const d = store.device(c, deviceId),
            cacheKey = `${d.account_id}:${d.id}`;
          if (req.method === "DELETE" && c.role === "controller") {
            store.revoke(c, d.id);
            cache.delete(cacheKey);
            for (const notify of policyListeners) notify(d);
            for (const client of clients)
              if (
                client.device?.id === d.id &&
                client.device?.account_id === d.account_id
              )
                client.ws.close(4003, "revoked");
            return reply(res, 200, { revoked: true });
          }
          if (
            req.method === "POST" &&
            match?.[2] === "privacy" &&
            c.role !== "source"
          ) {
            const body = await readJson(req, 4096);
            if (!["private", "public"].includes(body.mode))
              throw new Error("mode");
            const desiredEpoch = key(body.view_epoch),
              previousMode =
                mode === "relay" ? (d.remote_mode ?? d.mode) : d.mode,
              previousEpoch =
                mode === "relay"
                  ? (d.remote_view_epoch ?? d.view_epoch)
                  : d.view_epoch;
            if (previousMode !== body.mode && previousEpoch === desiredEpoch)
              throw new Error("new_epoch_required");
            if (mode === "relay") {
              d.remote_mode = body.mode;
              d.remote_view_epoch = desiredEpoch;
            } else {
              d.mode = body.mode;
              d.view_epoch = desiredEpoch;
            }
            cache.delete(cacheKey);
            store.save();
            for (const notify of policyListeners) notify(d);
            for (const client of clients)
              if (
                client.device?.id === d.id &&
                client.device?.account_id === d.account_id
              )
                client.ws.close(4001, "view_changed");
            return reply(res, 200, {
              view_epoch: mode === "relay" ? d.remote_view_epoch : d.view_epoch,
              mode: mode === "relay" ? d.remote_mode : d.mode,
            });
          }
          if (
            req.method === "POST" &&
            match?.[2] === "remote" &&
            c.role === "controller"
          ) {
            const b = await readJson(req, 4096);
            d.remote_enabled = b.enabled === true;
            cache.delete(cacheKey);
            store.save();
            for (const notify of policyListeners) notify(d);
            return reply(res, 200, { enabled: d.remote_enabled });
          }
          if (req.method === "GET") {
            if (mode === "relay") {
              clean();
              const cached = cache.get(cacheKey);
              if (
                !d.remote_enabled ||
                !cached ||
                cached.view_epoch !== (d.remote_view_epoch ?? d.view_epoch)
              )
                return reply(res, 503, {
                  error: "source_snapshot_unavailable",
                });
              return reply(res, 200, {
                frames: cachedFrames(cached, now()),
                source_fresh: cachedFrames(cached, now()).some(
                  (f) => f.payload.source?.fresh === true,
                ),
                relay_received_at: cached.received_at,
              });
            }
            const index = url.searchParams.get("frame");
            let frozen = fallback.get(cacheKey);
            if (
              index === null ||
              index === "0" ||
              !frozen ||
              now() - frozen.created >= 10000 ||
              frozen.view_epoch !== d.view_epoch
            ) {
              const p = new Publication(d.view_epoch);
              frozen = {
                created: now(),
                view_epoch: d.view_epoch,
                frames: p.snapshot(
                  modelFor(d.account_id, d.source_id).projection({
                    publicMode: d.mode === "public",
                  }),
                ),
              };
              fallback.set(cacheKey, frozen);
            }
            return reply(
              res,
              200,
              index === null
                ? { frames: frozen.frames }
                : (frozen.frames[Number(index)] ?? { error: "frame_index" }),
            );
          }
        }
        reply(res, 404, { error: "not_found" });
      } catch (e) {
        reply(
          res,
          ["unauthorized", "forbidden", "origin_denied"].includes(e.message)
            ? 403
            : 400,
          {
            error: [
              "unauthorized",
              "forbidden",
              "expired",
              "invalid_proof",
              "device_already_bound",
            ].includes(e.message)
              ? e.message
              : "invalid_request",
          },
        );
      }
    },
  );
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.maxConnections = 64;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMIT,
    maxFragments: 16,
    maxBufferedChunks: 64,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/device") {
      if (mode !== "relay" || req.url !== "/v1/relay") socket.destroy();
      return;
    }
    if (req.headers.origin || clients.size >= 32) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  const send = (client, f) => {
    if (
      client.ws.bufferedAmount + Buffer.byteLength(JSON.stringify(f)) >
      65536
    ) {
      client.ws.close(4008, "resync_required");
      return;
    }
    if (client.ws.readyState === WebSocket.OPEN)
      client.ws.send(JSON.stringify(f));
  };
  wss.on("connection", (ws) => {
    const client = { ws, auth: null, device: null, pub: null, hello: null },
      timeout = setTimeout(() => ws.close(4003, "auth_timeout"), 5000);
    clients.add(client);
    ws.on("close", () => {
      clearTimeout(timeout);
      clients.delete(client);
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.v !== 1) throw new Error("version");
        if (m.type === "hello" && !client.auth) {
          client.hello = m.payload;
          key(client.hello.device_id);
          key(client.hello.view_epoch);
          return;
        }
        if (m.type === "auth" && !client.auth) {
          const c = store.auth(m.payload.credential, ["device"]);
          if (!client.hello || c.device_id !== client.hello.device_id)
            throw new Error("auth");
          if (mode === "relay") throw new Error("relay_read_api_only");
          const authorizedDevice = store.device(c, c.device_id);
          client.device = authorizedDevice;
          client.device.view_epoch = client.hello.view_epoch;
          if (client.hello.public_mode === true) client.device.mode = "public";
          client.pub = new Publication(client.hello.view_epoch);
          client.auth = c;
          clearTimeout(timeout);
          send(
            client,
            frame("welcome", client.pub, 0, {
              capabilities: [],
              limits: { message_bytes: 4096, tasks: 16, inbox: 8 },
              source: modelFor(c.account_id, client.device.source_id).health(),
            }),
          );
          for (const f of client.pub.snapshot(
            modelFor(c.account_id, client.device.source_id).projection({
              publicMode: client.device.mode === "public",
            }),
          ))
            send(client, f);
          return;
        }
        if (
          !client.auth ||
          client.auth.revoked ||
          client.auth.expires < now() ||
          client.device.revoked
        )
          throw new Error("auth");
        if (m.type === "resync")
          for (const f of client.pub.snapshot(
            modelFor(
              client.auth.account_id,
              client.device.source_id,
            ).projection({ publicMode: client.device.mode === "public" }),
          ))
            send(client, f);
        else if (m.type === "view.configure") {
          const mode = m.payload.mode;
          if (!["public", "private"].includes(mode)) throw new Error("mode");
          client.device.mode = mode;
          client.device.view_epoch = key(m.payload.view_epoch);
          client.pub = new Publication(client.device.view_epoch);
          cache.delete(`${client.device.account_id}:${client.device.id}`);
          store.save();
          send(
            client,
            frame("view.ready", client.pub, 0, {
              mode,
              view_epoch: client.pub.view_epoch,
            }),
          );
          for (const f of client.pub.snapshot(
            modelFor(
              client.auth.account_id,
              client.device.source_id,
            ).projection({ publicMode: mode === "public" }),
          ))
            send(client, f);
        } else if (m.type === "action.prepare") {
          const target = modelFor(
            client.auth.account_id,
            client.device.source_id,
          ).tasks.get(m.payload.target_id);
          if (
            !target ||
            !capabilities.get(
              client.auth.account_id + ":" + client.device.source_id,
            ) ||
            !modelFor(client.auth.account_id, client.device.source_id).health()
              .fresh ||
            client.device.mode === "public"
          )
            throw new Error("unsupported");
          send(
            client,
            frame(
              "action.offer",
              client.pub,
              client.pub.revision,
              actions.prepare(client.auth, target, "open_on_host"),
            ),
          );
        } else if (m.type === "action") {
          const target = modelFor(
            client.auth.account_id,
            client.device.source_id,
          ).tasks.get(m.payload.target_id);
          if (
            !target ||
            !capabilities.get(
              client.auth.account_id + ":" + client.device.source_id,
            ) ||
            !modelFor(client.auth.account_id, client.device.source_id).health()
              .fresh ||
            client.device.mode === "public"
          )
            throw new Error("unsupported");
          actions
            .execute(
              client.auth,
              m.payload,
              target,
              () =>
                new Promise((resolve) => {
                  send(
                    client,
                    frame("action.result", client.pub, client.pub.revision, {
                      action_id: m.payload.action_id,
                      status: "accepted",
                    }),
                  );
                  const command_id = id(),
                    timeout = setTimeout(() => {
                      commands.delete(command_id);
                      resolve({ confirmed: false });
                    }, 30000);
                  timeout.unref();
                  commands.set(command_id, {
                    command_id,
                    type: "open_on_host",
                    session_id: modelFor(
                      client.auth.account_id,
                      client.device.source_id,
                    ).identities.get(target.id)?.session_id,
                    account_id: client.auth.account_id,
                    source_id: client.device.source_id,
                    resolve,
                    timeout,
                  });
                }),
            )
            .then((result) =>
              send(
                client,
                frame("action.result", client.pub, client.pub.revision, {
                  action_id: m.payload.action_id,
                  status: result.status,
                }),
              ),
            )
            .catch(() =>
              send(
                client,
                frame("action.result", client.pub, client.pub.revision, {
                  action_id: m.payload.action_id,
                  status: "conflict",
                }),
              ),
            );
        } else if (m.type === "action.query") {
          const r =
            store.data.actions[
              `${client.auth.account_id}:${client.auth.device_id}:${m.payload.action_id}`
            ];
          send(
            client,
            frame("action.result", client.pub, client.pub.revision, {
              action_id: m.payload.action_id,
              status: r?.status ?? "unknown",
            }),
          );
        } else if (m.type !== "ack" && m.type !== "device.status")
          throw new Error("unsupported");
      } catch {
        ws.close(4003, "protocol_or_auth");
      }
    });
  });
  const timer = setInterval(() => {
    clean();
    for (const c of clients) {
      if (!c.auth) continue;
      if (c.auth.revoked || c.auth.expires < now() || c.device.revoked) {
        c.ws.close(4003, "revoked");
        continue;
      }
      const model = modelFor(c.auth.account_id, c.device.source_id);
      for (const f of c.pub.update(
        model.projection({ publicMode: c.device.mode === "public" }),
      ))
        send(c, f);
      send(c, c.pub.heartbeat(model.health()));
    }
  }, 1000);
  timer.unref();
  const ipc = http.createServer(async (req, res) => {
    let diagnostic = null,
      counterGroup = null;
    try {
      if (req.headers.origin || !adapterToken || bearer(req) !== adapterToken)
        throw new Error("unauthorized");
      const b =
        req.method === "GET"
          ? { source_credential: req.headers["x-source-credential"] }
          : await readJson(req);
      const c = store.auth(b.source_credential, ["source"]),
        model = modelFor(c.account_id, c.source_id),
        sourceKey = c.account_id + ":" + c.source_id;
      if (
        req.method === "POST" &&
        ["/v1/events", "/v1/source/heartbeat"].includes(req.url)
      ) {
        diagnostic = diagnosticsFor(c.account_id);
        counterGroup =
          diagnostic[req.url === "/v1/events" ? "events" : "heartbeats"];
        increment(counterGroup, "received");
      }
      if (req.method === "GET" && req.url === "/v1/commands")
        return reply(res, 200, {
          commands: [...commands.values()]
            .filter(
              (x) =>
                x.account_id === c.account_id && x.source_id === c.source_id,
            )
            .map(({ command_id, type, session_id }) => ({
              command_id,
              type,
              session_id,
            })),
        });
      if (req.method !== "POST") throw new Error("method");
      if (req.url === "/v1/source/heartbeat") {
        if (b.usage !== undefined) model.setSourceUsage(b.usage);
        model.connected = b.connected === true;
        model.lastSeen = now();
        if (b.usage !== undefined) persistModel(c.account_id, c.source_id, model);
        if (!model.connected) capabilities.set(sourceKey, false);
        increment(counterGroup, "accepted");
        return reply(res, 200, { accepted: true });
      }
      if (req.url === "/v1/commands/result") {
        const command = commands.get(b.command_id);
        if (
          !command ||
          command.account_id !== c.account_id ||
          command.source_id !== c.source_id
        )
          throw new Error("command");
        if (!["succeeded", "failed", "unknown"].includes(b.status))
          throw new Error("command_status");
        clearTimeout(command.timeout);
        commands.delete(b.command_id);
        command.resolve({
          confirmed: b.status === "succeeded",
          failed: b.status === "failed",
        });
        return reply(res, 200, { accepted: true });
      }
      if (req.url !== "/v1/events" || b.event.source_id !== c.source_id)
        throw new Error("forbidden");
      const staged = new Model({ now });
      staged.tasks = new Map(model.tasks);
      staged.identities = new Map(model.identities);
      staged.records = new Map(model.records);
      staged.lastSeen = model.lastSeen;
      staged.connected = model.connected;
      staged.ingest(b.event);
      if (b.event.usage) {
        const u = b.event.usage;
        if (
          u.kind !== "session_total" ||
          u.accounting !== "dsh-token-meter@0.2.2-rc.1" ||
          u.coverage !== "loaded_session"
        )
          throw new Error("usage");
        const { counter } = await import("./model.mjs");
        const tokens = [
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ]
          .reduce((sum, k) => sum + BigInt(counter(u[k])), 0n)
          .toString();
        staged.meter({
          id: "usage:" + digest([c.source_id, b.event.session_id]).slice(0, 48),
          revision: u.revision,
          tokens,
        });
      }
      model.tasks = staged.tasks;
      model.identities = staged.identities;
      model.records = staged.records;
      model.lastSeen = staged.lastSeen;
      model.connected = staged.connected;
      capabilities.set(sourceKey, b.event.capabilities?.open_on_host === true);
      persistModel(c.account_id, c.source_id, model);
      increment(counterGroup, "accepted");
      reply(res, 200, { accepted: true });
    } catch (error) {
      const known = new Set([
        "invalid_identity",
        "invalid_revision",
        "invalid_counter",
        "usage",
        "task_capacity",
        "meter_capacity",
        "source_usage",
        "forbidden",
        "unauthorized",
      ]);
      const code = known.has(error.message) ? error.message : "invalid_event";
      if (counterGroup) {
        increment(counterGroup, "rejected");
        increment(diagnostic.rejection_categories, code);
      }
      reply(res, 403, { error: "adapter_rejected", code });
    }
  });
  return {
    server,
    ipc,
    store,
    models,
    cache,
    enrollment,
    actions,
    modelFor,
    policyListeners,
    close: async () => {
      clearInterval(timer);
      for (const command of commands.values()) {
        clearTimeout(command.timeout);
        command.resolve({ confirmed: false });
      }
      commands.clear();
      for (const c of clients) c.ws.terminate();
      await new Promise((r) => wss.close(r));
      await Promise.all(
        [server, ipc].map(
          (s) => new Promise((r) => (s.listening ? s.close(r) : r())),
        ),
      );
    },
  };
}
