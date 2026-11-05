import type {
  PairingQR,
  SetupSession,
  TransportProfile,
} from "./provisioning.ts";
import type { Relay, Service } from "./relay.ts";
export type EnrollmentChoice = "pair-only" | "local" | "remote";
type AccountAPI = Pick<
  Relay,
  "devices" | "service" | "ticket" | "consume" | "remote"
>;
type DeviceSetup = Pick<
  SetupSession,
  "trust" | "enrollment" | "configure" | "finish"
>;
export function serviceProfile(meta: Service): TransportProfile {
  const profile = meta.transport ?? "local";
  if (profile !== "local" && profile !== "remote")
    throw Error("The service returned an unsupported transport profile.");
  return profile;
}
// The caller must obtain explicit remote-sharing consent before choosing "remote".
// Ownership pairing alone never authorizes a relay upload or modifies the local network configuration.
export async function enroll({
  relay,
  session,
  qr,
  sourceId,
  choice,
}: {
  relay: AccountAPI;
  session: DeviceSetup;
  qr: PairingQR;
  sourceId: string;
  choice: EnrollmentChoice;
}) {
  if (!sourceId) throw Error("Choose an authorized source first.");
  const owned = (await relay.devices()).devices.find(
    (d) => d.id === qr.device_id,
  );
  if (owned && owned.source_id !== sourceId)
    throw Error("Choose the source already assigned to this device.");
  const meta = await relay.service();
  const transport = serviceProfile(meta);
  if (choice !== "pair-only" && choice !== transport)
    throw Error(
      "The service role changed. Reconnect your account before configuring the device.",
    );
  if (owned && choice === "pair-only")
    return {
      device_id: qr.device_id,
      transport,
      alreadyPaired: true,
      configured: false,
    };
  if (choice !== "pair-only" && !meta.endpoint)
    throw Error(
      "Your service administrator must configure a secure device endpoint first.",
    );
  await session.trust(meta.enrollment_public_key_pem, transport);
  const ticket = await relay.ticket(qr, sourceId, !!owned);
  const proof = await session.enrollment(ticket, transport);
  const result = await relay.consume(ticket.ticket, proof);
  if (result.device_id !== qr.device_id)
    throw Error("Enrollment device identity mismatch");
  try {
    if (choice === "pair-only") await session.finish();
    else {
      if (choice === "remote") await relay.remote(result.device_id, true);
      await session.configure(
        {
          endpoint: meta.endpoint,
          ca_pem: meta.ca_pem,
          server_name: meta.server_name,
          time: meta.time,
          time_bootstrap_url: meta.time_bootstrap_url,
          time_issuer: meta.time_issuer,
          enrollment_public_key_pem: meta.enrollment_public_key_pem,
        },
        result.credential,
        transport,
      );
    }
  } catch (error) {
    throw Error(
      (owned
        ? "This connection credential was renewed. Reopen device setup to retry this connection. "
        : "Ownership paired, but setup is unfinished. Reopen device setup to retry. ") +
        (error instanceof Error ? error.message : "Connection setup failed"),
    );
  }
  // Device credentials are forwarded within this session; no persistence or logging here.
  return {
    device_id: result.device_id,
    transport,
    alreadyPaired: false,
    configured: choice !== "pair-only",
  };
}
