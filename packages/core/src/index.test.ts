/**
 * Public-entry completeness: every type a public API surface references must be
 * re-exported from the package entry, so a consumer can name the parameter /
 * return / field types they are handed. A missing re-export is invisible at
 * runtime but blocks consumers from naming the type — caught here by `vp check`,
 * since the `import type` below fails to resolve when a member is not exported.
 */

import { expect, test } from "vite-plus/test";

import type {
  EventRingSlotDescriptor,
  MessageGraphPayload,
  MessageRingSlotDescriptor,
  MidiEventEmit,
  MidiEventEmitOf,
  MidiRingSlotDescriptor,
} from "./index.ts";

// Reference each type in a value-level signature so the import is "used" and the
// type names are checked against the entry's re-exports.
const _eventRing = (r: EventRingSlotDescriptor): number => r.capacity;
const _messageRing = (r: MessageRingSlotDescriptor): number => r.capacity;
const _midiRing = (r: MidiRingSlotDescriptor): string => r.name;
const _payload = (p: MessageGraphPayload<{ x: number }>): MessageGraphPayload<{ x: number }> => p;
const _emit = (e: MidiEventEmit): MidiEventEmit => e;
const _emitOf = (e: MidiEventEmitOf<"noteOn">): MidiEventEmitOf<"noteOn"> => e;

test("public API-referenced types are re-exported from the entry", () => {
  expect(
    [_eventRing, _messageRing, _midiRing, _payload, _emit, _emitOf].every(
      (f) => typeof f === "function",
    ),
  ).toBe(true);
});
