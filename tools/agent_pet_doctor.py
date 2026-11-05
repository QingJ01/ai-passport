#!/usr/bin/env python3
"""Read-only local readiness report; never open, reset, or flash serial ports."""
from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def command(argv: list[str], timeout: int = 10) -> dict:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"ok": result.returncode == 0, "output": result.stdout.strip(),
                "error": result.stderr.strip()[:500], "exit_code": result.returncode}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "error": str(error)}


def serial_devices() -> dict:
    try:
        from serial.tools import list_ports
    except ImportError:
        paths = sorted(glob.glob('/dev/cu.*')) if sys.platform == 'darwin' else sorted(
            glob.glob('/dev/ttyACM*') + glob.glob('/dev/ttyUSB*'))
        return {"metadata_available": False, "ports": [{"path": p, "candidate": False} for p in paths],
                "note": "Run using activated ESP-IDF Python for USB VID/PID metadata; paths alone do not identify a target."}
    ports = []
    for item in list_ports.comports():
        ports.append({"path": item.device, "description": item.description,
                      "vid": item.vid, "pid": item.pid,
                      "candidate": item.vid == 0x303A,
                      "manufacturer": item.manufacturer})
    return {"metadata_available": True, "ports": sorted(ports, key=lambda p: p['path']),
            "note": "Espressif VID suggests a candidate, not permission to open or flash it."}


def report(idf: Path | None = None) -> dict:
    candidates = [Path(os.environ['IDF_PATH'])] if os.environ.get('IDF_PATH') else []
    candidates += [Path.home() / 'esp' / 'esp-idf-v5.5.3']
    if idf:
        candidates.insert(0, idf.expanduser())
    selected = next((p for p in candidates if (p / 'tools' / 'idf.py').is_file()), None)
    tools = {}
    for name, args in [('python3', ['--version']), ('node', ['--version']),
                       ('cmake', ['--version']), ('ninja', ['--version']), ('idf.py', ['--version'])]:
        path = shutil.which(name)
        tools[name] = {"path": path, "version": command([path, *args]) if path else None}
    usb = None
    if sys.platform == 'darwin':
        raw = command(['system_profiler', 'SPUSBDataType', '-json'])
        if raw.get('ok'):
            try:
                tree = json.loads(raw['output'])
                devices = []
                def walk(items):
                    for item in items:
                        if item.get('vendor_id') or item.get('product_id'):
                            devices.append({"name": item.get('_name'), "vendor_id": item.get('vendor_id'),
                                            "product_id": item.get('product_id'),
                                            "manufacturer": item.get('manufacturer')})
                        walk(item.get('_items', []))
                walk(tree.get('SPUSBDataType', []))
                usb = {"ok": True, "devices": devices}
            except (ValueError, TypeError) as error:
                usb = {"ok": False, "error": str(error)}
        else:
            usb = {"ok": False, "error": raw.get('error')}
    return {"system": platform.system(), "architecture": platform.machine(),
            "python": sys.executable, "tools": tools, "idf_checkout": str(selected) if selected else None,
            "serial": serial_devices(), "usb": usb,
            "scope": "Read-only report. No ports were opened and no credentials were inspected."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--idf', type=Path, help='Selected existing ESP-IDF checkout')
    args = parser.parse_args()
    print(json.dumps(report(args.idf), indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
