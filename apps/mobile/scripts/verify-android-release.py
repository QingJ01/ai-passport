#!/usr/bin/env python3
"""Check release manifest and Espressif SDK log stripping in a built APK.

Usage: python3 scripts/verify-android-release.py APK ANDROID_SDK_ROOT
This checks bytecode/manifest properties, not phone BLE or runtime TLS behavior.
"""
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


def verify(apk: Path, sdk: Path):
    tools = sorted((sdk / 'build-tools').iterdir(), key=lambda p: tuple(int(x) for x in p.name.split('.') if x.isdigit()))[-1]
    manifest = subprocess.check_output([str(tools / 'aapt'), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml']).decode('utf-8', 'replace')
    for line in manifest.splitlines():
        if 'android:debuggable(' in line:
            assert line.rstrip().endswith('0x0'), 'Refuse debuggable APK for BLE provisioning'
    assert re.search(r'android:allowBackup\([^\n]+0x0\s*$', manifest, re.M), 'Backup must be disabled'
    assert 'android:networkSecurityConfig(' in manifest, 'Network security policy missing'
    count = 0
    # Each temporary directory is created and owned solely by this verifier.
    with tempfile.TemporaryDirectory(prefix='agentpet-apk-') as work:
        with zipfile.ZipFile(apk) as archive:
            names = [n for n in archive.namelist() if re.fullmatch(r'classes\d*\.dex', n)]
            assert names, 'APK has no DEX files'
            for name in names:
                target = Path(work) / name
                target.write_bytes(archive.read(name))
                dump = subprocess.check_output([str(tools / 'dexdump'), '-d', str(target)]).decode('utf-8', 'replace')
                owner = ''
                for line in dump.splitlines():
                    if 'Class descriptor' in line:
                        owner = line.split("'")[1]
                        if owner.startswith('Lcom/espressif/'):
                            count += 1
                    if owner.startswith('Lcom/espressif/') and 'invoke-' in line:
                        assert not re.search(r'Landroid/util/Log;\.(d|v|i|w|e):', line), 'SDK printing call remains in ' + owner
    assert count > 0, 'SDK class names unavailable; this verification cannot establish stripping'
    print(f'PASS: non-debuggable release, backup disabled, network policy present; {count} Espressif classes have no Log.d/v/i/w/e calls')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    verify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
