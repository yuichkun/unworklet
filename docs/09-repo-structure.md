# 09 — Repository structure

How the source code itself is organized: monorepo tooling, package boundaries, license, npm scope, language-toolchain version policy.

This doc is independent of the component docs and can be picked up at any time.

## Status

partial (§1–§5 settled at Q60 / Q61; §6 placeholder per Q61 = fill deferred to impl-phase)

## 1. Monorepo tool

pnpm workspaces。 root に `pnpm-workspace.yaml`、 root `package.json` の `packageManager` field で `pnpm@<version>` を 明 示、 cross-package reference は `workspace:*` protocol。 開 発 / CI で の 起 動 は 全 て `vp` CLI 経 由 で 統 一 (= AGENTS.md HARD CONTRACT、 npm / pnpm / yarn / npx 直 接 起 動 永 久 排 除)。 Q60 (`decisions-log.md`)。

## 2. Package layout

Day-one か ら 公 開 4 package + 内 部 module を 立 て る:

- 公 開: `@unworklet/core` / `@unworklet/vite-plugin` / `@unworklet/offline` / `@unworklet/test`
- 公 開 subpath: `@unworklet/core/simd`
- 内 部 module (= 公 開 package で は な い): compiler / worklet runtime (= `@unworklet/core` 内)

権 威 規 定 = `decisions-log.md` Q13 + Q52。

## 3. License

MIT。 Q60 (`decisions-log.md`)。

## 4. npm scope

`@unworklet`。 Q60 (`decisions-log.md`)。

## 5. TypeScript version policy

TypeScript 5.5 minimum。 Q60 (`decisions-log.md`)。

## 6. Versioning policy

<!-- semver shape, breaking-change rules, recompilation requirement on major bumps.
     Fill deferred to impl-phase owner per Q61 (Q14 itself resolved at Q62). -->
