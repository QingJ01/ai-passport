// Wi-Fi helpers for the setup wizard: the list of networks the device can see,
// the reasons a connection fails, and the phone-hotspot checklist. Pure logic, so
// it is unit tested without a phone.
import { utf8Bytes, type WifiFailure } from "./provisioning.ts";
export { WifiError, wifiFailure, type WifiFailure } from "./provisioning.ts";

export interface RawNetwork {
  ssid: string;
  rssi: number;
  secure: boolean;
}
export interface Network extends RawNetwork {
  /** 1 (weak) to 4 (strong). */
  bars: number;
}

export function bars(rssi: number) {
  return rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -78 ? 2 : 1;
}

// One row per name, strongest first; drops hidden and over-long names. The device
// only reports 2.4 GHz networks, so whatever is listed here can actually be joined.
export function networkList(raw: unknown, limit = 15): Network[] {
  if (!Array.isArray(raw)) return [];
  const best = new Map<string, RawNetwork>();
  for (const n of raw) {
    if (!n || typeof n !== "object") continue;
    const { ssid, rssi, secure } = n as Record<string, unknown>;
    if (typeof ssid !== "string" || !ssid.trim() || utf8Bytes(ssid) > 32)
      continue;
    const r = typeof rssi === "number" && Number.isFinite(rssi) ? rssi : -100;
    const previous = best.get(ssid);
    if (!previous || r > previous.rssi)
      best.set(ssid, { ssid, rssi: r, secure: secure !== false });
  }
  return [...best.values()]
    .sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid))
    .slice(0, limit)
    .map((n) => ({ ...n, bars: bars(n.rssi) }));
}

// Which network to suggest: the phone's own Wi-Fi when the device can see it.
export function suggested(list: Network[], phoneWifi: string | null) {
  return phoneWifi && list.some((n) => n.ssid === phoneWifi) ? phoneWifi : null;
}

export type NetworkKind = "wifi" | "hotspot";
export function failureText(reason: WifiFailure, kind: NetworkKind) {
  if (reason === "auth")
    return kind === "hotspot"
      ? "热点密码不对。到手机的热点设置里看一下密码（注意大小写），改好后再点一次“连接”。"
      : "Wi-Fi 密码不对。检查一下大小写和有没有多打空格，改好后再点一次“连接”。";
  if (reason === "not_found")
    return kind === "hotspot"
      ? "设备找不到这个热点。请确认热点开着、名字没打错；iPhone 要打开“最大兼容性”，安卓要把频段设成 2.4 GHz。然后点“重新搜索”。"
      : "设备找不到这个 Wi-Fi。它只能连 2.4 GHz 的 Wi-Fi，5 GHz 的看不到；也可能是离路由器太远。";
  return kind === "hotspot"
    ? "设备没能连上热点。把设备拿近一点，确认热点开着，再试一次。"
    : "设备没能连上这个 Wi-Fi。把设备拿近路由器一点再试；需要网页登录的 Wi-Fi（酒店、机场）和企业 Wi-Fi 不支持。";
}

export interface GuideStep {
  text: string;
  hint?: string;
}
// What to do on the phone before the device joins its hotspot. Order matters:
// the computer joins first, which also keeps an iPhone hotspot from switching off.
export function hotspotGuide(
  platform: "ios" | "android" | string,
): GuideStep[] {
  const shared: GuideStep[] = [
    {
      text: "让电脑也连上这个热点。",
      hint: "电脑上的 Agent Pet 会在 15 秒内自动切到新网络，不用重启。",
    },
    {
      text: "记下热点密码，等会儿要填。",
      hint: "配对过程中别切出 App，切出去配对会断开，需要重新扫设备的码。",
    },
  ];
  if (platform === "ios")
    return [
      {
        text: "打开 设置 → 个人热点，打开“允许其他人加入”。",
      },
      {
        text: "在同一页打开“最大兼容性”。",
        hint: "设备只能连 2.4 GHz，不开这个它搜不到你的热点。",
      },
      {
        text: "热点名就是这部 iPhone 的名字。",
        hint: "在 设置 → 通用 → 关于本机 → 名称 可以看到。",
      },
      ...shared,
    ];
  return [
    {
      text: "打开 设置 → 网络/连接 → 个人热点（或“热点与网络共享”），打开 WLAN 热点。",
    },
    {
      text: "把频段设成 2.4 GHz，或打开“兼容模式”。",
      hint: "设备只能连 2.4 GHz，5 GHz 热点它搜不到。",
    },
    { text: "在热点设置里可以看到热点名和密码。" },
    ...shared,
  ];
}
