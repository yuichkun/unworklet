// Self-contained re-export of the unworklet worklet runtime. runtimeCompile.ts
// imports this via `?worker&url`, which makes Vite bundle it into a single chunk
// with no bare imports. The runtime-compiled AudioWorklet entry (a Blob module)
// then imports `makeWorkletNamespaceFromMeta` from that chunk's absolute URL —
// AudioWorklet modules cannot resolve bare specifiers, so the dependency must be
// pre-bundled into a URL-importable file.
export { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet";
