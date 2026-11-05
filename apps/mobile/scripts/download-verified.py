#!/usr/bin/env python3
"""Download a public build artifact in bounded ranges, then verify its published hash.

Uses curl's normal certificate verification and existing HTTPS_PROXY settings.
Example: python3 scripts/download-verified.py URL SIZE sha256:DIGEST OUTPUT
This tool never installs software or changes global network settings.
"""
import concurrent.futures
import hashlib
import os
from pathlib import Path
import subprocess
import sys


def download(url, size, checksum, destination):
    algorithm, expected = checksum.split(":", 1)
    if algorithm not in ("sha256", "sha1"):
        raise ValueError("Unsupported published checksum")
    out = Path(destination).resolve()
    parts = out.parent / (out.name + ".parts")
    parts.mkdir(parents=True, exist_ok=True)
    chunk = 4 * 1024 * 1024

    def fetch(index):
        start = index * chunk
        end = min(size, start + chunk) - 1
        target = parts / str(index)
        if target.exists() and target.stat().st_size == end - start + 1:
            return target
        subprocess.run([
            "curl", "--http1.1", "--fail", "--location", "--silent", "--show-error",
            "--retry", "3", "--retry-all-errors", "--connect-timeout", "30",
            "--max-time", "120", "--range", f"{start}-{end}", "--output", str(target), url,
        ], check=True)
        if target.stat().st_size != end - start + 1:
            raise ValueError("Server did not return the requested complete range")
        return target

    count = (size + chunk - 1) // chunk
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, range(count)))
    digest = hashlib.new(algorithm)
    # Reassemble only after all bounded requests succeed. Keep chunks to make retries cheap.
    with out.open("wb") as stream:
        for index in range(count):
            with (parts / str(index)).open("rb") as source:
                while data := source.read(1024 * 1024):
                    digest.update(data)
                    stream.write(data)
    if out.stat().st_size != size or digest.hexdigest() != expected:
        raise ValueError("Published artifact checksum mismatch; do not extract or execute")
    print(f"Verified {algorithm}: {out.name} ({size} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    download(sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4])
