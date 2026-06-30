# PyInstaller spec for CopilotWatchTower.
# Build a one-folder bundle on Windows:
#   pyinstaller packaging/copilot-watchtower.spec --clean --noconfirm
#
# The resulting ``dist/CopilotWatchTower/`` directory can be wrapped by
# MSIX (see ``AppxManifest.xml``) or distributed as a portable ZIP.
# This spec only relies on PyInstaller's auto-collected metadata and
# the package's static resources (SQL schema, .qm translation files).

# -*- mode: python ; coding: utf-8 -*-
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None


def _playwright_browsers_root() -> Path | None:
    """Locate the Playwright browser cache (``ms-playwright``) to bundle.

    On a clean PC the user never runs ``playwright install``, so the
    Chromium build that the eDiscovery downloader needs must travel inside
    the bundle. We copy the resolved cache into ``ms-playwright/`` and a
    runtime hook points ``PLAYWRIGHT_BROWSERS_PATH`` at it.
    """
    override = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    candidates = []
    if override and override not in ("0", ""):
        candidates.append(Path(override))
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(Path(local_appdata) / "ms-playwright")
    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob("chromium*-*")):
            return candidate
    return None

project_root = Path(SPECPATH).resolve().parent
src_root = project_root / "src" / "copilot_watchtower"
# Entry script lives next to this spec file. It performs an absolute
# import of ``copilot_watchtower`` so PyInstaller does not run the
# package's ``__main__.py`` as a top-level script (which would break
# its relative imports with "attempted relative import with no known
# parent package").
entry_script = project_root / "packaging" / "launcher.py"

datas = []
# Bundle the SQL schema into the package directory so
# ``importlib.resources`` can locate it at runtime. (Translations live in
# Python catalog modules under ``i18n/`` and ship as normal package code.)
datas += collect_data_files(
    "copilot_watchtower",
    includes=[
        "db/schema.sql",
        # The web shell loads this packaged HTML via importlib.resources
        # when no source ``web/dist`` build is present (i.e. in the bundle).
        "webshell/assets/*",
    ],
)

# Bundle the built React UI (``web/dist``). At runtime
# ``WebShellWindow._workspace_dist_index`` walks a few parents up from
# ``webshell/window.py`` looking for ``web/dist/index.html``; placing the
# build under the bundle's contents dir (``_internal/web/dist``) lets that
# lookup succeed so the real web UI loads instead of the static fallback.
_web_dist = project_root / "web" / "dist"
if not (_web_dist / "index.html").is_file():
    raise SystemExit(
        f"[spec] web/dist not built at {_web_dist}. "
        f"Run `npm --prefix web run build` before packaging."
    )
for path in _web_dist.rglob("*"):
    if path.is_file():
        rel_parent = path.parent.relative_to(_web_dist)
        datas.append((str(path), str(Path("web") / "dist" / rel_parent)))
print(f"[spec] Bundling web UI from {_web_dist}")

hiddenimports = []
hiddenimports += collect_submodules("msal")
hiddenimports += collect_submodules("PySide6")
# extract_msg is required to parse the eDiscovery .msg export packages.
# It loads helpers and data (ole/encoding tables) dynamically, so pull in
# all submodules and bundled data files explicitly.
hiddenimports += collect_submodules("extract_msg")
datas += collect_data_files("extract_msg")
# Pull in every submodule of our own package — the launcher only does
# ``from copilot_watchtower.app import run`` and PyInstaller's static
# analysis may miss UI/services/workers modules that are imported via
# strings (e.g. translation loading, dynamic dispatch).
hiddenimports += collect_submodules("copilot_watchtower")

# The embedded web shell is served by a loopback Starlette + uvicorn ASGI
# app (see ``webshell/server.py``). uvicorn resolves its protocol, loop and
# lifespan implementations dynamically by dotted path, so PyInstaller's
# static analysis misses them without an explicit pull-in.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("starlette")

# Playwright drives the unattended eDiscovery download. Bundle both the
# Python package (which ships the Node-based ``driver``) and the Chromium
# browser build so the feature works on a machine that never ran
# ``playwright install``.
hiddenimports += collect_submodules("playwright")
datas += collect_data_files("playwright")

_pw_root = _playwright_browsers_root()
if _pw_root is not None:
    # The download paths launch Playwright with
    # ``channel="chromium-headless-shell"``, so only the lightweight
    # headless-shell build is needed at runtime — the full ``chromium-*``
    # binary (hundreds of MB) is intentionally excluded. We also keep just
    # the *newest* headless-shell / winldd version when the build machine
    # has several cached, to avoid shipping duplicates.
    def _version_key(name: str) -> int:
        tail = name.rsplit("-", 1)[-1]
        return int(tail) if tail.isdigit() else -1

    def _newest(prefix: str) -> str | None:
        candidates = [
            c.name for c in _pw_root.iterdir()
            if c.is_dir() and c.name.startswith(prefix)
        ]
        return max(candidates, key=_version_key) if candidates else None

    _keep_names: set[str] = {".links"}
    for _prefix in ("chromium_headless_shell-", "winldd-"):
        _newest_name = _newest(_prefix)
        if _newest_name is not None:
            _keep_names.add(_newest_name)

    def _keep(name: str) -> bool:
        return name in _keep_names

    for child in _pw_root.iterdir():
        if not _keep(child.name):
            continue
        for path in child.rglob("*"):
            if path.is_file():
                rel_parent = path.parent.relative_to(_pw_root)
                datas.append((str(path), str(Path("ms-playwright") / rel_parent)))
    print(f"[spec] Bundling Playwright browsers from {_pw_root}: "
          f"{sorted(_keep_names)}")
else:
    print("[spec] WARNING: Playwright browsers not found; eDiscovery "
          "download will not work on a clean PC. Run "
          "`python -m playwright install chromium` before building.")

# Bundle the application icon (used for the window/taskbar and the EXE).
_icon_ico = src_root / "resources" / "app.ico"
_icon_png = src_root / "resources" / "app.png"
if (src_root / "resources").is_dir():
    datas += collect_data_files(
        "copilot_watchtower",
        includes=["resources/*"],
        excludes=["resources/app_source.png"],
    )

a = Analysis(
    [str(entry_script)],
    pathex=[str(project_root / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[str(project_root / "packaging" / "rthook_playwright.py")],
    excludes=["tkinter"],
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CopilotWatchTower",
    icon=str(_icon_ico) if _icon_ico.exists() else None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="CopilotWatchTower",
)
