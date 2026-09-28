/// <reference types="vite-plus/client" />

interface ImportMetaEnv {
  /** Fingerprint of the release tarballs the demo was built from; unset for a repository build. */
  readonly VITE_UNWORKLET_TARBALLS?: string;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.css";

// Self-hosted fonts (Geist / JetBrains Mono) — side-effect CSS imports with no types.
declare module "@fontsource-variable/*";
