import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { isIP } from "node:net";
import { Store, secret } from "./security.mjs";
import { id } from "./model.mjs";
const dir = resolve(process.argv[2] ?? ".agent-pet");
const args = process.argv.slice(3);
let lanIp = null;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--lan-ip")
    throw new Error("Use --lan-ip PRIVATE_IPV4");
  lanIp = args[1];
  const octets = lanIp.split(".").map(Number);
  if (
    isIP(lanIp) !== 4 ||
    !(
      octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    )
  )
    throw new Error("Select a private IPv4 LAN address");
}
const host = lanIp ?? "127.0.0.1";
if (existsSync(join(dir, "config.json")))
  throw new Error("Configuration exists; refusing to overwrite credentials");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const privateFile = (name, data) =>
  writeFileSync(join(dir, name), data, { mode: 0o600, flag: "wx" });
const result = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-sha256",
    "-nodes",
    "-days",
    "365",
    "-subj",
    "/CN=agentpet.local",
    "-addext",
    `subjectAltName=DNS:agentpet.local,DNS:localhost,IP:127.0.0.1${lanIp ? ",IP:" + lanIp : ""}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    join(dir, "tls-key.pem"),
    "-out",
    join(dir, "tls-cert.pem"),
  ],
  { stdio: "pipe" },
);
if (result.status !== 0)
  throw new Error(
    "OpenSSL certificate creation failed; install OpenSSL with req -addext support",
  );
chmodSync(join(dir, "tls-key.pem"), 0o600);
const pair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
privateFile("signing-key.pem", pair.privateKey);
privateFile("signing-public.pem", pair.publicKey);
const store = new Store(join(dir, "store.json")),
  account_id = "local",
  source_id = "magpie",
  device_id = "passport-1";
const source_credential = store.issue({
    account_id,
    role: "source",
    source_id,
    ttl: 86400 * 30,
  }),
  controller_credential = store.issue({
    account_id,
    role: "controller",
    ttl: 86400 * 30,
  });
store.data.devices.push({
  id: device_id,
  account_id,
  source_id,
  remote_enabled: false,
  view_epoch: id(),
  mode: "private",
  revoked: false,
});
store.save();
const device_credential = store.issue({
  account_id,
  role: "device",
  device_id,
  source_id,
  ttl: 86400 * 30,
});
privateFile(
  "credentials.json",
  JSON.stringify(
    {
      account_id,
      source_id,
      device_id,
      source_credential,
      controller_credential,
      device_credential,
      adapter_token: secret(),
    },
    null,
    2,
  ),
);
privateFile(
  "config.json",
  JSON.stringify(
    {
      mode: "bridge",
      bind: host,
      public_endpoint: `wss://${host}:7443/v1/device`,
      server_name: "agentpet.local",
      port: 7443,
      ipc_port: 7445,
      time_port: 7444,
      time_issuer: "agentpet-local",
      time_bootstrap_url: `http://${host}:7444/v1/time`,
      tls_key: "tls-key.pem",
      tls_cert: "tls-cert.pem",
      signing_key: "signing-key.pem",
      store: "store.json",
      credentials: "credentials.json",
    },
    null,
    2,
  ),
);
console.log(
  `Created restricted local configuration in ${dir}. Bind the selected private LAN address explicitly before device use. Credentials were not printed.`,
);
