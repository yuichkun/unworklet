/**
 * Dev-only live-node registry (DevTools integration §4.1). `createNode`
 * registers a handle when `__UNWORKLET_DEVTOOLS__` is on; the dev page-script
 * (injected by the Vite plugin in serve mode) reads the registry via the
 * `@unworklet/core/dev` subpath and X-rays each live node through its `devDump`.
 *
 * Production builds define `__UNWORKLET_DEVTOOLS__` as `false`, so no node ever
 * registers and this module is inert. There is no main-thread user API here —
 * registration is automatic and unconditional within `createNode` (zero-config:
 * the app never calls a devtools API).
 */

import type { SnapshotSlot } from "./snapshot.ts";
import type { UnworkletNode } from "./types.ts";

export type DevNodeHandle = {
  readonly node: UnworkletNode<unknown>;
  /** `registerProcessor` key — carries HMR hash suffixes, not for display. */
  readonly processorName: string;
  /** Human-readable processor name (the source export name) for tools. */
  readonly displayName: string;
  readonly schemaHash: string;
  /** Request the worklet's unfiltered all-slot dump (the live X-ray). */
  devDump(): Promise<SnapshotSlot[]>;
};

const handles = new Set<DevNodeHandle>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function registerDevNode(handle: DevNodeHandle): void {
  handles.add(handle);
  notify();
}

export function unregisterDevNode(handle: DevNodeHandle): void {
  if (handles.delete(handle)) notify();
}

export function getDevNodes(): readonly DevNodeHandle[] {
  return [...handles];
}

/** Subscribe to register / unregister; returns an unsubscribe thunk. */
export function onDevNodesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
