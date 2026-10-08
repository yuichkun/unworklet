type TracePort = {
  addEventListener(kind: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(kind: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
};

export async function flushBoundaryTrace(port: TracePort): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receive = (_event: MessageEvent): void => {};
  let result: Record<string, unknown>;
  let cleanupFailed = false;
  try {
    result = await new Promise<Record<string, unknown>>((resolve) => {
      receive = (event: MessageEvent): void => {
        try {
          if (event.data?.kind !== "boundary-trace-result") return;
          resolve({
            ...event.data,
            rows: Array.from((event.data.rows as Float64Array).subarray(0, event.data.used * 9)),
          });
        } catch {
          resolve({ error: "trace reply decode failed" });
        }
      };
      timer = setTimeout(() => resolve({ error: "trace flush timed out" }), 1000);
      port.addEventListener("message", receive);
      port.postMessage({ kind: "boundary-trace-flush" });
    });
  } catch {
    result = { error: "trace flush failed" };
  } finally {
    clearTimeout(timer);
    try {
      port.removeEventListener("message", receive);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) result.cleanupError = "trace listener removal failed";
  return result;
}
