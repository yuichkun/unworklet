# 09 — Repository structure

How the source code itself is organized: monorepo tooling, package boundaries, license, npm scope, language-toolchain version policy.

This doc is independent of the component docs and can be picked up at any time.

## Status

skeleton

## 1. Monorepo tool

<!-- Q12 — pnpm workspaces? Turborepo? Nx? Vite+ per package? Concrete pick + rationale.
     Lands here. -->

## 2. Package layout

<!-- Q13 — initial structure: do all `@unworklet/*` packages exist from day one,
     or do we core-first and split later? List of packages with their boundaries
     (see also: each component doc states its owning package). Lands here. -->

## 3. License

<!-- Q15 — license choice. Lands here. -->

## 4. npm scope

<!-- Q16 — confirm `@unworklet/*` scope availability on npm; fallback name if taken.
     Lands here. -->

## 5. TypeScript version policy

<!-- Q26 — minimum supported TS version, CI matrix, ESM-only stance. Lands here. -->

## 6. Versioning policy

<!-- semver shape, breaking-change rules, recompilation requirement on major bumps.
     (Settled enough to write up after Q12 / Q14 / Q26 land.) -->
