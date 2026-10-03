import path from "node:path";

import { SAMPLES_PER_BLOCK } from "@unworklet/core";
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
      return {
        messages: d.events.map(({ name, payload, atSample }) => ({
          name,
          payload,
          atQuantum: Math.floor(atSample / SAMPLES_PER_BLOCK),
        })),
      };
  }
}

function expectPitch(channel: Float32Array, start: number, end: number, hz: number) {
  const crossings: number[] = [];
  for (let i = start + 1; i < end; i++) {
    const before = channel[i - 1]!;
    const after = channel[i]!;
    if (before <= 0 && after > 0) crossings.push(i - 1 - before / (after - before));
  }
  expect(crossings.length).toBeGreaterThan(2);
  const measured =
    (SOUND_CHECK_SAMPLE_RATE * (crossings.length - 1)) /
    (crossings[crossings.length - 1]! - crossings[0]!);
  expect(Math.abs(measured - hz), `expected pitch ${hz} Hz, measured ${measured}`).toBeLessThan(
    0.1,
  );
}

for (const check of soundChecks) {
  test(`${check.slug}: ${check.exercises}`, async () => {
    const processor = lowerToProcessor(check.source);
    const result = await renderOffline(processor, {
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
    if (check.drive.kind === "events") {
      const events = check.drive.events;
      expect(events.map((e) => e.atSample)).toEqual([12000, 24000, 36000]);
      expect(drive(check.drive)).toEqual({
        messages: [
          { name: "pitch", payload: { hz: 330 }, atQuantum: 93 },
          { name: "pitch", payload: { hz: 440 }, atQuantum: 187 },
          { name: "pitch", payload: { hz: 550 }, atQuantum: 281 },
        ],
      });
      const channel = result.outputs.main![0]!;
      expectPitch(channel, 1024, 11000, 220);
      const windows = [
        { start: 13000, end: 22000, hz: 330, boundary: 11904 },
        { start: 25000, end: 34000, hz: 440, boundary: 23936 },
        { start: 37000, end: 46000, hz: 550, boundary: 35968 },
      ];
      const renderEvents = async (stimuli: typeof events) => {
        const rendered = await renderOffline(processor, {
          sampleRate: SOUND_CHECK_SAMPLE_RATE,
          duration: SOUND_CHECK_FRAMES / SOUND_CHECK_SAMPLE_RATE,
          ...drive({ kind: "events", events: stimuli }),
        });
        expect(rendered.diagnostics).toEqual({ scrubbedSamples: 0, droppedSysexMessages: 0 });
        return rendered.outputs.main![0]!;
      };
      const control = await renderEvents([]);
      expect(channel.subarray(0, 11904)).toEqual(control.subarray(0, 11904));
      expect(channel.findIndex((v, i) => v !== control[i])).toBe(11904);
      for (const [index, window] of windows.entries()) {
        expectPitch(channel, window.start, window.end, window.hz);
        const omitted = await renderEvents(events.filter((_, i) => i !== index));
        const altered = await renderEvents(
          events.map((event, i) =>
            i === index ? { ...event, payload: { hz: window.hz + 37 } } : event,
          ),
        );
        for (const negative of [omitted, altered]) {
          expect(channel.subarray(0, window.boundary)).toEqual(
            negative.subarray(0, window.boundary),
          );
          expect(channel.findIndex((v, i) => v !== negative[i])).toBe(window.boundary);
          expect(() => expectPitch(negative, window.start, window.end, window.hz)).toThrow(
            /expected pitch/,
          );
        }
      }
    }
    await expectAudioMatchesSnapshot(result, {
      snapshotPath: path.join(GOLDENS, `${check.slug}.wav`),
      tolerance: TOLERANCE,
    });
  });
}
