import type { CrossRealmCase, CrossRealmObservation } from "./fixtures/crossrealm-observation.ts";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    renderGenericIngress: () => Promise<
      Omit<import("../generic-ingress-model.ts").IngressObservation, "overflow">
    >;
    renderCrossRealmOracle: (
      name: CrossRealmCase,
      sampleRate: number,
    ) => Promise<CrossRealmObservation>;
  }
}
