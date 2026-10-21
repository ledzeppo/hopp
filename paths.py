"""Where the app keeps its files. Packaged builds use ~/Hopp, a source checkout uses the repo folder."""
import shutil
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
BUNDLE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))  # read-only files shipped with the app
DATA = Path.home() / "Hopp" if FROZEN else Path(__file__).parent  # designs, keys, settings, state

DATA.mkdir(parents=True, exist_ok=True)
(DATA / "designs").mkdir(exist_ok=True)
if FROZEN and not (DATA / "config.json").exists():
    shutil.copy(BUNDLE / "config.json", DATA / "config.json")
