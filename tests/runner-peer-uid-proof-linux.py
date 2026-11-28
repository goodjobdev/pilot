#!/usr/bin/env python3
"""One disposable Linux smoke check for the identity-only peer UID proof."""

import os
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "scripts", "runner-peer-uid-proof.py")
REQUEST = b"STATUS\n"
EXPECTED = b'{"status":"peer-uid-verified"}\n'


def connect(path, payload=REQUEST):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2)
    client.connect(path)
    client.sendall(payload)
    try:
        return client.recv(128)
    except ConnectionResetError:
        return b""
    finally:
        client.close()


def check_instance(path, expected_uid, expected_response):
    process = subprocess.Popen(
        [sys.executable, HELPER, "--socket", path, "--expected-uid", str(expected_uid)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 3
        while not os.path.exists(path) and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if not os.path.exists(path):
            error = process.stderr.read().decode("utf-8", "replace")
            raise RuntimeError("proof listener failed to bind: " + error)
        if connect(path) != expected_response:
            raise AssertionError("peer response did not match the expected UID decision")
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def main():
    if sys.platform != "linux":
        print("SKIP: Linux SO_PEERCRED smoke check requires Linux")
        return 0
    uid = os.getuid()
    with tempfile.TemporaryDirectory(prefix="pilot-peer-uid-") as directory:
        check_instance(os.path.join(directory, "allowed.sock"), uid, EXPECTED)
        denied_uid = 0 if uid != 0 else 1
        check_instance(os.path.join(directory, "denied.sock"), denied_uid, b"")

        # A path that already exists is an operator-owned collision: bind fails, nothing is
        # replaced, and no unrelated path is unlinked. A symlink at the path must behave the same.
        occupied = os.path.join(directory, "occupied.sock")
        with open(occupied, "w", encoding="utf-8") as handle:
            handle.write("keep me")
        refused = subprocess.run(
            [sys.executable, HELPER, "--socket", occupied, "--expected-uid", str(uid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
        )
        assert refused.returncode != 0, "an existing path must make bind fail"
        with open(occupied, encoding="utf-8") as handle:
            assert handle.read() == "keep me", "the existing path must be left exactly as it was"

        linked = os.path.join(directory, "linked.sock")
        os.symlink(occupied, linked)
        refused_link = subprocess.run(
            [sys.executable, HELPER, "--socket", linked, "--expected-uid", str(uid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
        )
        assert refused_link.returncode != 0, "a symlinked path must make bind fail"
        assert os.path.islink(linked), "the symlink must not be replaced or removed"
        assert not os.path.exists(occupied) or os.path.getsize(occupied) == len("keep me")

        for bad in ("relative.sock", "/" + "a" * 120):
            invalid = subprocess.run(
                [sys.executable, HELPER, "--socket", bad, "--expected-uid", str(uid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
            )
            assert invalid.returncode != 0, "an invalid socket path must be refused: " + bad
        # The helper intentionally leaves socket paths; the enclosing disposable
        # directory owns cleanup, rather than the helper unlinking caller paths.
    print("PASS: matching UID received the fixed diagnostic; mismatching UID received none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
