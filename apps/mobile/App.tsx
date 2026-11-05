import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import native, { secureFetch } from "./modules/agent-pet-provisioning";
import {
  enroll,
  serviceProfile,
  type EnrollmentChoice,
} from "./src/enrollment";
import {
  parseQR,
  SetupSession,
  type PairingQR,
  type Challenge,
} from "./src/provisioning";
import {
  Relay,
  freshness,
  snapshot,
  type Device,
  type Source,
  type View as RemoteView,
} from "./src/relay";
const tabs = ["Today", "Devices", "Setup", "Account"] as const;
function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[s.button, disabled && { opacity: 0.4 }]}
    >
      <Text style={s.buttonText}>{title}</Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  set,
  secret = false,
}: {
  label: string;
  value: string;
  set: (x: string) => void;
  secret?: boolean;
}) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={set}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
      />
    </View>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}
function AppContent() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Today");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [relay, setRelay] = useState<Relay>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [device, setDevice] = useState<Device>();
  const [view, setView] = useState<RemoteView>();
  const [health, setHealth] = useState<Record<string, unknown>>();
  const [source, setSource] = useState("");
  const [serviceTransport, setServiceTransport] = useState<
    "local" | "remote"
  >();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [q, setQ] = useState<PairingQR>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [ssid, setSsid] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [replace, setReplace] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const session = useRef(new SetupSession(native));
  const epoch = useRef(0);
  const setupTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeSetup = async () => {
    clearTimeout(setupTimer.current);
    setChallenge(undefined);
    setQ(undefined);
    setPassphrase("");
    setScanning(false);
    await session.current.close();
  };
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        epoch.current++;
        void closeSetup();
        setView(undefined);
      }
    });
    return () => {
      clearInterval(t);
      sub.remove();
      void session.current.close();
    };
  }, []);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (
    r = relay,
    selected: Device | null = device ?? null,
  ) => {
    if (!r) return;
    const generation = epoch.current;
    const [d, src, h] = await Promise.all([
      r.devices(),
      r.sources(),
      r.health(),
    ]);
    if (generation !== epoch.current) return;
    setDevices(d.devices);
    setSources(src.sources);
    if (!src.sources.some((x) => x.id === source)) setSource("");
    setHealth(h);
    if (selected) {
      try {
        const state = snapshot(await r.state(selected.id));
        if (generation === epoch.current) setView(state);
      } catch {
        if (generation === epoch.current) {
          setView(undefined);
          setNotice(
            "Snapshot unavailable. Source must publish a complete current view.",
          );
        }
      }
    }
  };
  const selectDevice = async (d: Device) => {
    const generation = epoch.current;
    setDevice(d);
    setView(undefined);
    const v = snapshot(await relay!.state(d.id));
    if (generation === epoch.current) setView(v);
    setTab("Today");
  };
  const scan = async () => {
    await closeSetup();
    if (!permission?.granted) {
      const p = await requestPermission();
      if (!p.granted)
        throw Error(
          "Allow camera access in system settings to scan the screen code.",
        );
    }
    if (Platform.OS === "android") {
      const permissions =
        Number(Platform.Version) >= 31
          ? [
              PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
              PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            ]
          : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      const result = await PermissionsAndroid.requestMultiple(permissions);
      if (
        Object.values(result).some(
          (v) => v !== PermissionsAndroid.RESULTS.GRANTED,
        )
      )
        throw Error(
          "Bluetooth permission required. Open app permissions in Settings.",
        );
    }
    setScanning(true);
  };
  const onCode = (data: string) => {
    if (!scanning || busy) return;
    setScanning(false);
    void run(async () => {
      const qr = parseQR(data);
      setQ(qr);
      setNotice(
        "Press OK on the device to enable Bluetooth, then keep it nearby while connecting securely.",
      );
      setupTimer.current = setTimeout(() => {
        void closeSetup();
        setNotice(
          "Setup window expired. Open setup on the device and scan again.",
        );
      }, 120000);
      const c = await session.current.open(qr);
      setChallenge(c);
      setNotice("Device confirmed. Choose Wi-Fi or add it to your account.");
    });
  };
  const logout = async () => {
    epoch.current++;
    await closeSetup();
    setRelay(undefined);
    setServiceTransport(undefined);
    setToken("");
    setOrigin("");
    setDevices([]);
    setSources([]);
    setDevice(undefined);
    setView(undefined);
    setHealth(undefined);
    setSource("");
    await SecureStore.deleteItemAsync("agentpet.controller");
    setNotice(
      "Signed out. Local account data cleared. Revoke the phone token at the service if lost.",
    );
  };
  const enrollDevice = async (choice: EnrollmentChoice) => {
    if (!relay || !q || !source)
      throw Error(
        "Connect your account, choose a source and scan the device again.",
      );
    const result = await enroll({
      relay,
      session: session.current,
      qr: q,
      sourceId: source,
      choice,
    });
    if (result.alreadyPaired) {
      setNotice(
        "This device is already paired to your account. Choose Finish setup or configure its connection.",
      );
      return;
    }
    await closeSetup();
    await refresh();
    setNotice(
      choice === "remote"
        ? "Remote view configured. Check the device and refresh its online status."
        : choice === "local"
          ? "Local bridge configured. Check the device connection. Remote sharing was not changed."
          : "Ownership paired. Existing connections are preserved.",
    );
  };
  const currentSource = sources.find((x) => x.id === device?.source_id);
  const fresh =
    !!view &&
    freshness(
      currentSource?.source_updated_at ?? view.source_updated_at,
      now,
    ) === "fresh" &&
    currentSource?.connected === true;
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.eyebrow}>AI PASSPORT / COMPANION</Text>
        <Text style={s.heading}>
          {tab === "Today" ? "A little closer." : tab}
        </Text>
        <Text style={s.muted}>
          {device
            ? fresh
              ? "Source online"
              : "Last known state"
            : "Ready to pair"}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        {(notice || busy) && (
          <View accessibilityLiveRegion="polite" style={s.notice}>
            <Text style={s.body}>
              {busy ? "Working… " : ""}
              {notice}
            </Text>
          </View>
        )}
        {tab === "Today" && (
          <>
            <Card>
              <View style={s.pet} accessibilityLabel="A small whale" accessible>
                <View style={s.whaleBody} />
                <View style={s.whaleEye} />
                <View style={s.whaleSmile} />
                <View style={s.whaleFin} />
                <View style={s.whaleTail} />
                <View style={s.whaleFluke} />
                <View style={s.whaleSpout} />
                <View style={s.whaleSpray} />
              </View>
              <Text style={s.title}>
                {device?.id ?? "Your companion, anywhere"}
              </Text>
              {device ? (
                <>
                  <Text
                    style={[s.badge, { color: fresh ? "#8de6c3" : "#f4c181" }]}
                  >
                    {fresh
                      ? "SOURCE ONLINE"
                      : currentSource?.connected === false
                        ? "COMPUTER OFFLINE"
                        : "LAST KNOWN STATE"}
                  </Text>
                  <Text style={s.muted}>
                    Last sync:{" "}
                    {currentSource?.source_updated_at ??
                      view?.source_updated_at ??
                      "Not available yet"}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={s.body}>
                    Set up your AI Passport to follow your tasks wherever you
                    go.
                  </Text>
                  <Button
                    title="Set up a device"
                    onPress={() => setTab("Setup")}
                  />
                  <Button
                    title={
                      relay ? "Choose an account device" : "Connect account"
                    }
                    onPress={() => setTab(relay ? "Devices" : "Account")}
                  />
                </>
              )}
            </Card>
            {device && (
              <>
                <Button
                  title="Refresh"
                  disabled={!relay || busy}
                  onPress={() => void run(() => refresh())}
                />
                <Text style={s.section}>Tasks</Text>
                {view?.tasks.length ? (
                  view.tasks.map((t) => (
                    <Card key={t.id}>
                      <Text style={s.title}>{t.title ?? "Private task"}</Text>
                      <Text style={s.badge}>
                        {t.state} · {t.entity_kind ?? "task"}
                      </Text>
                      <Text style={s.muted}>
                        {t.execution_state ?? "Execution state unknown"}
                      </Text>
                    </Card>
                  ))
                ) : (
                  <Text style={s.muted}>
                    No task updates yet. Check your source connection and
                    refresh.
                  </Text>
                )}
                <Text style={s.section}>Usage</Text>
                <Card>
                  <Text style={s.muted}>Loaded sessions · lifetime</Text>
                  <Text style={s.title}>
                    {typeof view?.usage?.tokens === "string"
                      ? view.usage.tokens + " tokens"
                      : "Usage unavailable"}
                  </Text>
                  <Text style={s.muted}>Today's total: unavailable</Text>
                  <Button
                    title="About these totals"
                    onPress={() => setTab("Account")}
                  />
                </Card>
                <Text style={s.section}>Connection health</Text>
                <Card>
                  <Text style={s.body}>
                    Relay: {health ? "available" : "not checked"}
                    {`\n`}Device:{" "}
                    {device
                      ? "selected; live network health unavailable"
                      : "not selected"}
                    {`\n`}Bridge/source:{" "}
                    {currentSource?.connected
                      ? "connected"
                      : "offline or unknown"}
                    {`\n`}Data freshness:{" "}
                    {fresh ? "within 45 seconds" : "stale or unknown"}
                  </Text>
                </Card>
              </>
            )}
          </>
        )}
        {tab === "Devices" && (
          <>
            <Text style={s.body}>
              Select one authorized device. A room name or QR alone never grants
              account access.
            </Text>
            <Button
              title="Refresh devices and sources"
              disabled={!relay || busy}
              onPress={() => void run(() => refresh())}
            />
            {devices.map((d) => (
              <Card key={d.id}>
                <Text style={s.title}>{d.id}</Text>
                <Text style={s.muted}>
                  Source {d.source_id} ·{" "}
                  {serviceTransport === "remote"
                    ? d.remote_enabled
                      ? "Remote enabled"
                      : "Remote disabled"
                    : "Local bridge"}
                </Text>
                <Button
                  title="View tasks"
                  onPress={() => void run(() => selectDevice(d))}
                />
                {serviceTransport === "remote" && (
                  <Button
                    title={
                      d.remote_enabled
                        ? "Disable remote view"
                        : "Enable remote view"
                    }
                    onPress={() =>
                      Alert.alert(
                        d.remote_enabled
                          ? "Disable remote view?"
                          : "Enable remote summaries?",
                        d.remote_enabled
                          ? "The service clears this device’s remote cache. Check the device for credential teardown."
                          : "The relay operator can read the permitted task summaries. Confirm its region, retention and cost before enabling.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Continue",
                            onPress: () =>
                              void run(async () => {
                                epoch.current++;
                                setView(undefined);
                                await relay!.remote(d.id, !d.remote_enabled);
                                await refresh();
                                setNotice(
                                  "Remote policy updated. Verify the device connection separately.",
                                );
                              }),
                          },
                        ],
                      )
                    }
                  />
                )}
                <Button
                  title="Use public mode"
                  onPress={() =>
                    Alert.alert(
                      "Enable public mode?",
                      "The relay cache is cleared. Physical device policy must also be applied before wearing it publicly.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Enable",
                          onPress: () =>
                            void run(async () => {
                              epoch.current++;
                              setView(undefined);
                              await relay!.privacy(d.id, `phone-${Date.now()}`);
                              setNotice(
                                "Privacy change requested. Await a matching filtered snapshot.",
                              );
                            }),
                        },
                      ],
                    )
                  }
                />
                <Button
                  title="Revoke device"
                  onPress={() =>
                    Alert.alert("Revoke this device?", d.id, [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Revoke",
                        style: "destructive",
                        onPress: () =>
                          void run(async () => {
                            epoch.current++;
                            setView(undefined);
                            await relay!.revoke(d.id);
                            setDevice(undefined);
                            await refresh(relay, null);
                            setNotice(
                              "Device revoked; old credentials cannot reconnect.",
                            );
                          }),
                      },
                    ])
                  }
                />
              </Card>
            ))}
            <Text style={s.section}>Authorized sources</Text>
            {sources.map((x) => (
              <Card key={x.id}>
                <Text style={s.title}>{x.id}</Text>
                <Text style={s.muted}>
                  {x.connected ? "Bridge connected" : "Bridge offline"} ·{" "}
                  {freshness(x.source_updated_at, now)}
                  {`\n`}
                  {x.source_updated_at ?? "No source timestamp"}
                </Text>
                <Button
                  title={
                    source === x.id
                      ? "Selected for enrollment"
                      : "Use for new enrollment"
                  }
                  onPress={() => setSource(x.id)}
                />
              </Card>
            ))}
          </>
        )}
        {tab === "Setup" && (
          <>
            <Card>
              <Text style={s.title}>Set up with your phone</Text>
              <Text style={s.body}>
                For remote tasks, connect your account and choose a source in
                Devices first. Open Phone setup on the device. Scan its
                temporary screen QR, then press physical OK. The printed product
                QR is not a pairing secret. Setup closes after 120 seconds or
                when this app leaves the foreground.
              </Text>
              <Text style={s.warning}>
                If Phone setup is unavailable on the device, use USB recovery to
                update or configure it.
              </Text>
              <Button
                title="Scan device screen"
                disabled={busy}
                onPress={() => void run(scan)}
              />
              {scanning && (
                <CameraView
                  style={{ height: 260 }}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={(r) => onCode(r.data)}
                />
              )}
              <Button
                title="Exit setup / disconnect BLE"
                onPress={() => void run(closeSetup)}
              />
            </Card>
            {challenge && (
              <>
                <Card>
                  <Text style={s.title}>Network</Text>
                  <Text style={s.muted}>Confirmed device: {q?.device_id}</Text>
                  <Field
                    label="2.4 GHz Wi-Fi / hotspot SSID"
                    value={ssid}
                    set={setSsid}
                  />
                  <Field
                    label="Wi-Fi passphrase"
                    value={passphrase}
                    set={setPassphrase}
                    secret
                  />
                  <Text style={s.muted}>
                    Saved networks: {challenge.network_slots.length} /{" "}
                    {challenge.max_network_slots ?? "unknown"}. This firmware
                    supports the capacity shown above.
                  </Text>
                  {challenge.max_network_slots !== undefined &&
                    challenge.network_slots.length >=
                      challenge.max_network_slots && (
                      <>
                        <Text style={s.body}>
                          Saved-network capacity is full. Choose which network
                          to replace only after the candidate path is validated.
                          Failure must preserve the previous network.
                        </Text>
                        {challenge.network_slots.map((n, i) => (
                          <Button
                            key={i}
                            title={`${replace === i ? "✓ " : ""}${n}`}
                            onPress={() => setReplace(i)}
                          />
                        ))}
                      </>
                    )}
                  <Button
                    title="Connect to Wi-Fi"
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        try {
                          await session.current.network(
                            ssid,
                            passphrase,
                            replace,
                          );
                          setNotice(
                            "Wi-Fi tested. Settings are pending until the device confirms its connection. Complete setup below.",
                          );
                        } catch (e) {
                          await closeSetup();
                          throw e;
                        } finally {
                          setPassphrase("");
                        }
                      })
                    }
                  />
                </Card>
                <Card>
                  <Text style={s.title}>Account enrollment</Text>
                  <Text style={s.body}>
                    Service: {relay?.origin ?? "Connect your account first"} ·{" "}
                    {serviceTransport === "local"
                      ? "Local bridge"
                      : serviceTransport === "remote"
                        ? "Remote relay"
                        : "Not connected"}
                    {"\n"}Source:{" "}
                    {source || "Select an authorized source in Devices"}.
                    Confirm the service address before adding your device.
                    Existing ownership cannot be overwritten.
                  </Text>
                  <Button
                    title="Pair ownership only"
                    disabled={!relay || !source || !serviceTransport || busy}
                    onPress={() => void run(() => enrollDevice("pair-only"))}
                  />
                  {serviceTransport === "local" ? (
                    <Button
                      title="Connect local bridge"
                      disabled={!relay || !source || busy}
                      onPress={() => void run(() => enrollDevice("local"))}
                    />
                  ) : (
                    <Button
                      title="Add for remote view"
                      disabled={!relay || !source || !serviceTransport || busy}
                      onPress={() =>
                        Alert.alert(
                          "Enable remote view?",
                          `${relay?.origin}\nThis service can read the permitted task summaries. Confirm its region, retention and cost with your administrator before continuing.`,
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Enable and add",
                              onPress: () =>
                                void run(() => enrollDevice("remote")),
                            },
                          ],
                        )
                      }
                    />
                  )}
                  <Button
                    title="Finish setup"
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        await session.current.finish();
                        await closeSetup();
                        setNotice(
                          "Setup closed. Check your device and refresh the account view for online status.",
                        );
                      })
                    }
                  />
                </Card>
              </>
            )}
            <Text style={s.section}>Travel / hotspot</Text>
            <Card>
              <Text style={s.body}>
                iPhone: Settings → Personal Hotspot → Allow Others to Join.
                Enable Maximize Compatibility when available.{`\n\n`}Android:
                Settings → Hotspot & tethering → Wi-Fi hotspot → choose 2.4 GHz
                or Compatibility mode.{`\n\n`}Enter the hotspot name and
                passphrase manually above. Your phone need not join its own
                hotspot. Keep hotspot enabled after closing the app. Captive
                portals, enterprise 802.1X and 5 GHz-only networks are not
                supported.
              </Text>
              <Button
                title="Open app settings"
                onPress={() => void Linking.openSettings()}
              />
              <Text style={s.muted}>
                Keep your hotspot on while the device connects. Check cellular
                traffic and battery in system settings.
              </Text>
            </Card>
          </>
        )}
        {tab === "Account" && (
          <>
            <Card>
              <Text style={s.title}>Connect your service</Text>
              <Text style={s.body}>
                Use an account access token issued by your service
                administrator. It can manage your devices and view their task
                summaries. Browser sign-in and account recovery are not
                available in this version. Never paste a model-provider API key.
              </Text>
              <Field
                label="Trusted service HTTPS origin"
                value={origin}
                set={setOrigin}
              />
              <Field
                label="Controller access token"
                value={token}
                set={setToken}
                secret
              />
              <Text style={s.muted}>
                Remote summaries use TLS to the relay; the operator can read
                permitted fields. Confirm operator, region, retention and cost
                with your service administrator before connecting. No service is
                deployed by this app.
              </Text>
              <Button
                title="Connect account"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    epoch.current++;
                    setView(undefined);
                    setDevices([]);
                    setSources([]);
                    setDevice(undefined);
                    setHealth(undefined);
                    setSource("");
                    setRelay(undefined);
                    setServiceTransport(undefined);
                    const r = new Relay(origin, token, secureFetch);
                    await r.devices();
                    const profile = serviceProfile(await r.service());
                    await SecureStore.setItemAsync(
                      "agentpet.controller",
                      JSON.stringify({ origin: r.origin, token }),
                      {
                        keychainAccessible:
                          SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
                      },
                    );
                    setServiceTransport(profile);
                    setRelay(r);
                    setToken("");
                    await refresh(r, null);
                    setNotice(
                      "Account connected. Choose a device or start setup.",
                    );
                  })
                }
              />
              <Button
                title="Restore saved account"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const saved = await SecureStore.getItemAsync(
                      "agentpet.controller",
                    );
                    if (!saved) throw Error("No saved session");
                    const c = JSON.parse(saved);
                    epoch.current++;
                    setView(undefined);
                    setDevice(undefined);
                    setDevices([]);
                    setSources([]);
                    setSource("");
                    setHealth(undefined);
                    setRelay(undefined);
                    const r = new Relay(c.origin, c.token, secureFetch);
                    await r.devices();
                    const profile = serviceProfile(await r.service());
                    setOrigin(c.origin);
                    setServiceTransport(profile);
                    setRelay(r);
                    await refresh(r, null);
                    setNotice("Saved account connection restored.");
                  })
                }
              />
              <Button
                title="Sign out and clear phone cache"
                disabled={busy}
                onPress={() => void run(logout)}
              />
            </Card>
            <Card>
              <Text style={s.title}>About your updates</Text>
              <Text style={s.body}>
                Updates come from your authorized source computer or server.
                When it sleeps or goes offline, you see its last sync time. Task
                decisions and approvals stay on that source. Usage shows
                lifetime totals for loaded sessions; today's usage is
                unavailable until daily attribution is supported.
              </Text>
            </Card>
            <Card>
              <Text style={s.title}>Privacy & recovery</Text>
              <Text style={s.body}>
                Wi-Fi credentials and pairing QR secrets stay in memory only.
                Logout clears phone snapshots and the stored controller token.
                Device revocation is separate from resetting a device. Lost
                phone: revoke its controller token at your service. Ownership
                transfer and private mode require physical confirmation.
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
      <View style={s.tabs}>
        {tabs.map((t) => (
          <Pressable
            key={t}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            style={s.tab}
            onPress={() => {
              if (tab === "Setup" && t !== "Setup") void closeSetup();
              setTab(t);
            }}
          >
            <Text
              style={{
                color: tab === t ? "#9de7ce" : "#8b98a7",
                fontWeight: "700",
              }}
            >
              {t}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#101a23" },
  header: { padding: 24, paddingBottom: 14 },
  eyebrow: {
    color: "#9de7ce",
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "700",
  },
  heading: {
    color: "#f4f2eb",
    fontSize: 32,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  muted: { color: "#a5b4bf", fontSize: 13, lineHeight: 21 },
  body: { color: "#e2e8e9", fontSize: 15, lineHeight: 24 },
  content: { padding: 20, paddingBottom: 32, gap: 14 },
  notice: {
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: "#8de6c3",
    backgroundColor: "#1d303b",
  },
  card: { backgroundColor: "#1b2a35", padding: 20, borderRadius: 20, gap: 12 },
  title: { fontSize: 19, fontWeight: "600", color: "#f2f3ed" },
  section: { fontSize: 21, fontWeight: "600", color: "#f2f3ed", marginTop: 12 },
  pet: { width: 160, height: 94, alignSelf: "center", marginBottom: 12 },
  whaleBody: {
    position: "absolute",
    left: 12,
    top: 28,
    width: 104,
    height: 58,
    borderTopLeftRadius: 40,
    borderBottomLeftRadius: 32,
    borderTopRightRadius: 30,
    borderBottomRightRadius: 24,
    backgroundColor: "#9de7ce",
  },
  whaleEye: {
    position: "absolute",
    left: 32,
    top: 46,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#11202a",
  },
  whaleSmile: {
    position: "absolute",
    left: 26,
    top: 57,
    width: 17,
    height: 9,
    borderBottomWidth: 2,
    borderColor: "#11202a",
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
  },
  whaleFin: {
    position: "absolute",
    left: 68,
    top: 66,
    width: 22,
    height: 14,
    borderRadius: 9,
    backgroundColor: "#4ba991",
    transform: [{ rotate: "-30deg" }],
  },
  whaleTail: {
    position: "absolute",
    left: 100,
    top: 39,
    width: 36,
    height: 13,
    borderRadius: 7,
    backgroundColor: "#9de7ce",
    transform: [{ rotate: "-25deg" }],
  },
  whaleFluke: {
    position: "absolute",
    left: 122,
    top: 16,
    width: 14,
    height: 31,
    borderTopLeftRadius: 14,
    borderBottomRightRadius: 14,
    backgroundColor: "#9de7ce",
    transform: [{ rotate: "25deg" }],
  },
  whaleSpout: {
    position: "absolute",
    left: 48,
    top: 10,
    width: 5,
    height: 13,
    borderRadius: 3,
    backgroundColor: "#9de7ce",
  },
  whaleSpray: {
    position: "absolute",
    left: 42,
    top: 5,
    width: 17,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#9de7ce",
  },
  badge: {
    fontSize: 12,
    fontWeight: "700",
    color: "#a4d4ee",
    letterSpacing: 1,
  },
  button: {
    backgroundColor: "#9de7ce",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: { color: "#102c27", fontSize: 14, fontWeight: "700" },
  input: {
    borderWidth: 1,
    borderColor: "#516775",
    borderRadius: 10,
    color: "#f2f3ed",
    padding: 13,
    marginTop: 6,
    fontSize: 16,
  },
  label: { color: "#c3d1da", fontSize: 13 },
  warning: { color: "#f1c284", fontSize: 13, lineHeight: 21 },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#2e404d" },
  tab: { flex: 1, paddingVertical: 20, alignItems: "center" },
});
