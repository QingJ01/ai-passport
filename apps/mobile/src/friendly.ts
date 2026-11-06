import { TransportError } from "./transport.ts";
// Plain-language Chinese messages for the setup wizard. Internal messages stay English (and are
// what the tests assert); this layer only translates them for people. Never include secrets here.
export const PIN_MISMATCH =
  "证书指纹不匹配。请在电脑上重新运行 tools/agent_pet_up.sh phone，再扫一次新的二维码。";
export const OFFLINE =
  "连不上电脑。请确认手机和电脑在同一个 Wi-Fi 上，并且电脑上的 tools/agent_pet_up.sh 仍在运行。";
const RULES: [RegExp, string][] = [
  [/fingerprint does not match/i, PIN_MISMATCH],
  [
    /setup is unfinished|credential was renewed/i,
    "设备已经加到你的账户，但还没连上电脑。请在设备上重新打开“连接手机”，再做一次第 2、3 步。",
  ],
  [/Security1|no_pop/i, "设备固件不支持安全配对。请先用 USB 更新设备。"],
  [
    /secure device endpoint|service role changed/i,
    "电脑上的服务还没准备好。请在电脑上重新运行 tools/agent_pet_up.sh phone，再扫一次电脑二维码。",
  ],
  [
    /revoked|Session expired/i,
    "电脑拒绝了这部手机的访问。请在电脑上重新生成二维码再扫一次。",
  ],
  [
    /Unsupported pairing code version/i,
    "二维码版本不匹配。请把手机 App 和电脑上的 Agent Pet 都更新到最新版本。",
  ],
  [
    /Pairing code (has|is)|Scan the pairing code shown on your computer/i,
    "这不是有效的电脑配对二维码。请扫电脑终端里显示的二维码。",
  ],
  [
    /Scan the temporary device screen code|Unsupported or insecure pairing code/i,
    "这不是设备的配对二维码。请在设备菜单选“连接手机”，再扫设备屏幕上的二维码。",
  ],
  [
    /Device not found|Bluetooth scan/i,
    "没找到设备。请确认设备屏幕上还显示着二维码、手机蓝牙已打开，并把手机靠近设备。",
  ],
  [
    /Secure session failed|Proof of possession|Scan a fresh/i,
    "二维码已过期，请在设备上重新打开“连接手机”再扫一次。",
  ],
  [
    /Setup expired|Setup window expired|timed out|Setup closed|Setup cancelled/i,
    "二维码已过期，请在设备上重新打开“连接手机”再扫一次。",
  ],
  [
    /disconnected/i,
    "蓝牙连接断开了。请把手机靠近设备，在设备上重新打开“连接手机”再扫一次。",
  ],
  [
    /physical confirmation|identity or physical/i,
    "设备没有确认。请在设备上按 OK，然后重新扫码。",
  ],
  [
    /Bluetooth permission/i,
    "需要蓝牙权限。请在系统设置里允许本 App 使用蓝牙。",
  ],
  [/camera access/i, "需要相机权限。请在系统设置里允许本 App 使用相机。"],
  [
    /Wi-Fi|Candidate network|credentials and 2\.4 GHz|refused candidate/i,
    "设备连不上这个 Wi-Fi。请检查密码，并确认是 2.4 GHz 网络（5 GHz 不支持）。",
  ],
  [
    /1–32 byte SSID|passphrase/i,
    "Wi-Fi 名称不能为空，密码需要 8 到 63 个字符（开放网络可以留空）。",
  ],
  [
    /Choose which saved network/i,
    "设备已保存的 Wi-Fi 满了，请先选择要替换哪一个。",
  ],
  [
    /No authorized source/i,
    "电脑上还没有可用的任务来源。请保持 tools/agent_pet_up.sh 在电脑上运行，然后再试一次。",
  ],
  [
    /already assigned|Choose an authorized source/i,
    "请先在上面选一个任务来源，设备会显示它的任务。",
  ],
  [
    /refused service trust|Existing ownership/i,
    "这台设备已经属于另一台电脑。需要先在设备上恢复出厂设置，或用 USB 恢复。",
  ],
  [
    /USB recovery|Update the device through USB|Firmware/i,
    "设备固件太旧，不支持手机配对。请先用 USB 更新设备。",
  ],
  [/No saved session/i, "这部手机上还没有保存过电脑。请先扫电脑上的二维码。"],
  [
    /Certificate fingerprint must be/i,
    "证书指纹格式不对，应为 64 位小写十六进制。",
  ],
  [
    /Controller token required|Enter a trusted HTTPS service origin/i,
    "请填写 https:// 开头的服务地址和访问令牌。",
  ],
  [
    /Install the native/i,
    "请安装 Agent Pet 原生 App（Expo Go 和网页版不能配对）。",
  ],
];
export function friendly(error: unknown): string {
  if (error instanceof TransportError) {
    if (error.kind === "pin") return PIN_MISMATCH;
    if (error.kind === "network") return OFFLINE;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const [pattern, text] of RULES) if (pattern.test(message)) return text;
  if (/Relay request failed \(5\d\d\)/.test(message))
    return "电脑上的服务出错了。请在电脑上重新运行 tools/agent_pet_up.sh phone。";
  return message ? `出错了：${message}` : "出错了，请重试。";
}
