/**
 * Black-box tests for NESTED `forSample` (`01-dsl.md` Q58: independent `i`
 * parameters, e.g. 2D buffer tile iteration).
 *
 * Each nesting level must carry its own loop counter: the inner loop must not
 * corrupt the outer counter (so the outer still runs all 128 samples), and the
 * outer `i` read inside the inner body must still resolve to the outer index.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput } from "../../dsl/declarations.ts";
import { f32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("nested forSample: an empty inner loop does not truncate the outer loop", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(f32(i)); // out[i] = i, written before the inner loop
          forSample(() => {
            // empty inner loop — must not advance the outer counter
          });
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBe(k);
  }
});

test("nested forSample: inner counter is independent; outer i still resolves inside the inner body", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          // Inner runs exactly once per outer sample (stride == block size, j == 0).
          forSample.byN(SAMPLES_PER_BLOCK, (j) => {
            out
              .ch(0)
              .at(i)
              .write(f32(i).add(f32(j))); // out[i] = i + j = i + 0 = i
          });
        });
      },
    };
  });
  const { outputs } = await render(proc);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBe(k);
  }
});
