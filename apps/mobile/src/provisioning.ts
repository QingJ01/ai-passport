export function utf8Bytes(value: string) {
  return [...value].reduce((n, c) => {
    const x = c.codePointAt(0)!;
    return n + (x <= 0x7f ? 1 : x <= 0x7ff ? 2 : x <= 0xffff ? 3 : 4);
  }, 0);
}
export interface PairingQR {
  ver: "agentpet-v1";
  name: string;
  transport: "ble";
  security: 1;
  pop: string;
  device_id: string;
  public_key_pem: string;
  nonce: string;
  service_uuid: string;
}
export function parseQR(raw: string): PairingQR {
  if (raw.length > 4096) throw Error("Pairing code is too large");
  let q: PairingQR;
  try {
    q = JSON.parse(raw);
  } catch {
    throw Error("Scan the temporary device screen code");
  }
  if (
    q.ver !== "agentpet-v1" ||
    q.transport !== "ble" ||
    q.security !== 1 ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(q.pop) ||
    !/^[a-f0-9]{64}$/.test(q.nonce) ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(q.device_id) ||
    !/^PROV_[A-Za-z0-9_-]{1,64}$/.test(q.name) ||
    !/^[a-fA-F0-9-]{36}$/.test(q.service_uuid) ||
    typeof q.public_key_pem !== "string" ||
    !q.public_key_pem.startsWith("-----BEGIN PUBLIC KEY-----")
  )
    throw Error("Unsupported or insecure pairing code. Use USB recovery.");
  return q;
}
export type TransportProfile = "local" | "remote";
export interface NativeProvisioner {
  connect(q: PairingQR): Promise<void>;
  exchange(path: string, payload: string): Promise<string>;
  provision(ssid: string, passphrase: string): Promise<void>;
  disconnect(): Promise<void>;
}
export interface Challenge {
  device_id: string;
  nonce: string;
  public_key_pem: string;
  physical_confirmed: boolean;
  network_slots: string[];
  max_network_slots?: number;
  capabilities: string[];
}
// Proposed product endpoint. Firmware must implement it; no fallback to an unauthenticated endpoint.
export class SetupSession {
  private expires = 0;
  private q?: PairingQR;
  private challenge?: Challenge;
  constructor(
    private native: NativeProvisioner,
    private now = () => performance.now(),
  ) {}
  private live() {
    if (!this.q || this.now() >= this.expires)
      throw Error(
        "Setup expired. Open a new 120-second setup window on the device.",
      );
  }
  private async bounded<T>(work: Promise<T>, timeout = 15000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Setup request timed out. Reopen the device setup window.",
                ),
              ),
            Math.min(timeout, Math.max(1, this.expires - this.now())),
          );
        }),
      ]);
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async open(q: PairingQR) {
    await this.close();
    this.q = q;
    this.expires = this.now() + 120000;
    try {
      await this.bounded(this.native.connect(q));
      this.live();
      while (true) {
        const c: Challenge = JSON.parse(
          await this.bounded(
            this.native.exchange(
              "agentpet-setup",
              JSON.stringify({ v: 1, op: "challenge", nonce: q.nonce }),
            ),
          ),
        );
        this.live();
        if (
          c.device_id !== q.device_id ||
          c.nonce !== q.nonce ||
          c.public_key_pem !== q.public_key_pem ||
          typeof c.physical_confirmed !== "boolean" ||
          !Array.isArray(c.network_slots) ||
          c.network_slots.length > 3 ||
          (c.max_network_slots !== undefined &&
            (!Number.isInteger(c.max_network_slots) ||
              c.max_network_slots < 1 ||
              c.max_network_slots > 3 ||
              c.network_slots.length > c.max_network_slots)) ||
          !c.network_slots.every((x) => typeof x === "string") ||
          !Array.isArray(c.capabilities)
        )
          throw Error("Device identity or physical confirmation failed");
        if (c.physical_confirmed) {
          this.challenge = c;
          return c;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.live();
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async network(ssid: string, passphrase: string, replace?: number) {
    this.live();
    if (!this.challenge) throw Error("Confirm the device first");
    if (
      !ssid ||
      utf8Bytes(ssid) > 32 ||
      (passphrase !== "" &&
        (utf8Bytes(passphrase) < 8 || utf8Bytes(passphrase) > 63))
    )
      throw Error(
        "Use a 1–32 byte SSID and an 8–63 byte passphrase (or empty for an open network).",
      );
    if (!this.challenge.capabilities.includes("network-candidate-v1"))
      throw Error(
        "Firmware does not support safe network replacement. Use USB recovery.",
      );
    const capacity = this.challenge.max_network_slots;
    if (capacity === undefined)
      throw Error(
        "Firmware did not report saved-network capacity. Use USB recovery.",
      );
    if (
      this.challenge.network_slots.length >= capacity &&
      (!Number.isInteger(replace) || replace! < 0 || replace! >= capacity)
    )
      throw Error("Choose which saved network to replace");
    const result = JSON.parse(
      await this.bounded(
        this.native.exchange(
          "agentpet-setup",
          JSON.stringify({
            v: 1,
            op: "network.prepare",
            replace_slot: replace ?? null,
            ssid,
          }),
        ),
      ),
    );
    this.live();
    if (result.ready !== true) throw Error("Device refused candidate network");
    await this.bounded(this.native.provision(ssid, passphrase), 45000);
    this.live();
    // Keep the same physical window open so first-use enrollment can configure the relay before TLS validation.
    // Firmware must commit only after path validation; standard Wi-Fi provisioning alone cannot establish this.
    return { wifi: "connected", internet: "unverified", relay: "unverified" };
  }
  private async exchange(message: Record<string, unknown>) {
    let result = JSON.parse(
      await this.bounded(
        this.native.exchange("agentpet-setup", JSON.stringify(message)),
      ),
    );
    while (result.pending === true) {
      this.live();
      if (typeof result.request_id !== "string")
        throw Error("Invalid device worker response");
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = JSON.parse(
        await this.bounded(
          this.native.exchange(
            "agentpet-setup",
            JSON.stringify({
              v: 1,
              op: "result",
              request_id: result.request_id,
            }),
          ),
        ),
      );
    }
    this.live();
    return result.pending === false ? result.result : result;
  }
  private profile(transport: TransportProfile) {
    this.live();
    if (transport !== "local" && transport !== "remote")
      throw Error("Unsupported service profile");
    if (
      transport === "remote" &&
      !this.challenge?.capabilities.includes("transport-profiles-v1")
    )
      throw Error(
        "Update the device through USB before configuring a separate remote service.",
      );
  }
  async trust(public_key_pem: string, transport: TransportProfile = "local") {
    this.profile(transport);
    this.live();
    if (!this.challenge) throw Error("Confirm the device first");
    const result = await this.exchange({
      v: 1,
      op: "service.trust",
      public_key_pem,
      transport,
    });
    if (result.trusted !== true)
      throw Error(
        "Device refused service trust. Existing ownership cannot be replaced.",
      );
  }
  async configure(
    service: {
      endpoint: string | null;
      ca_pem: string;
      server_name: string;
      time: number;
      time_bootstrap_url?: string | null;
      time_issuer?: string;
      enrollment_public_key_pem?: string;
    },
    credential: string,
    transport: TransportProfile = "local",
  ) {
    this.profile(transport);
    if (!service.endpoint || !service.endpoint.startsWith("wss://"))
      throw Error("Service has no configured secure device endpoint");
    const result = await this.exchange({
      v: 1,
      op: "service.configure",
      ...service,
      credential,
      transport,
    });
    if (result.accepted !== true || result.state !== "validating_path")
      throw Error("Device did not accept relay configuration");
    await this.finish();
  }
  async finish() {
    this.live();
    const finished = await this.exchange({ v: 1, op: "finish" });
    if (finished.finished !== true)
      throw Error("Device could not finish setup");
  }
  async enrollment(ticket: unknown, transport: TransportProfile = "local") {
    this.profile(transport);
    if (!this.challenge?.capabilities.includes("enrollment-v1"))
      throw Error("Firmware enrollment endpoint is unavailable");
    const result = await this.exchange({
      v: 1,
      op: "enroll",
      ticket,
      transport,
    });
    this.live();
    if (
      result.service_signature_verified !== true ||
      result.device_id !== this.q!.device_id ||
      result.nonce !== this.q!.nonce ||
      typeof result.proof !== "string"
    )
      throw Error(
        "Device did not verify service signature and prove ownership",
      );
    return result.proof as string;
  }
  async close() {
    this.q = undefined;
    this.challenge = undefined;
    this.expires = 0;
    await this.native.disconnect();
  }
}
