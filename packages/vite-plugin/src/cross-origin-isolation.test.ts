/**
 * The plugin makes its dev server cross-origin isolated by default (COOP
 * `same-origin` + COEP `credentialless`) so `SharedArrayBuffer` — unworklet's fast
 * main↔worklet transport — works with no app config. `credentialless` is the
 * least-breaking isolation level (cross-origin subresources still load, without
 * credentials). `crossOriginIsolation: false` opts out, and an app that serves its
 * own COOP/COEP is left untouched. Production headers are the app server's job;
 * this only touches vite's dev server (not preview, which mirrors production).
 */

import { expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

type ConfigHook = (
  this: unknown,
  userConfig: Record<string, unknown>,
  env: { command: string; mode: string },
) => { server?: { headers?: Record<string, string> } } | undefined;

const callConfig = (
  command: string,
  options?: Parameters<typeof unworklet>[0],
  userConfig: Record<string, unknown> = {},
): { server?: { headers?: Record<string, string> } } | undefined => {
  const hook = unworklet(options).config;
  if (typeof hook !== "function") throw new Error("config hook is not a plain function");
  return (hook as unknown as ConfigHook).call(null, userConfig, { command, mode: "development" });
};

test("the dev server is cross-origin isolated by default", () => {
  const headers = callConfig("serve")?.server?.headers;
  expect(headers?.["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  expect(headers?.["Cross-Origin-Embedder-Policy"]).toBe("credentialless");
});

test("crossOriginIsolation: false leaves the dev server headers untouched", () => {
  expect(callConfig("serve", { crossOriginIsolation: false })?.server).toBeUndefined();
});

test("an app's own COOP/COEP header is respected, not overridden", () => {
  const config = callConfig("serve", undefined, {
    server: { headers: { "Cross-Origin-Embedder-Policy": "require-corp" } },
  });
  // The app set COEP itself — the plugin must not hand back a clobbering value …
  expect(config?.server?.headers?.["Cross-Origin-Embedder-Policy"]).toBeUndefined();
  // … but still fills in the COOP the app left unset.
  expect(config?.server?.headers?.["Cross-Origin-Opener-Policy"]).toBe("same-origin");
});
