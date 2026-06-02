/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.css";

// Self-hosted fonts (Geist / JetBrains Mono) — side-effect CSS imports with no types.
declare module "@fontsource-variable/*";
