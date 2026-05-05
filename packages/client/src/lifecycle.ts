// Lifecycle state machine for UnworkletNode (per docs/05-client.md §4 +
// draft_spec §11 transition rules).
//
//   creating  →  ready  →  running  →  disposed
//                  └─→  errored (terminal)
//
// State transitions:
//   creating → ready    : worklet 'ready' message received, layout known
//   ready    → running  : first non-zero process invocation
//   running  → disposed : explicit dispose() call
//   any      → errored  : trap or fatal error (terminal)

export type LifecycleState =
  | "creating"
  | "ready"
  | "running"
  | "disposed"
  | "errored";

export type LifecycleListener = (state: LifecycleState, prev: LifecycleState) => void;

export class Lifecycle {
  private _state: LifecycleState = "creating";
  private _listeners: LifecycleListener[] = [];

  get state(): LifecycleState {
    return this._state;
  }

  transition(next: LifecycleState): void {
    const prev = this._state;
    if (prev === next) return;
    if (prev === "disposed" || prev === "errored") {
      // terminal; no further transitions
      return;
    }
    this._state = next;
    for (const l of this._listeners) {
      try {
        l(next, prev);
      } catch (e) {
        console.error("[unworklet/lifecycle] listener error:", e);
      }
    }
  }

  on(listener: LifecycleListener): () => void {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }
}
