#!/usr/bin/env python3
"""Bounded USB diagnostics and verified-WSS forwarding. Never flash a device.

Run with the activated ESP-IDF Python (pyserial required). Opening a serial port
can reset some boards. Select the exact identified target, not an arbitrary port.
USB state forwarding requires the device's physical 120-second setup window.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import selectors
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
FRAME_MAX = 4096
INFO_FIELDS = {'device_id', 'view_epoch', 'public_mode', 'configured', 'fwversion',
               'applied_revision', 'task_count', 'source_fresh', 'synchronizing',
               'keys_seen', 'page', 'menu', 'details', 'usb_window_s',
               'heap_free', 'min_heap', 'largest_block', 'allocation_failures',
               'stack_min_free', 'network_count', 'transport', 'elf_sha256'}


class Lines:
    """Discard oversize lines entirely, including fragmented serial log lines."""
    def __init__(self):
        self.buffer = bytearray()
        self.discard = False

    def feed(self, data):
        output = []
        for byte in data:
            if byte == 10:
                if not self.discard:
                    output.append(bytes(self.buffer).rstrip(b'\r'))
                self.buffer.clear()
                self.discard = False
            elif not self.discard:
                if len(self.buffer) >= FRAME_MAX:
                    self.buffer.clear()
                    self.discard = True
                else:
                    self.buffer.append(byte)
        return output


def info_reply(line):
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(value, dict) or value.get('v') != 1 or value.get('type') != 'device.info':
        return None
    payload = value.get('payload')
    if not isinstance(payload, dict):
        return None
    if not all(isinstance(payload.get(k), str) and 0 < len(payload[k]) <= 96
               for k in ('device_id', 'view_epoch')):
        return None
    return {key: value for key, value in payload.items() if key in INFO_FIELDS}


def open_port(path):
    try:
        import serial
    except ImportError:
        raise SystemExit('pyserial is unavailable; use the activated ESP-IDF Python.')
    port = serial.Serial(port=None, baudrate=115200, timeout=0.05,
                         write_timeout=2, exclusive=True)
    # macOS asserts DTR/RTS at the driver level when a CDC port is opened, and
    # the ESP32-C3 USB-Serial/JTAG treats that as a chip-reset request
    # (rst:0x15). Pre-seeding the line state does not prevent it, so every open
    # reboots the board once: live counters and any open setup window are lost.
    # Tools therefore hold ONE port handle for the whole session and act on
    # state observed after that single reset.
    port._dtr_state = False
    port._rts_state = False
    port.port = path
    port.open()
    port.dtr = False
    port.rts = False
    return port


def query(port, seconds=8):
    lines = Lines()
    deadline = time.monotonic() + seconds
    next_query = 0
    while time.monotonic() < deadline:
        if time.monotonic() >= next_query:
            port.write(b'{"v":1,"type":"device.info"}\n')
            next_query = time.monotonic() + 1
        for line in lines.feed(port.read(512)):
            response = info_reply(line)
            if response:
                return response
    raise RuntimeError('No Agent Pet device.info reply. Firmware may be older or the port may be wrong. No logs were displayed.')


SETUP_LIMIT = 4096


def build_setup_message(*, ssid, password, endpoint, token, ca_pem, server_name,
                        device_id, time_url, time_issuer, enrollment_key_pem,
                        utc_seconds, transport="local", replace_slot=-1):
    """Build the exact `setup` payload the firmware accepts, without secrets in logs."""
    if transport not in ("local", "remote"):
        raise ValueError("transport must be local or remote")
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode("utf-8")) <= 32:
        raise ValueError("SSID must be 1..32 UTF-8 bytes")
    if not isinstance(password, str) or len(password.encode("utf-8")) > 64:
        raise ValueError("password must be at most 64 UTF-8 bytes")
    if not isinstance(endpoint, str) or not endpoint.startswith("wss://") or len(endpoint) > 256:
        raise ValueError("endpoint must be a bounded wss:// URL")
    if not isinstance(token, str) or len(token) < 43 or len(token) > 128:
        raise ValueError("device credential must be 43..128 characters")
    if not isinstance(ca_pem, str) or "-----BEGIN CERTIFICATE-----" not in ca_pem or len(ca_pem) > 2048:
        raise ValueError("a bounded PEM certificate is required")
    if not isinstance(server_name, str) or not server_name or len(server_name) > 128:
        raise ValueError("server_name is required")
    if not isinstance(device_id, str) or not device_id or len(device_id) > 96:
        raise ValueError("device_id is required")
    if time_url:
        if not isinstance(time_url, str) or not time_url.startswith("http://") or len(time_url) > 256:
            raise ValueError("time_bootstrap_url must be a bounded http:// URL")
        if not time_issuer or not enrollment_key_pem:
            raise ValueError("signed time needs an issuer and public key")
    if len(enrollment_key_pem.encode("utf-8")) > 512:
        raise ValueError("enrollment key is too large")
    if not 1735689600 <= int(utc_seconds) <= 4102444800:
        raise ValueError("utc_seconds is outside the accepted range")
    if not -1 <= replace_slot < 3:
        raise ValueError("replace_slot must be -1 or a slot 0..2")
    document = {
        "v": 1,
        "type": "setup",
        "transport": transport,
        "ssid": ssid,
        "password": password,
        "replace_slot": replace_slot,
        "endpoint": endpoint,
        "token": token,
        "ca_pem": ca_pem,
        "server_name": server_name,
        "device_id": device_id,
        "time_bootstrap_url": time_url or "",
        "time_issuer": time_issuer or "",
        "enrollment_public_key_pem": enrollment_key_pem or "",
        "time": int(utc_seconds),
    }
    message = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    if len(message.encode("utf-8")) > SETUP_LIMIT:
        raise ValueError("setup message exceeds the 4096-byte device limit")
    return message


def upstream_command(line):
    """Accept device actions/privacy controls, never a new host credential."""
    if len(line) > FRAME_MAX:
        return None
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(value, dict) or type(value.get('v')) is not int or value['v'] != 1:
        return None
    kind = value.get('type')
    if not isinstance(kind, str) or kind not in {'action.prepare', 'action', 'action.query', 'view.configure', 'resync'}:
        return None
    payload = value.get('payload')
    if not isinstance(payload, dict):
        return None
    if kind == 'view.configure':
        target = payload.get('view_epoch')
        if payload.get('mode') not in ('public', 'private') or not isinstance(target, str):
            return None
        if not re.fullmatch(r'[A-Za-z0-9:._-]{1,64}', target):
            return None
    return value


def bridge_frame(line, current_epoch):
    """Return a bridge frame for the device's current epoch, or None to drop it.

    The device starts a new privacy epoch when its USB window is reopened or its
    privacy mode changes. Frames the bridge emitted under the previous epoch can
    still be in the pipe at that moment; they belong to a projection the device
    has already discarded, so they are dropped here and never written to it.
    """
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(value, dict) or value.get('view_epoch') != current_epoch:
        return None
    return value


def forward(port, info, config_path, seconds, node):
    configuration = json.loads(config_path.read_text())
    directory = config_path.parent
    def local(name):
        path = Path(configuration[name])
        return path if path.is_absolute() else directory / path
    credentials = json.loads(local('credentials').read_text())
    if info['device_id'] != credentials['device_id']:
        raise RuntimeError('Device identity does not match this local bridge credential. Pair explicitly before forwarding.')
    configuration_frame = {
        'url': configuration['public_endpoint'],
        'credential': credentials['device_credential'],
        'ca_pem': local('tls_cert').read_text(),
        'server_name': configuration.get('server_name', ''),
        'device_id': info['device_id'], 'view_epoch': info['view_epoch'],
        'public_mode': info.get('public_mode', False),
    }
    process = subprocess.Popen([node, str(ROOT / 'tools/agent_pet_usb_bridge.mjs')],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    frames = 0
    commands = 0
    stale = 0
    current_epoch = info['view_epoch']
    parser = Lines()
    serial_lines = Lines()
    try:
        process.stdin.write(json.dumps(configuration_frame).encode() + b'\n')
        process.stdin.flush()
        configuration_frame['credential'] = ''
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready = selector.select(0.1)
            for key, _ in ready:
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    break
                for line in parser.feed(chunk):
                    if not line:
                        continue
                    if bridge_frame(line, current_epoch) is None:
                        stale += 1
                        continue
                    encoded = line + b'\n'
                    # Initial firmware drains 128 bytes each 25 ms; pace below
                    # that limit because the IDF USB RX ISR drops a full ring.
                    for offset in range(0, len(encoded), 128):
                        port.write(encoded[offset:offset + 128])
                        time.sleep(0.035)
                    frames += 1
            # Firmware actions are forwarded over the existing authenticated
            # connection. Logs and setup/auth messages never leave the host.
            for serial_line in serial_lines.feed(port.read(512)):
                command = upstream_command(serial_line)
                if command is None:
                    continue
                if command['type'] == 'view.configure':
                    current_epoch = command['payload']['view_epoch']
                process.stdin.write(json.dumps(command).encode() + b'\n')
                process.stdin.flush()
                commands += 1
            if process.poll() is not None:
                if process.returncode:
                    raise RuntimeError('Verified bridge transport failed; check local service, CA and authorization.')
                break
        if not frames:
            raise RuntimeError('No authenticated bridge frames received.')
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
    after = query(port)
    print(json.dumps({'forwarded_frames': frames, 'forwarded_commands': commands,
                      'dropped_stale_frames': stale, 'device_after': after}, ensure_ascii=False))
    if not after.get('source_fresh'):
        raise RuntimeError('Device did not confirm fresh source state; check physical USB window and source health.')


def watch(port, seconds):
    """One session, one reset: report live device state once per second."""
    last = None
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            info = query(port, seconds=3)
        except RuntimeError:
            continue
        snapshot = {k: info.get(k) for k in ('keys_seen', 'page', 'menu', 'details',
                                             'usb_window_s', 'applied_revision',
                                             'task_count', 'source_fresh', 'public_mode',
                                             'heap_free', 'min_heap', 'largest_block',
                                             'allocation_failures', 'stack_min_free', 'transport')}
        if snapshot != last:
            print(json.dumps(snapshot, ensure_ascii=False), flush=True)
            last = snapshot
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def wait_for_window(port, seconds):
    """Poll until the user physically opens the 120 s USB setup window."""
    deadline = time.monotonic() + seconds if seconds else float('inf')
    announced = False
    last_report = 0.0
    last_state = None
    while time.monotonic() < deadline:
        try:
            info = query(port, seconds=3)
        except RuntimeError:
            continue
        if not announced:
            print('Device rebooted once when the port opened; state is live from here.',
                  file=sys.stderr, flush=True)
            print('Open the physical USB setup window on the device now.', file=sys.stderr, flush=True)
            print(json.dumps({'device_before': info}, ensure_ascii=False), file=sys.stderr, flush=True)
            announced = True
        remaining = info.get('usb_window_s')
        if isinstance(remaining, int) and remaining > 0:
            return info
        now = time.monotonic()
        state = (info.get('keys_seen'), info.get('menu'), remaining)
        if state != last_state and now - last_report >= 5:
            last_state = state
            last_report = now
            print(json.dumps({'waiting_for_window': True, 'keys_seen': info.get('keys_seen'),
                              'menu': info.get('menu'), 'usb_window_s': remaining},
                             ensure_ascii=False), file=sys.stderr, flush=True)
        time.sleep(1)
    raise RuntimeError('USB setup window never opened; nothing was written to the device.')


def _asset(folder: Path, config: dict, key: str) -> Path:
    """Configuration paths resolve relative to the config file, like the bridge."""
    return (folder / config[key]).resolve()


def _signing_public(folder: Path, config: dict) -> Path:
    candidates = []
    if config.get('signing_key'):
        signing = _asset(folder, config, 'signing_key')
        candidates.append(signing.with_name(signing.stem.replace('-key', '') + '-public.pem'))
    candidates.extend([folder / 'signing-public.pem', folder.parent / 'signing-public.pem'])
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError('signing public key not found next to the configuration')


def current_ssid() -> str:
    try:
        result = subprocess.run(['networksetup', '-getairportnetwork', 'en0'],
                                capture_output=True, text=True, timeout=5)
        marker = 'Current Wi-Fi Network: '
        if result.stdout.startswith(marker):
            return result.stdout[len(marker):].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ''


def provision(port, config_path: Path, ssid: str, password: str, window_seconds: int,
              confirm_seconds: int, say=print) -> dict:
    """Write one locally built setup payload to a device that has a physical window."""
    folder = config_path.parent
    config = json.loads(config_path.read_text())
    credentials = json.loads(_asset(folder, config, 'credentials').read_text())
    message = build_setup_message(
        ssid=ssid, password=password, endpoint=config['public_endpoint'],
        token=credentials['device_credential'],
        ca_pem=_asset(folder, config, 'tls_cert').read_text(),
        server_name=config['server_name'], device_id=credentials['device_id'],
        time_url=config.get('time_bootstrap_url', ''),
        time_issuer=config.get('time_issuer', ''),
        enrollment_key_pem=_signing_public(folder, config).read_text(),
        utc_seconds=int(time.time()))
    info = wait_for_window(port, window_seconds)
    say(f"窗口已打开（还剩 {info.get('usb_window_s', 0)} 秒），正在发送配置…")
    port.write(message.encode('utf-8') + b'\n')
    port.flush()
    reader = Lines()
    deadline = time.monotonic() + 15
    status = None
    while time.monotonic() < deadline and status is None:
        for line in reader.feed(port.read(1024)):
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(value, dict) and value.get('type') == 'setup.result':
                payload = value.get('payload')
                if isinstance(payload, dict):
                    status = payload.get('status')
    if status is None:
        raise RuntimeError('设备没有回应配置请求；请确认已打开 USB 窗口后重试。')
    if status != 'confirm_on_device':
        raise RuntimeError(f'设备拒绝了配置（{status}）；没有写入任何设置。')
    say('设备已收到配置。现在在设备上按 OK 确认（长按 OK 取消）。')
    deadline = time.monotonic() + confirm_seconds
    last = {}
    while time.monotonic() < deadline:
        port.write(b'{"v":1,"type":"device.info","payload":{}}\n')
        port.flush()
        for line in reader.feed(port.read(1024)):
            value = info_reply(line)
            if value:
                last = value
        if last.get('configured') and (last.get('network_count') or 0) > 0:
            return {'status': 'configured', 'device': last}
        time.sleep(1)
    return {'status': 'timeout_waiting_for_confirmation', 'device': last}


def preflight_summary(config_path: Path, ssid: str, password: str) -> dict:
    """Describe a USB provisioning payload without device access or secrets."""
    folder = config_path.parent
    config = json.loads(config_path.read_text())
    credentials = json.loads(_asset(folder, config, 'credentials').read_text())
    ca_pem = _asset(folder, config, 'tls_cert').read_text()
    key_pem = _signing_public(folder, config).read_text()
    endpoint = config['public_endpoint']
    host = endpoint.split('://', 1)[-1].split('/', 1)[0].rsplit(':', 1)[0]
    message = build_setup_message(
        ssid=ssid, password=password, endpoint=endpoint,
        token=credentials['device_credential'], ca_pem=ca_pem,
        server_name=config['server_name'], device_id=credentials['device_id'],
        time_url=config.get('time_bootstrap_url', ''),
        time_issuer=config.get('time_issuer', ''), enrollment_key_pem=key_pem,
        utc_seconds=int(time.time()))
    return {
        'payload_bytes': len(message.encode('utf-8')),
        'limit_bytes': SETUP_LIMIT,
        'endpoint': endpoint,
        'endpoint_host': host,
        'endpoint_usable_by_device': host not in ('127.0.0.1', 'localhost', '::1'),
        'server_name': config['server_name'],
        'signed_time_configured': bool(config.get('time_bootstrap_url')),
        'ssid_bytes': len(ssid.encode('utf-8')),
        'device_id': credentials['device_id'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['info', 'watch', 'stream', 'preflight', 'provision'])
    parser.add_argument('--port', required=True)
    parser.add_argument('--config', type=Path, default=ROOT / '.agent-pet/config.json')
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--window-timeout', type=int, default=120, help='Read-only wait for physical consent; 0 waits until the user opens the window')
    parser.add_argument('--after-watch', type=int, default=0, help='Keep the same port open for heap/key observation after streaming (0..180 seconds)')
    parser.add_argument('--node', default='node')
    parser.add_argument('--ssid', help='Wi-Fi SSID to size in a provisioning preflight')
    parser.add_argument('--confirm-timeout', type=int, default=180, help='Seconds to wait for the on-device OK after a setup payload')
    parser.add_argument('--password-stdin', action='store_true', help='Read the Wi-Fi passphrase from stdin instead of a prompt (keeps it out of argv)')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 90:
        parser.error('--seconds must be between 1 and 90 for bounded USB-window diagnostics')
    if args.window_timeout < 0:
        parser.error('--window-timeout must be nonnegative')
    if not 0 <= args.after_watch <= 180:
        parser.error('--after-watch must be between 0 and 180 seconds')
    if args.operation == 'provision':
        print('即将打开串口：设备会复位一次，当前窗口会失效。')
        print('等这里出现 “Open the physical USB setup window on the device now.” 之后再按键。',
              file=sys.stderr, flush=True)
    try:
        with open_port(args.port) as port:
            if args.operation == 'provision':
                import getpass
                ssid = args.ssid or current_ssid()
                if not ssid:
                    ssid = input('Wi-Fi name (SSID): ').strip()
                if args.password_stdin:
                    secret = sys.stdin.readline().rstrip('\n')
                else:
                    secret = getpass.getpass('Wi-Fi password (not echoed, not stored): ')
                result = provision(port, args.config.resolve(), ssid, secret,
                                   args.window_timeout, args.confirm_timeout)
                print(json.dumps(result, ensure_ascii=False))
                return 0 if result['status'] == 'configured' else 1
            if args.operation == 'preflight':
                import getpass
                if not args.ssid:
                    parser.error('preflight needs --ssid')
                secret = getpass.getpass('Wi-Fi password (not stored, not logged): ')
                print(json.dumps(preflight_summary(args.config.resolve(), args.ssid, secret)))
                return 0
            if args.operation == 'info':
                print(json.dumps(query(port), ensure_ascii=False))
            elif args.operation == 'watch':
                watch(port, args.seconds)
            else:
                info = wait_for_window(port, args.window_timeout)
                if info.get('public_mode'):
                    print('Device is in public mode: frames will be applied but tasks stay hidden.',
                          file=sys.stderr)
                forward(port, info, args.config.resolve(), args.seconds, args.node)
                if args.after_watch:
                    print('Streaming verified; observing the same serial session.', file=sys.stderr, flush=True)
                    watch(port, args.after_watch)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        # Never dump configuration or raw serial data into the agent transcript.
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        else:
            print('Device operation failed; check selected port and local configuration.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
