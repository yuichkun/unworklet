import { expect, test } from "vite-plus/test";

import { COMPILE_WORKER_DEPS, devOptimizeDeps } from "./compile-worker-optimizer.ts";

test("the compile worker's core entries are optimized with the first scan on every Vite", () => {
  for (const version of ["6.4.3", "7.3.5", "8.0.16"]) {
    expect(devOptimizeDeps(version).include).toEqual([...COMPILE_WORKER_DEPS]);
  }
});

test.each(["6.4.3", "7.3.5"])(
  "Vite %s's esbuild optimizer keeps the self-check define and admits top-level await",
  (version) => {
    expect(devOptimizeDeps(version).esbuildOptions).toEqual({
      define: { __UNWORKLET_SELFCHECK__: "true" },
      supported: { "top-level-await": true },
    });
  },
);

test("Vite 8 optimizes with Rolldown and gets no esbuild options", () => {
  const options = devOptimizeDeps("8.0.16");
  expect(options.esbuildOptions).toBeUndefined();
  expect(options.rolldownOptions).toEqual({
    transform: { define: { __UNWORKLET_SELFCHECK__: "true" } },
  });
});
