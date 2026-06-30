"""Security primitives (DPAPI wrappers)."""

from .dpapi import ProtectedBlob, protect, unprotect

__all__ = ["ProtectedBlob", "protect", "unprotect"]
