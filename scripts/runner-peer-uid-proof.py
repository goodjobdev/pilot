#!/usr/bin/env python3
"""Uninstalled Linux-only SO_PEERCRED identity diagnostic; never executes work."""

import argparse
import os
import socket
import struct
import sys
import time

MAX_CONNECTIONS = 32
IO_TIMEOUT_SECONDS = 1.0
ACCEPT_TIMEOUT_SECONDS = 0.25
ACCEPT_WINDOW_SECONDS = 30.0
REQUEST = b"STATUS\n"
RESPONSE = b"{\"status\":\"peer-uid-verified\"}\n"


def parse_uid(value):
    if not value.isascii() or not value.isdecimal():
        raise argparse.ArgumentTypeError("expected UID as decimal digits")
    uid = int(value, 10)
    if uid < 0 or uid > 0xFFFFFFFF:
        raise argparse.ArgumentTypeError("UID is outside the Linux unsigned 32-bit range")
    return uid


def validate_socket_path(path):
    if not os.path.isabs(path):
        raise ValueError("socket path must be absolute")
    encoded = os.fsencode(path)
    if not encoded or len(encoded) > 107:
        raise ValueError("socket path must fit the Linux Unix-domain socket path limit")


def peer_uid(connection):
    # Linux struct ucred contains native-endian pid_t, uid_t, and gid_t fields.
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    if len(credentials) != 12:
        raise OSError("Linux returned malformed SO_PEERCRED data")
    _pid, uid, _gid = struct.unpack("=iII", credentials)
    return uid


def serve(path, expected_uid):
    if sys.platform != "linux":
        raise RuntimeError("this identity proof requires Linux SO_PEERCRED")
    if not hasattr(socket, "SO_PEERCRED"):
        raise RuntimeError("Python socket.SO_PEERCRED is unavailable")
    validate_socket_path(path)

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        # Deliberately never unlink: an existing pathname (including a stale socket) is
        # an operator-owned collision and must be investigated, not replaced.
        listener.bind(path)
        listener.listen(8)
        listener.settimeout(ACCEPT_TIMEOUT_SECONDS)
        handled = 0
        deadline = time.monotonic() + ACCEPT_WINDOW_SECONDS
        while handled < MAX_CONNECTIONS and time.monotonic() < deadline:
            try:
                connection, _address = listener.accept()
            except socket.timeout:
                continue
            handled += 1
            with connection:
                connection.settimeout(IO_TIMEOUT_SECONDS)
                try:
                    # Authenticate each accepted socket before reading or answering it.
                    if peer_uid(connection) != expected_uid:
                        continue
                    request = connection.recv(len(REQUEST) + 1)
                    if request != REQUEST:
                        continue
                    connection.sendall(RESPONSE)
                except (OSError, TimeoutError):
                    continue
    finally:
        listener.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="owner-provided private disposable absolute socket path")
    parser.add_argument("--expected-uid", required=True, type=parse_uid, help="explicit Linux peer UID to permit")
    args = parser.parse_args()
    try:
        serve(args.socket, args.expected_uid)
    except (OSError, RuntimeError, ValueError) as error:
        print("runner-peer-uid-proof: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
