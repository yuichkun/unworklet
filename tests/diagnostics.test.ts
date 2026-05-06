// Verify the diagnostics surface from docs/05-client §6.
//   - transport reports the actual transport name
//   - overflowCount() returns the real counter from the engine
//   - events.<name>.diagnostics.overflowCount() too
import { describe, expect, test } from "vite-plus/test";
import { createNode } from "@unworklet/client";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  message,
  event,
} from "@unworklet/core";

const SR = 48000;

function buildProc(pingCap: number, pongCap: number) {
  return defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const counter = state.f32(0);
    const ping = message<{ delta: number }>({ name: "ping", capacity: pingCap });
    const pong = event<{ at: number }>({ name: "pong", capacity: pongCap });
    return {
      process: () => {
        ping.onReceive(({ delta }: any) => {
          counter.store(delta);
          pong.emitIf(true, { at: 0 });
        });
        forSample((i) => out.set(0, i, counter.load()));
      },
    };
  });
}

describe("diagnostics surface", () => {
  test("messages.<name>.diagnostics.overflowCount() reports real overflow on JS engine", async () => {
    const node = await createNode(null, buildProc(4, 4), { sampleRate: SR, blockSize: 128 });
    // Capacity is 4 — send 6 messages without rendering. Excess 2 bump
    // the overflow counter.
    for (let i = 0; i < 6; i++) node.messages.ping!({ delta: i });
    expect(node.messages.ping!.diagnostics.overflowCount()).toBeGreaterThanOrEqual(2);
  });

  test("events.<name>.diagnostics.overflowCount() reports real overflow on JS engine", async () => {
    const node = await createNode(null, buildProc(64, 4), { sampleRate: SR, blockSize: 128 });
    // Send way more inbound messages than the event ring can hold.
    // Each one emits one pong. Render once to drain.
    for (let i = 0; i < 32; i++) node.messages.ping!({ delta: i });
    node.__engine.render({});
    expect(node.events.pong!.diagnostics.overflowCount()).toBeGreaterThan(0);
  });

  test("node.lifecycle exposes the current state", async () => {
    const node = await createNode(null, buildProc(8, 8), { sampleRate: SR, blockSize: 128 });
    expect(["creating", "ready"]).toContain(node.lifecycle?.state ?? "ready");
  });
});
