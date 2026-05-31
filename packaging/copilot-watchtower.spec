# PyInstaller spec for CopilotWatchTower.
# Build a one-folder bundle on Windows:
#   pyinstaller packaging/copilot-watchtower.spec --clean --noconfirm
#
# The resulting ``dist/CopilotWatchTower/`` directory can be wrapped by
# MSIX (see ``AppxManifest.xml``) or distributed as a portable ZIP.
# This spec only relies on PyInstaller's auto-collected metadata and
# the package's static resources (SQL schema, .qm translation files).

# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

project_root = Path(SPECPATH).resolve().parent
src_root = project_root / "src" / "copilot_watchtower"
# Entry script lives next to this spec file. It performs an absolute
# import of ``copilot_watchtower`` so PyInstaller does not run the
# package's ``__main__.py`` as a top-level script (which would break
# its relative imports with "attempted relative import with no known
# parent package").
entry_script = project_root / "packaging" / "launcher.py"

datas = []
# Bundle the SQL schema and i18n files into the package directory so
# ``importlib.resources`` and ``QTranslator`` can locate them at runtime.
datas += collect_data_files(
    "copilot_watchtower",
    includes=["db/schema.sql", "i18n/*.qm", "i18n/*.ts"],
)

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

a = Analysis(
    [str(entry_script)],
    pathex=[str(project_root / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
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
    icon=None,
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
