import { requireOptionalNativeModule } from "expo-modules-core";
import type { NativeProvisioner } from "../../src/provisioning";
import { Platform } from "react-native";
const native = requireOptionalNativeModule<{
  connectSecure(...args: string[]): Promise<void>;
  exchange(path: string, payload: string): Promise<string>;
  provision(ssid: string, passphrase: string): Promise<void>;
  disconnect(): Promise<void>;
  request(
    url: string,
    method: string,
    token: string,
    body: string | null,
  ): Promise<{ status: number; body: string }>;
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
      disconnect: () => native.disconnect(),
    }
  : {
      connect: unavailable,
      exchange: unavailable,
      provision: unavailable,
      disconnect: async () => {},
    };
export const secureFetch: typeof fetch = async (input, options) => {
  if (!native)
    throw Error("Install the native companion build to connect securely.");
  if (options?.signal?.aborted) throw Error("Request cancelled");
  const auth = new Headers(options?.headers).get("Authorization") ?? "";
  if (!auth.startsWith("Bearer "))
    throw Error("Controller authorization required");
  if (options?.body !== undefined && typeof options.body !== "string")
    throw Error("JSON request required");
  const result = await native.request(
    String(input),
    options?.method ?? "GET",
    auth.slice(7),
    (options?.body as string) ?? null,
  );
  if (options?.signal?.aborted) throw Error("Request cancelled");
  return new Response(result.status === 204 ? null : result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
};
export default adapter;
