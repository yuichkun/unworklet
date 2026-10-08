export const NATIVE48_CLEANUP_MS = 1000;
export const freshProgress = () => ({
  boundaries: [] as number[],
  resumed: [] as number[],
  cleanupFailures: [] as unknown[],
  settled: false,
  state: "suspended" as AudioContextState,
});

type RenderContext = Pick<OfflineAudioContext, "state" | "suspend" | "resume" | "startRendering">;

// The deadline bounds waiting, not native renderer termination. After failure
// every cleanup wait shares one deadline; normal resume/final-render waits also
// have a watchdog. These limits never change audio offsets or the test timeout.
export async function driveNative48Midi(
  ctx: RenderContext,
  observe: (block: number) => Promise<void>,
  progress: ReturnType<typeof freshProgress>,
) {
  const failures: unknown[] = [];
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupDeadline: Promise<{ kind: "timeout"; error: Error }> | undefined;
  let timedOut = false;
  let renderSettled = false;
  const remember = (error: unknown, cleanup: boolean) => {
    failures.push(error);
    if (cleanup) progress.cleanupFailures.push(error);
    if (!cleanupDeadline && !timedOut) {
      cleanupDeadline = new Promise((resolve) => {
        cleanupTimer = setTimeout(
          () =>
            resolve({
              kind: "timeout",
              error: new Error("native48 MIDI cleanup deadline exceeded"),
            }),
          NATIVE48_CLEANUP_MS,
        );
      });
    }
  };
  const wait = async <T>(promise: Promise<T>, label: string, bounded = false): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      cleanupDeadline ??
      (bounded
        ? new Promise<{ kind: "timeout"; error: Error }>((resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  kind: "timeout",
                  error: new Error(`native48 MIDI ${label} deadline exceeded`),
                }),
              NATIVE48_CLEANUP_MS,
            );
          })
        : undefined);
    const settled = promise.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    try {
      const result = deadline ? await Promise.race([settled, deadline]) : await settled;
      if (result.kind === "timeout") timedOut = true;
      if (result.kind !== "value") throw result.error;
      return result.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let buffer: AudioBuffer | undefined;
  try {
    const boundaries = [128, 256, 384, 512].map((sample) =>
      ctx.suspend(sample / 48000).then(
        () => ({ kind: "boundary" as const, sample }),
        (error: unknown) => ({ kind: "boundary-error" as const, error }),
      ),
    );
    const rendering = ctx.startRendering().then(
      (value) => {
        renderSettled = true;
        return { kind: "rendered" as const, buffer: value };
      },
      (error: unknown) => {
        renderSettled = true;
        return { kind: "render-error" as const, error };
      },
    );
    let renderFailureRecorded = false;
    for (const [block, boundary] of boundaries.entries()) {
      let reached;
      try {
        reached = await wait(Promise.race([boundary, rendering]), "boundary");
      } catch (error) {
        remember(error, true);
        break;
      }
      if (reached.kind === "render-error") {
        remember(reached.error, true);
        renderFailureRecorded = true;
        break;
      }
      if (reached.kind === "rendered") {
        remember(new Error("render ended before MIDI boundary"), false);
        break;
      }
      if (reached.kind === "boundary-error") {
        remember(reached.error, true);
        continue;
      }
      progress.boundaries.push(reached.sample);
      try {
        if (failures.length === 0) await observe(block);
      } catch (error) {
        remember(error, false);
      } finally {
        try {
          await wait(ctx.resume(), "resume", true);
          progress.resumed.push(reached.sample);
        } catch (error) {
          remember(error, true);
        }
      }
      if (timedOut) break;
    }
    if (!timedOut) {
      try {
        const result = await wait(rendering, "rendering", true);
        if (result.kind === "rendered") buffer = result.buffer;
        else if (!renderFailureRecorded) remember(result.error, true);
      } catch (error) {
        remember(error, true);
      }
    }
  } finally {
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    progress.settled = renderSettled;
    progress.state = ctx.state;
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "native48 MIDI cleanup failed", { cause: failures[0] });
  if (failures.length > 0) throw failures[0];
  return buffer!;
}
