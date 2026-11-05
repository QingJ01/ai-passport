**English** · [简体中文](README.zh_CN.md)

# Agent Pet phone companion

A React Native / Expo 54 application with generated iOS and Android projects and a local Swift/Kotlin Expo module wrapping Espressif's official BLE provisioning SDKs. This is a native development-build app. Expo Go, Safari and a PWA cannot provide this app's iOS BLE setup.

## Run

Requirements: Node 22.13+ (tested Node 24), npm; iOS: Xcode, Ruby with CocoaPods; Android: JDK 17, Android SDK platform/build tools 36, the NDK version selected by React Native, and an Android 8+ physical phone. BLE and QR acceptance needs real phones and an AI Passport. Simulator runs can inspect the UI but do not validate BLE.

```sh
cd apps/mobile
npm ci
npm test
npm run typecheck
npm run bundle
# Regenerates the checked-in native projects with the provisioning config plugin:
npm run prebuild
# Prefer a maintained Ruby 3 installation; keep gems local to this project.
BUNDLE_PATH=.bundle/vendor bundle install
BUNDLE_PATH=.bundle/vendor bundle exec pod install --project-directory=ios
BUNDLE_PATH=.bundle/vendor bundle exec npm run ios
# Or with JAVA_HOME and ANDROID_HOME pointing to your installed local tools:
npm run android
npm start
```

Use an Xcode development signing team for a physical iPhone. Native IDs are `dev.agentpet.companion`; no distribution signing, app-store publishing, cloud build or deployment is configured. The generated Android signing entry is the standard development configuration; do not publish it. The Android run script creates the ignored standard development keystore with local JDK keytool if a fresh checkout lacks it; distribution keys are never created or configured. Runtime controller tokens and Wi-Fi passphrases must never enter source configuration.

The optional `scripts/ruby-sdk-compat.rb` only works around macOS system Ruby 2.6 expecting `universal-darwin24` headers when the installed Xcode SDK provides `universal-darwin25`. It changes process-local `RbConfig`, not Xcode or global Ruby. Set `AGENTPET_RUBY_ARCH_HEADERS` to the actual SDK architecture headers and `RUBYOPT=-r<absolute script path>` before the local Bundler commands if encountering that exact error. A modern Ruby is preferred.

## Implemented screens

- **Today:** one selected device, task state and entity kind, lifetime usage from loaded host sessions, source timestamp and 45-second freshness, independent relay/source/device health. Today's usage and missing health remain unavailable. Refresh gets a full, validated snapshot; there is no invented live sample data.
- **Devices:** account-authorized inventory and sources, source selection for enrollment, remote enable/disable policy, public-mode request and device revocation. Public mode clears the phone view immediately and requires a newly filtered server view. It does not claim a physically disconnected device changed its display.
- **Setup:** camera QR scan, native BLE permission handling, secure session, physical confirmation and identity checks, network candidate preparation, explicit replacement choice at the firmware's reported capacity (up to three saved SSIDs), separate ownership/local-bridge/remote setup, timeout/exit/background teardown, and system hotspot guidance. Firmware may advertise fewer capabilities; unsupported operations fail closed.
- **Account:** administrator-issued, account-scoped controller token, OS-protected storage, explicit restore validation, logout/cache clearing, and service/data disclosure. Browser OAuth, account recovery and production identity-provider integration are not implemented by the current relay and are visibly unavailable.

Remote operation is P1 read-only. There are no approval, answer, deployment, payment or publishing shortcuts. Native push delivery is not implemented. The app does not read system Wi-Fi passphrases, create a hotspot, or maintain a background BLE gateway.

## BLE compatibility and security status

Selected dependencies are [Espressif ESPProvision iOS 3.0.3](https://github.com/espressif/esp-idf-provisioning-ios/releases/tag/3.0.3) (Apache-2.0) and [Espressif Android library lib-2.4.4](https://github.com/espressif/esp-idf-provisioning-android/tree/lib-2.4.4) (Apache-2.0). Official upstream source/README APIs were inspected, including secure sessions, custom data, connection events and provisioning callbacks. Android explicitly lists ESP32-C3. iOS documents the ESP32 family; an actual iOS/C3/ESP-IDF 5.5.3 interoperability test is still required. Library support is evidence for the implementation choice, not proof the whole product passes provisioning.

The app selects ESP-IDF Security1 (upstream X25519, proof of possession and AES-CTR), with a high-entropy temporary QR proof; no cryptographic handshake is implemented in JavaScript. It rejects security0, missing `sec_ver:1`, and `no_pop` capability. Advertising names only locate candidates; the secure endpoint must return the exact scanned device identity, session nonce and public key. The firmware must require physical OK before exposing standard provisioning endpoints. BLE expires after 120 seconds; ordinary calls time out in 15 seconds; joining Wi-Fi may take up to 45 seconds, bounded by the remaining setup window. Native cleanup also cancels scan/connect generations. Setup never installs trust from QR URLs.

Espressif's iOS logging is explicitly disabled. Android upstream logs PoP at DEBUG. The config plugin enables R8 log stripping, but AGP disables optimizations for debuggable variants even when minification is enabled. Therefore the native bridge **rejects BLE connection in every debuggable Android app before calling the SDK**. `npm run android` explicitly builds the optimized release variant, whose R8 rules remove `android.util.Log` calls. Debug builds remain useful for UI/remote-view development, with BLE unavailable. Do not disable release minification/log stripping for credential-bearing tests. Verify the optimized APK and runtime logs on the selected device before release; do not collect raw provisioning logs. The optimized release variant still uses development signing in this scaffold and is not an app-store publishing configuration.

## Firmware handshake

The application and firmware lead agreed on this product endpoint on top of the SDK's authenticated encrypted custom-data API. A missing endpoint is an error, never a simulated connection. The device-screen QR is JSON:

```json
{"ver":"agentpet-v1","name":"PROV_example","transport":"ble","security":1,"pop":"<temporary high-entropy base64url>","device_id":"<stable identity>","nonce":"<64 lowercase hex>","public_key_pem":"<SPKI PEM>","service_uuid":"<BLE service UUID>"}
```

The actual firmware provisioning service UUID must match its QR and advertising data; declaring a UUID in the QR does not configure ESP-IDF's BLE service. Android passes the scanned UUID to `connectBLEDevice`; the selected SDK scans by name without a vendor-UUID filter. iOS scans all service UUIDs and discovers the advertised service. Neither client assumes the SDK's default UUID. Verify this agreement over real BLE.

`agentpet-setup` messages include `v:1` and `op`:

| Operation | Request | Successful response |
| --- | --- | --- |
| `challenge` | Scanned nonce | Exact device ID/nonce/public key, `physical_confirmed:true`, `network_slots`, `max_network_slots` (1–3), `capabilities` |
| `network.prepare` | SSID, explicit `replace_slot` or null | `ready:true`; firmware must test candidate before persistent replacement |
| `service.trust` | Explicit `transport:'local'|'remote'`, `public_key_pem` from the chosen HTTPS service | `trusted:true`; existing different roots cannot be silently replaced |
| `enroll` | The same explicit transport and full ticket envelope including canonical bytes and service signature | `service_signature_verified:true`, matching device ID/nonce, device signature `proof` |
| `service.configure` | The same explicit transport, WSS endpoint, CA PEM, server name, UTC time, device credential, signed-time bootstrap URL/issuer/pinned enrollment public key | `accepted:true,state:'validating_path'` (acceptance is not relay success) |
| `finish` | No sensitive fields | `finished:true`; release BLE before business TLS |
| `result` | Worker `request_id` | `pending:true,request_id` or `pending:false,result` |

Authenticated service metadata selects `local` or `remote`; the same explicit transport accompanies trust, ticket verification and configuration. Remote setup requires `transport-profiles-v1` and fails before root mutation on older firmware. **Pair ownership only** binds the device without enabling upload or configuring a transport. **Connect local bridge** configures local service access without cloud consent or remote-policy mutation. **Add for remote view** requires a fresh default-cancel consent dialog, consumes the verified proof, then enables the server policy before configuring the remote device transport. The firmware profiles use independent roots and enrollment state; real device coexistence is still an acceptance gate.

Slow worker operations are polled every 250 ms within the same 120-second session. Standard SDK provisioning transfers the candidate SSID/passphrase only after `network.prepare`; successful Wi-Fi status still does not establish Internet, service authentication, saved-slot commit or source health. The app clears its passphrase after the attempt and keeps the same physical setup window open. First-use onboarding can then enroll and configure the relay before `finish` releases BLE for TLS validation; an existing-device network change uses the explicit Finish setup button. Connect the account and select its authorized source before scanning, so the phone never has to abandon the active setup window to choose a source. The profile-aware firmware reports up to three saved SSIDs; legacy one-slot responses remain supported. The app requires an explicit replacement choice when the reported capacity is full, refuses network writes when capacity is unreported, and validates capacities from one to three. Saved-slot commit, rollback and candidate path validation still require hardware acceptance.

## Relay contract

The route contract was coordinated with the services teammate; the app does not guess OAuth or send a controller token to QR destinations. Users explicitly enter a trusted HTTPS origin; the OS validates real certificates. Redirects and HTTP are refused in the native transport: iOS uses a per-request ephemeral URLSession with a redirect delegate that rejects every redirect; Android uses OkHttp with HTTP/HTTPS redirects and connection retries disabled. Both bound response size and request duration and retain normal system certificate validation. The app injects this transport into the relay client instead of relying on React Native's XHR-backed fetch redirect option. A self-hosted CA must be deliberately installed through OS trust management; do not disable TLS verification for development. For iOS development, transfer only the development CA certificate, install its profile in Settings → General → VPN & Device Management, then explicitly enable that CA in About → Certificate Trust Settings. Android uses system roots and deliberately user-installed roots in both debug and optimized release builds, so a local-only bridge can use its own CA without a public cloud certificate. Install only the intended CA through Security → Encryption & credentials → Install a CA certificate; this extends the phone's trust and should be an explicit user decision. Chain and hostname validation remain enabled. Release network policy disables cleartext; the debug resource permits Metro HTTP while the native service client still refuses HTTP in every variant. Verify the service hostname resolves on the phone and matches the certificate SAN; the default local development certificate is for `agentpet.local`, `localhost` and `127.0.0.1`, so a bare LAN IP or the phone's localhost will not work. A real reachable hostname/certificate must be configured. No certificate-error bypass is present.

- `GET /v1/devices`, `/v1/sources`, `/v1/health`, `/v1/devices/:id/state` with `Authorization: Bearer <controller token>`.
- `GET /v1/service` supplies `transport:'local'|'remote'`, `endpoint`, `ca_pem`, `server_name`, `time`, `enrollment_public_key_pem`, `key_id`. Legacy service role is resolved through authenticated health, never a QR destination. A null endpoint blocks connection configuration while ownership-only pairing remains available.
- `POST /v1/enrollment/tickets` with device ID/public key/session nonce/source ID returns the one-use signed ticket envelope. Canonical UTF-8 JSON is the service's exact ordered `{domain,ticket,account_id,device_id,source_id,nonce,public_key_pem,expires_at}`; `expires_at` is milliseconds. The phone forwards bytes without reserializing the signed canonical string.
- The device verifies the pretrusted/physically enrolled service P-256 SHA-256 DER/base64url signature and nonce, then signs the raw ticket string with its own private key. `POST /v1/enrollment/consume {ticket,proof}` atomically checks expiry/account/one-use/possession and returns `{device_id,credential}`. The phone forwards that scoped credential only within the same authenticated device setup operation; ownership-only pairing discards the issued credential. Device credentials are not persisted. Later configuration of an owned device explicitly requests `operation:'rotate_credential'` with a fresh physical nonce, the same account/source/P-256 key, and new proof; consumption revokes older device credentials without silently enabling remote sharing.
- `DELETE /v1/devices/:id`; `POST /v1/devices/:id/privacy {mode:'public',view_epoch}`. Logout is local session deletion; service-side controller-token revocation is a separate administrative action.

State responses contain complete canonical `snapshot.begin/page/end` frames. The client validates identity, stream, privacy epoch, revision, ordered pages/counts and task limits before publishing them. It rejects deltas/mixed or incomplete views. A service test imports its actual `Publication` to catch contract drift. Source time, never relay receive time, determines freshness. Account changes/logout discard phone views and invalidate older in-flight reads.

No relay is deployed here. TLS on both relay legs does **not** mean end-to-end encrypted task summaries. Operator, hosting region, retention, cost and recovery need an explicit service choice before use. The application never opens a home router port.

The optimized Android APK can be inspected with `python3 scripts/verify-android-release.py android/app/build/outputs/apk/release/app-release.apk "$ANDROID_HOME"`. This checks manifest and SDK bytecode properties; it is not a phone or BLE acceptance test.

## Validation and remaining gates

Client unit tests cover secure QR rejection, identity mismatch, expiry, network replacement, service-signature refusal, asynchronous firmware replies, HTTPS-only origins, scoped authorization, revocation, snapshot atomicity, the actual service projection and stale source timestamps. `npm run bundle` builds production Hermes JavaScript for both platforms; this is separate from compiling a native `.app`/APK.

Recorded local validation: TypeScript PASS; 26 client/service-contract tests PASS; production iOS and Android Hermes bundles PASS; native iOS simulator Debug and standalone Release `.app` builds PASS with Xcode 26.3 and ESPProvision 3.0.3. Standalone startup rendered successfully on the iPhone 17 simulator; see the [actual screen capture](screenshots/ios-now.png). The optimized native Android ARM64 release APK builds PASS; the release verifier confirms a non-debuggable manifest, disabled backup, network policy and no Log.d/v/i/w/e calls in Espressif SDK classes. Other libraries may retain unrelated logs. Real-phone/C3 BLE acceptance remains NOT RUN. No connected-account data or real Wi-Fi credentials were used for these checks.

Before claiming phone-only setup complete: compile/install both native targets; check permission denial, wrong/stale QR, spoofed name/identity, rejected physical OK, foreground/background expiry, Wi-Fi failure preserving previous settings, three-slot selection, own-hotspot use, service trust refusal, bad/replayed/cross-account tickets, relay TLS authentication, USB recovery, and repeated connect/exit. Measure ESP32-C3 BLE/Wi-Fi/TLS memory and teardown. Verify source sleep becomes visibly stale within 45 seconds. Run mixed LAN/hotspot use and measure power/traffic before battery claims. Keep UI rendering, native compilation, real BLE, firmware build and device tests separate in the final report.
