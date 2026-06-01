/**
 * Black-box behavior: `pipe(x, ...fns)` free function + `Node<T>.pipe(fn)` method
 * (RFC-001 S10). Pure left-to-right composition — `pipe(x, f, g)` is exactly
 * `g(f(x))`, with no graph node of its own. Verified by rendering a pipe-composed
 * processor against its hand-composed equivalent.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import "../../dsl/pipe.ts";
import { audioInput, audioOutput } from "../../dsl/declarations.ts";
import { pipe } from "../../index.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";
import type { Node } from "../../types.ts";

import { render } from "./render.ts";

const absF32 = (v: Node<"f32">): Node<"f32"> => v.abs();
const double = (v: Node<"f32">): Node<"f32"> => v.mul(2);

test("pipe(x, abs, double) renders identically to double(abs(x))", async () => {
  const make = (usePipe: boolean) =>
    defineProcessor(() => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            const x = input.ch(0).at(i);
            const y = usePipe ? pipe(x, absF32, double) : double(absF32(x));
            out.ch(0).at(i).write(y);
          });
        },
      };
    });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = -1.5;
  x[1] = 2;
  x[2] = -0.25;
  const piped = await render(make(true), { inputs: { main: [x] } });
  const manual = await render(make(false), { inputs: { main: [x] } });
  expect(Array.from(piped.outputs.main![0]!.subarray(0, 3))).toEqual([3, 4, 0.5]); // abs * 2
  expect(Array.from(piped.outputs.main![0]!.subarray(0, 3))).toEqual(
    Array.from(manual.outputs.main![0]!.subarray(0, 3)),
  );
});

test("pipe(x) with no functions returns x unchanged", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(pipe(input.ch(0).at(i)));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 0.7;
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(outputs.main![0]![0]).toBeCloseTo(0.7, 6);
});

test("x.pipe(double) method form matches double(x)", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(input.ch(0).at(i).pipe(double));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 1.5;
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(outputs.main![0]![0]).toBeCloseTo(3, 6);
});
