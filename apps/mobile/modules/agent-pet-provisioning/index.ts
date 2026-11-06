import { requireOptionalNativeModule } from "expo-modules-core";
import type { NativeProvisioner } from "../../src/provisioning";
import { TransportError, type SecureRequest } from "../../src/transport";
import { Platform } from "react-native";
const native = requireOptionalNativeModule<{
  connectSecure(...args: string[]): Promise<void>;
  exchange(path: string, payload: string): Promise<string>;
  provision(ssid: string, passphrase: string): Promise<void>;
  scanWifi?(): Promise<{ ssid: string; rssi: number; secure: boolean }[]>;
  disconnect(): Promise<void>;
  // pin: 64 lowercase hex SHA-256 of the server leaf certificate DER, or null for OS trust.
  request(
    url: string,
    method: string,
    token: string,
    body: string | null,
    pin: string | null,
  ): Promise<{ status: number; body: string }>;
  currentWifiName(): Promise<string | null>;
}>("AgentPetProvisioning");
const unavailable = async () => {
  throw Error(
    "Install the native development build. Expo Go and web cannot run secure BLE setup.",
  );
};
const adapter: NativeProvisioner = native
  ? {
      connect: (q) =>
        native.connectSecure(
          ...(Platform.OS === "ios"
            ? [q.name, q.pop]
            : [q.name, q.pop, q.service_uuid]),
        ),
      exchange: (p, d) => native.exchange(p, d),
      provision: (s, p) => native.provision(s, p),
      scanWifi: native.scanWifi ? () => native.scanWifi!() : undefined,
      disconnect: () => native.disconnect(),
    }
  : {
      connect: unavailable,
      exchange: unavailable,
      provision: unavailable,
      disconnect: async () => {},
    };
export const secureFetch: SecureRequest = async (input, options, pin) => {
  if (!native)
    throw Error("Install the native companion build to connect securely.");
  if (options?.signal?.aborted) throw Error("Request cancelled");
  const auth = new Headers(options?.headers).get("Authorization") ?? "";
  if (!auth.startsWith("Bearer "))
    throw Error("Controller authorization required");
  if (options?.body !== undefined && typeof options.body !== "string")
    throw Error("JSON request required");
  if (pin !== undefined && !/^[0-9a-f]{64}$/.test(pin))
    throw new TransportError("request", "Invalid certificate fingerprint");
  let result: { status: number; body: string };
  try {
    result = await native.request(
      String(input),
      options?.method ?? "GET",
      auth.slice(7),
      (options?.body as string) ?? null,
      pin ?? null,
    );
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    throw new TransportError(
      code === "PIN" ? "pin" : code === "REQUEST" ? "request" : "network",
      e instanceof Error ? e.message : "HTTPS request failed",
    );
  }
  if (options?.signal?.aborted) throw Error("Request cancelled");
  return new Response(result.status === 204 ? null : result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
};
// Best effort: null when the platform does not reveal the current Wi-Fi name.
export async function currentWifiName(): Promise<string | null> {
  if (!native?.currentWifiName) return null;
  try {
    const name = await native.currentWifiName();
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
export default adapter;
