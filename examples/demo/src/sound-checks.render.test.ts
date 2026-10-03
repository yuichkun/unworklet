import path from "node:path";

import { lowerToProcessor } from "@unworklet/lang/browser";
import { renderOffline } from "@unworklet/offline";
import { expectAudioMatchesSnapshot } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

import {
  SOUND_CHECK_FRAMES,
  SOUND_CHECK_SAMPLE_RATE,
  soundChecks,
  sweep,
  type SoundCheckDrive,
} from "./sound-checks.ts";

const GOLDENS = path.join(import.meta.dirname, "__goldens__");
const TOLERANCE = 1e-5;

function drive(d: SoundCheckDrive): Record<string, unknown> {
  switch (d.kind) {
    case "none":
      return {};
    case "sweep":
      return { inputs: { [d.port]: Array.from({ length: d.channels }, () => sweep()) } };
    case "notes":
      return {
        events: [
          ...d.notes.map((note) => ({
            name: d.port,
            payload: { type: "noteOn", channel: 0, note, velocity: 100 },
            atSample: 0,
          })),
          ...d.notes.map((note) => ({
            name: d.port,
            payload: { type: "noteOff", channel: 0, note, velocity: 0 },
            atSample: 36000,
          })),
        ],
      };
    case "param-ramp":
      return {
        params: {
          [d.param]: Array.from(
            { length: SOUND_CHECK_FRAMES },
            (_, n) => (d.to * n) / SOUND_CHECK_FRAMES,
          ),
        },
      };
    case "events":
      return { events: d.events };
  }
}

for (const check of soundChecks) {
  test(`${check.slug}: ${check.exercises}`, async () => {
    const result = await renderOffline(lowerToProcessor(check.source), {
      sampleRate: SOUND_CHECK_SAMPLE_RATE,
      duration: SOUND_CHECK_FRAMES / SOUND_CHECK_SAMPLE_RATE,
      ...drive(check.drive),
    } as Parameters<typeof renderOffline>[1]);
    expect(result.sampleRate).toBe(SOUND_CHECK_SAMPLE_RATE);
    expect(result.diagnostics).toEqual({ scrubbedSamples: 0, droppedSysexMessages: 0 });
    for (const channels of Object.values(result.outputs)) {
      for (const channel of channels) {
        expect(channel.length).toBe(SOUND_CHECK_FRAMES);
        expect(channel.every(Number.isFinite)).toBe(true);
        const peak = channel.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(1);
        if (check.group === "operation") {
          expect(peak).toBeGreaterThanOrEqual(check.slug === "noise" ? 0.24 : 0.25);
        }
        if (check.drive.kind === "notes") {
          const silentFrom = check.slug === "granular" ? 4096 : 36000;
          expect(channel.subarray(silentFrom).every((v) => v === 0)).toBe(true);
        }
      }
    }
    await expectAudioMatchesSnapshot(result, {
      snapshotPath: path.join(GOLDENS, `${check.slug}.wav`),
      tolerance: TOLERANCE,
    });
  });
}
