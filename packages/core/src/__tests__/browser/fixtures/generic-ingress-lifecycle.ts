type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function tracked<T>(promise: Promise<T>) {
  const item = {
    status: "pending",
    result: promise.then(
      (value): Outcome<T> => {
        item.status = "fulfilled";
        return { ok: true, value };
      },
      (error: unknown): Outcome<T> => {
        item.status = "rejected";
        return { ok: false, error };
      },
    ),
  };
  return item;
}

export function createIngressLifecycle({
  context,
  boundaries,
  rendering,
  timeoutMs = 1000,
}: {
  context: { resume(): Promise<void> };
  boundaries: Promise<unknown>[];
  rendering: Promise<unknown>;
  timeoutMs?: number;
}) {
  const suspensions = boundaries.map(tracked);
  const render = tracked(rendering);
  const resumes: ReturnType<typeof tracked<void>>[] = [];
  let cursor = 0;
  let first: Error | undefined;
  let notifyFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => {
    notifyFailure = resolve;
  });
  const fail = (error: unknown) => {
    if (first !== undefined) return;
    first = error instanceof Error ? error : new Error(String(error));
    notifyFailure(first);
  };
  const bounded = async <T>(
    item: ReturnType<typeof tracked<T>>,
    label: string,
    deadline: number,
    listen: boolean,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: new Error(`${label} timed out`) }),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const outcome = await Promise.race([
        item.result,
        timeout,
        ...(listen ? [failed.then((error): Outcome<T> => ({ ok: false, error }))] : []),
      ]);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      clearTimeout(timer);
    }
  };
  let pendingResume: ReturnType<typeof tracked<void>> | undefined;
  const resumeUntil = async (deadline: number, listen: boolean) => {
    if (pendingResume?.status === "fulfilled") pendingResume = undefined;
    if (pendingResume === undefined) {
      // Promise adoption also handles synchronous exceptions from test doubles.
      pendingResume = tracked(
        Promise.resolve()
          .then(() => context.resume())
          .then(() => {
            cursor++;
          }),
      );
      resumes.push(pendingResume);
    }
    const attempt = pendingResume;
    try {
      await bounded(attempt, "resume", deadline, listen);
    } finally {
      if (attempt.status !== "pending") pendingResume = undefined;
    }
  };
  return {
    fail,
    wait: <T>(promise: Promise<T>, label = "operation") =>
      bounded(tracked(promise), label, Date.now() + timeoutMs, true),
    boundary: (index: number) =>
      bounded(suspensions[index]!, `suspension ${index}`, Date.now() + timeoutMs, true),
    resume: () => resumeUntil(Date.now() + timeoutMs, true),
    async cleanup(actions: (() => void)[]): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      const errors: string[] = [];
      const record = (error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
        fail(error);
      };
      while (cursor < suspensions.length && Date.now() < deadline) {
        const index = cursor;
        try {
          await bounded(suspensions[index]!, `suspension ${index}`, deadline, false);
          if (cursor !== index) continue;
          try {
            await resumeUntil(deadline, false);
          } catch (error) {
            record(error);
            if (Date.now() >= deadline) break;
            // A rejected resume can be retried once; a pending native operation
            // retains its identity and shares the same teardown deadline.
            await resumeUntil(deadline, false);
          }
        } catch (error) {
          record(error);
          break;
        }
      }
      try {
        await bounded(render, "render", deadline, false);
      } catch (error) {
        record(error);
      }
      for (const action of actions) {
        try {
          action();
        } catch (error) {
          record(error);
        }
      }
      if (first !== undefined) {
        if (errors.length > 0) {
          first.message += `; cleanup: ${errors.join("; ")}; native status: suspensions=[${suspensions.map((item) => item.status).join(",")}], resumes=[${resumes.map((item) => item.status).join(",")}], render=${render.status} (no native cancellation)`;
        }
        throw first;
      }
    },
  };
}
