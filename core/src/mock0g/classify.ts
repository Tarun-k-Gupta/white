/**
 * DEV-ONLY heuristic "vision model" for the mock: separates the sim's procedural
 * cracks (thin, jagged, grey) from its decoys (yellow paint, thick cable). It is
 * tuned to robot/blackbox_robot/world.py textures and is not a real classifier.
 */
import { PNG } from "pngjs";

export function classify(png: Buffer): { label: string; severity: number; action: string } {
  const { width, height, data } = PNG.sync.read(png);
  let n = 0;
  let sat = 0;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(Math.abs(r - 152), Math.abs(g - 150), Math.abs(b - 146)) <= 45) continue;
      n++;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (n < 150) return { label: "unsure", severity: 0, action: "descend" };
  if (sat / n > 60) return { label: "decoy", severity: 0, action: "continue" }; // paint
  const meanWidth = n / Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  if (meanWidth > 10) return { label: "decoy", severity: 0, action: "continue" }; // thick and uniform: a cable
  return { label: "crack", severity: meanWidth < 5 ? 1 : meanWidth < 7 ? 2 : 3, action: "descend" };
}
