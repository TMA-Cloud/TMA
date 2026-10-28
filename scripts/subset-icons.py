"""Rebuild the app's icon fonts from the icons listed in crates/tma-ui/src/icons/ph.rs.

The full Phosphor 2.1 fonts in crates/tma-ui/assets/fonts/phosphor/ hold about 1,500
icons; the app ships only the ones it names. Run it after adding an icon to ph.rs:

    pip install fonttools
    python scripts/subset-icons.py

Filled icons share Phosphor's codepoints with the outlined ones, so the fill font's
glyphs are moved to U+F0000 + (codepoint - U+E000) and both fonts load side by side.
"""

import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "crates" / "tma-ui" / "assets" / "fonts"
LIST = ROOT / "crates" / "tma-ui" / "src" / "icons" / "ph.rs"
FILL_BASE = 0xF0000
PHOSPHOR_BASE = 0xE000


def codepoints(text):
    return [int(cp, 16) for cp in re.findall(r'"\\u\{([0-9A-Fa-f]+)\}"', text)]


def subset_font(source, unicodes, target, remap=None):
    font = TTFont(source)
    options = subset.Options()
    # Icons only: no ligatures (which would map letters to blank glyphs), no hinting.
    options.layout_features = []
    options.hinting = False
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    if remap:
        cmap = font.getBestCmap()
        moved = {remap(cp): glyph for cp, glyph in cmap.items()}
        table = CmapSubtable.newSubtable(12)
        table.platformID, table.platEncID, table.language, table.cmap = 3, 10, 0, moved
        font["cmap"].tables = [table]
    font.save(target)
    print(f"{target.name}: {len(unicodes)} icons, {target.stat().st_size} bytes")


def main():
    text = LIST.read_text(encoding="utf-8")
    regular_part, fill_part = text.split("pub mod fill", 1)
    regular = sorted(set(codepoints(regular_part)))
    fill = sorted({cp - FILL_BASE + PHOSPHOR_BASE for cp in codepoints(fill_part)})
    subset_font(FONTS / "phosphor" / "Phosphor.ttf", regular, FONTS / "PhosphorIcons.ttf")
    subset_font(
        FONTS / "phosphor" / "Phosphor-Fill.ttf",
        fill,
        FONTS / "PhosphorIcons-Fill.ttf",
        remap=lambda cp: cp - PHOSPHOR_BASE + FILL_BASE,
    )


if __name__ == "__main__":
    main()
