// Local-network mode for Wi-Fi devices and phones, without fixed IP addresses.
//
//   node src/lan.mjs CONFIG enable|refresh|disable|status|check
//   node src/lan.mjs CONFIG pair-qr
//
// Devices and phones reach the bridge by this computer's Bonjour name
// (<LocalHostName>.local): the device verifies the certificate name
// (server_name, agentpet.local) and the phone pins the certificate fingerprint,
// so neither depends on the current IP. The bridge itself must bind an explicit
// address, so `refresh` re-detects the private LAN IPv4 on every start; with no
// LAN address it falls back to loopback (USB keeps working). Run enable/refresh/
// disable while the bridge is stopped. pair-qr prints a QR for the phone app and
// never prints the token as text.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces, hostname } from "node:os";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function isPrivateIPv4(address) {
  const o = String(address).split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
}

// Prefer the usual Wi-Fi/Ethernet interfaces, then any other private IPv4.
export function lanAddress(interfaces = networkInterfaces()) {
  const names = Object.keys(interfaces).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of names)
    for (const entry of interfaces[name] ?? [])
      if (entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address)) return entry.address;
  return null;
}
function rank(name) {
  if (/^(en0|wlan0|wlp|eth0|enp)/.test(name)) return 0;
  if (/^(en|eth|wl)/.test(name)) return 1;
  if (/^(utun|tun|tap|bridge|vmnet|docker|veth|awdl|llw)/.test(name)) return 9;
  return 5;
}

export function bonjourName() {
  let name = "";
  try {
    name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
  } catch {
    name = hostname().replace(/\.local$/i, "");
  }
  if (!/^[A-Za-z0-9-]{1,63}$/.test(name)) throw new Error("bonjour_name");
  return `${name}.local`;
}

export function displayName() {
  try {
    return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim().slice(0, 48);
  } catch {
    return hostname().slice(0, 48);
  }
}

const marker = (configPath) => join(dirname(configPath), "lan.enabled");
export const lanEnabled = (configPath) => existsSync(marker(configPath));

// Rewrite bind/endpoint/time URL for the current network. Returns what changed.
export function applyNetwork(config, { lan, host, address }) {
  const next = { ...config };
  if (lan && address) {
    next.bind = address;
    next.public_endpoint = `wss://${host}:${config.port}/v1/device`;
    next.time_bootstrap_url = `http://${host}:${config.time_port}/v1/time`;
  } else {
    next.bind = "127.0.0.1";
    next.public_endpoint = `wss://127.0.0.1:${config.port}/v1/device`;
    next.time_bootstrap_url = `http://127.0.0.1:${config.time_port}/v1/time`;
  }
  const changed = ["bind", "public_endpoint", "time_bootstrap_url"].some((k) => next[k] !== config[k]);
  return { config: next, changed };
}

function save(configPath, config) {
  const temp = configPath + ".tmp";
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, configPath);
}

export function certificatePin(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const pem = readFileSync(resolve(dirname(configPath), config.tls_cert), "utf8");
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

export function pairPayload(configPath, { host = bonjourName(), address = lanAddress(), name = displayName() } = {}) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const credentials = JSON.parse(readFileSync(resolve(dirname(configPath), config.credentials), "utf8"));
  const payload = {
    v: "agentpet-pair-v1",
    origin: `https://${host}:${config.port}`,
    ...(address ? { origin_ip: `https://${address}:${config.port}` } : {}),
    token: credentials.controller_credential,
    pin: certificatePin(configPath),
    name,
  };
  return payload;
}

function main(argv) {
  const configPath = resolve(argv[0] ?? ".agent-pet/config.json");
  const op = argv[1] ?? "status";
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (op === "pair-qr") {
    return import("qrcode").then(({ default: qrcode }) =>
      qrcode.toString(JSON.stringify(pairPayload(configPath)), { type: "terminal", small: true, errorCorrectionLevel: "L" }).then((art) => {
        process.stdout.write(art);
      }),
    );
  }
  if (op === "enable") writeFileSync(marker(configPath), "1\n", { mode: 0o600 });
  if (op === "disable" && existsSync(marker(configPath))) unlinkSync(marker(configPath));
  const lan = lanEnabled(configPath);
  const address = lan ? lanAddress() : null;
  const host = lan ? bonjourName() : null;
  if (op === "status" || op === "check") {
    const wanted = applyNetwork(config, { lan, host, address }).config.bind;
    console.log(JSON.stringify({ lan, bind: config.bind, endpoint: config.public_endpoint, stale: wanted !== config.bind }));
    return;
  }
  const { config: next, changed } = applyNetwork(config, { lan, host, address });
  if (changed) save(configPath, next);
  console.log(JSON.stringify({ lan, bind: next.bind, host, changed, offline: lan && !address }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
