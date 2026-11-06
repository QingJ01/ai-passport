import { utf8Bytes } from "./provisioning.ts";
import { serviceURL } from "./relay.ts";
import { PIN_PATTERN } from "./transport.ts";
export const PAIRING_VERSION = "agentpet-pair-v1";
// Scanned from the computer: everything the phone needs to reach the local bridge.
export interface ComputerPairing {
  origin: string;
  origin_ip?: string;
  token: string;
  pin: string;
  name: string;
}
const KEYS = new Set(["v", "origin", "origin_ip", "token", "pin", "name"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function origin(value: unknown, ipOnly: boolean) {
  if (typeof value !== "string" || value.length > 256)
    throw Error("Pairing code has an invalid computer address");
  let normalized: string;
  try {
    normalized = serviceURL(value);
  } catch {
    throw Error("Pairing code has an invalid computer address");
  }
  const host = new URL(normalized).hostname;
  if (!host || (ipOnly && !IPV4.test(host) && !/^\[[0-9a-f:.]+\]$/i.test(host)))
    throw Error("Pairing code has an invalid computer address");
  return normalized;
}
function displayName(value: unknown) {
  if (typeof value !== "string")
    throw Error("Pairing code has no computer name");
  const name = value.trim();
  if (
    !name ||
    [...name].length > 64 ||
    utf8Bytes(name) > 192 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)
  )
    throw Error("Pairing code has an invalid computer name");
  return name;
}
export function isPairingText(raw: string) {
  return raw.includes(PAIRING_VERSION);
}
export function parsePairing(raw: string): ComputerPairing {
  if (typeof raw !== "string" || raw.length > 2048)
    throw Error("Pairing code is too large");
  let q: Record<string, unknown>;
  try {
    q = JSON.parse(raw);
  } catch {
    throw Error("Scan the pairing code shown on your computer");
  }
  if (!q || typeof q !== "object" || Array.isArray(q))
    throw Error("Scan the pairing code shown on your computer");
  if (q.v !== PAIRING_VERSION)
    throw Error(
      "Unsupported pairing code version. Update the app or the computer.",
    );
  if (Object.keys(q).some((k) => !KEYS.has(k)))
    throw Error("Pairing code has unexpected fields");
  if (typeof q.token !== "string" || !TOKEN.test(q.token))
    throw Error("Pairing code has an invalid access credential");
  if (typeof q.pin !== "string" || !PIN_PATTERN.test(q.pin))
    throw Error("Pairing code has an invalid certificate fingerprint");
  const result: ComputerPairing = {
    origin: origin(q.origin, false),
    token: q.token,
    pin: q.pin,
    name: displayName(q.name),
  };
  if (q.origin_ip !== undefined && q.origin_ip !== null)
    result.origin_ip = origin(q.origin_ip, true);
  return result;
}
// Secure storage record. Version 1 (manual entry) had only origin and token.
export interface StoredConnection {
  origin: string;
  origin_ip?: string;
  token: string;
  pin?: string;
  name?: string;
}
export function encodeStored(c: StoredConnection) {
  return JSON.stringify({
    v: 2,
    origin: c.origin,
    origin_ip: c.origin_ip ?? null,
    token: c.token,
    pin: c.pin ?? null,
    name: c.name ?? null,
  });
}
export function decodeStored(raw: string): StoredConnection {
  const c = JSON.parse(raw);
  if (!c || typeof c !== "object" || typeof c.token !== "string" || !c.token)
    throw Error("Saved connection is damaged. Scan the computer again.");
  const out: StoredConnection = {
    origin: serviceURL(c.origin),
    token: c.token,
  };
  if (c.origin_ip) out.origin_ip = serviceURL(c.origin_ip);
  if (c.pin !== undefined && c.pin !== null) {
    if (typeof c.pin !== "string" || !PIN_PATTERN.test(c.pin))
      throw Error("Saved connection is damaged. Scan the computer again.");
    out.pin = c.pin;
  }
  if (typeof c.name === "string" && c.name) out.name = c.name;
  return out;
}
// Pick the source for enrollment. An already-owned device keeps its source; a single source is
// chosen automatically. Returns null when the user has to choose between several.
export function chooseSource(
  sources: { id: string }[],
  devices: { id: string; source_id: string }[],
  deviceId: string | undefined,
  selected: string,
): string | null {
  const owned = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
  if (owned) return owned.source_id;
  if (selected && sources.some((s) => s.id === selected)) return selected;
  if (sources.length === 1) return sources[0].id;
  if (!sources.length)
    throw Error(
      "No authorized source yet. Keep tools/agent_pet_up.sh running on the computer and try again.",
    );
  return null;
}
