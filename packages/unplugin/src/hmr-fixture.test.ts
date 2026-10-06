import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer, type DevEnvironment } from "vite-plus";
import { expect, test, vi } from "vite-plus/test";

import { closeHmrServer } from "./hmr-fixture.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("waits for an in-flight dependency optimizer write before closing the fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unworklet-hmr-lifecycle-"));
  const dependency = path.join(root, "node_modules/fixture-dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "fixture-dependency", type: "module", exports: "./index.js" }),
  );
  await writeFile(path.join(dependency, "index.js"), "export const value = 42;");
  const events: string[] = [];
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  let reachedWriteGate = false;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: {
      include: ["fixture-dependency"],
      rolldownOptions: {
        plugins: [
          {
            name: "hold-fixture-optimizer-write",
            async generateBundle() {
              reachedWriteGate = true;
              started.resolve();
              await release.promise;
            },
            writeBundle() {
              events.push("write");
            },
            closeBundle() {
              finished.resolve();
            },
          },
        ],
      },
    },
  });
  let closing: Promise<void> | undefined;
  try {
    await started.promise;
    const originalClose = server.close.bind(server);
    const close = vi.spyOn(server, "close").mockImplementation(() => {
      events.push("close");
      return originalClose();
    });
    closing = closeHmrServer(server);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual(["write", "close"]);
    expect(
      await readFile(path.join(server.config.cacheDir, "deps/fixture-dependency.js"), "utf8"),
    ).toContain("42");
    await rm(root, { recursive: true, force: true });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    if (reachedWriteGate) await finished.promise;
    await closing;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("waits for dependencies discovered during an earlier optimization batch", async () => {
  const first = deferred();
  const second = deferred();
  const firstRead = deferred();
  const secondRead = deferred();
  let discovered: Record<string, { processing: Promise<void> }> = {
    first: { processing: first.promise },
  };
  const close = vi.fn(async () => {});
  const closing = closeHmrServer({
    close,
    environments: {
      client: {
        waitForRequestsIdle: async () => {},
        depsOptimizer: {
          metadata: {
            get discovered() {
              if ("first" in discovered) firstRead.resolve();
              if ("second" in discovered) secondRead.resolve();
              return discovered;
            },
          },
        },
      } as unknown as DevEnvironment,
    },
  });
  try {
    await firstRead.promise;
    discovered = { second: { processing: second.promise } };
    first.resolve();
    await Promise.race([
      secondRead.promise,
      closing.then(() => {
        throw new Error("server closed before the second optimization batch");
      }),
    ]);
    expect(close).not.toHaveBeenCalled();
    discovered = {};
    second.resolve();
    await closing;
    expect(close).toHaveBeenCalledOnce();
  } finally {
    discovered = {};
    first.resolve();
    second.resolve();
    await closing;
  }
});

test("waits for crawl and scan completion before reading dependencies from every environment", async () => {
  const environments = Object.fromEntries(
    ["client", "ssr"].map((name) => {
      const crawl = deferred();
      const scan = deferred();
      const processing = deferred();
      let completed = false;
      void processing.promise.then(() => {
        completed = true;
      });
      const discovered = vi.fn(() =>
        completed ? {} : { dependency: { processing: processing.promise } },
      );
      const environment = {
        waitForRequestsIdle: vi.fn(() => crawl.promise),
        depsOptimizer: {
          scanProcessing: scan.promise,
          metadata: {
            get discovered() {
              return discovered();
            },
          },
        },
      } as unknown as DevEnvironment;
      return [name, { crawl, scan, processing, discovered, environment }];
    }),
  );
  const close = vi.fn(async () => {});
  const closing = closeHmrServer({
    close,
    environments: Object.fromEntries(
      Object.entries(environments).map(([name, fixture]) => [name, fixture.environment]),
    ),
  });
  for (const fixture of Object.values(environments)) {
    expect(fixture.discovered).not.toHaveBeenCalled();
    fixture.crawl.resolve();
  }
  await Promise.resolve();
  for (const fixture of Object.values(environments)) {
    expect(fixture.discovered).not.toHaveBeenCalled();
    fixture.scan.resolve();
  }
  await Promise.resolve();
  for (const fixture of Object.values(environments))
    expect(fixture.discovered).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  environments.client!.processing.resolve();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  environments.ssr!.processing.resolve();
  await closing;
  expect(close).toHaveBeenCalledOnce();
});

test("closes a fixture with no active dependency optimization", async () => {
  const close = vi.fn(async () => {});
  await closeHmrServer({
    close,
    environments: {
      client: { depsOptimizer: undefined } as DevEnvironment,
      ssr: {
        waitForRequestsIdle: async () => {},
        depsOptimizer: { metadata: { discovered: {} } },
      } as unknown as DevEnvironment,
    },
  });
  expect(close).toHaveBeenCalledOnce();
});

test.each(["crawl", "scan", "processing"])(
  "closes the server and preserves a failed %s barrier",
  async (stage) => {
    const failure = new Error(`${stage} failed`);
    const barrier = deferred();
    const close = vi.fn(async () => {});
    const closing = closeHmrServer({
      close,
      environments: {
        client: {
          waitForRequestsIdle: async () => {
            if (stage === "crawl") await barrier.promise;
          },
          depsOptimizer: {
            scanProcessing: stage === "scan" ? barrier.promise : undefined,
            metadata: {
              discovered:
                stage === "processing" ? { dependency: { processing: barrier.promise } } : {},
            },
          },
        } as unknown as DevEnvironment,
      },
    });
    barrier.reject(failure);
    await expect(closing).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  },
);

test("preserves server shutdown failures", async () => {
  const failure = new Error("server shutdown failed");
  await expect(
    closeHmrServer({
      environments: {},
      close: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});

test("finishes every environment drain before reporting a failed barrier", async () => {
  const failure = new Error("client crawl failed");
  const processing = deferred();
  const draining = deferred();
  let done = false;
  const close = vi.fn(async () => {
    if (!done) throw new Error("closed while SSR was still writing");
  });
  const closing = closeHmrServer({
    close,
    environments: {
      client: {
        waitForRequestsIdle: async () => {
          throw failure;
        },
        depsOptimizer: {},
      } as unknown as DevEnvironment,
      ssr: {
        waitForRequestsIdle: async () => {},
        depsOptimizer: {
          metadata: {
            get discovered() {
              draining.resolve();
              return done ? {} : { dependency: { processing: processing.promise } };
            },
          },
        },
      } as unknown as DevEnvironment,
    },
  });
  const result = closing.catch((error: unknown) => error);
  try {
    await draining.promise;
    expect(close).not.toHaveBeenCalled();
    done = true;
    processing.resolve();
    expect(await result).toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    done = true;
    processing.resolve();
    await result;
  }
});

test("reports both a barrier failure and a server shutdown failure", async () => {
  const barrierFailure = new Error("crawl failed");
  const closeFailure = new Error("shutdown failed");
  await expect(
    closeHmrServer({
      close: async () => {
        throw closeFailure;
      },
      environments: {
        client: {
          waitForRequestsIdle: async () => {
            throw barrierFailure;
          },
          depsOptimizer: {},
        } as unknown as DevEnvironment,
      },
    }),
  ).rejects.toMatchObject({ errors: [barrierFailure, closeFailure] });
});

test("finishes other pending writes in the same environment before reporting a failure", async () => {
  const failure = new Error("first dependency failed");
  const failed = deferred();
  const pending = deferred();
  const draining = deferred();
  let done = false;
  const close = vi.fn(async () => {
    if (!done) throw new Error("closed while a dependency was still writing");
  });
  const closing = closeHmrServer({
    close,
    environments: {
      client: {
        waitForRequestsIdle: async () => {},
        depsOptimizer: {
          metadata: {
            get discovered() {
              draining.resolve();
              return {
                first: { processing: failed.promise },
                second: { processing: pending.promise },
              };
            },
          },
        },
      } as unknown as DevEnvironment,
    },
  });
  const result = closing.catch((error: unknown) => error);
  try {
    await draining.promise;
    failed.reject(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();
    done = true;
    pending.resolve();
    expect(await result).toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    done = true;
    pending.resolve();
    await result;
  }
});

test("does not drain settled processing promises again when metadata retains them", async () => {
  const processing = Promise.resolve();
  let reads = 0;
  const close = vi.fn(async () => {});
  await closeHmrServer({
    close,
    environments: {
      client: {
        waitForRequestsIdle: async () => {},
        depsOptimizer: {
          metadata: {
            get discovered() {
              if (++reads > 2) throw new Error("read the same completed batch repeatedly");
              return { complete: { processing }, cached: { processing: undefined } };
            },
          },
        },
      } as unknown as DevEnvironment,
    },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(reads).toBe(2);
});
