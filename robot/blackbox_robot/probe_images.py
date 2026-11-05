"""Write the sim's crack and decoy crops for the Gate A probe.

    python -m blackbox_robot.probe_images assets/probe
"""
from __future__ import annotations

import os
import sys

from .world import CRACK_VARIANTS, DECOY_VARIANTS, World


def main(out: str) -> None:
    os.makedirs(out, exist_ok=True)
    w = World(24000, 8000, 42, os.environ.get("BLACKBOX_TEXTURE_DIR") or None)
    items = [("crack", v) for v in range(len(CRACK_VARIANTS))] + [("decoy", v) for v in range(len(DECOY_VARIANTS))]
    for i, (kind, v) in enumerate(items):
        x = 2000 + i * 3000
        w.add_defect(kind, x, 4000, v)
        png, _ = w.crop(x, 4000)
        with open(os.path.join(out, f"{kind}-{v}.png"), "wb") as f:
            f.write(png)
    print(f"wrote {len(items)} crops to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "assets/probe")
