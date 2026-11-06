// Transport seam shared by the native HTTPS module and the relay client.
// pin: 64 lowercase hex SHA-256 of the server's leaf certificate DER. When present,
// the native layer accepts that exact certificate and nothing else.
export type SecureRequest = (
  input: string,
  init?: RequestInit,
  pin?: string,
) => Promise<Response>;
export type TransportFailure = "network" | "pin" | "request";
export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
export const PIN_PATTERN = /^[0-9a-f]{64}$/;
