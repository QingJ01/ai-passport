// Keep a single-computer Agent Pet setup working without manual steps.
//
//   node src/renew.mjs CONFIG [--days N] [--magpie FILE]
//
// Run while the bridge is STOPPED (it keeps the credential store in memory).
// Renews the local source, controller and device credentials that expire within
// N days (default 10), revokes the replaced ones, prunes long-expired records and
// writes the Magpie connection file (0600) from the current credentials. Prints
// one JSON line with what changed; never prints a credential.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Store } from "./security.mjs";

const TTL = 86400 * 30;
const ROLES = { source_credential: "source", controller_credential: "controller", device_credential: "device" };
const hash = (token) => createHash("sha256").update(token).digest("hex");

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

export function renew({ configPath, days = 10, magpiePath, now = Date.now() }) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const base = dirname(configPath);
  const store = new Store(resolve(base, config.store));
  const credentialsPath = resolve(base, config.credentials);
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const renewed = [];
  let soonest = Infinity;
  for (const [field, role] of Object.entries(ROLES)) {
    const token = credentials[field];
    if (typeof token !== "string") continue;
    const record = store.data.credentials.find((c) => c.hash === hash(token));
    const left = record && !record.revoked ? record.expires - now : -1;
    if (left > days * 86400000) {
      soonest = Math.min(soonest, left);
      continue;
    }
    credentials[field] = store.issue({
      account_id: credentials.account_id,
      role,
      source_id: role === "controller" ? null : credentials.source_id,
      device_id: role === "device" ? credentials.device_id : null,
      ttl: TTL,
    });
    if (record) record.revoked = true;
    renewed.push(role);
    soonest = Math.min(soonest, TTL * 1000);
  }
  // Drop records that expired more than a week ago; keeps the store bounded.
  const before = store.data.credentials.length;
  store.data.credentials = store.data.credentials.filter((c) => c.expires > now - 7 * 86400000);
  if (renewed.length || store.data.credentials.length !== before) store.save();
  if (renewed.length) writePrivate(credentialsPath, credentials);
  let magpie = null;
  if (magpiePath) {
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(magpiePath, "utf8"));
    } catch {
      previous = {};
    }
    const next = {
      bridgeUrl: `http://127.0.0.1:${config.ipc_port}`,
      sourceId: credentials.source_id,
      ipcToken: credentials.adapter_token,
      sourceToken: credentials.source_credential,
      // Only the optional in-agent plugin reads this list; the Magpie source ignores it.
      sessionIds: Array.isArray(previous.sessionIds) && previous.sessionIds.length ? previous.sessionIds : ["none"],
    };
    if (JSON.stringify(previous) !== JSON.stringify(next) || !existsSync(magpiePath)) {
      writePrivate(magpiePath, next);
      magpie = "written";
    } else magpie = "unchanged";
  }
  return { renewed, days_left: Number.isFinite(soonest) ? Math.floor(soonest / 86400000) : null, magpie };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const configPath = resolve(args[0] ?? ".agent-pet/config.json");
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const result = renew({
    configPath,
    days: Number(option("--days", 10)),
    magpiePath: option("--magpie", join(homedir(), ".config/agent-pet/magpie.json")),
  });
  console.log(JSON.stringify(result));
}
