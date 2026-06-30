from __future__ import annotations

import sys

import pytest

from copilot_watchtower.security import protect, unprotect


def test_round_trip_secret() -> None:
    secret = "super-secret-client-secret-😊"
    blob = protect(secret)
    assert blob.data  # non-empty bytes
    assert blob.algorithm in {"dpapi-v1", "base64-fallback"}
    assert unprotect(blob) == secret


def test_round_trip_bytes() -> None:
    raw = b"\x00\x01\x02hello"
    blob = protect(raw)
    out = unprotect(blob, decode=False)
    assert out == raw


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI only on Windows")
def test_dpapi_used_on_windows() -> None:
    blob = protect("x")
    assert blob.algorithm == "dpapi-v1"
