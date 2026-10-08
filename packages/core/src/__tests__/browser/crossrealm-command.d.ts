import type { CrossRealmCase, CrossRealmObservation } from "./fixtures/crossrealm-observation.ts";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    renderCrossRealmOracle: (
      name: CrossRealmCase,
      sampleRate: number,
    ) => Promise<CrossRealmObservation>;
  }
}
