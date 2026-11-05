**English** · [简体中文](README.zh_CN.md)

# Agent Pet computer services

This directory contains a runnable Node.js bridge, opt-in trusted relay, scoped enrollment API, signed time service, protocol tests, and the [Magpie plugin](magpie-plugin/README.md). No service is deployed or installed into the running host automatically. Node 22+ and OpenSSL are required; the only service runtime dependency is exact-pinned `ws` 8.22.1. The service uses standard Node TLS, P-256 signatures and SHA-256; it does not implement its own cryptography.

## Local installation

Run from this directory:

```sh
/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts
/usr/local/bin/node src/setup.mjs .agent-pet
/usr/local/bin/node src/cli.mjs .agent-pet/config.json
/usr/local/bin/node --test test/*.test.mjs
```

Setup creates a restricted directory and files, a development certificate valid for `agentpet.local`, `localhost`, and `127.0.0.1`, an independent signing key, an account `local`, source `magpie`, and device `passport-1`. It writes credentials to a restricted file and never prints them. Existing configuration is not overwritten. The development root is for explicit paired local trust only; a public relay requires its real domain certificate and operator-controlled enrollment signing identity.

Default TLS binds `127.0.0.1:7443`; adapter IPC binds `127.0.0.1:7445`. For device/phone use, run setup with `node src/setup.mjs .agent-pet --lan-ip 192.168.1.20`, replacing the address with the selected computer interface. This validates private IPv4, adds that IP to the certificate SAN, binds only that address, and writes `public_endpoint` and `time_bootstrap_url` using the reachable IP. The phone can verify the IP SAN; firmware can additionally use fixed `server_name:'agentpet.local'`. Without the flag, metadata uses loopback and is only for local tests. mDNS advertising is not implemented. Wildcard bindings are rejected by the CLI. No firewall, router, DNS, or global plugin configuration is changed.

Transfer device credentials and the root certificate only through physically confirmed USB or encrypted, physically confirmed phone provisioning. USB uses the exact schema in [protocol.json](protocol.json), including optional `device_id` matching the credential. Do not paste secrets into command arguments or logs. Credentials have a finite 30-day initial lifetime; rotation currently requires re-enrollment/operator action. Production OAuth, recovery, automatic refresh, encrypted server storage, backup policy, and operator monitoring are deployment work still required.

The [offline admin tool](src/admin.mjs) issues controller/source/device credentials and revokes a device. Stop the service first; it does not reload arbitrary external store edits. For example, `node src/admin.mjs .agent-pet/config.json issue-controller local operator .agent-pet/controller.json` writes a new restricted credential file. Device binding currently selects source `magpie`. Online revocation uses the API and immediately closes subscriptions. Never commit the runtime directory.

## Wire and phone API

[protocol.json](protocol.json) is the canonical wire profile. Frames are complete UTF-8 JSON messages of at most 4096 bytes; WebSocket compression is disabled. The device sends `hello` with `device_id`, `versions:[1]`, `view_epoch`, optional `public_mode`, then `auth` with `credential`, within five seconds. Authentication binds the account, device and selected source. Business messages carry `v,type,stream_id,view_epoch,revision,payload`.

Snapshots use begin/page/end, zero-based pages, at most four tasks per page, 16 tasks and eight inbox items. This implementation sends one task per page plus a metadata page, requiring up to 17 pages. Counts and source metadata are sent atomically. `state.delta` replaces complete task summaries or usage; membership/count/inbox changes start a new stream and snapshot. Revisions advance only for published deltas in one device view, with uint32 rollover creating a new stream. Snapshot frames are frozen; HTTPS fallback `GET /v1/state?frame=0` creates a ten-second frozen snapshot and subsequent frame indices read the same baseline. The unindexed endpoint returns `{frames:[...]}` for phones/computers and may exceed 4096 bytes as a whole.

Phone HTTPS APIs use `Authorization: Bearer <controller credential>`. Browser origins are rejected; native clients use the selected authenticated HTTPS origin. Source/device tokens cannot manage another account's inventory.

| Request | Result |
| --- | --- |
| `GET /v1/service` | `endpoint`, `ca_pem`, `server_name`, UTC `time`, `enrollment_public_key_pem` and alias `public_key_pem`, `key_id,time_bootstrap_url,time_issuer,transport` (`local` or `remote`) |
| `GET /v1/devices` | `{devices:[{id,source_id,remote_enabled,view_epoch,mode}]}` |
| `GET /v1/sources` | `{sources:[{id,connected,fresh,source_updated_at}]}` |
| `GET /v1/health` | Service mode, `source_scope`, `source_id`, aggregate `source` and authorized `sources` |
| `GET /v1/devices/:id/state` | `{frames:[...]}`; relay also reports `source_fresh,relay_received_at` |
| `GET /v1/diagnostics` | Controller-only account-scoped adapter event/heartbeat counters and fixed rejection categories |
| `POST /v1/enrollment/tickets` | Signed ticket; body `device_id,source_id,public_key_pem,nonce`, optional `operation:'enroll'|'rotate_credential'` |
| `POST /v1/enrollment/consume` | `{device_id,credential}`; body `ticket,proof` |
| `POST /v1/devices/:id/privacy` | Body `mode,view_epoch`; clears cached view and closes old subscriptions |
| `POST /v1/devices/:id/remote` | Body `{enabled:boolean}`; explicit remote permission |
| `DELETE /v1/devices/:id` | Immediate credential/subscription revocation and cached snapshot deletion |

Controller health lists deduplicated active sources in the authenticated account. With one source, `source_scope` is `single_source`; with multiple or no sources it is `any_authorized_source`, and aggregate connected/fresh means any authorized source has that property. Device health stays limited to its bound source. Relay health derives from the authorized cached source snapshots and their original freshness, never from a synthetic local adapter or relay heartbeat.

Tickets expire after 120 seconds and are consumed once after P-256 proof of possession. The returned `canonical` string is UTF-8 JSON in this exact property order: `domain,ticket,account_id,device_id,source_id,nonce,public_key_pem,expires_at`. Domain is `agentpet-enroll-v1`; nonce is 64 lowercase hexadecimal characters; expiry is UTC milliseconds. Verify the base64url DER ECDSA/SHA-256 `signature` over that exact string with the pretrusted enrollment public key. Device `proof` is the base64url DER signature over the UTF-8 ticket string. Enrollment only accepts P-256 public keys and an already authorized source in the controller's account. Ticket state is memory-only: restart invalidates unconsumed tickets.

Account enrollment leaves `remote_enabled:false`. Ownership-only pairing can discard its issued device credential and preserve LAN configuration. Enabling remote transport requires explicit consent and the separate remote-enable API. A later physically confirmed session can request `operation:'rotate_credential'` with the same account, source and P-256 key plus a new challenge nonce. Consumption verifies fresh ticket possession, revokes previous device credentials and immediately closes their subscriptions; it returns the replacement credential only in the authenticated TLS response flow and preserves the existing remote-enabled setting. Key replacement, revoked devices and legacy devices without an enrolled key binding fail closed. The server retains hashes of the most recent 32 consumed device nonces to reject reuse; ticket replay is independently rejected. The signed canonical ticket shape remains unchanged.

Diagnostics are memory-only and reset on process restart. They count authenticated-source event and heartbeat requests separately as received/accepted/rejected, with fixed validation categories. They contain no task IDs, payloads, tokens or credentials and are scoped to the controller's account. Valid heartbeats with zero event receipts indicate a different failure from events rejected during normalization.

## Magpie adapter boundary

The [plugin package](magpie-plugin/package.json) is separately version gated. Loopback IPC requires a distinct adapter bearer token, rejects Origin headers, and separately validates the source credential. `POST /v1/events` accepts `{source_credential,event}`. Events contain `source_id,session_id,run_id,revision,title,entity_kind,execution_state,pending_interactions,task_outcome,turn_outcome,capabilities`; unknown raw content is never stored or forwarded. Request IDs and plain text are bounded. Task IDs are stable SHA-256-derived identifiers within the firmware's 96-byte identity limit; original session/run identities remain only in restricted local state for routing.

Optional `event.usage` is `{kind:'session_total',revision,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,coverage:'loaded_session',accounting:'dsh-token-meter@0.2.2-rc.1'}`. All token fields are nonnegative decimal strings. The bridge upserts one complete host-reduced record per source/session, independent of turns; a newer lower total is a correction. Usage scope is `loaded_sessions_lifetime`, and `daily_tokens` is null. This is not today's spending or subscription quota. More than 23 digits becomes unavailable on the firmware wire. Money is unavailable from this adapter; the reducer supports explicitly sourced provenance-bearing micro-unit records, without currency conversion or guessed prices.

`POST /v1/source/heartbeat` takes `{source_credential,connected}` every 15 seconds and on unload. `GET /v1/commands` uses the adapter bearer plus `X-Source-Credential` and returns `{commands:[{command_id,type:'open_on_host',session_id}]}`. `POST /v1/commands/result` accepts `{source_credential,command_id,status}`. Host-open remains unavailable unless the plugin advertises a live confirmed navigation capability. Device actions use fresh 30-second offers, durable pre-dispatch intent and action IDs; receipt is distinct from confirmed navigation. Repeated identical IDs return their record; different parameters conflict. Restart changes unresolved accepted intents to unknown rather than dispatching twice. There is no cross-system exactly-once guarantee. Answers, cancel and retry are unsupported.

Running and waiting remain independent. A finished turn has `turn_outcome:'ended'` and does not imply a completed goal. Source freshness expires after 45 seconds; heartbeat transport activity cannot complete a task. Idle observed-session rows are superseded once real runs appear. Public mode sends no tasks, inbox or usage, clears cloud caches and starts a fresh publication epoch.

## Opt-in relay

Run a second service with `mode:'relay'`, a real certificate, explicit bind address, and its own restricted store containing independently issued account/source/device credentials. Relay source and device credentials are independent of LAN credentials; provision both deliberately. Remote WSS uses `/v1/relay`. Sources authenticate with `{v:1,type:'auth',payload:{credential,device_id}}`; devices add `view_epoch` and boolean `public_mode` to that payload. The relay responds with a canonical authenticated `welcome` containing the selected remote epoch/mode, original source health and limits. Sources publish only complete validated minimal snapshots; devices can read state and configure their privacy view, with remote actions disabled. The relay never proxies host APIs, files, commands or terminals. Initial relay snapshots are periodically republished rather than forwarding deltas; each remains an atomic source snapshot.

On the bridge, configure `remote:{enabled:true,disclosure_acknowledged:true,url:'wss://your-domain/v1/relay',credentials_file:'relay-credentials.json'}` only after reviewing operator, region, fields, retention and cost. The publisher is outbound, validates real TLS, reconnects with bounded exponential jitter, sends no private titles or question bodies, strips money, and emits only aliases, IDs, states, attention IDs/counts, verified token totals and source health. The CLI requires a separate `remote.credentials_file` containing independently issued `source_credential` and `device_id`; it never defaults to the LAN credential. The publisher waits for authenticated relay policy before sending a projection. Do not reuse LAN credentials in a production relay store. The relay device must have `remote_enabled` true. Its `remote_view_epoch` and `remote_mode` are stored separately from LAN fields. A new device boot epoch or `view.configure {mode,view_epoch}` clears the old cache and asks the scoped source publisher to produce a newly filtered snapshot under a new stream. `view.ready` acknowledges privacy configuration; it is not a synchronized snapshot. Late source frames for old epochs are discarded. With the source offline, welcome/heartbeats report unavailable source data and no old snapshot is relabeled for the new epoch.

The relay is a trusted processor that can read permitted summaries; this is TLS on two legs, not end-to-end encryption. It retains only a latest validated complete snapshot per device in memory, expiring after 24 hours. Restart requires fresh source synchronization. Source age becomes stale after 45 seconds even while relay heartbeats remain live. Revocation/privacy/disable clears the relevant cache and closes old subscriptions; no seven-day task history is uploaded. Remote actions are unsupported. No public service is started by tests.

[time.mjs](src/time.mjs) provides a separate HTTP `/v1/time?nonce=<64 hex>` endpoint. Setup defaults to port 7444 on the same explicitly selected bind address, issuer `agentpet-local`; configure `time_bootstrap_url` to the reachable device address. The response contains `issuer,nonce,unix_seconds` as a decimal string and a base64url DER `signature`, plus compatible `domain,bridge_id,seconds` fields. Signed bytes are `agentpet-time-v1`, issuer, nonce and decimal seconds newline-separated without a final newline. Verify P-256/SHA-256 against the physically pinned signing key, require completion within five monotonic seconds, then validate normal TLS fully. The endpoint accepts no credentials and exposes no tasks. Hardware cold boot, key rotation and recovery still require validation.

## Validation and limits

Run `node --test test/*.test.mjs` and `npm audit`. Tests exercise actual TLS/WSS bridge and relay connections, certificate rejection, IPC isolation, cached-source aging/TTL, bounded snapshots, corrections, account isolation, P-256 possession, revocation and durable action ambiguity. No hardware, mobile BLE or installed desktop plugin acceptance is claimed by service tests. The lead runs the repository-wide static and firmware gates.

Restricted local state persists only normalized summaries, session routing identities, reduced usage and action hashes/results. Capacity is 4096 summaries, 10000 meter records, 1024 credentials, 128 tickets/offers, four executing actions and 4096 retained action records. Ended-summary/day retention and date-aware daily aggregation remain incomplete; normalized local state is capacity bounded and must be explicitly cleared by the operator. This first service uses restricted files, not encrypted storage. Do not deploy publicly before account lifecycle, storage, ingress quotas, certificate rotation, trusted time, source coverage and operating policy are reviewed.
