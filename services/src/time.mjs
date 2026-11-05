import http from "node:http";
import { sign } from "node:crypto";
import { key } from "./model.mjs";
export function createTimeServer({ bridgeId, privateKey, now = Date.now }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(bridgeId)) throw new Error("issuer");
  let budget = 30,
    last = now();
  return http.createServer((req, res) => {
    const current = now();
    if (current - last >= 1000) {
      budget = 30;
      last = current;
    }
    if (--budget < 0) {
      res.writeHead(429);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://time.invalid"),
      nonce = url.searchParams.get("nonce");
    if (
      req.method !== "GET" ||
      url.pathname !== "/v1/time" ||
      !/^[a-f0-9]{64}$/.test(nonce ?? "")
    ) {
      res.writeHead(400);
      res.end();
      return;
    }
    const seconds = Math.floor(current / 1000),
      canonical = `agentpet-time-v1\n${bridgeId}\n${nonce}\n${seconds}`;
    const signature = sign(
      "sha256",
      Buffer.from(canonical),
      privateKey,
    ).toString("base64url");
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        domain: "agentpet-time-v1",
        issuer: bridgeId,
        bridge_id: bridgeId,
        nonce,
        unix_seconds: String(seconds),
        seconds,
        signature,
      }),
    );
  });
}
