"""Windows DPAPI wrappers for protecting secrets at rest.

Only the Entra ID client secret is protected (the SQLite store keeps
interaction bodies in plaintext per the user's confirmed choice).

`win32crypt.CryptProtectData` ties the ciphertext to the current
Windows user account. Falling back to a clear-text byte string on
non-Windows platforms allows the development environment to run, but
emits a warning.
"""
from __future__ import annotations

import base64
import logging
import sys
from dataclasses import dataclass, field
from typing import Union

log = logging.getLogger(__name__)

_ENTROPY = b"CopilotWatchTower::v1::secret"

# Byte prefixes stamped on freshly-created blobs so we can tell DPAPI
# ciphertexts apart from the base64 fallback used on non-Windows dev
# machines. Older blobs without a prefix still decrypt fine via the
# platform default in :func:`unprotect`.
_TAG_DPAPI = b"DP1\x00"
_TAG_FALLBACK = b"B64\x00"


@dataclass(frozen=True)
class ProtectedBlob:
    """Opaque ciphertext suitable for storing in SQLite (BLOB column).

    ``algorithm`` is derived from the byte prefix and exists purely for
    diagnostics and tests; it is not consulted during decryption.
    """

    data: bytes
    algorithm: str = field(init=False)

    def __post_init__(self) -> None:
        if self.data.startswith(_TAG_FALLBACK):
            object.__setattr__(self, "algorithm", "base64-fallback")
        else:
            # Includes legacy untagged DPAPI ciphertexts.
            object.__setattr__(self, "algorithm", "dpapi-v1")

    def to_text(self) -> str:
        return base64.b64encode(self.data).decode("ascii")

    @classmethod
    def from_text(cls, text: str) -> "ProtectedBlob":
        return cls(base64.b64decode(text.encode("ascii")))


def _as_bytes(value: Union[str, bytes]) -> bytes:
    if isinstance(value, bytes):
        return value
    return value.encode("utf-8")


def protect(secret: Union[str, bytes]) -> ProtectedBlob:
    """Encrypt ``secret`` for the current user.

    Accepts both text (encoded as UTF-8) and raw bytes so callers can
    store arbitrary binary payloads without round-tripping through
    ``str``.
    """
    payload = _as_bytes(secret)
    if sys.platform != "win32":
        log.warning("DPAPI not available on this platform; storing secret obfuscated only.")
        return ProtectedBlob(_TAG_FALLBACK + base64.b64encode(payload))

    import win32crypt  # type: ignore[import-not-found]

    cipher = win32crypt.CryptProtectData(
        payload, "CopilotWatchTower", _ENTROPY, None, None, 0
    )
    return ProtectedBlob(_TAG_DPAPI + cipher)


def unprotect(blob: ProtectedBlob, *, decode: bool = True) -> Union[str, bytes]:
    """Decrypt a value previously returned by :func:`protect`.

    Pass ``decode=False`` to receive the raw bytes (useful when the
    original payload was binary). With ``decode=True`` (default), the
    bytes are interpreted as UTF-8.
    """
    raw = blob.data
    if raw.startswith(_TAG_FALLBACK):
        payload = base64.b64decode(raw[len(_TAG_FALLBACK):])
    elif raw.startswith(_TAG_DPAPI):
        import win32crypt  # type: ignore[import-not-found]

        _, payload = win32crypt.CryptUnprotectData(
            raw[len(_TAG_DPAPI):], _ENTROPY, None, None, 0
        )
    elif sys.platform != "win32":
        # Legacy untagged base64 payload from earlier builds.
        payload = base64.b64decode(raw)
    else:
        import win32crypt  # type: ignore[import-not-found]

        _, payload = win32crypt.CryptUnprotectData(raw, _ENTROPY, None, None, 0)

    return payload.decode("utf-8") if decode else bytes(payload)
