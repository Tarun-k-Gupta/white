"""The inspected deck: a seeded concrete texture with judge-placed defects.

Everything here is a pure function of (seed, defects in order), so a replay
renders byte-identical camera crops. Coordinates are millimetres; image rows
follow world +y.
"""
from __future__ import annotations

import io
import math
import os
import random
from dataclasses import asdict, dataclass
from typing import List, Optional, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .canonical import keccak_hex

PX_PER_M = 128
BLOCK_PX = 32  # detector block = 0.25 m
CONCRETE_RGB = (152, 150, 146)
ANOMALY_DELTA = 45  # max-channel deviation from concrete that counts as "marked"
CROP_PX = 256

# (length m, width px, heading jitter rad/step, branches) - all >= 2 px wide so
# the on-board detector can see them
CRACK_VARIANTS = [
    (0.85, 3, 0.35, 2),
    (0.70, 2, 0.50, 1),
    (0.90, 2, 0.25, 3),
    (0.60, 4, 0.30, 0),
    (0.80, 2, 0.60, 2),
]
DECOY_VARIANTS = ["paint_stripe", "cable"]


@dataclass
class Defect:
    id: int
    kind: str  # "crack" | "decoy"
    x_mm: int
    y_mm: int
    variant: int

    def to_json(self) -> dict:
        return asdict(self)


class World:
    def __init__(self, deck_w_mm: int, deck_h_mm: int, seed: int, texture_dir: Optional[str] = None):
        self.deck_w_mm = deck_w_mm
        self.deck_h_mm = deck_h_mm
        self.seed = seed
        self.texture_dir = texture_dir
        self.w_px = deck_w_mm * PX_PER_M // 1000
        self.h_px = deck_h_mm * PX_PER_M // 1000
        self.bx = self.w_px // BLOCK_PX
        self.by = self.h_px // BLOCK_PX
        self.defects: List[Defect] = []
        self.img = self._render_concrete()
        # display-only copy of the marks, so the dashboard map can show thin cracks
        # after downscaling; never part of a camera crop
        self.marks = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        self._ref = Image.new("RGB", self.img.size, CONCRETE_RGB)
        self.anomaly = [[0] * self.bx for _ in range(self.by)]  # 0..255 per block
        self._update_anomaly(0, 0, self.bx, self.by)

    # ------------------------------------------------------------------ render
    def _render_concrete(self) -> Image.Image:
        rng = random.Random(f"deck:{self.seed}")
        cw, ch = self.w_px // 32 + 2, self.h_px // 32 + 2
        coarse = Image.frombytes("L", (cw, ch), bytes(rng.randrange(256) for _ in range(cw * ch)))
        coarse = coarse.resize((self.w_px, self.h_px), Image.BICUBIC).point(lambda v: int(128 + (v - 128) * 0.15))
        fine = Image.frombytes("L", (self.w_px, self.h_px), rng.randbytes(self.w_px * self.h_px))
        fine = fine.point(lambda v: int(128 + (v - 128) * 0.10))
        lum = ImageChops.add(coarse, fine, scale=1.0, offset=-106)  # centred on 150
        r = lum.point(lambda v: min(255, v + 2))
        b = lum.point(lambda v: max(0, v - 4))
        return Image.merge("RGB", (r, lum, b))

    def _update_anomaly(self, bx0: int, by0: int, bx1: int, by1: int) -> None:
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(self.bx, bx1), min(self.by, by1)
        if bx1 <= bx0 or by1 <= by0:
            return
        box = (bx0 * BLOCK_PX, by0 * BLOCK_PX, bx1 * BLOCK_PX, by1 * BLOCK_PX)
        diff = ImageChops.difference(self.img.crop(box), self._ref.crop(box))
        r, g, b = diff.split()
        mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
        mask = mx.point(lambda v: 255 if v > ANOMALY_DELTA else 0)
        red = mask.reduce(BLOCK_PX)
        px = red.load()
        for j in range(by1 - by0):
            for i in range(bx1 - bx0):
                self.anomaly[by0 + j][bx0 + i] = px[i, j]

    def add_defect(self, kind: str, x_mm: int, y_mm: int, variant: int) -> Defect:
        if kind not in ("crack", "decoy"):
            raise ValueError("kind must be crack or decoy")
        n_var = len(CRACK_VARIANTS) if kind == "crack" else len(DECOY_VARIANTS)
        d = Defect(id=len(self.defects), kind=kind, x_mm=int(x_mm), y_mm=int(y_mm), variant=int(variant) % n_var)
        self.defects.append(d)
        cx, cy = d.x_mm * PX_PER_M / 1000.0, d.y_mm * PX_PER_M / 1000.0
        if not self._paste_texture(d, cx, cy):
            for target in (self.img, self.marks):
                rng = random.Random(f"defect:{self.seed}:{d.id}:{d.kind}:{d.variant}")
                draw = ImageDraw.Draw(target)
                if kind == "crack":
                    _draw_crack(draw, rng, cx, cy, *CRACK_VARIANTS[d.variant])
                elif DECOY_VARIANTS[d.variant] == "paint_stripe":
                    _draw_stripe(draw, rng, cx, cy)
                else:
                    _draw_cable(draw, rng, cx, cy)
        r = int(0.6 * PX_PER_M)
        self._update_anomaly(int((cx - r) // BLOCK_PX), int((cy - r) // BLOCK_PX),
                             int((cx + r) // BLOCK_PX) + 1, int((cy + r) // BLOCK_PX) + 1)
        return d

    def _paste_texture(self, d: Defect, cx: float, cy: float) -> bool:
        """Optional real photos: <texture_dir>/<kind>/*.png, chosen by variant."""
        if not self.texture_dir:
            return False
        folder = os.path.join(self.texture_dir, d.kind)
        if not os.path.isdir(folder):
            return False
        files = sorted(f for f in os.listdir(folder) if f.lower().endswith((".png", ".jpg", ".jpeg")))
        if not files:
            return False
        tex = Image.open(os.path.join(folder, files[d.variant % len(files)])).convert("RGB")
        size = int(0.9 * PX_PER_M)
        tex = tex.resize((size, size), Image.LANCZOS)
        self.img.paste(tex, (int(cx - size / 2), int(cy - size / 2)))
        self.marks.paste(tex.convert("RGBA"), (int(cx - size / 2), int(cy - size / 2)))
        return True

    # ------------------------------------------------------------------ sensing
    def crop(self, cx_mm: int, cy_mm: int, size_mm: int = 1000) -> Tuple[bytes, str]:
        """Camera crop centred on a point. Returns (png bytes, pixel hash)."""
        half = size_mm * PX_PER_M // 2000
        cx, cy = cx_mm * PX_PER_M // 1000, cy_mm * PX_PER_M // 1000
        left = min(max(0, cx - half), self.w_px - 2 * half)
        top = min(max(0, cy - half), self.h_px - 2 * half)
        img = self.img.crop((left, top, left + 2 * half, top + 2 * half)).resize((CROP_PX, CROP_PX), Image.LANCZOS)
        raw = img.tobytes()
        pix_hash = keccak_hex(b"BBX-PIX-V1" + CROP_PX.to_bytes(2, "big") + CROP_PX.to_bytes(2, "big") + raw)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, compress_level=6)
        return buf.getvalue(), pix_hash

    def block_of(self, x_mm: int, y_mm: int) -> Tuple[int, int]:
        return (x_mm * PX_PER_M // 1000) // BLOCK_PX, (y_mm * PX_PER_M // 1000) // BLOCK_PX

    def block_center_mm(self, i: int, j: int) -> Tuple[int, int]:
        c = (BLOCK_PX // 2) * 1000 // PX_PER_M
        return i * BLOCK_PX * 1000 // PX_PER_M + c, j * BLOCK_PX * 1000 // PX_PER_M + c

    def preview_png(self, scale: int = 2) -> bytes:
        size = (self.w_px // scale, self.h_px // scale)
        img = self.img.resize(size, Image.BOX).filter(ImageFilter.GaussianBlur(2.5))
        marks = self.marks.resize(size, Image.BOX)
        marks.putalpha(marks.getchannel("A").point(lambda v: min(255, v * 3)))
        img.paste(marks, (0, 0), marks)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ---------------------------------------------------------------------- drawing
def _walk(rng: random.Random, x: float, y: float, heading: float, length_px: float, jitter: float):
    pts = [(x, y)]
    step = 5.0
    for _ in range(int(length_px / step)):
        heading += rng.gauss(0.0, jitter)
        x += step * math.cos(heading)
        y += step * math.sin(heading)
        pts.append((x, y))
    return pts


def _draw_crack(draw: ImageDraw.ImageDraw, rng: random.Random, cx: float, cy: float,
                length_m: float, width: int, jitter: float, branches: int) -> None:
    heading = rng.uniform(0, 2 * math.pi)
    half = length_m * PX_PER_M / 2
    a = _walk(rng, cx, cy, heading, half, jitter)
    b = _walk(rng, cx, cy, heading + math.pi, half, jitter)
    main = list(reversed(b)) + a[1:]
    dark = (rng.randrange(30, 50),) * 3
    n = len(main)
    for i in range(n - 1):
        taper = 1.0 - abs(i - n / 2) / (n / 2)  # thicker in the middle
        w = max(2, int(round(width * (0.6 + 0.6 * taper))))
        draw.line([main[i], main[i + 1]], fill=dark, width=w)
    for _ in range(branches):
        sx, sy = main[rng.randrange(n // 4, 3 * n // 4)]
        br = _walk(rng, sx, sy, heading + rng.choice((-1, 1)) * rng.uniform(0.5, 1.2), half * 0.5, jitter * 1.2)
        draw.line(br, fill=dark, width=max(2, width - 1))


def _draw_stripe(draw: ImageDraw.ImageDraw, rng: random.Random, cx: float, cy: float) -> None:
    heading = rng.uniform(0, math.pi)
    half = 0.45 * PX_PER_M
    dx, dy = half * math.cos(heading), half * math.sin(heading)
    draw.line([(cx - dx, cy - dy), (cx + dx, cy + dy)], fill=(214, 178, 44), width=11)


def _draw_cable(draw: ImageDraw.ImageDraw, rng: random.Random, cx: float, cy: float) -> None:
    heading = rng.uniform(0, math.pi)
    half = 0.45 * PX_PER_M
    amp = rng.uniform(6, 12)
    ux, uy = math.cos(heading), math.sin(heading)
    pts, hi = [], []
    for i in range(41):
        t = -half + 2 * half * i / 40
        o = amp * math.sin(t / half * math.pi)
        x, y = cx + t * ux - o * uy, cy + t * uy + o * ux
        pts.append((x, y))
        hi.append((x - 1.5 * uy, y + 1.5 * ux))
    draw.line(pts, fill=(26, 26, 30), width=7, joint="curve")
    draw.line(hi, fill=(92, 92, 98), width=1)
