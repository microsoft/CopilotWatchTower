"""Static assets bundled with the web shell.

This package only ships data files (e.g. ``index.html``) that are loaded
at runtime via :mod:`importlib.resources`. Making it a regular package
ensures the assets are discoverable both from a source checkout and from
a PyInstaller/MSIX bundle.
"""
