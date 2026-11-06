import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseSource,
  decodeStored,
  encodeStored,
  isPairingText,
  parsePairing,
} from "../src/pairing.ts";
import { Relay } from "../src/relay.ts";
import { TransportError } from "../src/transport.ts";
import { friendly, OFFLINE, PIN_MISMATCH } from "../src/friendly.ts";
const pin = "0123456789abcdef".repeat(4);
const token = "A".repeat(20) + "b".repeat(20) + "_-9";
const good = {
  v: "agentpet-pair-v1",
  origin: "https://studio-mac.local:7443",
  origin_ip: "https://192.168.1.20:7443",
  token,
  pin,
  name: "Qing 的 MacBook",
};
test("computer pairing QR parses the exact v1 contract", () => {
  assert.equal(token.length, 43);
  const text = JSON.stringify(good);
  assert.ok(isPairingText(text));
  assert.deepEqual(parsePairing(text), {
    origin: good.origin,
    origin_ip: good.origin_ip,
    token,
    pin,
    name: good.name,
  });
  const { origin_ip: _ip, ...withoutIp } = good;
  assert.equal(parsePairing(JSON.stringify(withoutIp)).origin_ip, undefined);
  assert.equal(
    parsePairing(
      JSON.stringify({ ...good, origin: "https://Studio-Mac.local:7443/" }),
    ).origin,
    "https://studio-mac.local:7443",
  );
});
test("computer pairing QR rejects anything outside the contract", () => {
  const bad: Record<string, unknown>[] = [
    { v: "agentpet-pair-v2" },
    { v: "agentpet-v1" },
    { origin: "http://studio-mac.local:7443" },
    { origin: "https://user:pw@studio-mac.local:7443" },
    { origin: "https://studio-mac.local:7443/path" },
    { origin: "https://studio-mac.local:7443/?x=1" },
    { origin: 7443 },
    { origin_ip: "http://192.168.1.20:7443" },
    { origin_ip: "https://not-an-ip.local:7443" },
    { origin_ip: "https://192.168.1.256:7443" },
    { token: token.slice(1) },
    { token: token + "x" },
    { token: token.slice(0, 42) + "=" },
    { token: token.slice(0, 42) + "+" },
    { pin: pin.toUpperCase() },
    { pin: pin.slice(1) },
    { pin: pin.slice(0, 63) + "g" },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(65) },
    { name: "evil\nname" },
    { name: 5 },
    { extra: "field" },
  ];
  for (const change of bad)
    assert.throws(
      () => parsePairing(JSON.stringify({ ...good, ...change })),
      undefined,
      JSON.stringify(change),
    );
  for (const key of ["v", "origin", "token", "pin", "name"]) {
    const missing: Record<string, unknown> = { ...good };
    delete missing[key];
    assert.throws(() => parsePairing(JSON.stringify(missing)), undefined, key);
  }
  for (const raw of [
    "",
    "null",
    "[]",
    "not json",
    '"agentpet-pair-v1"',
    "x".repeat(4096),
  ])
    assert.throws(() => parsePairing(raw));
});
test("secure storage keeps the pin and accepts legacy manual records", () => {
  const stored = encodeStored(parsePairing(JSON.stringify(good)));
  assert.deepEqual(decodeStored(stored), {
    origin: good.origin,
    origin_ip: good.origin_ip,
    token,
    pin,
    name: good.name,
  });
  assert.deepEqual(
    decodeStored(
      JSON.stringify({ origin: "https://relay.example", token: "t" }),
    ),
    { origin: "https://relay.example", token: "t" },
  );
  assert.throws(() => decodeStored(JSON.stringify({ ...good, pin: "bad" })));
  assert.throws(() =>
    decodeStored(JSON.stringify({ ...good, origin: "http://x" })),
  );
});
test("a single source is chosen automatically; several need a choice", () => {
  const one = [{ id: "mac" }];
  const two = [{ id: "mac" }, { id: "server" }];
  assert.equal(chooseSource(one, [], "dev", ""), "mac");
  assert.equal(chooseSource(two, [], "dev", ""), null);
  assert.equal(chooseSource(two, [], "dev", "server"), "server");
  assert.equal(chooseSource(two, [], "dev", "gone"), null);
  assert.equal(
    chooseSource(two, [{ id: "dev", source_id: "server" }], "dev", "mac"),
    "server",
    "an owned device keeps its source",
  );
  assert.throws(() => chooseSource([], [], "dev", ""), /No authorized source/);
});
function recorder(
  respond: (url: string, pin?: string) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({})),
) {
  const seen: { url: string; method: string; pin?: string; args: number }[] =
    [];
  const request = async (...args: [string, RequestInit?, string?]) => {
    const [url, init, p] = args;
    seen.push({
      url,
      method: init?.method ?? "GET",
      pin: p,
      args: args.length,
    });
    return respond(url, p);
  };
  return { seen, request };
}
test("the pin reaches the native transport on every bridge request", async () => {
  const { seen, request } = recorder(
    (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/v1/service")
            ? { transport: "local", endpoint: "wss://x/v1/device" }
            : url.endsWith("/v1/enrollment/consume")
              ? { device_id: "d", credential: "c" }
              : {},
        ),
      ),
  );
  const relay = new Relay(good.origin, token, request, {
    pin,
    fallbackOrigin: good.origin_ip,
  });
  await relay.devices();
  await relay.sources();
  await relay.health();
  await relay.service();
  await relay.state("d");
  await relay.ticket(
    { device_id: "d", public_key_pem: "k", nonce: "n".repeat(64) },
    "mac",
  );
  await relay.consume("ticket", "proof");
  await relay.remote("d", true);
  await relay.privacy("d", "epoch");
  await relay.revoke("d");
  assert.equal(seen.length, 10);
  for (const call of seen) {
    assert.equal(call.pin, pin, call.url);
    assert.equal(call.args, 3);
    assert.ok(call.url.startsWith(good.origin + "/v1/"), call.url);
  }
  assert.deepEqual(
    seen.map((c) => c.method),
    [
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
      "DELETE",
    ],
  );
});
test("without a pin the transport keeps OS trust (no pin argument)", async () => {
  const { seen, request } = recorder(
    () => new Response(JSON.stringify({ devices: [] })),
  );
  await new Relay("https://relay.example", "t", request).devices();
  assert.equal(seen[0].pin, undefined);
  assert.equal(seen[0].args, 2, "no pin argument is passed without a pin");
  assert.throws(
    () => new Relay("https://relay.example", "t", request, { pin: "abc" }),
    /fingerprint/,
  );
});
test("GET falls back to the LAN IP with the same pin and then stays there", async () => {
  const { seen, request } = recorder((url) => {
    if (url.startsWith(good.origin))
      throw new TransportError("network", "mDNS lookup failed");
    return new Response(JSON.stringify({ devices: [] }));
  });
  const relay = new Relay(good.origin, token, request, {
    pin,
    fallbackOrigin: good.origin_ip,
  });
  assert.deepEqual(await relay.devices(), { devices: [] });
  assert.equal(relay.address, good.origin_ip);
  assert.deepEqual(
    seen.map((c) => [c.url, c.pin]),
    [
      [good.origin + "/v1/devices", pin],
      [good.origin_ip + "/v1/devices", pin],
    ],
  );
  await relay.consume("ticket", "proof");
  assert.equal(seen.at(-1)!.url, good.origin_ip + "/v1/enrollment/consume");
  assert.equal(seen.at(-1)!.pin, pin);
});
test("a POST whose connection failed is never replayed on the other address", async () => {
  const { seen, request } = recorder(() => {
    throw new TransportError("network", "connection reset");
  });
  const relay = new Relay(good.origin, token, request, {
    pin,
    fallbackOrigin: good.origin_ip,
  });
  await assert.rejects(
    relay.consume("ticket", "proof"),
    (e) => e instanceof TransportError && e.kind === "network",
  );
  assert.equal(seen.length, 1);
});
test("certificate mismatch is reported as a pin failure after both addresses", async () => {
  const { seen, request } = recorder((url) => {
    throw url.startsWith(good.origin)
      ? new TransportError("pin", "mismatch")
      : new TransportError("network", "unreachable");
  });
  const relay = new Relay(good.origin, token, request, {
    pin,
    fallbackOrigin: good.origin_ip,
  });
  let error: unknown;
  await relay.devices().catch((e) => (error = e));
  assert.ok(error instanceof TransportError && error.kind === "pin");
  assert.equal(seen.length, 2);
  assert.equal(friendly(error), PIN_MISMATCH);
  assert.match(PIN_MISMATCH, /证书指纹不匹配/);
});
test("errors become plain Chinese, never raw codes", () => {
  assert.equal(friendly(new TransportError("network", "NETWORK")), OFFLINE);
  assert.match(OFFLINE, /同一个 Wi-Fi/);
  assert.match(
    friendly(
      Error("Setup expired. Open a new 120-second setup window on the device."),
    ),
    /二维码已过期，请在设备上重新打开/,
  );
  assert.match(
    friendly(Error("Proof of possession failed. Scan a fresh code.")),
    /二维码已过期/,
  );
  assert.match(
    friendly(Error("Session expired or access revoked")),
    /重新生成二维码/,
  );
  assert.match(
    friendly(
      Error("Wi-Fi failed. Check credentials and 2.4 GHz availability."),
    ),
    /2\.4 GHz/,
  );
  assert.match(
    friendly(Error("Scan the temporary device screen code")),
    /设备屏幕上的二维码/,
  );
  assert.match(
    friendly(Error("Scan the pairing code shown on your computer")),
    /电脑/,
  );
  for (const message of [
    "Unsupported pairing code version. Update the app or the computer.",
    "Pairing code has an invalid certificate fingerprint",
  ])
    assert.doesNotMatch(friendly(Error(message)), /[A-Za-z]{6,}/);
});
