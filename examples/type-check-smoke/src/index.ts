/**
 * Cross-package TypeScript type-check smoke (Phase 2 Step 2.6).
 *
 * Touches the major public surface of all 4 packages
 * (`@unworklet/core` + `@unworklet/core/simd` + `@unworklet/offline`
 * + `@unworklet/test` + `@unworklet/vite-plugin`) as an external
 * consumer would — type-only references, no runtime execution.
 *
 * The whole file compiles iff every public type / function signature
 * declared across the 4 packages composes consistently. Any drift
 * surfaces here as a TypeScript error.
 */

import {
  audioInput,
  audioOutput,
  CAPACITY_256,
  compile,
  createNode,
  createSubgraph,
  defineProcessor,
  defineSubgraph,
  event,
  forSample,
  inspect,
  num,
  param,
  replaceProcessor,
  SAMPLES_PER_BLOCK,
  state,
} from "@unworklet/core";
import type {
  CompiledProcessor,
  MidiEvent,
  NodeErrorEvent,
  ProcessorContext,
  UnworkletNode,
} from "@unworklet/core";

import { mulVec, splat, sumLanes, vec4 } from "@unworklet/core/simd";

import { renderOffline } from "@unworklet/offline";
import type { RenderOfflineConfig, RenderOfflineResult } from "@unworklet/offline";

import {
  expectAudioMatches,
  expectEventsEqual,
  expectNoNaN,
  expectPeakUnder,
  expectRmsUnder,
  expectStateMatches,
} from "@unworklet/test";

import unworkletPlugin from "@unworklet/vite-plugin";

// ─────────────────────────────────────────────────────────────────────────
// Touch every imported value so it is statically visible.
// All call sites are guarded by `() => { ... }` so they never execute.
// ─────────────────────────────────────────────────────────────────────────

const _typeCheckSmoke = (): void => {
  // Build-time constants.
  void SAMPLES_PER_BLOCK;
  void CAPACITY_256;

  // Plugin factory.
  void unworkletPlugin;

  // ── canonical Ex 1 (= stereo gain + meter) — touches audio I/O, param,
  //    state.expose with publish + snapshot, forSample, primitive method form.
  const processor = defineProcessor((_ctx: ProcessorContext) => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });

    const gain = param
      .f32({
        default: 1.0,
        min: 0.0,
        max: 4.0,
        automationRate: "a-rate",
      })
      .named("gain");

    const meterL = state
      .f32(0)
      .expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });
    const meterR = state
      .f32(0)
      .expose({ name: "meterR", snapshot: "transient", publish: { rateFps: 30 } });

    return {
      process: () => {
        forSample((i) => {
          const l = input.left.at(i).mul(gain.at(i));
          const r = input.right.at(i).mul(gain.at(i));
          out.left.at(i).write(l);
          out.right.at(i).write(r);

          meterL.write(l.abs().max(meterL.read()));
          meterR.write(r.abs().max(meterR.read()));
        });

        // Per-block decay.
        meterL.write(meterL.read().mul(0.95));
        meterR.write(meterR.read().mul(0.95));
      },
    };
  });

  // ── canonical Ex 6 essence (= MIDI ports + event + message + onReceive).
  defineProcessor((_ctx: ProcessorContext) => {
    const mIn = event.midi({ from: "main", name: "noteIn" });
    const mOut = event.midi({ to: "main", name: "arpOut", capacity: CAPACITY_256 });
    const reset = event<{ slot: number }>({ from: "main", name: "resetSlot" });
    const fired = event<{ velocity: number }>({ to: "main", name: "fired" });

    return {
      process: () => {
        mIn.onEvent("noteOn", ({ velocity, atSample }) => {
          fired.emitIf(true, { atSample, velocity });
          mOut.emitIf(true, {
            type: "noteOn",
            channel: num(0),
            note: num(60),
            velocity,
            atSample,
          });
        });
        reset.onReceive(({ slot: _slot }) => {
          // ...
        });
      },
    };
  });

  // ── L2 subgraph touch.
  const myOnepole = defineSubgraph((_coef: number) => ({
    process: () => {
      // body
    },
  }));
  const inst = createSubgraph(myOnepole, 0.5, { name: "lpfL" });
  void inst;

  // ── SIMD path touch.
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample.byN(4, (i) => {
          const v = vec4(num(0), num(0), num(0), num(0));
          const w = mulVec(v, splat(num(0.5)));
          const sum = sumLanes(w);
          out.ch(0).at(i).write(sum);
        });
      },
    };
  });

  // ── compile + createNode + replaceProcessor.
  void (async () => {
    const ctx = new AudioContext();
    // `compile()` is the bundler-side WASM emit entry; touched here for type surface check.
    void compile;
    const node: UnworkletNode<unknown> = await createNode(ctx, processor);

    node.params.gain.value = 0.8;
    node.state.meterL.subscribe((_v) => {
      // ...
    });
    node.onError((evt: NodeErrorEvent) => {
      void evt.code;
    });

    // MIDI send touches MidiEvent shape.
    const exampleEvent: MidiEvent = { type: "noteOn", channel: 0, note: 60, velocity: 100 };
    void exampleEvent;

    // replaceProcessor smoke.
    const swap = await replaceProcessor(node, processor);
    if (swap.ok) {
      void swap.node;
    }

    // snapshot + restore.
    const blob = await node.snapshot();
    void blob;
    const inspected = inspect(blob);
    void inspected.schemaHash;

    node.dispose();
  });

  // ── offline path touch.
  const _runOffline = async (cp: CompiledProcessor<unknown>): Promise<void> => {
    const cfg: RenderOfflineConfig = { sampleRate: 48000, duration: 1.0 };
    const result: RenderOfflineResult = await renderOffline(cp, cfg);
    void result.outputs;
    void result.events;
    void result.state;
  };
  void _runOffline;

  // ── test matchers touch.
  const _runMatchers = (result: RenderOfflineResult): void => {
    expectAudioMatches(result, result);
    expectAudioMatches(result, result, { tolerance: 0 });
    expectNoNaN(result);
    expectPeakUnder(result, -1);
    expectRmsUnder(result, -20);
    expectEventsEqual(result, []);
    expectStateMatches(result, new Uint8Array());
  };
  void _runMatchers;
};
void _typeCheckSmoke;
