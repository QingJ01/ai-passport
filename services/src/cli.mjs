import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createService } from "./server.mjs";
import { Store } from "./security.mjs";
import { attachRelay, publishRemote } from "./relay.mjs";
import { createTimeServer } from "./time.mjs";
const configPath = resolve(process.argv[2] ?? ".agent-pet/config.json"),
  base = dirname(configPath),
  config = JSON.parse(readFileSync(configPath, "utf8"));
const file = (p) => readFileSync(resolve(base, p), "utf8");
const credentials = JSON.parse(file(config.credentials)),
  store = new Store(resolve(base, config.store));
if (!["bridge", "relay"].includes(config.mode)) throw new Error("invalid_mode");
if (config.bind === "0.0.0.0" || config.bind === "::")
  throw new Error("Select an explicit interface address");
const service = createService({
  mode: config.mode,
  store,
  tls: { key: file(config.tls_key), cert: file(config.tls_cert) },
  signingKey: file(config.signing_key),
  adapterToken: credentials.adapter_token,
  publicEndpoint: config.public_endpoint ?? null,
  serverName: config.server_name ?? "agentpet.local",
  timeBootstrapUrl: config.time_bootstrap_url ?? null,
  issuer: config.time_issuer ?? "agentpet-local",
});
const stops = [];
let timeServer;
if (config.time_port) {
  timeServer = createTimeServer({
    bridgeId: config.time_issuer ?? "agentpet-local",
    privateKey: file(config.signing_key),
  });
  await new Promise((r, j) => {
    timeServer.once("error", j);
    timeServer.listen(config.time_port, config.bind, r);
  });
}
if (config.mode === "relay") stops.push(attachRelay(service));
await new Promise((r, j) => {
  service.server.once("error", j);
  service.server.listen(config.port, config.bind, r);
});
if (config.mode === "bridge")
  await new Promise((r, j) => {
    service.ipc.once("error", j);
    service.ipc.listen(config.ipc_port, "127.0.0.1", r);
  });
if (config.remote?.enabled === true) {
  if (config.mode !== "bridge" || !config.remote.disclosure_acknowledged)
    throw new Error("remote_opt_in_required");
  const d = store.device(
    { account_id: credentials.account_id, role: "controller" },
    credentials.device_id,
  );
  if (!config.remote.credentials_file)
    throw new Error("separate_relay_credentials_required");
  const relayCredentials = JSON.parse(file(config.remote.credentials_file));
  stops.push(
    publishRemote({
      url: config.remote.url,
      credential: relayCredentials.source_credential,
      device_id: relayCredentials.device_id ?? d.id,
      model: service.modelFor(d.account_id, d.source_id),
      ca: config.remote.ca ? file(config.remote.ca) : undefined,
    }),
  );
}
console.log(
  `Agent Pet ${config.mode} listening with TLS at ${config.bind}:${config.port}; adapter IPC loopback only.`,
);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  for (const stop of stops) stop();
  await service.close();
  if (timeServer) await new Promise((r) => timeServer.close(r));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
