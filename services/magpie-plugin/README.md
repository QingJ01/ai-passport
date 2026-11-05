**English** · [简体中文](README.zh_CN.md)

# Agent Pet Magpie adapter

An installable host adapter and browser companion for **DSH 0.2.2-rc.1**. The host reads permitted live registries and projections, exports minimal sanitized summaries to the bridge, and forwards authenticated open-session intents to a live owner client. The companion calls `uiWorkspace.openSession` and confirms the resulting selected session. It does not claim operating-system focus or a deep link.

## Package and review

Package: `@ai-passport/dsh-agent-pet@0.2.1`. The manifest exports the host entry `./src/index.mjs`, browser bundle `./src/client.js`, package manifest and `./cordis.patch.yml`. `dsh.bundle.patch` inserts Cordis row `agent-pet-adapter`, module `@ai-passport/dsh-agent-pet`. `dsh.client` declares web platform dependencies on the existing DSH Gateway and Workspace UI modules. The browser file uses the packaged `window.__ModuleLoader__.load({id,factory})` convention.

There are no installation scripts, native assets, background sidecars or host-source patches. JavaScript is the distributable. The browser wrapper is deterministically generated from the shared Remote descriptors and browser-safe companion core:

```sh
cd services/magpie-plugin
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm test
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

Review the tarball before installing it through the target DSH profile's plugin UI. A CLI-managed test profile can use `dsh plugin --profile <test-profile> add <absolute-tarball-path>`. Desktop profiles are application-managed: do not manage the reserved desktop profile with the CLI or edit its files manually. Global installation, activation and any reload belong to the lead/operator after review; packaging and tests do not perform them. Do not grant a version exemption to bypass incompatibility.

## Secure live connection setup

The default bundle reads only the explicitly designated Agent Pet connection file: `~/.config/agent-pet/magpie.json`. It never reads personal DSH session databases or DSH configuration files. The project setup/operator creates this connection file only after review, using the bridge's scoped source provisioning credentials and the exact approved session IDs. The reader does not create or rewrite it.

The file must be a regular, non-symlink file owned by the current user, with mode **0600**, at most 8192 bytes. Open uses `O_NOFOLLOW|O_NONBLOCK` and validates the opened descriptor's type, owner and permissions. Reads are bounded. Wrong ownership, permissions, symlinks, malformed JSON or unknown fields fail activation with a sanitized category. A missing file and missing environment credentials leave the plugin inactive with no export. Creating the file after inactive activation requires toggling the plugin to reread it; changing credentials does not silently change an already active connection.

Exact file schema; all example values are synthetic:

```json
{
  "bridgeUrl": "http://127.0.0.1:7445",
  "sourceId": "magpie-local",
  "ipcToken": "<separate-bridge-ipc-token>",
  "sourceToken": "<scoped-source-token>",
  "sessionIds": ["approved-session-id"]
}
```

`sessionIds` must be a nonempty explicit allowlist. File configuration always forces `includeAllSessions:false`; that field is not accepted in the file. Actual credentials must be 32-512 printable ASCII characters. Never commit connection files or real session IDs, put credentials in patch files or browser code, or include them in URLs/logs. Bridge URL accepts an HTTP literal loopback origin `127.0.0.1`, with no path, URL authentication, query or fragment. IPC must bind only to loopback and reject browser Origin requests.

Environment credentials remain supported and override file token values. The default variable names are `AGENT_PET_IPC_TOKEN` and `AGENT_PET_SOURCE_TOKEN`. Existing deployments can configure the Cordis row with `sourceId`, `bridgeUrl`, `ipcTokenEnv`, `sourceTokenEnv`, `sessionIds`, `includeAllSessions`, and optional absolute `connectionFile`. Empty `connectionFile` selects the default above. In environment-only mode, the default empty session selection exports no sessions; `includeAllSessions:true` is an explicit advanced opt-in. If a connection file is present, its source, endpoint and exact allowlist take precedence over those row defaults and all-session export is disabled. The file path/configuration is never a browser credential channel.

## Compatibility and active APIs

`engines.dsh` and activation-time `getDshRuntimeVersion()` both require exact `0.2.2-rc.1`. Runtime dependencies: `@deepseek-ai/schemastery@3.19.0`, `zod@4.4.3`. Exact host peers: Cordis `4.1.0`; DSH app-boot, session, agent, session-projection, token-meter, user-questions, typert-protocol, typert-registry, api-gateway and client-ui-workspace `0.2.2-rc.1`. Profile resolution supplies the host peers, avoiding duplicate registries. These internal hooks are intentionally supported only for the pinned release.

Read-only evidence comes from installed `dsh/node_modules/@deepseek-ai/` package sources and manifests, with no private session samples:

| Capability | Packaged evidence | Use |
| --- | --- | --- |
| Installable bundle | `dsh-experimental-forge-bundle/package.json:50`, its `cordis.patch.yml`; `dsh-app-boot/lib/index.js:1301,3080` | Actual patch composition and compatibility gate |
| Browser plugin | `dsh-client-ui-shortcuts/package.json:29`; `dsh-client-modules/lib/index.js:32` | `dsh.client`, `./client`, lazy module factory |
| Live sessions | `dsh-session/lib/index.js:1999,2006` | `sessions.get/list`, exact live-instance guard |
| Session events | `dsh-session/lib/index.js:1583,1924` | Global created/event/disposed observers with explicit selection filtering |
| Agent and turn | `dsh-agent-loop/lib/index.js:554,731,819` | Agent status; host-only `petLifecycle` fold |
| Projections | `dsh-session-projection/lib/index.js:156,193,232` | Awaited handle, selected snapshot, onChanged |
| Provider tokens | `dsh-token-meter/lib/index.js:394-427,803` | Authoritative `tokenUsage` wire view |
| Questions | `dsh-user-questions/lib/index.js:170,676-712` | Continued-question projection and delegating request waterfall |
| Typed host/client channel | `dsh-typert-registry/lib/index.js:460`; `dsh-api-gateway/lib/client.node.js:1485` | Explicit strict descriptor registration and `remote.$mount` |
| Owner provenance | `dsh-api-gateway/lib/index.js:1200-1244`; `dsh-typert-protocol/lib/index.js:338` | Gateway-injected invocation peer; owner-only navigation service |
| Navigation confirmation | `dsh-client-ui-workspace/lib/client.js:1473,1661-1684` | `openSession(id)` followed by `selection.getSnapshot().sessionId` |

The `agentPetNavigation` Remote namespace exposes `poll(clientId)`, `result(clientId,commandId,status)`, `leave(clientId)` and owner-only `diagnostics()`. Strict hand-authored Typert descriptors are shared by host and client; no source-reflection fallback or arbitrary endpoint is exposed. Remote calls require the Gateway's owner principal, independently of broader non-owner access policies. Credentials remain exclusively on the host.

Version 0.2.1 adds the read-only `agentPetNavigation/diagnostics` endpoint with `{args:{}}`. It returns selected/configured/live-agent counts, queue/capture/IPC counters, an active flag and a fixed failure-stage enum; it contains no session IDs, source IDs, credentials, titles, paths or exception text. Calling diagnostics does not claim a browser lease or advertise navigation capability. Heartbeat freshness proves source presence, not successful capture: compare selected-live, captured and accepted-event counters when tasks are absent. Reconciliation always republishes complete selected current state after each heartbeat, even with an unchanged host log, so an empty restarted bridge can recover without a new user event.

## Bridge and navigation contract

All IPC uses `Authorization: Bearer <ipc-token>` and no browser Origin:

- `POST /v1/events`: `{source_credential,event}`.
- `POST /v1/source/heartbeat`: `{source_credential,connected}` every 15 seconds; best-effort false after draining older sends at unload.
- `GET /v1/commands`: scoped token in `X-Source-Credential`; response `{commands:[{command_id,type:"open_on_host",session_id}]}`.
- `POST /v1/commands/result`: `{source_credential,command_id,status}`, where status is `succeeded`, `failed` or `unknown`.

The browser never calls loopback directly. It mounts its typed namespace through DSH's existing authenticated connection. A visible owner client polls once per second and holds a five-second host lease. Only one client receives each intent. Other clients cannot take over an already assigned command after lease loss; the bridge's 30-second deadline returns unknown. Hidden/unloaded clients release their lease or expire. Capability expires with the lease and is republished to the bridge. Targets are revalidated against the exact selected live sessions.

Before calling `uiWorkspace.openSession`, the client records the command ID and an unknown decision. It invokes that ID at most once during its retention window. It reports succeeded only after the selection store names the requested session, failed on a thrown navigation error, and unknown when selection is unconfirmed. Retries resend the same decision; they do not navigate again. Host/client caches are bounded at 256 intents with 60-second retention, using monotonic timing. A page/process crash loses volatile deduplication; no cross-process exactly-once claim is made. The bridge owns durable action state and timeout. Navigation success means selection inside DSH; no OS focus or content-load completion is claimed.

Events contain `source_id`, `session_id`, `run_id`, safe integer `revision`, generic title, `entity_kind:"turn"`, execution state, pending interaction IDs, `task_outcome:null`, `turn_outcome:null|"ended"`, and capability `open_on_host` only while the companion lease is live. Stable run IDs are `turn-<turn>-<startSeq>`; `session-observed` is superseded when a real turn appears. Idle/registry disposal are not goal success. Disposal marks execution unknown and removes dead interactions. No answer, cancel, retry, billing or quota capability is advertised.

Question observation calls the existing waterfall `next()` exactly once and preserves the exact answer object or rejection. Timed calls use `wait.callId`, deduplicated with durable continued questions; blocking requests use a process-local random ID because the request exposes no stable call ID. Execution and waiting remain orthogonal. No question text, options, answers, approval details, prompts, replies, code or tool outputs are exported.

## Usage accounting and limits

`event.usage` is a whole host-reduced record:

```json
{"kind":"session_total","revision":123,"input_tokens":"12","output_tokens":"4","cache_read_tokens":"6","cache_write_tokens":"8","coverage":"loaded_session","accounting":"dsh-token-meter@0.2.2-rc.1"}
```

Input means uncached input; the four buckets are disjoint decimal strings. DSH replaces a prior settlement in the same turn/step, permits negative corrections, and closes that replacement slot on `llm/retry-started`, allowing the retried attempt to add. The adapter reads the host projection rather than summing chunks. Bridge storage upserts one record per source/session, independent of run, using `usage.revision = asOfSeq + 1`. Never add snapshots or both parent and inherited child history. Seeded/inherited sessions omit usage entirely. Unsafe/nonnegative-counter violations suppress only usage rather than lose precision. Lifecycle, usage and question projections are read independently: an optional view failure cannot suppress the selected live execution observation. If the turn projection itself is unavailable, the adapter emits `session-observed` with the live execution status and unknown outcomes, and records the failure count without inferring a turn.

These are **lifetime totals of loaded sessions**, not today's usage, full history or billing. Baselines must not be attributed to ingestion day. Daily attribution, cold sessions, actual money, model prices and subscription quota remain unavailable. Missing is unknown, never fabricated zero.

The queue retains at most 256 run summaries and coalesces by session/run. IPC failures retry after five seconds; overflow evicts oldest queued state. Heartbeat reconciliation repairs current live state after bridge recovery, but complete historical transitions are not guaranteed. Event callbacks only read projections and enqueue. IPC uses a two-second deadline, fixed routes, no redirects, and 16 KB request/response limits. Diagnostics never log exception bodies or secrets. All observers, timers, client leases, Remote registrations, HTTP requests and the private projection are released during unload. No orphan process is launched.

Summary revisions use wall time multiplied by 1000 and increase within an instance; usage revisions use the durable host cursor. Clock rollback across process restarts may delay summary replacement until time catches up; no private cursor persistence is introduced.

## Validation and remaining checks

`npm test` verifies lifecycle reduction, session selection and exact-instance guards, host usage normalization/fork exclusion, question delegation, retry/coalescing, ordered unload, secure connection-file handling, single-client intent assignment, duplicate/result retry behavior, selection confirmation/failure, authenticated IPC and archive contents. `npm run build` produces the browser wrapper; the test gate rejects a stale generated file.

Read-only runtime smokes use installed code in separate processes, never boot a profile or install a plugin:

```sh
DSH_TEST_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' test/runtime-smoke.mjs
```

Run the same command with `test/entry-smoke.mjs` and `test/client-runtime-smoke.mjs`. They validate the real reducer (10 corrected to 7, retry adds 5, total 12), compatibility/patch composition, exported host entry with real registries/questions, and the real host/client Gateways plus generated browser factory. The client smoke mocks the Workspace UI surface against the inspected synchronous selection contract; actual GUI navigation requires the lead's approved installation test. Temporary resolver hooks exist only inside the disposable test process.

Live profile activation/reload, real browser navigation, full-day coverage and device presentation remain integration checks. No firmware is changed by this package; flashing is not applicable.
