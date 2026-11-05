import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Store, Enrollment } from "../src/security.mjs";
const pair = () =>
  generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
test("explicit same-owner key-bound rotation revokes old credentials without enabling remote", () => {
  const s = new Store(),
    root = pair(),
    device = pair(),
    other = pair(),
    e = new Enrollment(s, root.privateKey),
    c = { account_id: "owner", role: "controller" };
  s.issue({ account_id: "owner", role: "source", source_id: "magpie" });
  s.issue({ account_id: "owner", role: "source", source_id: "other-source" });
  s.issue({ account_id: "foreign", role: "source", source_id: "magpie" });
  const base = {
    device_id: "paired",
    source_id: "magpie",
    public_key_pem: device.publicKey,
  };
  const consume = (offer) =>
    e.consume({
      ticket: offer.ticket,
      proof: sign(
        "sha256",
        Buffer.from(offer.ticket),
        device.privateKey,
      ).toString("base64url"),
    });
  const initial = consume(e.offer(c, { ...base, nonce: "a".repeat(64) })),
    bound = s.data.devices[0],
    epoch = bound.view_epoch;
  assert.equal(bound.remote_enabled, false);
  assert.throws(() => e.offer(c, { ...base, nonce: "b".repeat(64) }));
  const rotate = {
    ...base,
    operation: "rotate_credential",
    nonce: "b".repeat(64),
  };
  assert.throws(() =>
    e.offer(c, { ...rotate, public_key_pem: other.publicKey }),
  );
  assert.throws(() => e.offer(c, { ...rotate, source_id: "other-source" }));
  assert.throws(() =>
    e.offer({ account_id: "foreign", role: "controller" }, rotate),
  );
  assert.throws(() => e.offer(c, { ...rotate, nonce: "a".repeat(64) }));
  const offer = e.offer(c, rotate);
  assert.throws(() => e.consume({ ticket: offer.ticket, proof: "bad" }));
  assert(s.auth(initial.credential));
  const renewed = consume(offer);
  assert.throws(() => s.auth(initial.credential));
  assert(s.auth(renewed.credential));
  assert.equal(bound.remote_enabled, false);
  assert.equal(bound.view_epoch, epoch);
  assert.throws(() => consume(offer));
  assert.throws(() => e.offer(c, rotate));
  bound.remote_enabled = true;
  const next = consume(e.offer(c, { ...rotate, nonce: "c".repeat(64) }));
  assert.equal(bound.remote_enabled, true);
  assert.throws(() => s.auth(renewed.credential));
  assert(s.auth(next.credential));
  bound.revoked = true;
  assert.throws(() => e.offer(c, { ...rotate, nonce: "d".repeat(64) }));
});
test("legacy devices without enrolled key binding cannot silently replace trust", () => {
  const s = new Store(),
    root = pair(),
    device = pair();
  s.issue({ account_id: "owner", role: "source", source_id: "magpie" });
  s.data.devices.push({
    id: "legacy",
    account_id: "owner",
    source_id: "magpie",
    revoked: false,
  });
  const e = new Enrollment(s, root.privateKey);
  assert.throws(() =>
    e.offer(
      { account_id: "owner", role: "controller" },
      {
        device_id: "legacy",
        source_id: "magpie",
        public_key_pem: device.publicKey,
        nonce: "a".repeat(64),
        operation: "rotate_credential",
      },
    ),
  );
});
