/**
 * Inbound `message<T>` payload field meta + the bool wire-type seal
 * (`02-messaging.md` §5.3 + `01-dsl.md` §4.2).
 *
 * An inbound payload proxy is type-blind at runtime — `T` is erased before graph
 * capture, so the proxy knows only a field's *name*, not whether it was declared
 * `number` or `boolean`. Each field therefore defaults to the `f32` wire (a
 * declared `number` keeps its fraction) and is *sealed* to `bool` the moment the
 * field node is consumed in a boolean position. A declared `boolean` field is
 * typed `Node<'bool'>` by `MessageGraphPayload<T>`, so TypeScript only lets it
 * flow into those positions (`state.bool.write`, `select` cond, `not()`,
 * `emitIf` cond, a `bool` buffer write) — which makes the seal reliable: a
 * `boolean` field is always sealed before layout, and a `number` field never
 * reaches a bool position so it keeps the f32 default.
 *
 * The field's wire type lives on the declaration (`decl.fields[].wireType`), the
 * single source of truth read by layout / emit / the transport encode sites / the
 * `?worklet` witness — so sealing here pins the value every consumer sees.
 */

import type { MessageDeclAst } from "../compile/ast.ts";
import { isWrappedNode, unwrapAst } from "../compile/capture.ts";

/**
 * Hidden meta attached to an inbound message payload field node: which field of
 * which message it reads. The payload proxy attaches it; `buffer.copyFrom` and the
 * bool seal read it. An internal symbol that never appears on the public surface.
 */
export const PAYLOAD_FIELD_META = Symbol("unworklet.payloadFieldMeta");

export type PayloadFieldMeta = { decl: MessageDeclAst; field: string };

export function payloadFieldMeta(v: unknown): PayloadFieldMeta | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<symbol, PayloadFieldMeta | undefined>)[PAYLOAD_FIELD_META]
    : undefined;
}

/**
 * Seal an inbound message field's scalar wire type to `bool` when the field node
 * is consumed directly in a boolean position. No-ops on any value without the
 * field meta (a literal, a `state.read()`, an arithmetic result, an `f32()` /
 * `bool()` convert) — so only a *bare* field used directly as a boolean seals.
 * A typed-array field (`payloadElementType` already set) is left untouched.
 */
export function sealInboundFieldBool(value: unknown): void {
  const meta = payloadFieldMeta(value);
  if (meta === undefined) return;
  const field = meta.decl.fields.find((f) => f.name === meta.field);
  if (field === undefined || field.payloadElementType !== undefined) return;
  field.wireType = "bool";
  // Keep the already-handed-out node consistent (the field is read once per
  // handler, so this is the same AST every use references; inferAstType reads it).
  if (isWrappedNode(value)) {
    const ast = unwrapAst(value);
    if (ast.kind === "messageFieldRead") ast.wireType = "bool";
  }
}
