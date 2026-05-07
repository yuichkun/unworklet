# @unworklet/dsp

Math precision variants. Both subpaths re-export the same primitive names from `@unworklet/core` with different precision tags.

## /precise

```ts
import { sin, cos, tan, tanh, exp, log, sqrt } from "@unworklet/dsp/precise";
```

Compiles to a JS Math import (f64-precise). Reserve for paths where rounding matters (oversampled FFT, scientific computation).

## /table

```ts
import { sin, cos, exp, log } from "@unworklet/dsp/table";
```

Compiles to a 4096-entry quarter-wave / piecewise-linear lookup table embedded at the end of linear memory. ~22-bit accuracy, 3-5× faster than the JS Math import on hot paths.

`tan` and `tanh` are NOT exposed from `/table` — `tan` has poles every π/2 that ruin a uniform interpolation table; `tanh` saturates outside ±5. Use `default` precision for those (which is already a JS Math import).

## When to use which

| Path | Latency | Accuracy | Use |
|---|---|---|---|
| Default (`@unworklet/core`) | JS Math import | f64 | Most code |
| `/precise` | JS Math import | f64 | Reserved for future higher-precision lowerings |
| `/table` | LUT + interp | ~22 bits | Hot inner loops (per-sample sin in oscillators, etc.) |

The decision is per call site — you can mix.
