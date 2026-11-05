import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Store, Enrollment } from "../src/security.mjs";
const pair = () =>
  generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
test("ticket consumption rechecks revoked source and issuing controller authorization", () => {
  for (const role of ["source", "controller"]) {
    const store = new Store(),
      root = pair(),
      device = pair();
    const source = store.auth(
      store.issue({ account_id: "owner", role: "source", source_id: "magpie" }),
    );
    const controller = store.auth(
      store.issue({ account_id: "owner", role: "controller" }),
    );
    const enrollment = new Enrollment(store, root.privateKey),
      offer = enrollment.offer(controller, {
        device_id: "device",
        source_id: "magpie",
        public_key_pem: device.publicKey,
        nonce: "a".repeat(64),
      });
    (role === "source" ? source : controller).revoked = true;
    const proof = sign(
      "sha256",
      Buffer.from(offer.ticket),
      device.privateKey,
    ).toString("base64url");
    assert.throws(
      () => enrollment.consume({ ticket: offer.ticket, proof }),
      /forbidden/,
    );
    assert.equal(store.data.devices.length, 0);
  }
});
