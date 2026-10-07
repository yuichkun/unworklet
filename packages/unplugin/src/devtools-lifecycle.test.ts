import { afterEach, expect, test, vi } from "vite-plus/test";
import * as pages from "./devtools-pages.ts";
import unworklet from "./index.ts";

afterEach(() => vi.restoreAllMocks());

test.each([false, true])(
  "DevTools cleanup survives server close before setup completes: %s",
  async (closeEarly) => {
    const dispose = vi.fn();
    let resolve!: (dispose: () => void) => void;
    const pending = new Promise<() => void>((done) => {
      resolve = done;
    });
    vi.spyOn(pages, "setupDevtoolsPages").mockReturnValue(pending);
    const plugin = unworklet() as unknown as {
      devtools: { setup: (ctx: unknown) => Promise<void> };
      closeBundle: () => Promise<void>;
    };
    const ctx = { docks: { register: vi.fn() }, views: { hostStatic: vi.fn() } };
    const setup = plugin.devtools.setup(ctx);
    if (closeEarly) await plugin.closeBundle();
    resolve(dispose);
    await setup;
    if (!closeEarly) await plugin.closeBundle();
    expect(dispose).toHaveBeenCalledTimes(1);
  },
);
