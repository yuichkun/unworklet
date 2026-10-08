import type { Browser, ConsoleMessage, Page, Request } from "playwright";

type Stage =
  | "setup"
  | "panel-navigation"
  | "panel-auth-ready"
  | "a-navigation"
  | "a-ready"
  | "b-navigation"
  | "b-ready"
  | "routing"
  | "hmr"
  | "close-a"
  | "reload"
  | "reload-ready"
  | "disconnect"
  | "disconnected-ready"
  | "reload-disconnected"
  | "recovery-ready"
  | "recovered-routing";
type Label = "panel" | "a" | "b";
type Route = "app" | "panel" | "vite" | "other";
type Category = "document" | "script" | "stylesheet" | "fetch" | "websocket" | "other";

// Test-only: no event payload, URL, error message or connection value is retained.
export function createDevtoolsEvidence(emit: (output: string) => void = console.error) {
  const start = performance.now();
  let stage: Stage = "setup";
  let dropped = 0;
  let observerErrors = 0;
  let disposed = false;
  let tracked = 0;
  let untracked = 0;
  const records: { ms: number; stage: Stage; page?: Label; event: string }[] = [];
  const active: Partial<Record<Label, Partial<Record<Category, number>>>> = {};
  const routes: Partial<Record<Label, Partial<Record<Route, number>>>> = {};
  const pages: { label: Label; page: Page }[] = [];
  const detach: (() => void)[] = [];
  const requests = new WeakMap<Request, { category: Category; route: Route }>();
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      observerErrors++;
    }
  };
  const record = (event: string, page?: Label) => {
    if (disposed) return;
    if (records.length === 64) {
      records.shift();
      dropped++;
    }
    records.push({ ms: Math.round(performance.now() - start), stage, page, event });
  };
  return {
    stage(value: Stage) {
      stage = value;
      record("stage");
    },
    watchBrowser(browser: Browser) {
      const listener = () => safe(() => record("browser-disconnected"));
      safe(() => browser.on("disconnected", listener));
      detach.push(() => browser.off("disconnected", listener));
    },
    watch(label: Label, page: Page) {
      if (disposed) return;
      if (pages.some((entry) => entry.label === label)) return;
      pages.push({ label, page });
      const counts = (active[label] = {} as Partial<Record<Category, number>>);
      const routeCounts = (routes[label] = {} as Partial<Record<Route, number>>);
      const on = (event: string, fn: (...args: any[]) => void) => {
        const listener = (...args: any[]) => safe(() => fn(...args));
        safe(() => page.on(event as "load", listener));
        detach.push(() => page.off(event as "load", listener));
      };
      for (const event of [
        "load",
        "domcontentloaded",
        "close",
        "crash",
        "pageerror",
        "framenavigated",
      ])
        on(event, () => record(event, label));
      on("console", (message: ConsoleMessage) => {
        if (message.type() === "error") record("console-error", label);
      });
      on("request", (request: Request) => {
        if (tracked === 128) {
          untracked++;
          return;
        }
        const type = request.resourceType();
        const category: Category =
          type === "document" ||
          type === "script" ||
          type === "stylesheet" ||
          type === "fetch" ||
          type === "websocket"
            ? type
            : "other";
        const pathname = new URL(request.url()).pathname;
        const route: Route =
          pathname === "/" || pathname === "/main.mjs" || pathname === "/thru.processor.mjs"
            ? "app"
            : pathname.startsWith("/__unworklet/")
              ? "panel"
              : pathname.startsWith("/@vite/") || pathname.startsWith("/@id/")
                ? "vite"
                : "other";
        requests.set(request, { category, route });
        tracked++;
        routeCounts[route] = (routeCounts[route] ?? 0) + 1;
        counts[category] = (counts[category] ?? 0) + 1;
      });
      const finish = (request: Request) => {
        const entry = requests.get(request);
        if (entry) {
          const { category, route } = entry;
          routeCounts[route]!--;
          tracked--;
          counts[category]!--;
          requests.delete(request);
        }
      };
      on("requestfinished", finish);
      on("requestfailed", (request: Request) => {
        finish(request);
        record("requestfailed", label);
      });
    },
    async report() {
      // No waiting for selectors or navigation: one bounded, best-effort snapshot.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const probes = pages.map(async ({ label, page }) => {
          let closed = false;
          try {
            closed = page.isClosed();
            if (closed) return { page: label, closed };
            const result = await page.evaluate(() => {
              const fixture = globalThis as typeof globalThis & {
                devtoolsStatus?: () => string;
                generation?: number;
                document: { readyState: string; querySelector: (selector: string) => unknown };
              };
              const status = fixture.devtoolsStatus?.();
              return {
                connected: status === "connected",
                disconnected: status === "disconnected",
                connectionError: status === "error",
                generationReady: fixture.generation === 1,
                documentReady: fixture.document.readyState === "complete",
                selector:
                  fixture.document.querySelector('[aria-label="Application page"]') !== null,
              };
            });
            return {
              page: label,
              closed,
              connected: result.connected === true,
              generationReady: result.generationReady === true,
              documentReady: result.documentReady === true,
              selector: result.selector === true,
              disconnected: result.disconnected === true,
              connectionError: result.connectionError === true,
            };
          } catch {
            return { page: label, closed, unavailable: true };
          }
        });
        const readiness = await Promise.race([
          Promise.all(probes),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 200);
          }),
        ]);
        emit(
          JSON.stringify({
            kind: "devtools-test-evidence",
            stage,
            records,
            dropped,
            observerErrors,
            untracked,
            active,
            routes,
            probeTimedOut: readiness === null,
            readiness: readiness ?? [],
          }),
        );
      } catch {
        /* Diagnostics must never replace the test failure. */
      } finally {
        clearTimeout(timer);
      }
    },
    dispose() {
      disposed = true;
      for (const off of detach) safe(off);
      detach.length = 0;
      pages.length = 0;
    },
  };
}
