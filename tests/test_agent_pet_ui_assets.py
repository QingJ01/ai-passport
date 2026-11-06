#!/usr/bin/env python3
"""Guard the documented host-render previews against source drift."""
from __future__ import annotations

import hashlib
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs/assets"
FRAMES = ("now", "now-live", "tasks", "menu", "usage", "inbox", "confirm", "action", "now-claude", "tasks-claude", "desk", "toast", "desk-claude", "link", "wifi")


def text_chunks(path: Path) -> dict[str, str]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError(f"{path.name}: not a PNG")
    offset, found = 8, {}
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if kind == b"tEXt":
            key, _, value = body.partition(b"\0")
            found[key.decode("latin-1")] = value.decode("utf-8", "replace")
        elif kind == b"IDAT":
            if not body:
                raise AssertionError(f"{path.name}: empty image data")
        elif kind == b"IEND":
            break
    return found


def main() -> int:
    main_c = ROOT / "main/main.c"
    expected = hashlib.sha256(main_c.read_bytes()).hexdigest()
    problems = []
    for name in FRAMES:
        path = ASSETS / f"agent-pet-ui-{name}.png"
        if not path.exists():
            problems.append(f"{path.name}: missing")
            continue
        meta = text_chunks(path)
        recorded = meta.get("SourceSHA256", "")
        if recorded != expected:
            problems.append(
                f"{path.name}: preview was rendered from {recorded[:16] or 'unknown'}, "
                f"main.c is {expected[:16]}; rerun tools/ui_preview")
        description = meta.get("Description", "")
        if not description.startswith("HOST LVGL RENDER"):
            problems.append(f"{path.name}: {name} preview lacks host-render provenance")
        if name in {"now-live", "tasks", "usage", "inbox", "action", "now-claude", "tasks-claude", "desk", "toast", "desk-claude", "wifi"} and "SYNTHETIC FIXTURE" not in description:
            problems.append(f"{path.name}: fixture frame must say it uses synthetic data")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"UI preview assets match main.c ({expected[:16]}) and keep honest provenance")
    return 0


if __name__ == "__main__":
    sys.exit(main())
