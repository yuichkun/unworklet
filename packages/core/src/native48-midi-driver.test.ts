import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  driveNative48Midi,
  freshProgress,
  NATIVE48_CLEANUP_MS,
} from "./__tests__/browser/fixtures/native48-midi-driver.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledContext() {
  const boundaries = Array.from({ length: 4 }, () => deferred<void>());
  const render = deferred<AudioBuffer>();
  const pendingResume = deferred<void>();
  let state: AudioContextState = "suspended";
  const ctx = {
    get state() {
      return state;
    },
    suspend: vi.fn((time: number) => boundaries[Math.round((time * 48000) / 128) - 1]!.promise),
    resume: vi.fn(() => pendingResume.promise),
    startRendering: vi.fn(() => {
      boundaries[0]!.resolve();
      return render.promise;
    }),
  };
  return {
    ctx,
    boundaries,
    render,
    setState: (next: AudioContextState) => {
      state = next;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

for (const mode of ["resume-reject", "resume-pending", "render-pending"] as const) {
  test(`native48 cleanup terminates ${mode}, preserving primary and cleanup failures`, async () => {
    const { ctx, boundaries, render, setState } = controlledContext();
    const first = new Error("observation failed");
    const resumeError = new Error("resume rejected");
    if (mode === "resume-reject") ctx.resume.mockRejectedValue(resumeError);
    if (mode === "render-pending") {
      let next = 1;
      ctx.resume.mockImplementation(async () => {
        if (next < 4) boundaries[next++]!.resolve();
        else setState("running");
      });
    }
    const progress = freshProgress();
    let returned = false;
    const outcome = driveNative48Midi(
      ctx,
      async () => {
        throw first;
      },
      progress,
    ).catch((error: unknown) => {
      returned = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(NATIVE48_CLEANUP_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await outcome) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(first);
    expect(error.errors[0]).toBe(first);
    expect(error.errors.slice(1)).toEqual(progress.cleanupFailures);
    if (mode === "resume-reject") expect(progress.cleanupFailures[0]).toBe(resumeError);
    expect(progress.cleanupFailures.at(-1)).toBeInstanceOf(Error);
    expect((progress.cleanupFailures.at(-1) as Error).message).toMatch(/deadline/);
    expect(progress.settled).toBe(false);
    expect(progress.state).toBe(mode === "render-pending" ? "running" : "suspended");
    expect(vi.getTimerCount()).toBe(0);
    // Late rejections remain handled, and cannot rewrite the reported outcome.
    render.reject(new Error("late renderer rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.settled).toBe(false);
  });
}

test("native48 cleanup shares one deadline across successive boundary/resume waits", async () => {
  const { ctx, boundaries } = controlledContext();
  const resumes = Array.from({ length: 4 }, () => deferred<void>());
  let count = 0;
  ctx.resume.mockImplementation(() => resumes[count++]!.promise);
  const first = new Error("observation failed");
  const progress = freshProgress();
  let returned = false;
  const outcome = driveNative48Midi(
    ctx,
    async () => {
      throw first;
    },
    progress,
  ).catch((error: unknown) => {
    returned = true;
    return error;
  });
  for (let i = 0; i < 2; i++) {
    await vi.advanceTimersByTimeAsync(400);
    resumes[i]!.resolve();
    boundaries[i + 1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(NATIVE48_CLEANUP_MS - 801);
  expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const error = (await outcome) as AggregateError;
  expect(error.cause).toBe(first);
  expect(progress.resumed).toEqual([128, 256]);
  expect(progress.cleanupFailures).toHaveLength(1);
  expect(progress.settled).toBe(false);
  expect(progress.state).toBe("suspended");
  expect(vi.getTimerCount()).toBe(0);
});

test("native48 resume watchdog works even without an earlier observation failure", async () => {
  const { ctx } = controlledContext();
  const progress = freshProgress();
  const outcome = driveNative48Midi(ctx, async () => {}, progress).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(NATIVE48_CLEANUP_MS);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/resume.*deadline/);
  expect(progress.cleanupFailures).toEqual([error]);
  expect(progress.settled).toBe(false);
  expect(progress.state).toBe("suspended");
  expect(vi.getTimerCount()).toBe(0);
});

test("native48 render rejection settles without waiting on unreached suspensions", async () => {
  const { ctx, render } = controlledContext();
  ctx.startRendering.mockImplementation(() => render.promise);
  const error = new Error("renderer rejected");
  const observe = vi.fn(async () => {});
  const progress = freshProgress();
  const outcome = driveNative48Midi(ctx, observe, progress).catch((failure: unknown) => failure);
  render.reject(error);
  expect(await outcome).toBe(error);
  expect(observe).not.toHaveBeenCalled();
  expect(ctx.resume).not.toHaveBeenCalled();
  expect(progress.boundaries).toEqual([]);
  expect(progress.cleanupFailures).toEqual([error]);
  expect(progress.settled).toBe(true);
  expect(progress.state).toBe("suspended");
  expect(vi.getTimerCount()).toBe(0);
});

test("native48 final-render watchdog works without an earlier failure", async () => {
  const { ctx, boundaries, setState } = controlledContext();
  let next = 1;
  ctx.resume.mockImplementation(async () => {
    if (next < 4) boundaries[next++]!.resolve();
    else setState("running");
  });
  const progress = freshProgress();
  const outcome = driveNative48Midi(ctx, async () => {}, progress).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(NATIVE48_CLEANUP_MS);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/rendering.*deadline/);
  expect(progress.cleanupFailures).toEqual([error]);
  expect(progress.resumed).toEqual([128, 256, 384, 512]);
  expect(progress.settled).toBe(false);
  expect(progress.state).toBe("running");
  expect(vi.getTimerCount()).toBe(0);
});
