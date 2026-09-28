// What the page tells the listener about the build they are hearing.
// `tarballs` is the release tarballs' fingerprint, set by the release tooling
// when it builds the demo from them; a build from the repository has none.
import corePackage from "@unworklet/core/package.json";

export const PRODUCTION_HOST = "unworklet.vercel.app";

export function describeBuild(build: {
  version: string;
  tarballs: string | undefined;
  hostname: string;
}): { label: string; detail: string } {
  if (build.tarballs === undefined) {
    return {
      label: "development build",
      detail: `Built from the repository rather than release tarballs; based on v${build.version}.`,
    };
  }
  if (build.hostname === PRODUCTION_HOST) {
    return {
      label: `v${build.version} · released`,
      detail: `Built from the release tarballs ${build.tarballs}.`,
    };
  }
  return {
    label: `v${build.version} · release candidate`,
    detail: `Built from the release tarballs ${build.tarballs}, which are not released yet.`,
  };
}

export const currentBuild = (): { label: string; detail: string } =>
  describeBuild({
    version: corePackage.version,
    tarballs: import.meta.env.VITE_UNWORKLET_TARBALLS || undefined,
    hostname: window.location.hostname,
  });
