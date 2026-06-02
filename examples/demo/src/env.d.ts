/// <reference types="vite/client" />

declare module "*?worker&url" {
  const url: string;
  export default url;
}

declare module "virtual:uwk-type-snapshot" {
  import type { FsSnapshot } from "@unworklet/lang";

  const snapshot: FsSnapshot;
  export default snapshot;
}
