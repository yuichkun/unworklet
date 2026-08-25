/**
 * Wire format for the postMessage-fallback egress frame — the single
 * transferable packet that carries one quantum's worklet→main ring news
 * (event rings + MIDI out rings) when `SharedArrayBuffer` is unavailable.
 *
 * Why a pooled frame instead of per-ring messages: the fallback egress used to
 * build a fresh `Uint8Array` (and a content-region `.slice()`) on the audio
 * thread every quantum — a per-quantum heap allocation, which the realtime
 * invariants forbid (`00-foundations.md` §5.1 invariant 1). The pool inverts
 * ownership: main pre-allocates `EGRESS_POOL_COUNT` buffers sized to the
 * worst case and transfers them to the worklet; the worklet encodes into a
 * free buffer and transfers it back; main decodes, then returns the buffer
 * together with its consumed-tail acknowledgements (the consumer→producer
 * feedback the postMessage path otherwise lacks). Ownership ping-pongs, and
 * the audio thread never allocates.
 *
 * Frame layout (little-endian u32 words unless noted):
 *
 *   u32 eventSectionCount
 *   u32 midiSectionCount
 *   eventSectionCount × event section, then midiSectionCount × midi section,
 *   each 4-aligned:
 *
 *     u32 ringIndex
 *     u32 head          — the producer head this section drained up to
 *                          (absolute i32 ring counter; the consumer acks it)
 *     u32 newSlotCount
 *     u32 overflowCount — producer-lifetime total, mirrors the SAB header word
 *     u32 contentLen    — bytes of trailing content region (0 = none)
 *     newSlotCount × slotSize bytes of slots (slot layout identical to the
 *       in-memory ring; slotSize is 4-aligned for event rings, 8 for MIDI)
 *     contentLen bytes of content region (typed-array payloads for event
 *       rings, sysex chunks for MIDI), padded to the next 4-byte boundary
 *
 * The worst-case frame size is static — every ring full, whole content
 * regions attached — so a pool buffer sized by `egressPoolBufferBytes` always
 * fits and the encoder never bounds-checks in the hot path.
 */

export const EGRESS_HEADER_BYTES = 8;
export const EGRESS_SECTION_HEADER_BYTES = 20;
export const EGRESS_POOL_COUNT = 3;

const MIDI_SLOT_BYTES = 8;

export const alignUp4 = (n: number): number => (n + 3) & ~3;

export type EgressEventRingDescriptor = {
  readonly capacity: number;
  readonly slotSize: number;
  readonly payloadContent?: { readonly capacity: number } | undefined;
};

export type EgressMidiRingDescriptor = {
  readonly direction: "in" | "out";
  readonly capacity: number;
  readonly sysex?: { readonly perChunk: number; readonly chunks: number } | undefined;
};

/**
 * Worst-case byte size of one egress frame for the given rings — the size main
 * allocates each pool buffer at. Both sides compute this from the same ring
 * descriptors `createNode` hands to the worklet, so the two never disagree.
 */
export function egressPoolBufferBytes(
  eventRings: readonly EgressEventRingDescriptor[],
  midiRings: readonly EgressMidiRingDescriptor[],
): number {
  let bytes = EGRESS_HEADER_BYTES;
  for (const ring of eventRings) {
    bytes +=
      EGRESS_SECTION_HEADER_BYTES +
      ring.capacity * ring.slotSize +
      alignUp4(ring.payloadContent?.capacity ?? 0);
  }
  for (const ring of midiRings) {
    if (ring.direction !== "out") continue;
    bytes +=
      EGRESS_SECTION_HEADER_BYTES +
      ring.capacity * MIDI_SLOT_BYTES +
      alignUp4(ring.sysex !== undefined ? ring.sysex.perChunk * ring.sysex.chunks : 0);
  }
  return bytes;
}
