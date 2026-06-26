import { connectRemoteDevTools, parseRemoteConnection } from "@vitejs/devtools-kit/client";

/**
 * Shared devtools RPC connection for every panel view.
 *
 * The panel runs inside an iframe the devtools host does NOT inject its client
 * context into. The dock is registered with `remote: true`, so the host injects
 * a session auth-token descriptor into the iframe URL; `connectRemoteDevTools()`
 * reads it and connects as a TRUSTED client. Trust is by token, not by a
 * version-coupled anonymous RPC scope (`vite:anonymous:` vs `devframe:anonymous:`
 * across devtools-kit majors), so the panel works against whatever devtools host
 * the user's toolchain ships — no version match required.
 *
 * One connection backs all four views (graph / state / signals / MIDI); the
 * promise is memoised so they share a single WebSocket.
 */
export type PanelRpc = Awaited<ReturnType<typeof connectRemoteDevTools>>;

let rpcPromise: Promise<PanelRpc> | null = null;

export function getPanelRpc(): Promise<PanelRpc> {
  if (!rpcPromise) {
    // No descriptor = the panel was opened outside the devtools host (e.g. the
    // URL hit directly). Connecting would throw; reject with a clear message the
    // callers already swallow rather than surfacing an opaque parse error.
    rpcPromise = parseRemoteConnection()
      ? connectRemoteDevTools()
      : Promise.reject(new Error("unworklet devtools panel: no host connection descriptor"));
  }
  return rpcPromise;
}
