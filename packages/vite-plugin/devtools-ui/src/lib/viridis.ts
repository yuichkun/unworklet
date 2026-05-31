/**
 * Viridis colormap — perceptually uniform, colorblind-safe, monotonic in
 * luminance (= darker reads as lower amplitude even in grayscale). Pre-baked
 * into a 256-step RGB string LUT so per-pixel draw cost is one indexed lookup,
 * not an interpolation.
 *
 * Lives at module scope so the LUT is computed once for the whole module
 * graph; components that render spectrograms can import the same instance
 * instead of re-baking on every mount.
 */

const VIRIDIS_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 68, 1, 84],
  [0.13, 72, 40, 120],
  [0.25, 62, 73, 137],
  [0.38, 49, 104, 142],
  [0.5, 38, 130, 142],
  [0.63, 31, 158, 137],
  [0.75, 53, 183, 121],
  [0.88, 110, 206, 88],
  [1.0, 253, 231, 37],
];

const buildViridisLut = (size: number): string[] => {
  const lut: string[] = [];
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < VIRIDIS_STOPS.length - 1; j++) {
      const [t0, r0, g0, b0] = VIRIDIS_STOPS[j]!;
      const [t1, r1, g1, b1] = VIRIDIS_STOPS[j + 1]!;
      if (t >= t0 && t <= t1) {
        const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        r = Math.round(r0 + (r1 - r0) * f);
        g = Math.round(g0 + (g1 - g0) * f);
        b = Math.round(b0 + (b1 - b0) * f);
        break;
      }
    }
    lut.push(`rgb(${r},${g},${b})`);
  }
  return lut;
};

export const VIRIDIS_LUT_256: ReadonlyArray<string> = buildViridisLut(256);
