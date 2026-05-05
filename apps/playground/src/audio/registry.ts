// Registry of available processors for the playground. Each name maps to a
// CompiledProcessor that the WASM compiler can build at runtime.

import type { CompiledProcessor } from "@unworklet/core";
import {
  stereoGain,
  threeBandEQ,
  linearPhaseEQ,
  lookaheadLimiter,
  granularSampler,
  arpeggiator,
  convolutionReverb,
  polySynth,
  feedbackDelay,
  chorus,
  distortion,
  drumSampler,
  compressor,
  fmSynth,
} from "@unworklet/examples";

export const processorRegistry: Record<string, CompiledProcessor> = {
  stereoGain,
  threeBandEQ,
  linearPhaseEQ,
  lookaheadLimiter,
  granularSampler,
  arpeggiator,
  convolutionReverb,
  polySynth,
  feedbackDelay,
  chorus,
  distortion,
  drumSampler,
  compressor,
  fmSynth,
};
