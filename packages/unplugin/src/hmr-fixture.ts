import type { ViteDevServer } from "vite-plus";

export async function closeHmrServer(
  server: Pick<ViteDevServer, "close"> & {
    environments: Record<string, ViteDevServer["environments"][string]>;
  },
): Promise<void> {
  const drains = await Promise.allSettled(
    Object.values(server.environments).map(async (environment) => {
      const optimizer = environment.depsOptimizer;
      if (!optimizer) return [];
      const failures: unknown[] = [];
      const observed = new Set<Promise<void>>();
      const scanning = optimizer.scanProcessing;
      const scan = Promise.allSettled(scanning ? [scanning] : []);
      // Vite can finish closing while a scanned Rolldown build is still writing.
      // Keep the optimizer alive until its discovered dependencies are committed.
      try {
        await environment.waitForRequestsIdle();
      } catch (error) {
        failures.push(error);
      }
      for (const result of await scan) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      for (;;) {
        const pending = new Set(
          Object.values(optimizer.metadata.discovered)
            .map((dependency) => dependency.processing)
            .filter(
              (processing): processing is Promise<void> =>
                processing !== undefined && !observed.has(processing),
            ),
        );
        if (pending.size === 0) break;
        for (const processing of pending) observed.add(processing);
        for (const result of await Promise.allSettled(pending)) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      return failures;
    }),
  );
  const errors: unknown[] = drains.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : result.value,
  );
  try {
    await server.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "HMR fixture shutdown failed");
}
