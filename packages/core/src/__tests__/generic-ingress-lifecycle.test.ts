import { expect, test, vi } from "vite-plus/test";
import { createIngressLifecycle } from "./generic-ingress-lifecycle.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const boundaries = Array.from({ length: 4 }, () => deferred<void>());
  const rendering = deferred<void>();
  let resumed = 0;
  const context = {
    resume: async () => {
      resumed++;
      if (resumed < 4) boundaries[resumed]!.resolve();
      else rendering.resolve();
    },
  };
  boundaries[0]!.resolve();
  const lifecycle = createIngressLifecycle({
    context,
    boundaries: boundaries.map((item) => item.promise),
    rendering: rendering.promise,
    timeoutMs: 20,
  });
  return { lifecycle, context, rendering, boundaries, resumed: () => resumed };
}

for (const completed of [0, 2]) {
  test(`cleanup resumes every remaining suspension after failure at ${completed}`, async () => {
    const f = fixture();
    for (let i = 0; i < completed; i++) {
      await f.lifecycle.boundary(i);
      await f.lifecycle.resume();
    }
    const first = new Error("body assertion");
    f.lifecycle.fail(first);
    let disposed = false;
    await expect(
      f.lifecycle.cleanup([
        () => {
          disposed = true;
        },
      ]),
    ).rejects.toBe(first);
    expect(f.resumed()).toBe(4);
    expect(disposed).toBe(true);
  });
}

test("listener failure interrupts a pending wait and survives cleanup failures", async () => {
  const f = fixture();
  const first = new Error("listener decoding");
  const waiting = f.lifecycle.wait(new Promise<void>(() => {}));
  f.lifecycle.fail(first);
  await expect(waiting).rejects.toBe(first);
  const called: string[] = [];
  await expect(
    f.lifecycle.cleanup([
      () => {
        called.push("unsubscribe");
        throw new Error("unsubscribe failure");
      },
      () => {
        called.push("dispose");
        throw new Error("dispose failure");
      },
    ]),
  ).rejects.toBe(first);
  expect(called).toEqual(["unsubscribe", "dispose"]);
  expect(first.message).toContain("unsubscribe failure");
  expect(first.message).toContain("dispose failure");
});

for (const fault of [
  "resume rejects",
  "resume pending",
  "render rejects",
  "render pending",
  "boundary pending",
  "boundary rejects",
]) {
  test(`bounded teardown reports ${fault} and preserves first failure`, async () => {
    const f = fixture();
    const first = new Error("first failure");
    f.lifecycle.fail(first);
    if (fault === "resume rejects")
      f.context.resume = () => Promise.reject(new Error("resume refused"));
    if (fault === "resume pending") f.context.resume = () => new Promise<void>(() => {});
    if (fault === "render rejects") f.rendering.reject(new Error("render refused"));
    if (fault === "render pending")
      f.context.resume = async () => {
        for (const boundary of f.boundaries) boundary.resolve();
      };
    if (fault === "boundary pending") f.context.resume = async () => {};
    if (fault === "boundary rejects") f.boundaries[1]!.reject(new Error("suspend refused"));
    let disposed = false;
    await expect(
      f.lifecycle.cleanup([
        () => {
          disposed = true;
        },
      ]),
    ).rejects.toBe(first);
    expect(disposed).toBe(true);
    expect(first.message).toContain("cleanup");
    expect(first.message).toContain("native status");
    if (fault.endsWith("pending")) expect(first.message).toContain("pending");
  });
}

test("successful cleanup settles every tracked native operation", async () => {
  const f = fixture();
  await f.lifecycle.cleanup([]);
  expect(f.resumed()).toBe(4);
});

test("a wait timeout still permits complete teardown", async () => {
  const f = fixture();
  await expect(f.lifecycle.wait(new Promise<void>(() => {}), "snapshot")).rejects.toThrow(
    "snapshot timed out",
  );
  await f.lifecycle.cleanup([]);
  expect(f.resumed()).toBe(4);
});

test("cleanup retries a rejected resume once without skipping its suspension", async () => {
  const f = fixture();
  const resume = f.context.resume;
  let attempts = 0;
  f.context.resume = () => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error("transient resume refusal")) : resume();
  };
  await expect(f.lifecycle.cleanup([])).rejects.toThrow("transient resume refusal");
  expect(f.resumed()).toBe(4);
  expect(attempts).toBe(5);
});

test("listener failure concurrent with successful resume does not resume a boundary twice", async () => {
  const f = fixture();
  const first = new Error("listener during resume");
  const resume = f.context.resume;
  f.context.resume = async () => {
    f.lifecycle.fail(first);
    await resume();
  };
  await f.lifecycle.boundary(0);
  await expect(f.lifecycle.resume()).rejects.toBe(first);
  await expect(f.lifecycle.cleanup([])).rejects.toBe(first);
  expect(f.resumed()).toBe(4);
  expect(first.message).toBe("listener during resume");
});

test("all pending teardown waits share one deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.context.resume = () => new Promise<void>(() => {});
    const started = Date.now();
    const cleanup = f.lifecycle.cleanup([]).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    const failure = await cleanup;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("render=pending");
    expect(Date.now() - started).toBe(20);
  } finally {
    vi.useRealTimers();
  }
});

test("cleanup skips a rejected suspension and releases later registered boundaries", async () => {
  const boundaries = Array.from({ length: 4 }, () => deferred<void>());
  const rendering = deferred<void>();
  boundaries[0]!.resolve();
  boundaries[1]!.reject(new Error("unregistered suspension"));
  let resumed = 0;
  const context = {
    resume: async () => {
      resumed++;
      if (resumed === 1) boundaries[2]!.resolve();
      else if (resumed === 2) boundaries[3]!.resolve();
      else rendering.resolve();
    },
  };
  const lifecycle = createIngressLifecycle({
    context,
    boundaries: boundaries.map((item) => item.promise),
    rendering: rendering.promise,
    timeoutMs: 20,
  });
  const first = new Error("body failure");
  lifecycle.fail(first);
  await expect(lifecycle.cleanup([])).rejects.toBe(first);
  expect(resumed).toBe(3);
  expect(first.message).toContain("unregistered suspension");
  expect(first.message).toContain("suspensions=[fulfilled,rejected,fulfilled,fulfilled]");
  expect(first.message).toContain("render=fulfilled");
});
