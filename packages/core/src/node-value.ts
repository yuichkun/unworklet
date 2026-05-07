// Interp-mode wrapper for graph values. The capture path uses AST objects
// from c.fresh(); both paths share the same method shape (defined in
// methods.ts) so user code that uses method-chain DSL works identically in
// both modes.
//
// `valueOf()` makes existing JS coercions (`(a as N) + (b as N)`,
// `Float32Array[i] = v`, `(idx as number) | 0`) continue to work without
// changes — every numeric ToNumber path extracts the underlying primitive
// automatically.
//
// Methods are attached lazily by ./methods.ts to avoid the
// node-value → primitives → node-value circular dependency.

export class NodeImpl {
  constructor(public _v: number | boolean) {}
  valueOf(): number | boolean {
    return this._v;
  }
}

export function wrap<T = any>(v: number | boolean | NodeImpl): T {
  if (v instanceof NodeImpl) return v as unknown as T;
  return new NodeImpl(v) as unknown as T;
}

/**
 * Extract the underlying primitive from a NodeImpl wrapper. Use at sites
 * where JS truthiness / strict equality won't auto-coerce via valueOf
 * (`if (cond)`, `cond ? a : b` on bool nodes), since objects are always
 * truthy regardless of valueOf.
 */
export function unwrap(v: any): any {
  if (v instanceof NodeImpl) return v._v;
  return v;
}
