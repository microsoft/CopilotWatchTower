"""Generate application icons from a single source PNG.

Reads ``resources/app_source.png`` (the master 1024x1024 art) and emits:
  - ``resources/app.ico``     multi-resolution Windows icon (EXE + window)
  - ``resources/app.png``     256x256 PNG (Qt window/taskbar fallback)
  - ``packaging/Assets/*.png`` MSIX tile + logo assets

Run from the repo root:  python scripts/generate_icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "src" / "copilot_watchtower" / "resources"
ASSETS = ROOT / "packaging" / "Assets"

SOURCE = RES / "app_source.png"

# (filename, (width, height)) for the MSIX visual assets referenced by
# AppxManifest.xml.
MSIX_ASSETS = {
    "Square44x44Logo.png": (44, 44),
    "Square150x150Logo.png": (150, 150),
    "Wide310x150Logo.png": (310, 150),
    "StoreLogo.png": (50, 50),
}

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def _load_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(f"Source art not found: {SOURCE}")
    img = Image.open(SOURCE).convert("RGBA")
    # Normalize to a square canvas.
    if img.width != img.height:
        side = min(img.width, img.height)
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))
    return img


def _fit_contain(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Scale ``img`` to fit inside ``size`` (preserving aspect) on a
    transparent canvas — used for the wide tile."""
    target_w, target_h = size
    scale = min(target_w / img.width, target_h / img.height)
    new_w = max(1, int(round(img.width * scale)))
    new_h = max(1, int(round(img.height * scale)))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2), resized)
    return canvas


def main() -> None:
    img = _load_source()
    RES.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    # Windows .ico (multi-size) for the EXE and Qt window icon.
    ico_path = RES / "app.ico"
    img.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"wrote {ico_path}")

    # 256x256 PNG fallback for Qt.
    png_path = RES / "app.png"
    img.resize((256, 256), Image.LANCZOS).save(png_path, format="PNG")
    print(f"wrote {png_path}")

    # MSIX tiles / logos.
    for name, size in MSIX_ASSETS.items():
        out = ASSETS / name
        if size[0] == size[1]:
            tile = img.resize(size, Image.LANCZOS)
        else:
            tile = _fit_contain(img, size)
        tile.save(out, format="PNG")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
