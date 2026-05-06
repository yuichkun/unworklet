// Re-export the canonical WASM-backed node helper from the shipped package.
// (Moved out of the playground in commit 4cdacf6+; previously this file
// held the implementation, which was a "private" surface the audit caught
// — the production path now lives in @unworklet/worklet so end-users have
// access to the same code.)
export { createWasmNode, type WasmUnworkletNode, type CreateWasmNodeOptions } from "@unworklet/worklet";
