#!/usr/bin/env bash
# One command for everything Agent Pet needs on this computer.
#
#   tools/agent_pet_up.sh              first-time setup if needed, then start
#   tools/agent_pet_up.sh status       what is running, credential days left, link state
#   tools/agent_pet_up.sh stop         stop all three services
#   tools/agent_pet_up.sh wifi         let the device work without the cable (asks the Wi-Fi password once)
#   tools/agent_pet_up.sh phone        show the QR the phone app scans to pair with this computer
#   tools/agent_pet_up.sh autostart on|off   start at login (macOS LaunchAgent)
#
# Starts the local bridge, the Magpie data source and the resident USB link.
# First run creates .agent-pet/ (loopback-only bridge, enough for USB) and the
# Magpie connection file. Every start renews credentials that expire within 10
# days. Nothing is written to the device without a button press on it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOG="$ROOT/.agent-pet"
CONFIG="$ROOT/.agent-pet/config.json"
# Absolute paths: pgrep/pkill must only ever match this checkout's processes.
BRIDGE="$ROOT/services/src/cli.mjs $CONFIG"
SOURCE="$ROOT/services/src/magpie-source.mjs"
LINK="$ROOT/tools/agent_pet_device.py link"
PLIST="$HOME/Library/LaunchAgents/dev.agentpet.up.plist"

say() { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

find_python() {
  for candidate in "${AGENT_PET_PYTHON:-}" "${IDF_PYTHON_ENV_PATH:+$IDF_PYTHON_ENV_PATH/bin/python}" python3; do
    if [ -n "$candidate" ] && "$candidate" -c 'import serial' 2>/dev/null; then echo "$candidate"; return 0; fi
  done
  return 1
}

stop_all() { pkill -f "$LINK" || true; pkill -f "$SOURCE" || true; pkill -f "$BRIDGE" || true; }
LAN="$ROOT/services/src/lan.mjs"

case "${1:-start}" in
  stop) stop_all; say "已停止 Agent Pet 的电脑端服务。"; exit 0 ;;
  status)
    for p in "$BRIDGE" "$SOURCE" "$LINK"; do
      if pgrep -f "$p" >/dev/null; then say "运行中  $p"; else say "未运行  $p"; fi
    done
    if [ -f "$LOG/link.log" ]; then say "USB 连接：$(tail -n 1 "$LOG/link.log")"; fi
    exit 0 ;;
  autostart)
    case "${2:-}" in
      on)
        mkdir -p "$(dirname "$PLIST")"
        cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agentpet.up</string>
  <key>ProgramArguments</key><array><string>$ROOT/tools/agent_pet_up.sh</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string>${AGENT_PET_PYTHON:+<key>AGENT_PET_PYTHON</key><string>$AGENT_PET_PYTHON</string>}</dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/$LOG/autostart.log</string>
  <key>StandardErrorPath</key><string>$ROOT/$LOG/autostart.log</string>
</dict></plist>
EOF
        launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"
        say "已设置登录后自动启动。关闭：$0 autostart off" ;;
      off) launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; say "已关闭登录后自动启动。" ;;
      *) fail "用法：$0 autostart on|off" ;;
    esac
    exit 0 ;;
  start|wifi|phone) ;;
  *) fail "用法：$0 [start|status|stop|wifi|phone|autostart on|off]" ;;
esac

# 1. Prerequisites, each with the exact fix.
command -v node >/dev/null || fail "需要 Node.js 20 或更新版本：https://nodejs.org 下载安装后重新运行。"
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' || fail "Node.js 版本太旧，请升级到 20 或更新版本。"
PY=$(find_python) || fail "需要 Python 的 pyserial：运行  python3 -m pip install --user pyserial  后重新运行（或设置 AGENT_PET_PYTHON）。"
if [ ! -d services/node_modules ]; then
  say "· 第一次运行，安装电脑端依赖…"
  (cd services && npm ci --ignore-scripts --silent) || fail "依赖安装失败，请检查网络后重试。"
fi

# 2. First-time bridge setup (loopback only: enough for USB).
if [ ! -f "$CONFIG" ]; then
  command -v openssl >/dev/null || fail "需要 openssl（macOS 自带；Linux 用包管理器安装）。"
  say "· 第一次运行，创建本机配置 .agent-pet/ …"
  node "$ROOT/services/src/setup.mjs" "$ROOT/.agent-pet" >/dev/null || fail "创建配置失败。"
fi

# 3. Wi-Fi and phone need the bridge on the local network (by Bonjour name; the
#    listening IP is re-detected here so a new DHCP address never breaks it).
if [ "${1:-start}" != start ] && [ ! -f "$ROOT/.agent-pet/lan.enabled" ]; then
  say "· 开启局域网模式：同一 Wi-Fi 下的设备和手机可以找到这台电脑（仍需凭据，数据只在本地网络）。"
  pkill -f "$BRIDGE" || true; sleep 1
  node "$LAN" "$CONFIG" enable >/dev/null
fi
if [ -f "$ROOT/.agent-pet/lan.enabled" ] && pgrep -f "$BRIDGE" >/dev/null; then
  case "$(node "$LAN" "$CONFIG" check)" in *'"stale":true'*) say "· 电脑的网络地址变了，重启桥接服务…"; pkill -f "$BRIDGE" || true; sleep 1 ;; esac
fi

# 4. With the bridge stopped: renew credentials, sync the Magpie file, refresh the address.
if ! pgrep -f "$BRIDGE" >/dev/null; then
  lan_state=$(node "$LAN" "$CONFIG" refresh)
  case "$lan_state" in *'"offline":true'*) say "· 现在没有连接局域网，只能用 USB。" ;; esac
  result=$(node "$ROOT/services/src/renew.mjs" "$CONFIG") || fail "更新凭据失败。"
  case "$result" in
    *'"renewed":[]'*) ;;
    *'"renewed":['*) say "· 凭据快到期，已自动续期。" ;;
    *) fail "更新凭据没有返回结果。" ;;
  esac
fi

# 5. Start what is not running yet.
mkdir -p "$LOG"
if ! pgrep -f "$BRIDGE" >/dev/null; then
  nohup node "$ROOT/services/src/cli.mjs" "$CONFIG" >"$LOG/bridge.log" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q "listening" "$LOG/bridge.log" 2>/dev/null && break; sleep 0.5; done
  if ! grep -q "listening" "$LOG/bridge.log" 2>/dev/null; then
    if grep -q EADDRINUSE "$LOG/bridge.log"; then
      fail "桥接服务没能启动：端口 7443/7444/7445 被占用。可能另一份 Agent Pet 正在运行，请先停止它。"
    elif grep -q EADDRNOTAVAIL "$LOG/bridge.log"; then
      fail "桥接服务没能启动：电脑的网络地址刚变过。请再运行一次：$0"
    else
      fail "桥接服务没能启动：$(grep -v '^\s*at ' "$LOG/bridge.log" | grep -m1 -i 'error' || tail -n 1 "$LOG/bridge.log")"
    fi
  fi
fi
if ! pgrep -f "$SOURCE" >/dev/null; then nohup node "$SOURCE" 10 >"$LOG/magpie-source.log" 2>&1 & fi
if ! pgrep -f "$LINK" >/dev/null; then nohup "$PY" -u "$ROOT/tools/agent_pet_device.py" link >"$LOG/link.log" 2>&1 & fi
[ -x /Applications/magpie.app/Contents/MacOS/magpie ] || [ -n "${MAGPIE_BIN:-}" ] || say "· 没找到 Magpie：任务和用量数据来自 Magpie，请先安装（https://usemagpie.ai）。"

case "${1:-start}" in
  wifi)
    say "· 设置设备 Wi-Fi：请插上设备的 USB 线。"
    pkill -f "$LINK" || true; sleep 1
    "$PY" "$ROOT/tools/agent_pet_device.py" provision --config "$CONFIG" || say "没有完成，可以再运行一次：$0 wifi"
    nohup "$PY" -u "$ROOT/tools/agent_pet_device.py" link >"$LOG/link.log" 2>&1 &
    exit 0 ;;
  phone)
    say ""
    say "用手机 App 扫描下面的二维码（手机和电脑要连同一个 Wi-Fi）："
    node "$LAN" "$CONFIG" pair-qr
    say "这个二维码相当于钥匙，只给自己的手机扫，不要截图或分享。"
    say "接着在设备菜单选“连接手机”，再用 App 扫设备屏幕上的二维码。"
    exit 0 ;;
esac
say "✓ Agent Pet 已启动。"
say "  插上设备，屏幕会弹出“电脑请求连接”，按一下 OK 就好。"
say "  不插线使用：$0 wifi    配对手机：$0 phone"
say "  查看状态：$0 status    停止：$0 stop"
