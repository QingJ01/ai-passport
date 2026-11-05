import {
  randomBytes,
  createHash,
  createPublicKey,
  timingSafeEqual,
  sign,
  verify,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { id, key, digest } from "./model.mjs";
export const secret = () => randomBytes(32).toString("base64url");
const hash = (x) => createHash("sha256").update(x).digest("hex");
export class Store {
  constructor(path) {
    this.path = path;
    this.data = { credentials: [], devices: [], actions: {} };
    if (path) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      for (const a of Object.values(this.data.actions))
        if (a.status === "accepted") a.status = "unknown";
      this.save();
    }
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const temp = this.path + ".tmp";
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }
  issue({ account_id, role, device_id = null, source_id = null, ttl = 3600 }) {
    key(account_id);
    if (device_id !== null) key(device_id);
    if (source_id !== null) key(source_id);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400 * 30)
      throw new Error("ttl");
    if (this.data.credentials.length >= 1024)
      throw new Error("credential_limit");
    if (!["controller", "source", "device", "adapter"].includes(role))
      throw new Error("role");
    const token = secret();
    this.data.credentials.push({
      id: id(),
      hash: hash(token),
      account_id,
      role,
      device_id,
      source_id,
      expires: Date.now() + ttl * 1000,
      revoked: false,
    });
    this.save();
    return token;
  }
  auth(token, role) {
    if (typeof token !== "string" || token.length > 256)
      throw new Error("unauthorized");
    const fingerprint = Buffer.from(hash(token), "hex");
    const c = this.data.credentials.find(
      (c) =>
        timingSafeEqual(Buffer.from(c.hash, "hex"), fingerprint) &&
        !c.revoked &&
        c.expires > Date.now(),
    );
    if (!c || (role && !role.includes(c.role))) throw new Error("unauthorized");
    return c;
  }
  device(c, deviceId) {
    const d = this.data.devices.find(
      (d) => d.id === deviceId && d.account_id === c.account_id && !d.revoked,
    );
    if (
      !d ||
      (c.role === "device" && c.device_id !== d.id) ||
      (c.role === "source" && c.source_id !== d.source_id)
    )
      throw new Error("forbidden");
    return d;
  }
  revoke(c, deviceId) {
    const d = this.device(c, deviceId);
    d.revoked = true;
    for (const x of this.data.credentials)
      if (x.account_id === c.account_id && x.device_id === deviceId)
        x.revoked = true;
    this.save();
  }
}
export class Enrollment {
  constructor(store, privateKey, { now = Date.now } = {}) {
    this.store = store;
    this.privateKey = privateKey;
    this.now = now;
    this.tickets = new Map();
  }
  offer(
    c,
    { device_id, public_key_pem, nonce, source_id, operation = "enroll" },
  ) {
    if (
      c.role !== "controller" ||
      !["enroll", "rotate_credential"].includes(operation)
    )
      throw new Error("forbidden");
    key(device_id);
    key(source_id);
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("nonce");
    const pair = this.store.data.credentials.some(
      (x) =>
        x.role === "source" &&
        x.account_id === c.account_id &&
        x.source_id === source_id &&
        !x.revoked &&
        x.expires > this.now(),
    );
    if (!pair) throw new Error("forbidden");
    const bound = this.store.data.devices.find((d) => d.id === device_id);
    if (operation === "enroll" && bound)
      throw new Error("device_already_bound");
    if (
      operation === "rotate_credential" &&
      (!bound ||
        bound.revoked ||
        bound.account_id !== c.account_id ||
        bound.source_id !== source_id ||
        !bound.enrollment_key_fingerprint)
    )
      throw new Error("forbidden");
    if (typeof public_key_pem !== "string" || public_key_pem.length > 1024)
      throw new Error("public_key");
    // Reject non-P256 keys before issuing a ticket.
    const supplied = createPublicKey(public_key_pem);
    if (
      supplied.asymmetricKeyType !== "ec" ||
      supplied.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error("public_key");
    const fingerprint = createHash("sha256")
      .update(supplied.export({ type: "spki", format: "der" }))
      .digest("hex");
    if (bound && bound.enrollment_key_fingerprint !== fingerprint)
      throw new Error("forbidden");
    if (bound?.enrollment_nonces?.includes(hash(nonce)))
      throw new Error("nonce_replayed");
    for (const [k, v] of this.tickets)
      if (v.used || v.payload.expires_at < this.now()) this.tickets.delete(k);
    if (this.tickets.size >= 128) throw new Error("ticket_limit");
    const ticket = secret(),
      expires_at = this.now() + 120000;
    const payload = {
      domain: "agentpet-enroll-v1",
      ticket,
      account_id: c.account_id,
      device_id,
      source_id,
      nonce,
      public_key_pem,
      expires_at,
    };
    const canonical = JSON.stringify(payload),
      signature = sign(
        "sha256",
        Buffer.from(canonical),
        this.privateKey,
      ).toString("base64url");
    this.tickets.set(ticket, {
      payload,
      used: false,
      operation,
      fingerprint,
      controller_id: c.id ?? null,
    });
    return {
      ticket,
      payload,
      canonical,
      signature,
      key_id: "enrollment-p256-v1",
      expires_at,
    };
  }
  consume({ ticket, proof }) {
    const entry = this.tickets.get(ticket);
    if (!entry || entry.used || entry.payload.expires_at < this.now())
      throw new Error("expired");
    if (
      !verify(
        "sha256",
        Buffer.from(ticket),
        entry.payload.public_key_pem,
        Buffer.from(proof ?? "", "base64url"),
      )
    )
      throw new Error("invalid_proof");
    const p = entry.payload;
    if (
      !this.store.data.credentials.some(
        (c) =>
          c.role === "source" &&
          c.account_id === p.account_id &&
          c.source_id === p.source_id &&
          !c.revoked &&
          c.expires > this.now(),
      )
    )
      throw new Error("forbidden");
    if (
      entry.controller_id &&
      !this.store.data.credentials.some(
        (c) =>
          c.id === entry.controller_id &&
          c.role === "controller" &&
          c.account_id === p.account_id &&
          !c.revoked &&
          c.expires > this.now(),
      )
    )
      throw new Error("forbidden");
    const bound = this.store.data.devices.find((d) => d.id === p.device_id);
    if (this.store.data.credentials.length >= 1024)
      throw new Error("credential_limit");
    if (entry.operation === "rotate_credential") {
      if (
        !bound ||
        bound.revoked ||
        bound.account_id !== p.account_id ||
        bound.source_id !== p.source_id ||
        bound.enrollment_key_fingerprint !== entry.fingerprint
      )
        throw new Error("forbidden");
      if (bound.enrollment_nonces?.includes(hash(p.nonce)))
        throw new Error("nonce_replayed");
      for (const credential of this.store.data.credentials)
        if (
          credential.account_id === p.account_id &&
          credential.device_id === p.device_id
        )
          credential.revoked = true;
      bound.enrollment_nonces = [
        ...(bound.enrollment_nonces ?? []),
        hash(p.nonce),
      ].slice(-32);
    } else {
      if (bound) throw new Error("device_already_bound");
      this.store.data.devices.push({
        id: p.device_id,
        account_id: p.account_id,
        source_id: p.source_id,
        remote_enabled: false,
        view_epoch: id(),
        mode: "private",
        revoked: false,
        enrollment_key_fingerprint: entry.fingerprint,
        enrollment_nonces: [hash(p.nonce)],
      });
    }
    entry.used = true;
    return {
      device_id: p.device_id,
      credential: this.store.issue({
        account_id: p.account_id,
        device_id: p.device_id,
        source_id: p.source_id,
        role: "device",
        ttl: 86400 * 30,
      }),
    };
  }
}
export class Actions {
  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
    this.offers = new Map();
  }
  prepare(c, target, capability) {
    for (const [k, v] of this.offers)
      if (v.expires < this.now()) this.offers.delete(k);
    if (this.offers.size >= 128) throw new Error("offer_limit");
    if (capability !== "open_on_host") throw new Error("unsupported");
    const token = secret();
    this.offers.set(token, {
      account: c.account_id,
      device: c.device_id,
      target: target.id,
      revision: target.state_revision,
      expires: this.now() + 30000,
    });
    return {
      token,
      type: capability,
      target_id: target.id,
      target_revision: target.state_revision,
      expires_at: new Date(this.now() + 30000).toISOString(),
    };
  }
  async execute(c, a, target, dispatch) {
    key(a.action_id);
    key(a.device_boot_id);
    if (
      a.parameters === null ||
      typeof a.parameters !== "object" ||
      Array.isArray(a.parameters) ||
      Object.keys(a.parameters).length
    )
      throw new Error("parameters");
    const recordKey = `${c.account_id}:${c.device_id}:${a.action_id}`,
      fingerprint = digest(a);
    const existing = this.store.data.actions[recordKey];
    if (existing) {
      if (existing.hash !== fingerprint) throw new Error("conflict");
      return existing;
    }
    const offer = this.offers.get(a.token);
    if (!offer || offer.expires < this.now()) throw new Error("expired");
    if (
      offer.account !== c.account_id ||
      offer.device !== c.device_id ||
      offer.target !== target.id ||
      offer.revision !== target.state_revision ||
      a.target_revision !== offer.revision ||
      a.type !== "open_on_host"
    )
      throw new Error("conflict");
    if (
      Object.keys(this.store.data.actions).length >= 4096 ||
      Object.values(this.store.data.actions).filter(
        (r) => r.status === "accepted",
      ).length >= 4
    )
      throw new Error("action_capacity");
    const record = {
      hash: fingerprint,
      status: "accepted",
      created_at: this.now(),
    };
    this.store.data.actions[recordKey] = record;
    this.store.save();
    try {
      const result = await dispatch(a);
      record.status =
        result?.confirmed === true
          ? "succeeded"
          : result?.failed === true
            ? "failed"
            : "unknown";
    } catch {
      record.status = "failed";
    }
    this.store.save();
    return record;
  }
}
