import test from "node:test";
import assert from "node:assert/strict";
import {
  SetupSession,
  type NativeProvisioner,
  type PairingQR,
} from "../src/provisioning.ts";
import {
  bars,
  failureText,
  hotspotGuide,
  networkList,
  suggested,
  WifiError,
} from "../src/wifi.ts";
import { friendly } from "../src/friendly.ts";

const q: PairingQR = {
  ver: "agentpet-v1",
  name: "PROV_test",
  transport: "ble",
  security: 1,
  pop: "x".repeat(32),
  device_id: "device-test",
  public_key_pem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  nonce: "a".repeat(64),
  service_uuid: "12345678-1234-1234-1234-123456789abc",
};
const coded = (code: string) =>
  Object.assign(new Error(`native ${code}`), { code });
function device(
  capabilities: string[],
  overrides: Partial<NativeProvisioner> = {},
) {
  const calls: string[] = [];
  const native: NativeProvisioner = {
    connect: async () => void calls.push("connect"),
    exchange: async (_p, raw) => {
      const m = JSON.parse(raw);
      calls.push(m.op);
      return JSON.stringify(
        m.op === "challenge"
          ? {
              ...q,
              physical_confirmed: true,
              network_slots: [],
              max_network_slots: 3,
              capabilities,
            }
          : { ready: true },
      );
    },
    provision: async () => void calls.push("provision"),
    disconnect: async () => void calls.push("disconnect"),
    ...overrides,
  };
  return { native, calls };
}

test("network list keeps the strongest entry per name and drops junk", () => {
  const list = networkList([
    { ssid: "Home", rssi: -70, secure: true },
    { ssid: "Home", rssi: -50, secure: true },
    { ssid: "", rssi: -30, secure: true },
    { ssid: "x".repeat(33), rssi: -30, secure: true },
    { ssid: "Cafe", rssi: -80, secure: false },
    { ssid: "小明的 iPhone", rssi: -60, secure: true },
    null,
    "bad",
  ]);
  assert.deepEqual(
    list.map((n) => [n.ssid, n.bars, n.secure]),
    [
      ["Home", 4, true],
      ["小明的 iPhone", 3, true],
      ["Cafe", 1, false],
    ],
  );
  assert.deepEqual(networkList("nope"), []);
  assert.equal(
    networkList(
      Array.from({ length: 30 }, (_, i) => ({ ssid: `n${i}`, rssi: -40 })),
    ).length,
    15,
  );
  assert.deepEqual([bars(-40), bars(-60), bars(-70), bars(-90)], [4, 3, 2, 1]);
});

test("the phone's own Wi-Fi is suggested only when the device can see it", () => {
  const list = networkList([{ ssid: "Home", rssi: -50, secure: true }]);
  assert.equal(suggested(list, "Home"), "Home");
  assert.equal(suggested(list, "Office-5G"), null);
  assert.equal(suggested(list, null), null);
});

test("device scan failures never end setup; people can still type the name", async () => {
  const { native, calls } = device(["network-candidate-v1"], {
    scanWifi: async () => {
      throw coded("SCAN_UNSUPPORTED");
    },
  });
  const setup = new SetupSession(native);
  await setup.open(q);
  const opened = calls.length;
  await assert.rejects(setup.scan(), /native SCAN_UNSUPPORTED/);
  assert.ok(!calls.slice(opened).includes("disconnect"));
  await setup.network("Home", "valid-passphrase");
  assert.ok(calls.includes("provision"));
});

test("scan returns what the device reports", async () => {
  const raw = [{ ssid: "Home", rssi: -50, secure: true }];
  const { native } = device(["network-candidate-v1"], {
    scanWifi: async () => raw,
  });
  const setup = new SetupSession(native);
  await setup.open(q);
  assert.deepEqual(await setup.scan(), raw);
});

test("a wrong password keeps the device window open on firmware that supports retry", async () => {
  let attempt = 0;
  const { native, calls } = device(
    ["network-candidate-v1", "network-retry-v1"],
    {
      provision: async () => {
        calls.push("provision");
        if (++attempt === 1) throw coded("WIFI_AUTH");
      },
    },
  );
  const setup = new SetupSession(native);
  await setup.open(q);
  const opened = calls.length;
  assert.equal(setup.canRetryWifi, true);
  await assert.rejects(
    setup.network("Home", "wrong-password"),
    (e: unknown) => {
      assert.ok(e instanceof WifiError);
      assert.equal(e.reason, "auth");
      assert.equal(e.retryable, true);
      return true;
    },
  );
  assert.ok(!calls.slice(opened).includes("disconnect"));
  await setup.network("Home", "right-password");
  assert.equal(calls.filter((c) => c === "provision").length, 2);
  assert.equal(calls.filter((c) => c === "network.prepare").length, 2);
});

test("older firmware still closes setup after a Wi-Fi failure, with the precise reason", async () => {
  const { native, calls } = device(["network-candidate-v1"], {
    provision: async () => {
      throw coded("WIFI_NOT_FOUND");
    },
  });
  const setup = new SetupSession(native);
  await setup.open(q);
  await assert.rejects(
    setup.network("Hotspot", "valid-passphrase"),
    (e: unknown) => {
      assert.ok(e instanceof WifiError);
      assert.equal(e.reason, "not_found");
      assert.equal(e.retryable, false);
      return true;
    },
  );
  assert.equal(calls.at(-1), "disconnect");
});

test("non-Wi-Fi failures during provisioning still close setup", async () => {
  const { native, calls } = device(
    ["network-candidate-v1", "network-retry-v1"],
    {
      provision: async () => {
        throw coded("SESSION");
      },
    },
  );
  const setup = new SetupSession(native);
  await setup.open(q);
  await assert.rejects(setup.network("Home", "valid-passphrase"));
  assert.equal(calls.at(-1), "disconnect");
});

test("failure text tells hotspot and Wi-Fi users what to change", () => {
  assert.match(failureText("auth", "wifi"), /密码不对/);
  assert.match(failureText("auth", "hotspot"), /热点密码/);
  assert.match(failureText("not_found", "hotspot"), /最大兼容性/);
  assert.match(failureText("not_found", "wifi"), /2\.4 GHz/);
  assert.match(friendly(new WifiError("auth", false)), /密码不对/);
  assert.match(friendly(new WifiError("not_found", false)), /2\.4 GHz/);
});

test("hotspot guide covers 2.4 GHz and has the computer join first", () => {
  for (const platform of ["ios", "android"]) {
    const text = hotspotGuide(platform)
      .map((x) => x.text + (x.hint ?? ""))
      .join("\n");
    assert.match(text, /2\.4 GHz/);
    assert.match(text, /电脑也连上这个热点/);
    assert.match(text, /别切出 App/);
  }
  assert.match(
    hotspotGuide("ios")
      .map((x) => x.text)
      .join(),
    /最大兼容性/,
  );
});
