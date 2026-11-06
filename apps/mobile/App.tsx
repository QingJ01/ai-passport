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
import native, {
  currentWifiName,
  secureFetch,
} from "./modules/agent-pet-provisioning";
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
import {
  chooseSource,
  decodeStored,
  encodeStored,
  isPairingText,
  parsePairing,
  type StoredConnection,
} from "./src/pairing";
import { friendly } from "./src/friendly";
const tabs = ["Today", "Devices", "Setup", "Account"] as const;
const tabLabel: Record<(typeof tabs)[number], string> = {
  Today: "今天",
  Devices: "设备",
  Setup: "配对",
  Account: "账户",
};
const STORE_KEY = "agentpet.controller";
const PIN_HEX = /^[0-9a-f]{64}$/;
// Resolves false on cancel or dismissal, so consent always defaults to "no".
function confirm(title: string, message: string, ok: string) {
  return new Promise<boolean>((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: "取消", style: "cancel", onPress: () => resolve(false) },
        { text: ok, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}
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
function LinkButton({
  title,
  onPress,
}: {
  title: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.link}>
      <Text style={s.linkText}>{title}</Text>
    </Pressable>
  );
}
function Step({
  n,
  title,
  state,
  children,
}: {
  n: string;
  title: string;
  state: "done" | "active" | "todo";
  children?: React.ReactNode;
}) {
  return (
    <View
      style={[s.card, state === "todo" && { opacity: 0.45 }]}
      accessibilityLabel={`${n} ${title}${state === "done" ? "，已完成" : ""}`}
    >
      <Text style={s.title}>
        {state === "done" ? "✓" : n} {title}
      </Text>
      {children}
    </View>
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
  const [manualPin, setManualPin] = useState("");
  const [computerName, setComputerName] = useState("");
  const [savedName, setSavedName] = useState<string | null>();
  const [advanced, setAdvanced] = useState(false);
  const [setupAdvanced, setSetupAdvanced] = useState(false);
  const [deadline, setDeadline] = useState(0);
  const [done, setDone] = useState<string>();
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
  const [scanTarget, setScanTarget] = useState<"computer" | "device" | null>(
    null,
  );
  const scanLock = useRef(false);
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
    setReplace(undefined);
    setDeadline(0);
    setScanTarget(null);
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
    // First run: no saved computer means the pairing wizard is the starting screen.
    // Only the display name is read here; connecting still needs an explicit tap.
    SecureStore.getItemAsync(STORE_KEY)
      .then((saved) => {
        if (!saved) {
          setSavedName(null);
          setTab("Setup");
          return;
        }
        try {
          const c = decodeStored(saved);
          setSavedName(c.name ?? new URL(c.origin).hostname);
        } catch {
          setSavedName(null);
        }
      })
      .catch(() => setSavedName(null));
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
      setNotice(friendly(e));
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
    // One source needs no decision; several keep the explicit choice in Devices.
    if (src.sources.length === 1) setSource(src.sources[0].id);
    else if (!src.sources.some((x) => x.id === source)) setSource("");
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
  const connectWith = async (c: StoredConnection, persist: boolean) => {
    epoch.current++;
    setView(undefined);
    setDevices([]);
    setSources([]);
    setDevice(undefined);
    setHealth(undefined);
    setSource("");
    setRelay(undefined);
    setServiceTransport(undefined);
    const r = new Relay(c.origin, c.token, secureFetch, {
      pin: c.pin,
      fallbackOrigin: c.origin_ip,
    });
    await r.devices();
    const profile = serviceProfile(await r.service());
    if (persist) {
      await SecureStore.setItemAsync(
        STORE_KEY,
        encodeStored({ ...c, origin: r.origin }),
        {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        },
      );
      setSavedName(c.name ?? new URL(c.origin).hostname);
    }
    setServiceTransport(profile);
    setRelay(r);
    setComputerName(c.name ?? new URL(c.origin).hostname);
    await refresh(r, null);
    return r;
  };
  const restore = async () => {
    const saved = await SecureStore.getItemAsync(STORE_KEY);
    if (!saved) throw Error("No saved session");
    const c = decodeStored(saved);
    await connectWith(c, false);
    setOrigin(c.origin);
    setNotice(`已连接电脑：${c.name ?? c.origin}`);
  };
  const scan = async (target: "computer" | "device") => {
    await closeSetup();
    if (!permission?.granted) {
      const p = await requestPermission();
      if (!p.granted)
        throw Error(
          "Allow camera access in system settings to scan the screen code.",
        );
    }
    if (target === "device" && Platform.OS === "android") {
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
    if (target === "device") await prefillWifi();
    scanLock.current = false;
    setScanTarget(target);
  };
  // Best effort only. Android reveals the SSID only with location access; iOS usually does not.
  const prefillWifi = async () => {
    if (ssid) return;
    if (Platform.OS === "android") {
      const perm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
      if (!(await PermissionsAndroid.check(perm)))
        await PermissionsAndroid.request(perm, {
          title: "自动填写 Wi-Fi 名称",
          message:
            "Android 需要“位置”权限才能告诉 App 手机当前连接的 Wi-Fi 名称。拒绝也没关系，稍后手动输入即可。",
          buttonPositive: "好",
          buttonNegative: "不用了",
        }).catch(() => undefined);
    }
    const name = await currentWifiName();
    if (name) setSsid((current) => current || name);
  };
  const onCode = (data: string) => {
    const target = scanTarget;
    if (!target || busy || scanLock.current) return;
    scanLock.current = true;
    setScanTarget(null);
    if (target === "computer") {
      void run(async () => {
        if (!isPairingText(data))
          throw Error("Scan the pairing code shown on your computer");
        const pairing = parsePairing(data);
        await connectWith(pairing, true);
        setDone(undefined);
        setNotice(`已连接电脑：${pairing.name}`);
      });
      return;
    }
    void run(async () => {
      if (isPairingText(data))
        throw Error("Scan the temporary device screen code");
      const qr = parseQR(data);
      setQ(qr);
      setDone(undefined);
      setDeadline(Date.now() + 120000);
      setNotice(
        "请在设备上按 OK 确认。手机正在通过蓝牙连接设备，请放在设备旁边。",
      );
      setupTimer.current = setTimeout(() => {
        void closeSetup();
        setNotice("二维码已过期，请在设备上重新打开“连接手机”再扫一次。");
      }, 120000);
      let c: Challenge;
      try {
        c = await session.current.open(qr);
      } catch (e) {
        await closeSetup();
        throw e;
      }
      setChallenge(c);
      setNotice("设备已确认。请输入 Wi-Fi 密码。");
    });
  };
  // One button: Wi-Fi, ownership enrollment, bridge configuration and finish, inside the same
  // 120-second physical window. The bridge scanned in step 1 is the service; remote sharing still
  // needs its own default-cancel consent.
  const finishWizard = async (skipWifi: boolean) => {
    if (!relay || !q || !challenge)
      throw Error(
        "Setup expired. Open a new 120-second setup window on the device.",
      );
    try {
      const [d, src] = await Promise.all([relay.devices(), relay.sources()]);
      setDevices(d.devices);
      setSources(src.sources);
      const sourceId = chooseSource(
        src.sources,
        d.devices,
        q.device_id,
        source,
      );
      if (!sourceId) throw Error("Choose an authorized source first.");
      const choice: EnrollmentChoice =
        serviceTransport === "remote" ? "remote" : "local";
      if (
        choice === "remote" &&
        !(await confirm(
          "允许远程查看？",
          `${relay.origin}\n这个服务能读取允许共享的任务摘要。继续前请向管理员确认服务所在地区、保留期限和费用。`,
          "同意并继续",
        ))
      )
        return;
      if (!skipWifi) {
        try {
          await session.current.network(ssid, passphrase, replace);
        } finally {
          setPassphrase("");
        }
      }
      const result = await enroll({
        relay,
        session: session.current,
        qr: q,
        sourceId,
        choice,
      });
      await closeSetup();
      setDone(result.device_id);
      setNotice("");
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      // Input mistakes keep the device window open so the user can just correct them.
      if (
        !/Choose (an authorized source|which saved network)|byte SSID/.test(
          message,
        )
      )
        await closeSetup();
      throw e;
    }
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
    setComputerName("");
    setSavedName(null);
    setDone(undefined);
    await SecureStore.deleteItemAsync(STORE_KEY);
    setNotice(
      "已退出，手机上保存的电脑连接和任务缓存已清除。如果手机丢失，请在电脑上吊销这部手机的令牌。",
    );
  };
  const enrollDevice = async (choice: EnrollmentChoice) => {
    const sourceId =
      relay && q ? chooseSource(sources, devices, q.device_id, source) : null;
    if (!relay || !q || !sourceId)
      throw Error(
        "Connect your account, choose a source and scan the device again.",
      );
    const result = await enroll({
      relay,
      session: session.current,
      qr: q,
      sourceId,
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
          {tab === "Today" ? "A little closer." : tabLabel[tab]}
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
        {scanTarget && (
          <Card>
            <Text style={s.title}>
              {scanTarget === "computer"
                ? "对准电脑上的二维码"
                : "对准设备屏幕上的二维码"}
            </Text>
            <CameraView
              style={{ height: 280 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(r) => onCode(r.data)}
            />
            <LinkButton title="取消扫码" onPress={() => setScanTarget(null)} />
          </Card>
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
                    扫两次二维码、输入一次 Wi-Fi
                    密码，就能在设备上看到电脑里的任务。
                  </Text>
                  <Button title="开始配对" onPress={() => setTab("Setup")} />
                  {relay && (
                    <Button
                      title="选择已配对的设备"
                      onPress={() => setTab("Devices")}
                    />
                  )}
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
            <Step n="①" title="连接电脑" state={relay ? "done" : "active"}>
              {relay ? (
                <>
                  <Text style={s.body}>已连接：{computerName}</Text>
                  <Text style={s.muted}>
                    {serviceTransport === "remote"
                      ? "远程中继服务"
                      : "本机桥接服务"}{" "}
                    · {relay.address}
                  </Text>
                  <LinkButton
                    title="换一台电脑"
                    onPress={() => void run(() => scan("computer"))}
                  />
                </>
              ) : (
                <>
                  <Text style={s.body}>
                    在电脑的终端里运行下面这行命令，电脑上会出现一个二维码：
                  </Text>
                  <Text selectable style={s.code}>
                    tools/agent_pet_up.sh phone
                  </Text>
                  <Button
                    title="扫电脑上的二维码"
                    disabled={busy}
                    onPress={() => void run(() => scan("computer"))}
                  />
                  {savedName && (
                    <LinkButton
                      title={`使用上次的电脑（${savedName}）`}
                      onPress={() => void run(restore)}
                    />
                  )}
                </>
              )}
            </Step>
            <Step
              n="②"
              title="连接设备"
              state={done || challenge ? "done" : relay ? "active" : "todo"}
            >
              {relay && !done && !challenge && (
                <>
                  <Text style={s.body}>
                    在设备菜单里选“连接手机”，设备屏幕上会出现二维码。扫码后在设备上按
                    OK 确认。
                  </Text>
                  {q ? (
                    <Text style={s.muted}>
                      正在通过蓝牙连接设备…请在设备上按 OK。
                    </Text>
                  ) : (
                    <Button
                      title="扫设备屏幕上的二维码"
                      disabled={busy}
                      onPress={() => void run(() => scan("device"))}
                    />
                  )}
                </>
              )}
              {challenge && (
                <Text style={s.muted}>已确认设备：{q?.device_id}</Text>
              )}
              {!!deadline && (
                <Text style={s.warning}>
                  配对窗口还剩 {Math.max(0, Math.ceil((deadline - now) / 1000))}{" "}
                  秒
                </Text>
              )}
            </Step>
            <Step
              n="③"
              title="输入 Wi-Fi 密码"
              state={done ? "done" : challenge ? "active" : "todo"}
            >
              {challenge && (
                <>
                  <Field label="Wi-Fi 名称" value={ssid} set={setSsid} />
                  <Field
                    label="Wi-Fi 密码"
                    value={passphrase}
                    set={setPassphrase}
                    secret
                  />
                  <Text style={s.muted}>
                    设备只支持 2.4 GHz
                    Wi-Fi。用手机热点时，请在热点设置里打开“最大兼容性”。
                  </Text>
                  {challenge.max_network_slots !== undefined &&
                    challenge.network_slots.length >=
                      challenge.max_network_slots && (
                      <>
                        <Text style={s.body}>
                          设备已经存满 {challenge.max_network_slots} 个
                          Wi-Fi，请选一个替换。新 Wi-Fi 连不上时，旧的会保留。
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
                  {sources.length > 1 &&
                    !devices.some((d) => d.id === q?.device_id) && (
                      <>
                        <Text style={s.body}>
                          这台电脑上有多个任务来源，请选择设备要显示哪一个：
                        </Text>
                        {sources.map((x) => (
                          <Button
                            key={x.id}
                            title={`${source === x.id ? "✓ " : ""}${x.id}`}
                            onPress={() => setSource(x.id)}
                          />
                        ))}
                      </>
                    )}
                  <Button
                    title="完成配对"
                    disabled={busy}
                    onPress={() => void run(() => finishWizard(false))}
                  />
                  <LinkButton
                    title="设备已经连着 Wi-Fi，跳过这一步"
                    onPress={() => void run(() => finishWizard(true))}
                  />
                </>
              )}
            </Step>
            <Step n="④" title="完成" state={done ? "active" : "todo"}>
              {done && (
                <>
                  <Text style={s.body}>
                    设备正在连接电脑，几秒后设备屏幕上会出现你的任务。
                  </Text>
                  <Button
                    title="查看任务"
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        const d = devices.find((x) => x.id === done);
                        if (d) await selectDevice(d);
                        else setTab("Devices");
                      })
                    }
                  />
                  <LinkButton
                    title="再配一台设备"
                    onPress={() => setDone(undefined)}
                  />
                </>
              )}
            </Step>
            {(q || challenge) && (
              <LinkButton
                title="退出配对（断开蓝牙）"
                onPress={() => void run(closeSetup)}
              />
            )}
            <LinkButton
              title={setupAdvanced ? "收起高级选项" : "高级 / Advanced"}
              onPress={() => setSetupAdvanced(!setupAdvanced)}
            />
            {setupAdvanced && (
              <Card>
                <Text style={s.title}>Advanced setup</Text>
                <Text style={s.body}>
                  After scanning the device in step ②, the cards below offer
                  ownership-only pairing, Wi-Fi only, and remote-relay setup.
                  Setup closes after 120 seconds or when this app leaves the
                  foreground. The printed product QR is not a pairing secret.
                </Text>
                <Text style={s.warning}>
                  If Phone setup is unavailable on the device, use USB recovery
                  to update or configure it.
                </Text>
              </Card>
            )}
            {challenge && setupAdvanced && (
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
              <Text style={s.title}>连接电脑</Text>
              <Text style={s.body}>
                {relay
                  ? `已连接：${computerName}（${relay.address}）`
                  : "在电脑终端运行 tools/agent_pet_up.sh phone，然后扫电脑上的二维码。"}
              </Text>
              <Button
                title="扫电脑上的二维码"
                disabled={busy}
                onPress={() => void run(() => scan("computer"))}
              />
              {savedName && (
                <Button
                  title={`使用上次的电脑（${savedName}）`}
                  disabled={busy}
                  onPress={() => void run(restore)}
                />
              )}
              <Button
                title="退出并清除手机上的数据"
                disabled={busy}
                onPress={() => void run(logout)}
              />
              <LinkButton
                title={advanced ? "收起高级选项" : "高级 / Advanced"}
                onPress={() => setAdvanced(!advanced)}
              />
            </Card>
            {advanced && (
              <Card>
                <Text style={s.title}>Manual connection</Text>
                <Text style={s.body}>
                  For an existing service: use an account access token issued by
                  your service administrator. It can manage your devices and
                  view their task summaries. Never paste a model-provider API
                  key.
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
                <Field
                  label="Certificate SHA-256 pin (optional, 64 hex)"
                  value={manualPin}
                  set={setManualPin}
                />
                <Text style={s.muted}>
                  Without a pin, the phone's normal certificate trust applies,
                  so a self-signed service needs its CA installed in the OS.
                  With a pin, only that exact certificate is accepted. Remote
                  summaries use TLS to the relay; the operator can read
                  permitted fields. Confirm operator, region, retention and cost
                  with your service administrator before connecting.
                </Text>
                <Button
                  title="Connect account"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const pin = manualPin.trim().toLowerCase();
                      if (pin && !PIN_HEX.test(pin))
                        throw Error(
                          "Certificate fingerprint must be 64 lowercase hex characters",
                        );
                      const r = await connectWith(
                        {
                          origin,
                          token,
                          pin: pin || undefined,
                          name: undefined,
                        },
                        true,
                      );
                      setOrigin(r.origin);
                      setToken("");
                      setNotice("已连接。可以查看设备或开始配对。");
                    })
                  }
                />
              </Card>
            )}
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
              {tabLabel[t]}
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
  code: {
    color: "#9de7ce",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 14,
    backgroundColor: "#101a23",
    padding: 10,
    borderRadius: 8,
  },
  link: { paddingVertical: 10, alignItems: "center" },
  linkText: { color: "#9de7ce", fontSize: 14, fontWeight: "600" },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#2e404d" },
  tab: { flex: 1, paddingVertical: 20, alignItems: "center" },
});
