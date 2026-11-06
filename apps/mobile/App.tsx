import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
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
  utf8Bytes,
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
import {
  ago,
  compact,
  effectiveState,
  taskState,
  type Tone,
} from "./src/format";
import {
  failureText,
  hotspotGuide,
  networkList,
  suggested,
  WifiError,
  type Network,
  type NetworkKind,
} from "./src/wifi";
const tabs = ["Today", "Devices", "Setup", "Account"] as const;
type Tab = (typeof tabs)[number];
const tabLabel: Record<Tab, string> = {
  Today: "首页",
  Devices: "设备",
  Setup: "配对",
  Account: "我的",
};
const STORE_KEY = "agentpet.controller";
const NETWORK_KEY = "agentpet.network";
const PIN_HEX = /^[0-9a-f]{64}$/;
const WINDOW_MS = 120000;
// iOS system colours (light / dark), so the app looks like part of the phone.
const LIGHT = {
  bg: "#F2F2F7",
  card: "#FFFFFF",
  label: "#000000",
  secondary: "rgba(60,60,67,0.6)",
  tertiary: "rgba(60,60,67,0.3)",
  separator: "rgba(60,60,67,0.29)",
  fill: "rgba(118,118,128,0.12)",
  bar: "rgba(249,249,249,0.94)",
  tint: "#007AFF",
  green: "#34C759",
  orange: "#FF9500",
  red: "#FF3B30",
  gray: "#8E8E93",
};
type Palette = typeof LIGHT;
const DARK: Palette = {
  bg: "#000000",
  card: "#1C1C1E",
  label: "#FFFFFF",
  secondary: "rgba(235,235,245,0.6)",
  tertiary: "rgba(235,235,245,0.3)",
  separator: "rgba(84,84,88,0.65)",
  fill: "rgba(118,118,128,0.24)",
  bar: "rgba(22,22,24,0.94)",
  tint: "#0A84FF",
  green: "#30D158",
  orange: "#FF9F0A",
  red: "#FF453A",
  gray: "#8E8E93",
};
const toneColor = (c: Palette, tone: Tone) =>
  ({ good: c.green, warn: c.orange, bad: c.red, idle: c.gray })[tone];
const Theme = createContext({ c: LIGHT, s: makeStyles(LIGHT) });
const useTheme = () => useContext(Theme);
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
  quiet = false,
  danger = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
  danger?: boolean;
}) {
  const { s, c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        s.button,
        (quiet || danger) && s.buttonQuiet,
        danger && s.buttonDanger,
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text
        style={[
          s.buttonText,
          quiet && s.buttonQuietText,
          danger && s.buttonDangerText,
        ]}
      >
        {title}
      </Text>
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
  const { s, c } = useTheme();
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
  summary,
  action,
  children,
}: {
  n: number;
  title: string;
  state: "done" | "active" | "todo";
  summary?: string;
  action?: { title: string; onPress: () => void };
  children?: React.ReactNode;
}) {
  const { s, c } = useTheme();
  return (
    <View
      style={[s.card, state === "todo" && { opacity: 0.5 }]}
      accessibilityLabel={`第 ${n} 步 ${title}${state === "done" ? "，已完成" : ""}`}
    >
      <View style={s.stepHead}>
        <View style={[s.stepDot, state === "done" && s.stepDotDone]}>
          <Text
            style={[s.stepDotText, state === "done" && { color: "#FFFFFF" }]}
          >
            {state === "done" ? "✓" : n}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{title}</Text>
          {state === "done" && summary ? (
            <Text style={s.muted}>{summary}</Text>
          ) : null}
        </View>
        {state === "done" && action ? (
          <Pressable
            accessibilityRole="button"
            onPress={action.onPress}
            hitSlop={8}
          >
            <Text style={s.linkText}>{action.title}</Text>
          </Pressable>
        ) : null}
      </View>
      {state === "active" && children}
      {state === "done" && children}
    </View>
  );
}
function Field({
  label,
  value,
  set,
  secret = false,
  placeholder,
}: {
  label: string;
  value: string;
  set: (x: string) => void;
  secret?: boolean;
  placeholder?: string;
}) {
  const { s, c } = useTheme();
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
        placeholder={placeholder}
        placeholderTextColor={c.tertiary}
        style={s.input}
      />
    </View>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  const { s, c } = useTheme();
  return <View style={s.card}>{children}</View>;
}
// A numbered how-to list. Each step can carry a smaller "why" line.
function Guide({ steps }: { steps: { text: string; hint?: string }[] }) {
  const { s, c } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      {steps.map((x, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 10 }}>
          <Text style={s.guideNumber}>{i + 1}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.body}>{x.text}</Text>
            {x.hint ? <Text style={s.muted}>{x.hint}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}
// Small status chip: coloured dot plus text.
function Pill({ tone, text }: { tone: Tone; text: string }) {
  const { s, c } = useTheme();
  return (
    <View style={s.pill}>
      <View style={[s.dot, { backgroundColor: toneColor(c, tone) }]} />
      <Text style={s.pillText}>{text}</Text>
    </View>
  );
}
function Tile({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  const { s, c } = useTheme();
  return (
    <View style={s.tile} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={[s.tileValue, warn && { color: c.orange }]}>{value}</Text>
      <Text style={s.muted}>{label}</Text>
    </View>
  );
}
// iOS list row with a checkmark when selected.
function Option({
  title,
  detail,
  selected,
  first = false,
  onPress,
}: {
  title: string;
  detail?: string;
  selected: boolean;
  first?: boolean;
  onPress: () => void;
}) {
  const { s } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        s.option,
        !first && s.divider,
        pressed && s.pressed,
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.optionTitle}>{title}</Text>
        {detail ? <Text style={s.muted}>{detail}</Text> : null}
      </View>
      <Text style={s.check}>{selected ? "✓" : ""}</Text>
    </Pressable>
  );
}
// Four signal bars, filled up to n.
function Bars({ n }: { n: number }) {
  const { s, c } = useTheme();
  return (
    <View style={s.bars} accessible={false}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[s.bar, { height: 4 + i * 3 }, i <= n && s.barOn]}
        />
      ))}
    </View>
  );
}
// Collapsible "having trouble?" block.
function Help({
  title,
  open,
  toggle,
  children,
}: {
  title: string;
  open: boolean;
  toggle: () => void;
  children: React.ReactNode;
}) {
  const { s, c } = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        onPress={toggle}
        style={s.disclosure}
      >
        <Text style={s.linkText}>{title}</Text>
        <Text style={[s.chevron, open && { transform: [{ rotate: "90deg" }] }]}>
          ›
        </Text>
      </Pressable>
      {open && <View style={s.help}>{children}</View>}
    </View>
  );
}
function AppContent() {
  const { s, c } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("Today");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [manualPin, setManualPin] = useState("");
  const [computerName, setComputerName] = useState("");
  const [savedName, setSavedName] = useState<string | null>();
  const [restoring, setRestoring] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [setupAdvanced, setSetupAdvanced] = useState(false);
  const [help, setHelp] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [done, setDone] = useState<string>();
  const [online, setOnline] = useState<
    "waiting" | "online" | "timeout" | "unknown"
  >();
  const [onlineTry, setOnlineTry] = useState(0);
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
  const [pulling, setPulling] = useState(false);
  const [notice, setNotice] = useState("");
  const [scanTarget, setScanTarget] = useState<"computer" | "device" | null>(
    null,
  );
  const scanLock = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [q, setQ] = useState<PairingQR>();
  const [challenge, setChallenge] = useState<Challenge>();
  // Which network the device should join; remembered between launches.
  const [netKind, setNetKind] = useState<NetworkKind | null>(null);
  const [hotspotReady, setHotspotReady] = useState(false);
  const [phoneWifi, setPhoneWifi] = useState<string | null>(null);
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manualSsid, setManualSsid] = useState(false);
  const [ssid, setSsid] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [wifiError, setWifiError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [replace, setReplace] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const session = useRef(new SetupSession(native));
  const epoch = useRef(0);
  const setupLive = useRef(false);
  const setupTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  setupLive.current = !!q;
  const closeSetup = async () => {
    clearTimeout(setupTimer.current);
    setChallenge(undefined);
    setQ(undefined);
    setPassphrase("");
    setShowPass(false);
    setReplace(undefined);
    setDeadline(0);
    setScanTarget(null);
    setNetworks(null);
    setManualSsid(false);
    setWifiError("");
    setConnecting(false);
    await session.current.close();
  };
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    // Only a real switch away counts. iOS also reports "inactive" while a permission
    // prompt (Bluetooth, camera, local network) is on screen, which is exactly when a
    // first pairing is in progress, so that state must not end setup.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        epoch.current++;
        // Setup secrets live only in memory and the device window is short, so leaving
        // the app ends setup. Say so, so people know why they need to scan again.
        if (setupLive.current)
          setNotice(
            "刚才离开了 App，配对已断开。在设备上重新打开“连接手机”，再扫一次设备的码。",
          );
        void closeSetup();
        setView(undefined);
      }
    });
    SecureStore.getItemAsync(NETWORK_KEY)
      .then((kind) => {
        if (kind === "wifi" || kind === "hotspot") {
          setNetKind(kind);
          setHotspotReady(kind === "hotspot");
        }
      })
      .catch(() => undefined);
    // First run: no saved computer means the pairing wizard is the starting screen.
    // A saved computer reconnects by itself; a failure just leaves a retry button.
    SecureStore.getItemAsync(STORE_KEY)
      .then((saved) => {
        if (!saved) {
          setSavedName(null);
          setTab("Setup");
          return;
        }
        let c: StoredConnection;
        try {
          c = decodeStored(saved);
        } catch {
          setSavedName(null);
          return;
        }
        const name = c.name ?? new URL(c.origin).hostname;
        setSavedName(name);
        setRestoring(true);
        connectWith(c, false)
          .then(() => setOrigin(c.origin))
          .catch(() =>
            setNotice(
              `暂时连不上电脑「${name}」。电脑开着并运行 tools/agent_pet_up.sh 时，点“重新连接”就好。`,
            ),
          )
          .finally(() => setRestoring(false));
      })
      .catch(() => setSavedName(null));
    return () => {
      clearInterval(t);
      sub.remove();
      void session.current.close();
    };
  }, []);
  // After setup, watch the bridge until the device actually connects.
  useEffect(() => {
    if (!done || !relay) return;
    let stop = false;
    const started = Date.now();
    setOnline("waiting");
    (async () => {
      while (!stop) {
        try {
          const d = (await relay.devices()).devices.find((x) => x.id === done);
          if (stop) return;
          if (d && d.online === undefined) {
            setOnline("unknown");
            return;
          }
          if (d?.online) {
            setOnline("online");
            setDevices((list) =>
              list.map((x) => (x.id === d.id ? { ...x, online: true } : x)),
            );
            return;
          }
        } catch {
          // The bridge may be restarting; keep waiting until the timeout.
        }
        if (Date.now() - started > 75000) {
          if (!stop) setOnline("timeout");
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [done, relay, onlineTry]);
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
  const chooseNetwork = (kind: NetworkKind) => {
    setNetKind(kind);
    setHotspotReady(false);
    SecureStore.setItemAsync(NETWORK_KEY, kind).catch(() => undefined);
  };
  const refresh = async (
    r = relay,
    selected: Device | null = device ?? null,
  ): Promise<Device[] | undefined> => {
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
          setNotice("暂时拿不到任务数据，等电脑上的数据源连上后再刷新。");
        }
      }
    }
    return d.devices;
  };
  const selectDevice = async (d: Device, r = relay, jump = true) => {
    const generation = epoch.current;
    setDevice(d);
    setView(undefined);
    const v = snapshot(await r!.state(d.id));
    if (generation === epoch.current) setView(v);
    if (jump) setTab("Today");
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
    const list = await refresh(r, null);
    // One paired device: show it straight away instead of asking.
    if (list?.length === 1)
      await selectDevice(list[0], r, false).catch(() => undefined);
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
  // Best effort only. Android reveals the SSID only with location access; iOS usually does not.
  const readPhoneWifi = async () => {
    if (netKind === "hotspot") return null;
    if (Platform.OS === "android") {
      const perm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
      if (!(await PermissionsAndroid.check(perm)))
        await PermissionsAndroid.request(perm, {
          title: "自动选中你的 Wi-Fi",
          message:
            "Android 需要“位置”权限才能告诉 App 手机现在连的是哪个 Wi-Fi。拒绝也没关系，等会儿在列表里点一下就行。",
          buttonPositive: "好",
          buttonNegative: "不用了",
        }).catch(() => undefined);
    }
    const name = await currentWifiName();
    setPhoneWifi(name);
    return name;
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
    if (target === "device") await readPhoneWifi();
    scanLock.current = false;
    setScanTarget(target);
  };
  // Ask the device which networks it sees. It only reports 2.4 GHz ones, so the list
  // doubles as a check that the hotspot or router is actually reachable.
  const scanNetworks = async (preferred = phoneWifi) => {
    setScanning(true);
    setWifiError("");
    try {
      const list = networkList(await session.current.scan());
      setNetworks(list);
      const pick = suggested(list, preferred);
      if (pick) setSsid((current) => current || pick);
    } catch {
      // Old firmware or a failed scan: typing the name still works.
      setNetworks(null);
      setManualSsid(true);
    } finally {
      setScanning(false);
    }
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
        setNotice("");
      });
      return;
    }
    void run(async () => {
      if (isPairingText(data))
        throw Error("Scan the temporary device screen code");
      const qr = parseQR(data);
      setQ(qr);
      setDone(undefined);
      setSsid("");
      setDeadline(Date.now() + WINDOW_MS);
      setNotice("");
      setupTimer.current = setTimeout(() => {
        void closeSetup();
        setNotice(
          "配对时间到了（2 分钟）。在设备上重新打开“连接手机”，再扫一次就行。",
        );
      }, WINDOW_MS);
      let c: Challenge;
      try {
        c = await session.current.open(qr);
      } catch (e) {
        await closeSetup();
        throw e;
      }
      setChallenge(c);
      void scanNetworks();
    });
  };
  // One button: Wi-Fi, ownership enrollment, bridge configuration and finish, inside the same
  // 120-second physical window. The bridge scanned in step 2 is the service; remote sharing still
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
        setWifiError("");
        setConnecting(true);
        try {
          await session.current.network(ssid.trim(), passphrase, replace);
        } catch (e) {
          if (!(e instanceof WifiError)) throw e;
          const kind = netKind ?? "wifi";
          if (e.reason === "auth") setPassphrase("");
          if (e.retryable) {
            // The device window is still open: fix the input and press Connect again.
            setWifiError(failureText(e.reason, kind));
            return;
          }
          await closeSetup();
          setNotice(
            `${failureText(e.reason, kind)}\n改好后，在设备上重新打开“连接手机”再扫一次。`,
          );
          return;
        } finally {
          setConnecting(false);
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
      "已退出，手机上保存的电脑连接和任务缓存已清除。如果手机丢了，请在电脑上吊销这部手机的令牌。",
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
        "这台设备已经在你的账户里了。可以直接点“结束配对”，或者重新设置它的连接。",
      );
      return;
    }
    await closeSetup();
    await refresh();
    setNotice(
      choice === "remote"
        ? "已设置远程查看。请看一下设备，再刷新在线状态。"
        : choice === "local"
          ? "已连接本机桥接服务。远程共享设置没有改动。"
          : "已完成配对，原有连接保持不变。",
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
  const kind = netKind ?? "wifi";
  const networkReady = !!netKind && (netKind === "wifi" || hotspotReady);
  const selected = networks?.find((n) => n.ssid === ssid);
  const needsPassword = manualSsid || !selected || selected.secure;
  const passBytes = utf8Bytes(passphrase);
  // A typed-in name may be an open network, so an empty password is allowed there.
  const passOk = needsPassword
    ? (passBytes >= 8 && passBytes <= 63) || (manualSsid && passphrase === "")
    : passphrase === "";
  const slotsFull =
    !!challenge &&
    challenge.max_network_slots !== undefined &&
    challenge.network_slots.length >= challenge.max_network_slots;
  const canConnect =
    !!ssid.trim() &&
    passOk &&
    !scanning &&
    (!slotsFull || replace !== undefined);
  const toggle = (key: string) => setHelp(help === key ? null : key);
  const deviceOnline = devices.find((d) => d.id === device?.id)?.online;
  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <Text style={s.heading}>
          {tab === "Today" ? "Agent Pet" : tabLabel[tab]}
        </Text>
        <Pill
          tone={relay ? "good" : restoring ? "idle" : "warn"}
          text={
            relay
              ? `已连接电脑 · ${computerName}`
              : restoring
                ? `正在连接「${savedName}」…`
                : "还没连接电脑"
          }
        />
      </View>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          relay && tab !== "Setup" ? (
            <RefreshControl
              refreshing={pulling}
              tintColor={c.gray}
              onRefresh={() => {
                setPulling(true);
                refresh()
                  .catch((e) => setNotice(friendly(e)))
                  .finally(() => setPulling(false));
              }}
            />
          ) : undefined
        }
      >
        {(notice || busy) && (
          <View accessibilityLiveRegion="polite" style={s.notice}>
            <Text style={s.body}>{busy && !notice ? "请稍等…" : notice}</Text>
            {!!notice && !busy && (
              <LinkButton title="知道了" onPress={() => setNotice("")} />
            )}
          </View>
        )}
        {scanTarget && (
          <Card>
            <Text style={s.title}>
              {scanTarget === "computer"
                ? "对准电脑屏幕上的二维码"
                : "对准设备屏幕上的二维码"}
            </Text>
            <CameraView
              style={{ height: 280, borderRadius: 12 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(r) => onCode(r.data)}
            />
            <LinkButton title="取消扫码" onPress={() => setScanTarget(null)} />
          </Card>
        )}
        {tab === "Today" && (
          <>
            <Card>
              {device ? (
                <View style={{ gap: 6 }}>
                  <Text style={s.largeTitle} numberOfLines={1}>
                    {device.id}
                  </Text>
                  <Pill
                    tone={
                      fresh
                        ? "good"
                        : currentSource?.connected === false
                          ? "bad"
                          : "warn"
                    }
                    text={
                      fresh
                        ? "实时同步中"
                        : currentSource?.connected === false
                          ? "电脑离线，显示的是上次的数据"
                          : "显示的是上次的数据"
                    }
                  />
                  <Text style={s.muted}>
                    {(() => {
                      const when = ago(
                        currentSource?.source_updated_at ??
                          view?.source_updated_at,
                        now,
                      );
                      return when
                        ? `同步于 ${when} · 下拉刷新`
                        : "还没同步过 · 下拉刷新";
                    })()}
                  </Text>
                </View>
              ) : relay ? (
                <>
                  <Text style={s.title}>电脑已连接</Text>
                  <Text style={s.body}>
                    {devices.length
                      ? "选一台设备看看它的任务。"
                      : "还没有设备。去“配对”里连上你的设备，大约两分钟。"}
                  </Text>
                  <Button
                    title={devices.length ? "选择设备" : "去配对设备"}
                    onPress={() => setTab(devices.length ? "Devices" : "Setup")}
                  />
                </>
              ) : (
                <>
                  <Text style={s.title}>第一次用？跟着做就行</Text>
                  <Guide
                    steps={[
                      {
                        text: "电脑上运行 Agent Pet。",
                        hint: "在项目目录里运行 tools/agent_pet_up.sh phone，电脑上会出现一个二维码。",
                      },
                      {
                        text: "选好设备要连的网络。",
                        hint: "家里的 Wi-Fi 或者这部手机的热点都可以。",
                      },
                      {
                        text: "扫两个二维码，填一次 Wi-Fi 密码。",
                        hint: "一个在电脑上，一个在设备屏幕上。",
                      },
                    ]}
                  />
                  <Button title="开始配对" onPress={() => setTab("Setup")} />
                  {savedName && !restoring && (
                    <Button
                      quiet
                      title={`重新连接「${savedName}」`}
                      disabled={busy}
                      onPress={() => void run(restore)}
                    />
                  )}
                </>
              )}
            </Card>
            {device && (
              <>
                <View style={s.tiles}>
                  <Tile
                    label="进行中"
                    value={String(
                      view?.tasks.filter((t) => effectiveState(t) === "running")
                        .length ?? 0,
                    )}
                  />
                  <Tile
                    label="等你处理"
                    value={String(
                      view?.tasks.filter((t) => t.state === "waiting_user")
                        .length ?? 0,
                    )}
                    warn={view?.tasks.some((t) => t.state === "waiting_user")}
                  />
                  <Tile
                    label="Token"
                    value={compact(view?.usage?.tokens) ?? "–"}
                  />
                </View>
                <Text style={s.section}>任务</Text>
                {view?.tasks.length ? (
                  <View style={s.listCard}>
                    {view.tasks.map((t, i) => {
                      const [label, tone] = taskState(effectiveState(t));
                      return (
                        <View
                          key={t.id}
                          style={[s.taskRow, i > 0 && s.divider]}
                          accessible
                          accessibilityLabel={`${t.title ?? "私密任务"}，${label}`}
                        >
                          <View
                            style={[
                              s.dot,
                              { backgroundColor: toneColor(c, tone) },
                            ]}
                          />
                          <Text style={s.taskTitle} numberOfLines={2}>
                            {t.title ?? "私密任务"}
                          </Text>
                          <Text
                            style={[
                              s.taskState,
                              (tone === "warn" || tone === "bad") && {
                                color: toneColor(c, tone),
                              },
                            ]}
                          >
                            {label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <Card>
                    <Text style={s.muted}>
                      还没有任务更新。确认电脑上的 Agent Pet
                      在运行，然后下拉刷新。
                    </Text>
                  </Card>
                )}
                <Text style={s.section}>连接</Text>
                <View style={s.listCard}>
                  {(
                    [
                      [
                        "电脑",
                        health ? "good" : "idle",
                        health ? "已连接" : "未检查",
                      ],
                      [
                        "设备",
                        deviceOnline === true
                          ? "good"
                          : deviceOnline === false
                            ? "bad"
                            : "idle",
                        deviceOnline === true
                          ? "在线"
                          : deviceOnline === false
                            ? "离线"
                            : "未知",
                      ],
                      [
                        "数据源",
                        currentSource?.connected ? "good" : "warn",
                        currentSource?.connected ? "已连接" : "离线或未知",
                      ],
                    ] as [string, Tone, string][]
                  ).map(([name, tone, value], i) => (
                    <View key={name} style={[s.kv, i > 0 && s.divider]}>
                      <Text style={s.body}>{name}</Text>
                      <Pill tone={tone} text={value} />
                    </View>
                  ))}
                </View>
                {deviceOnline === false && (
                  <Text style={s.muted}>
                    设备离线：没插 USB 线，也没连上
                    Wi-Fi。可以在“设备”页重新配网。
                  </Text>
                )}
                <Text style={s.muted}>
                  按模型分的用量明细在设备的“用量”页里。
                </Text>
              </>
            )}
          </>
        )}
        {tab === "Devices" && (
          <>
            {!relay && (
              <Card>
                <Text style={s.body}>
                  先在“配对”里连上电脑，这里才会列出设备。
                </Text>
                <Button title="去配对" onPress={() => setTab("Setup")} />
              </Card>
            )}
            {relay && !devices.length && (
              <Card>
                <Text style={s.body}>还没有设备。</Text>
                <Button title="配对一台设备" onPress={() => setTab("Setup")} />
              </Card>
            )}
            {devices.map((d) => (
              <Card key={d.id}>
                <View style={s.cardHead}>
                  <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
                    {d.id}
                  </Text>
                  <Pill
                    tone={
                      d.online === true
                        ? "good"
                        : d.online === false
                          ? "bad"
                          : "idle"
                    }
                    text={
                      d.online === true
                        ? "在线"
                        : d.online === false
                          ? "离线"
                          : "状态未知"
                    }
                  />
                </View>
                <Text style={s.muted}>
                  {serviceTransport === "remote"
                    ? d.remote_enabled
                      ? "远程查看已开启"
                      : "远程查看已关闭"
                    : "通过这台电脑同步"}
                  {device?.id === d.id ? " · 正在首页显示" : ""}
                </Text>
                <View style={s.row2}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="查看任务"
                      onPress={() => void run(() => selectDevice(d))}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      quiet
                      title="重新配网"
                      onPress={() => setTab("Setup")}
                    />
                  </View>
                </View>
                <Help
                  title="更多操作"
                  open={help === `more:${d.id}`}
                  toggle={() => toggle(`more:${d.id}`)}
                >
                  {serviceTransport === "remote" && (
                    <Button
                      quiet
                      title={d.remote_enabled ? "关闭远程查看" : "开启远程查看"}
                      onPress={() =>
                        Alert.alert(
                          d.remote_enabled
                            ? "关闭远程查看？"
                            : "开启远程摘要？",
                          d.remote_enabled
                            ? "服务会清除这台设备的远程缓存。之后请看一下设备是否已断开远程连接。"
                            : "中继服务的运营者能读到允许共享的任务摘要。开启前请确认服务所在地区、保留期限和费用。",
                          [
                            { text: "取消", style: "cancel" },
                            {
                              text: "继续",
                              onPress: () =>
                                void run(async () => {
                                  epoch.current++;
                                  setView(undefined);
                                  await relay!.remote(d.id, !d.remote_enabled);
                                  await refresh();
                                  setNotice(
                                    "远程设置已更新。设备的连接状态请单独确认。",
                                  );
                                }),
                            },
                          ],
                        )
                      }
                    />
                  )}
                  <Button
                    quiet
                    title="切换到公开模式"
                    onPress={() =>
                      Alert.alert(
                        "切换到公开模式？",
                        "设备屏幕会隐藏任务标题等私密内容，适合带到公共场合。中继缓存会被清空。",
                        [
                          { text: "取消", style: "cancel" },
                          {
                            text: "切换",
                            onPress: () =>
                              void run(async () => {
                                epoch.current++;
                                setView(undefined);
                                await relay!.privacy(
                                  d.id,
                                  `phone-${Date.now()}`,
                                );
                                setNotice(
                                  "已请求切换，设备收到过滤后的数据就会生效。",
                                );
                              }),
                          },
                        ],
                      )
                    }
                  />
                  <Button
                    danger
                    title="移除这台设备"
                    onPress={() =>
                      Alert.alert(
                        "移除这台设备？",
                        `${d.id}\n移除后它的旧凭据不能再连接，需要重新配对。`,
                        [
                          { text: "取消", style: "cancel" },
                          {
                            text: "移除",
                            style: "destructive",
                            onPress: () =>
                              void run(async () => {
                                epoch.current++;
                                setView(undefined);
                                await relay!.revoke(d.id);
                                setDevice(undefined);
                                await refresh(relay, null);
                                setNotice("设备已移除，旧凭据已失效。");
                              }),
                          },
                        ],
                      )
                    }
                  />
                </Help>
              </Card>
            ))}
            {sources.length > 1 && (
              <>
                <Text style={s.section}>任务来源</Text>
                {sources.map((x) => (
                  <Card key={x.id}>
                    <View style={s.cardHead}>
                      <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
                        {x.id}
                      </Text>
                      <Pill
                        tone={x.connected ? "good" : "bad"}
                        text={x.connected ? "已连接" : "离线"}
                      />
                    </View>
                    <Text style={s.muted}>
                      {ago(x.source_updated_at, now)
                        ? `更新于 ${ago(x.source_updated_at, now)}`
                        : "还没有数据"}
                    </Text>
                    <Button
                      quiet
                      title={
                        source === x.id
                          ? "✓ 新设备会显示这个来源"
                          : "新设备用这个来源"
                      }
                      onPress={() => setSource(x.id)}
                    />
                  </Card>
                ))}
              </>
            )}
          </>
        )}
        {tab === "Setup" && (
          <>
            <Step
              n={1}
              title="设备要连哪个网络？"
              state={networkReady ? "done" : "active"}
              summary={
                netKind === "hotspot"
                  ? "这部手机的热点"
                  : "家里或办公室的 Wi-Fi"
              }
              action={{
                title: "更改",
                onPress: () => {
                  setNetKind(null);
                  setHotspotReady(false);
                },
              }}
            >
              {networkReady ? null : (
                <>
                  <View style={s.group}>
                    <Option
                      first
                      title="家里或办公室的 Wi-Fi"
                      detail="手机和电脑连同一个 Wi-Fi，设备放在桌上用"
                      selected={false}
                      onPress={() => chooseNetwork("wifi")}
                    />
                    <Option
                      title="这部手机的热点"
                      detail="没有 Wi-Fi 时，设备和电脑都连你的热点"
                      selected={netKind === "hotspot"}
                      onPress={() => chooseNetwork("hotspot")}
                    />
                  </View>
                  {netKind === "hotspot" && (
                    <>
                      <Text style={s.subhead}>先把热点准备好</Text>
                      <Guide steps={hotspotGuide(Platform.OS)} />
                      {Platform.OS === "android" && (
                        <Button
                          quiet
                          title="打开系统设置"
                          onPress={() =>
                            void Linking.sendIntent(
                              "android.settings.WIRELESS_SETTINGS",
                            ).catch(() => Linking.openSettings())
                          }
                        />
                      )}
                      <Button
                        title="热点开好了，电脑也连上了"
                        onPress={() => setHotspotReady(true)}
                      />
                    </>
                  )}
                </>
              )}
            </Step>
            <Step
              n={2}
              title="连接电脑"
              state={relay ? "done" : networkReady ? "active" : "todo"}
              summary={relay ? `${computerName} · ${relay.address}` : undefined}
              action={{
                title: "更换",
                onPress: () => void run(() => scan("computer")),
              }}
            >
              {relay ? null : (
                <>
                  <Text style={s.body}>
                    在电脑的终端里，进入 Agent Pet 项目目录，运行：
                  </Text>
                  <Text selectable style={s.code}>
                    tools/agent_pet_up.sh phone
                  </Text>
                  <Text style={s.muted}>
                    电脑上会出现一个二维码，用下面的按钮扫它。
                  </Text>
                  <Button
                    title="扫电脑上的二维码"
                    disabled={busy}
                    onPress={() => void run(() => scan("computer"))}
                  />
                  {savedName && (
                    <Button
                      quiet
                      title={`用上次的电脑（${savedName}）`}
                      disabled={busy || restoring}
                      onPress={() => void run(restore)}
                    />
                  )}
                  <Help
                    title="扫完连不上电脑？"
                    open={help === "computer"}
                    toggle={() => toggle("computer")}
                  >
                    <Guide
                      steps={
                        kind === "hotspot"
                          ? [
                              {
                                text: "确认电脑连的是这部手机的热点。",
                                hint: "电脑连上热点后等 15 秒，Agent Pet 会自动换到新网络。",
                              },
                              {
                                text: "在电脑上重新运行 tools/agent_pet_up.sh phone，扫新出现的二维码。",
                              },
                            ]
                          : [
                              { text: "确认手机和电脑连的是同一个 Wi-Fi。" },
                              {
                                text: "确认电脑上的 tools/agent_pet_up.sh 还在运行（关掉终端也没关系，它在后台）。",
                              },
                              {
                                text: "公司或学校的 Wi-Fi 可能不让设备之间互相访问，这时可以改用手机热点。",
                              },
                            ]
                      }
                    />
                    {Platform.OS === "ios" && (
                      <Text style={s.muted}>
                        iPhone
                        第一次连接时会问“是否允许查找本地网络上的设备”，要点“允许”。点错了可以在
                        设置 → 隐私与安全性 → 本地网络 里打开。
                      </Text>
                    )}
                  </Help>
                  <Help
                    title="电脑上还没有 Agent Pet？"
                    open={help === "install"}
                    toggle={() => toggle("install")}
                  >
                    <Text style={s.body}>
                      电脑需要 Node.js 20 以上和
                      Python。把项目下载到电脑后，在项目目录里运行上面那行命令，第一次会自动装好依赖和配置，之后每次开机运行
                      tools/agent_pet_up.sh 就行。
                    </Text>
                  </Help>
                </>
              )}
            </Step>
            <Step
              n={3}
              title="连接设备"
              state={
                done || challenge
                  ? "done"
                  : relay && networkReady
                    ? "active"
                    : "todo"
              }
              summary={challenge ? `已确认：${challenge.device_id}` : undefined}
            >
              {relay && networkReady && !done && !challenge && (
                <>
                  <Guide
                    steps={[
                      { text: "在设备上按 OK 打开菜单，选“连接手机”。" },
                      { text: "设备屏幕出现二维码后，点下面的按钮扫它。" },
                      {
                        text: "扫完在设备上按 OK 确认。",
                        hint: "手机通过蓝牙连设备，放在设备旁边就行。",
                      },
                    ]}
                  />
                  {q ? (
                    <Text style={s.warning}>
                      正在连接设备…请在设备上按 OK 确认。
                    </Text>
                  ) : (
                    <Button
                      title="扫设备屏幕上的二维码"
                      disabled={busy}
                      onPress={() => void run(() => scan("device"))}
                    />
                  )}
                  <Help
                    title="设备没反应？"
                    open={help === "device"}
                    toggle={() => toggle("device")}
                  >
                    <Guide
                      steps={[
                        {
                          text: "确认手机蓝牙开着，并允许了本 App 使用蓝牙和相机。",
                        },
                        {
                          text: "设备上的二维码 2 分钟后失效，失效了就在设备上重新选“连接手机”。",
                        },
                        {
                          text: "设备菜单里没有“连接手机”时，先插 USB 线更新一下设备。",
                        },
                      ]}
                    />
                  </Help>
                </>
              )}
              {!!deadline && (
                <Text style={s.warning}>
                  设备的配对窗口还剩{" "}
                  {Math.max(0, Math.ceil((deadline - now) / 1000))} 秒
                </Text>
              )}
            </Step>
            <Step
              n={4}
              title={
                kind === "hotspot" ? "选你的热点，填密码" : "选 Wi-Fi，填密码"
              }
              state={done ? "done" : challenge ? "active" : "todo"}
              summary={done ? "设备已收到网络设置" : undefined}
            >
              {challenge && (
                <>
                  {kind === "hotspot" && (
                    <Text style={s.muted}>
                      {Platform.OS === "ios"
                        ? "热点名就是这部 iPhone 的名字。"
                        : "热点名在手机的热点设置里。"}
                    </Text>
                  )}
                  {scanning && (
                    <Text style={s.body}>设备正在搜索附近的网络…</Text>
                  )}
                  {!scanning && networks && networks.length > 0 && (
                    <View>
                      <Text style={s.label}>设备能搜到的网络</Text>
                      <View style={s.group}>
                        {networks.map((n, i) => (
                          <Pressable
                            key={n.ssid}
                            accessibilityRole="radio"
                            accessibilityState={{
                              selected: ssid === n.ssid && !manualSsid,
                            }}
                            accessibilityLabel={`${n.ssid}，信号 ${n.bars} 格${n.secure ? "，需要密码" : "，不需要密码"}`}
                            onPress={() => {
                              setManualSsid(false);
                              setSsid(n.ssid);
                              setWifiError("");
                            }}
                            style={({ pressed }) => [
                              s.row,
                              i > 0 && s.divider,
                              pressed && s.pressed,
                            ]}
                          >
                            <Bars n={n.bars} />
                            <Text style={s.rowName} numberOfLines={1}>
                              {n.ssid}
                            </Text>
                            <Text style={s.muted}>
                              {n.secure ? "需密码" : "开放"}
                            </Text>
                            <Text style={s.check}>
                              {ssid === n.ssid && !manualSsid ? "✓" : ""}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  )}
                  {!scanning && networks && networks.length === 0 && (
                    <Text style={s.warning}>
                      设备没搜到任何网络。
                      {kind === "hotspot"
                        ? Platform.OS === "ios"
                          ? "确认热点开着、“最大兼容性”已打开，然后点“重新搜索”。"
                          : "确认热点开着、频段是 2.4 GHz，然后点“重新搜索”。"
                        : "把设备拿近路由器一点，然后点“重新搜索”。"}
                    </Text>
                  )}
                  {!scanning && networks && (
                    <View style={s.inline}>
                      <LinkButton
                        title="重新搜索"
                        onPress={() => void scanNetworks()}
                      />
                      <LinkButton
                        title={
                          manualSsid ? "从列表里选" : "列表里没有？手动输入"
                        }
                        onPress={() => {
                          setManualSsid(!manualSsid);
                          setSsid("");
                        }}
                      />
                    </View>
                  )}
                  {!scanning &&
                    networks &&
                    networks.length > 0 &&
                    !manualSsid && (
                      <Help
                        title="列表里找不到我的网络？"
                        open={help === "list"}
                        toggle={() => toggle("list")}
                      >
                        <Text style={s.body}>
                          设备只能看到 2.4 GHz 的网络。
                          {kind === "hotspot"
                            ? Platform.OS === "ios"
                              ? "iPhone 热点要打开“最大兼容性”；如果电脑还没连上热点，iPhone 可能已经把热点暂停了，让电脑先连上再搜。"
                              : "安卓热点要把频段改成 2.4 GHz（有的手机叫“兼容模式”）。"
                            : "双频路由器如果把 2.4G 和 5G 合成了一个名字通常没问题；只开了 5G 的话，需要在路由器里打开 2.4G。"}
                        </Text>
                      </Help>
                    )}
                  {(manualSsid || !networks) && (
                    <Field
                      label={kind === "hotspot" ? "热点名称" : "Wi-Fi 名称"}
                      value={ssid}
                      set={(x) => {
                        setSsid(x);
                        setWifiError("");
                      }}
                      placeholder={
                        kind === "hotspot" && Platform.OS === "ios"
                          ? "例如：小明的 iPhone"
                          : "区分大小写"
                      }
                    />
                  )}
                  {!!ssid && needsPassword && (
                    <>
                      <Field
                        label={kind === "hotspot" ? "热点密码" : "Wi-Fi 密码"}
                        value={passphrase}
                        set={(x) => {
                          setPassphrase(x);
                          setWifiError("");
                        }}
                        secret={!showPass}
                      />
                      <View style={s.inline}>
                        <LinkButton
                          title={showPass ? "隐藏密码" : "显示密码"}
                          onPress={() => setShowPass(!showPass)}
                        />
                      </View>
                      {passphrase !== "" && passBytes < 8 && (
                        <Text style={s.muted}>密码至少 8 位。</Text>
                      )}
                    </>
                  )}
                  {!!ssid && !needsPassword && (
                    <Text style={s.muted}>这个网络不需要密码。</Text>
                  )}
                  {slotsFull && (
                    <>
                      <Text style={s.body}>
                        设备已经存了 {challenge.max_network_slots}{" "}
                        个网络，选一个换掉。新网络连不上时，旧的会保留。
                      </Text>
                      {challenge.network_slots.map((n, i) => (
                        <Button
                          quiet
                          key={i}
                          title={`${replace === i ? "✓ " : ""}换掉 ${n}`}
                          onPress={() => setReplace(i)}
                        />
                      ))}
                    </>
                  )}
                  {sources.length > 1 &&
                    !devices.some((d) => d.id === q?.device_id) && (
                      <>
                        <Text style={s.body}>
                          这台电脑上有多个任务来源，选一个让设备显示：
                        </Text>
                        {sources.map((x) => (
                          <Button
                            quiet
                            key={x.id}
                            title={`${source === x.id ? "✓ " : ""}${x.id}`}
                            onPress={() => setSource(x.id)}
                          />
                        ))}
                      </>
                    )}
                  {!!wifiError && (
                    <View style={s.error} accessibilityLiveRegion="assertive">
                      <Text style={s.body}>{wifiError}</Text>
                    </View>
                  )}
                  {connecting && (
                    <Text style={s.body}>
                      设备正在连接{kind === "hotspot" ? "热点" : " Wi-Fi"}
                      ，最多半分钟…
                    </Text>
                  )}
                  <Button
                    title="连接"
                    disabled={busy || !canConnect}
                    onPress={() => void run(() => finishWizard(false))}
                  />
                  <LinkButton
                    title="设备已经连着网络了，跳过这一步"
                    onPress={() => void run(() => finishWizard(true))}
                  />
                </>
              )}
            </Step>
            <Step n={5} title="完成" state={done ? "active" : "todo"}>
              {done && (
                <>
                  {online === "waiting" && (
                    <Text style={s.body}>
                      设置已发给设备，正在等它连上电脑…一般十几秒。
                    </Text>
                  )}
                  {online === "online" && (
                    <Text style={[s.body, { color: c.green }]}>
                      ✓ 设备已经连上电脑，屏幕上很快会出现你的任务。
                    </Text>
                  )}
                  {online === "unknown" && (
                    <Text style={s.body}>
                      设置已发给设备，几秒后设备屏幕上会出现你的任务。
                    </Text>
                  )}
                  {online === "timeout" && (
                    <>
                      <Text style={s.warning}>
                        设备还没连上电脑。看一下设备屏幕上的提示：
                      </Text>
                      <Guide
                        steps={[
                          {
                            text: "显示“Wi-Fi 已连接，正在连服务”：设备上网了，但找不到电脑。",
                            hint:
                              kind === "hotspot"
                                ? "确认电脑也连在这部手机的热点上，然后等 15 秒。"
                                : "确认电脑和设备在同一个 Wi-Fi 上，电脑上的 tools/agent_pet_up.sh 在运行。",
                          },
                          {
                            text: "显示“Wi-Fi 已断开，正在重试”：设备连不上网络。",
                            hint: "回到第 3 步重新扫设备的码，检查网络名和密码。",
                          },
                          {
                            text: "实在不行就插上 USB 线，设备马上就能用，网络的事之后再弄。",
                          },
                        ]}
                      />
                      <Button
                        quiet
                        title="再检查一次"
                        onPress={() => setOnlineTry((x) => x + 1)}
                      />
                    </>
                  )}
                  <Button
                    title="查看任务"
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        const list = (await refresh()) ?? devices;
                        const d = list.find((x) => x.id === done);
                        if (d) await selectDevice(d);
                        else setTab("Devices");
                      })
                    }
                  />
                  <LinkButton
                    title="再配一台设备"
                    onPress={() => {
                      setDone(undefined);
                      setOnline(undefined);
                    }}
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
              title={setupAdvanced ? "收起高级选项" : "高级选项"}
              onPress={() => setSetupAdvanced(!setupAdvanced)}
            />
            {setupAdvanced && (
              <Card>
                <Text style={s.title}>高级选项</Text>
                <Text style={s.body}>
                  扫过设备的码以后，这里可以只做配对、或单独设置连接方式。配对窗口
                  2 分钟后关闭，App
                  切到后台也会关闭。设备外壳上印的二维码不是配对密钥。
                </Text>
                <Text style={s.warning}>
                  设备上打不开“连接手机”时，请插 USB 线更新或设置设备。
                </Text>
                {challenge && (
                  <>
                    <Text style={s.muted}>
                      服务：{relay?.origin ?? "还没连接电脑"} ·{" "}
                      {serviceTransport === "remote" ? "远程中继" : "本机桥接"}
                      {"\n"}任务来源：{source || "请在“设备”页选择"}
                    </Text>
                    <Button
                      quiet
                      title="只配对，不改连接"
                      disabled={!relay || !source || !serviceTransport || busy}
                      onPress={() => void run(() => enrollDevice("pair-only"))}
                    />
                    {serviceTransport === "local" ? (
                      <Button
                        quiet
                        title="连接本机桥接服务"
                        disabled={!relay || !source || busy}
                        onPress={() => void run(() => enrollDevice("local"))}
                      />
                    ) : (
                      <Button
                        quiet
                        title="添加为远程查看"
                        disabled={
                          !relay || !source || !serviceTransport || busy
                        }
                        onPress={() =>
                          Alert.alert(
                            "开启远程查看？",
                            `${relay?.origin}\n这个服务能读取允许共享的任务摘要。继续前请向管理员确认服务所在地区、保留期限和费用。`,
                            [
                              { text: "取消", style: "cancel" },
                              {
                                text: "开启并添加",
                                onPress: () =>
                                  void run(() => enrollDevice("remote")),
                              },
                            ],
                          )
                        }
                      />
                    )}
                    <Button
                      quiet
                      title="结束配对"
                      disabled={busy}
                      onPress={() =>
                        void run(async () => {
                          await session.current.finish();
                          await closeSetup();
                          setNotice("配对已结束。看一下设备，再刷新在线状态。");
                        })
                      }
                    />
                  </>
                )}
              </Card>
            )}
          </>
        )}
        {tab === "Account" && (
          <>
            <Card>
              <Text style={s.title}>电脑</Text>
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
              {savedName && !relay && (
                <Button
                  quiet
                  title={`重新连接「${savedName}」`}
                  disabled={busy || restoring}
                  onPress={() => void run(restore)}
                />
              )}
              <Button
                quiet
                title="退出并清除手机上的数据"
                disabled={busy}
                onPress={() =>
                  void confirm(
                    "退出并清除？",
                    "会删掉手机上保存的电脑连接和任务缓存。之后要重新扫电脑的二维码。",
                    "退出",
                  ).then((ok) => ok && void run(logout))
                }
              />
              <LinkButton
                title={advanced ? "收起高级选项" : "高级选项"}
                onPress={() => setAdvanced(!advanced)}
              />
            </Card>
            {advanced && (
              <Card>
                <Text style={s.title}>手动连接服务</Text>
                <Text style={s.body}>
                  用于已有的服务：填服务管理员给你的账户访问令牌。它能管理你的设备、查看任务摘要。不要填模型厂商的
                  API Key。
                </Text>
                <Field
                  label="服务地址（https://）"
                  value={origin}
                  set={setOrigin}
                />
                <Field label="访问令牌" value={token} set={setToken} secret />
                <Field
                  label="证书 SHA-256 指纹（可选，64 位十六进制）"
                  value={manualPin}
                  set={setManualPin}
                />
                <Text style={s.muted}>
                  不填指纹时使用系统的证书信任，自签名证书需要先在系统里安装它的
                  CA；填了指纹就只接受这一张证书。远程中继的运营者能看到允许共享的字段，连接前请确认运营方、地区、保留期限和费用。
                </Text>
                <Button
                  title="连接"
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
              <Text style={s.title}>数据从哪来</Text>
              <Text style={s.body}>
                任务和用量来自你电脑上的 Agent Pet（经由
                Magpie）。电脑睡眠或离线时，这里显示上次同步的时间。需要你处理的任务，仍然在电脑上操作。
              </Text>
            </Card>
            <Card>
              <Text style={s.title}>隐私</Text>
              <Text style={s.body}>
                Wi-Fi
                密码和设备配对码只在配对时留在内存里，不会保存。退出会清除手机上的电脑连接和任务缓存。手机丢了的话，请在电脑上吊销这部手机的令牌。
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
      <View style={[s.tabs, { paddingBottom: insets.bottom }]}>
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
            <Text style={[s.tabText, { color: tab === t ? c.tint : c.gray }]}>
              {tabLabel[t]}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
export default function App() {
  const dark = useColorScheme() === "dark";
  const theme = useMemo(() => {
    const c = dark ? DARK : LIGHT;
    return { c, s: makeStyles(c) };
  }, [dark]);
  return (
    <SafeAreaProvider>
      <Theme.Provider value={theme}>
        <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
        <AppContent />
      </Theme.Provider>
    </SafeAreaProvider>
  );
}
function makeStyles(c: Palette) {
  const hair = StyleSheet.hairlineWidth;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 6 },
    heading: {
      color: c.label,
      fontSize: 34,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    largeTitle: { color: c.label, fontSize: 22, fontWeight: "600" },
    title: { color: c.label, fontSize: 17, fontWeight: "600" },
    subhead: { color: c.label, fontSize: 15, fontWeight: "600", marginTop: 4 },
    section: {
      color: c.secondary,
      fontSize: 13,
      marginTop: 10,
      marginBottom: -6,
      marginLeft: 16,
    },
    body: { color: c.label, fontSize: 15, lineHeight: 22 },
    muted: { color: c.secondary, fontSize: 13, lineHeight: 18 },
    label: { color: c.secondary, fontSize: 13, marginBottom: 6 },
    warning: { color: c.orange, fontSize: 13, lineHeight: 18 },
    content: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 32,
      gap: 16,
    },
    notice: { padding: 14, borderRadius: 12, backgroundColor: c.fill, gap: 4 },
    error: { padding: 12, borderRadius: 10, backgroundColor: c.fill },
    help: { paddingTop: 4, gap: 10 },
    card: { backgroundColor: c.card, padding: 16, borderRadius: 12, gap: 12 },
    group: {
      borderRadius: 10,
      backgroundColor: c.card,
      borderWidth: hair,
      borderColor: c.separator,
      overflow: "hidden",
    },
    divider: { borderTopWidth: hair, borderTopColor: c.separator },
    pressed: { backgroundColor: c.fill },
    stepHead: { flexDirection: "row", alignItems: "center", gap: 12 },
    stepDot: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: c.tertiary,
      alignItems: "center",
      justifyContent: "center",
    },
    stepDotDone: { backgroundColor: c.green, borderColor: c.green },
    stepDotText: { color: c.secondary, fontWeight: "600", fontSize: 13 },
    guideNumber: {
      color: c.secondary,
      fontSize: 15,
      lineHeight: 22,
      width: 14,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    optionTitle: { color: c.label, fontSize: 16 },
    check: { color: c.tint, fontSize: 17, fontWeight: "600", width: 16 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    rowName: { flex: 1, color: c.label, fontSize: 16 },
    bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, width: 22 },
    bar: { width: 4, borderRadius: 1, backgroundColor: c.fill },
    barOn: { backgroundColor: c.label },
    inline: { flexDirection: "row", gap: 20, flexWrap: "wrap" },
    pill: { flexDirection: "row", alignItems: "center", gap: 6 },
    pillText: { color: c.secondary, fontSize: 13 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    tiles: { flexDirection: "row", gap: 12 },
    tile: {
      flex: 1,
      backgroundColor: c.card,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      gap: 2,
    },
    tileValue: { color: c.label, fontSize: 26, fontWeight: "600" },
    listCard: { backgroundColor: c.card, borderRadius: 12, paddingLeft: 16 },
    taskRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingRight: 16,
    },
    taskTitle: { flex: 1, color: c.label, fontSize: 16, lineHeight: 21 },
    taskState: { color: c.secondary, fontSize: 15 },
    cardHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    row2: { flexDirection: "row", gap: 10 },
    kv: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 12,
      paddingRight: 16,
    },
    button: {
      backgroundColor: c.tint,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: "center",
    },
    buttonQuiet: { backgroundColor: c.fill },
    buttonDanger: {},
    buttonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
    buttonQuietText: { color: c.tint },
    buttonDangerText: { color: c.red },
    input: {
      backgroundColor: c.fill,
      borderRadius: 10,
      color: c.label,
      paddingHorizontal: 12,
      paddingVertical: 11,
      fontSize: 17,
    },
    code: {
      color: c.label,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 13,
      backgroundColor: c.fill,
      padding: 10,
      borderRadius: 8,
    },
    link: { paddingVertical: 8, alignItems: "center" },
    linkText: { color: c.tint, fontSize: 15 },
    disclosure: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 8,
    },
    chevron: { color: c.tertiary, fontSize: 20, lineHeight: 22 },
    tabs: {
      flexDirection: "row",
      borderTopWidth: hair,
      borderTopColor: c.separator,
      backgroundColor: c.bar,
    },
    tab: { flex: 1, paddingTop: 10, paddingBottom: 6, alignItems: "center" },
    tabText: { fontSize: 13, fontWeight: "500" },
  });
}
