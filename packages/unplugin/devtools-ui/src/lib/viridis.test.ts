import { expect, test } from "vite-plus/test";

import { VIRIDIS_LUT_256 } from "./viridis";

test("viridis spans purple to yellow with 256 bounded RGB samples", () => {
  expect(VIRIDIS_LUT_256).toHaveLength(256);
  expect(VIRIDIS_LUT_256[0]).toBe("rgb(68,1,84)");
  expect(VIRIDIS_LUT_256[255]).toBe("rgb(253,231,37)");
  expect(VIRIDIS_LUT_256[128]).toBe("rgb(38,130,142)");
  for (const color of VIRIDIS_LUT_256) {
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    for (const channel of color.match(/\d+/g)!.map(Number)) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  }
  for (let index = 1; index < VIRIDIS_LUT_256.length; index++) {
    const previous = VIRIDIS_LUT_256[index - 1]!.match(/\d+/g)!.map(Number);
    const current = VIRIDIS_LUT_256[index]!.match(/\d+/g)!.map(Number);
    expect(
      current.every((channel, component) => Math.abs(channel - previous[component]!) <= 5),
    ).toBe(true);
  }
});
